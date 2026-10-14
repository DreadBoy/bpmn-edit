// Sharing state of one server: the public tunnel and the session token collaborators use
// (`<tunnel url>/s/<token>`). Started and stopped only by the host (POST / DELETE /api/share).
import { EventEmitter } from 'node:events';
import { newSessionToken, safeEqual, TOKEN_RE } from './security.js';
import { cloudflareProvider, startTunnel } from './tunnel.js';

/** Overall deadline for a quick tunnel to answer (Q3: 6.5–7 s typical; PLAN: 7–13 s). */
const TUNNEL_TIMEOUT_MS = 60_000;

/** Human-readable text for a tunnel progress event (shown next to the Share spinner). */
export function describeProgress(event) {
  switch (event.phase) {
    case 'download': {
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      if (event.total) return `Downloading cloudflared… ${Math.floor((event.received / event.total) * 100)}%`;
      return `Downloading cloudflared… ${mb(event.received)} MB`;
    }
    case 'extract': return 'Unpacking cloudflared…';
    case 'path':
    case 'cached':
    case 'done':
    case 'spawn': return 'Starting tunnel…';
    case 'url':
    case 'dns': return 'Waiting for the public link to come online…';
    case 'retry': return 'Cloudflare is busy, retrying…';
    case 'ready': return 'Almost there…';
    default: return null;
  }
}

/** First line of an error message (tunnel errors append cloudflared's last output lines). */
function firstLine(message) {
  return String(message ?? 'unknown error').split('\n')[0].trim();
}

/** Default provider factory: Cloudflare quick tunnel, no automatic retries (the user retries). */
export function defaultProviderFactory({ onProgress }) {
  return cloudflareProvider({ onProgress, retries: 0, timeoutMs: TUNNEL_TIMEOUT_MS });
}

/**
 * Events:
 * - 'status' (status) whenever status() changes (state, progress text, url, error)
 * - 'revoked' (token) when a session token stops being valid (stop, unexpected tunnel exit); the
 *   server disconnects the collaborators that joined with it
 *
 * status(): { state: 'idle' | 'starting' | 'active' | 'error', url?, progress?, error?: { code, message } }
 */
export class ShareManager extends EventEmitter {
  #getPort;
  #createProvider;
  #log;
  #state = 'idle';
  #token = null;
  #tunnel = null;
  #tunnelHost = null;
  #url = null;
  #progress = null;
  #error = null;
  #starting = null;  // promise of the running start()
  #attempt = null;   // { cancelled } of the running start(); stop() cancels it

  /**
   * @param {object} options
   * @param {() => number} options.getPort  the local server's port
   * @param {(opts: { onProgress }) => object} [options.createProvider]  tunnel provider factory
   * @param {(message: string) => void} [options.log]
   */
  constructor({ getPort, createProvider = defaultProviderFactory, log = (m) => process.stderr.write(m) }) {
    super();
    this.#getPort = getPort;
    this.#createProvider = createProvider;
    this.#log = log;
  }

  get state() { return this.#state; }

  /** Hostname of the tunnel (once its URL is known, while starting or active), else null. */
  get tunnelHost() { return this.#tunnelHost; }

  status() {
    const status = { state: this.#state };
    if (this.#state === 'active') status.url = this.#url;
    if (this.#state === 'starting' && this.#progress) status.progress = this.#progress;
    if (this.#state === 'error') status.error = { ...this.#error };
    return status;
  }

  /** True if `token` is the current session token and sharing is active. */
  isValidToken(token) {
    return this.#state === 'active' && typeof token === 'string' && TOKEN_RE.test(token) && safeEqual(token, this.#token);
  }

  #emitStatus() {
    this.emit('status', this.status());
  }

  #setProgress(text) {
    if (!text || text === this.#progress || this.#state !== 'starting') return;
    this.#progress = text;
    this.#emitStatus();
  }

  /** Starts sharing (or joins a start in progress). Resolves to status(): 'active' or 'error'. */
  start() {
    if (this.#state === 'active') return Promise.resolve(this.status());
    if (this.#starting) return this.#starting;
    this.#state = 'starting';
    this.#error = null;
    this.#progress = 'Starting tunnel…';
    this.#emitStatus();
    const attempt = { cancelled: false };
    this.#attempt = attempt;
    const starting = this.#doStart(attempt).finally(() => {
      if (this.#starting === starting) {
        this.#starting = null;
        this.#attempt = null;
      }
    });
    this.#starting = starting;
    return starting;
  }

  async #doStart(attempt) {
    let tunnel;
    try {
      const provider = this.#createProvider({
        onProgress: (event) => {
          if (attempt.cancelled) return;
          if (event.phase === 'url' && event.url) this.#tunnelHost = new URL(event.url).hostname;
          this.#setProgress(describeProgress(event));
        },
      });
      tunnel = await startTunnel({ port: this.#getPort(), provider });
    } catch (err) {
      if (attempt.cancelled) return { state: 'idle' };
      this.#tunnelHost = null;
      const code = err.code === 'TUNNEL_RATE_LIMITED' ? err.code : 'TUNNEL_FAILED';
      const message = code === 'TUNNEL_RATE_LIMITED'
        ? 'Cloudflare is limiting new quick tunnels from this network right now (HTTP 429). Wait a few minutes, then try Share again.'
        : `Could not start the public tunnel: ${firstLine(err.message).replace(/^Tunnel failed to start: /, '')}`;
      this.#log(`bpmn-edit: sharing failed: ${err.message}\n`);
      this.#state = 'error';
      this.#error = { code, message };
      this.#emitStatus();
      return this.status();
    }
    if (attempt.cancelled) {
      // Stopped while starting: this tunnel was never shared; close it.
      await tunnel.stop().catch(() => {});
      return { state: 'idle' };
    }
    this.#tunnel = tunnel;
    this.#tunnelHost = new URL(tunnel.url).hostname;
    this.#token = newSessionToken();
    this.#url = `${tunnel.url.replace(/\/+$/, '')}/s/${this.#token}`;
    this.#state = 'active';
    this.#progress = null;
    tunnel.process?.once('exit', () => this.#onTunnelExit(tunnel));
    this.#log(`bpmn-edit: sharing at ${this.#url}\n`);
    this.#emitStatus();
    return this.status();
  }

  #onTunnelExit(tunnel) {
    if (this.#tunnel !== tunnel) return; // stopped on purpose
    this.#log('bpmn-edit: the tunnel stopped unexpectedly; the shared link no longer works\n');
    this.#revoke();
    this.#state = 'error';
    this.#error = { code: 'TUNNEL_EXITED', message: 'The public tunnel stopped unexpectedly. Share again to get a new link.' };
    this.#emitStatus();
  }

  /** Invalidates the session token and forgets the tunnel (does not stop it). */
  #revoke() {
    const token = this.#token;
    this.#token = null;
    this.#url = null;
    this.#tunnel = null;
    this.#tunnelHost = null;
    if (token) this.emit('revoked', token);
  }

  /**
   * Stops sharing: the token is invalidated at once (collaborators are disconnected, the link 404s),
   * then the tunnel is stopped. A start in progress is cancelled without waiting for it: its tunnel
   * is closed as soon as it is up (and the tunnel module kills it if the process exits first).
   * Resolves to status() ('idle').
   */
  async stop() {
    const tunnel = this.#tunnel;
    if (this.#attempt) {
      this.#attempt.cancelled = true;
      this.#attempt = null;
      this.#starting = null;
    }
    const changed = this.#state !== 'idle';
    this.#revoke();
    this.#state = 'idle';
    this.#error = null;
    this.#progress = null;
    if (changed) this.#emitStatus();
    if (tunnel) {
      await tunnel.stop().catch((err) => this.#log(`bpmn-edit: could not stop the tunnel: ${err.message}\n`));
      this.#log('bpmn-edit: sharing stopped\n');
    }
    return this.status();
  }
}
