// Public tunnel lifecycle: locate or download `cloudflared`, run a Cloudflare quick tunnel to the local
// server, and tear it down again. Providers share one small interface so alternatives (ngrok, bore, ...)
// can be added later:
//
//   { name: string, async start(port, opts) -> { url, stop(): Promise<void>, process? } }
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_URL_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const OUTPUT_LINES_KEPT = 20;
const STOP_GRACE_MS = 3_000;
/** The binary download fails if no response arrives, or the body stalls, for this long. */
const DOWNLOAD_STALL_MS = 30_000;

/** Directory holding bpmn-edit's own state (binary cache etc.). */
export function defaultHome() {
  return process.env.BPMN_EDIT_HOME || path.join(homedir(), '.bpmn-edit');
}

/** Which cloudflared release asset fits this machine. Throws for unsupported platforms. */
export function assetFor(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'darwin-x64':
      return { asset: 'cloudflared-darwin-amd64.tgz', archive: 'tgz', binName: 'cloudflared' };
    case 'darwin-arm64':
      return { asset: 'cloudflared-darwin-arm64.tgz', archive: 'tgz', binName: 'cloudflared' };
    case 'linux-x64':
      return { asset: 'cloudflared-linux-amd64', archive: null, binName: 'cloudflared' };
    case 'linux-arm64':
      return { asset: 'cloudflared-linux-arm64', archive: null, binName: 'cloudflared' };
    case 'linux-arm':
      return { asset: 'cloudflared-linux-arm', archive: null, binName: 'cloudflared' };
    case 'linux-ia32':
      return { asset: 'cloudflared-linux-386', archive: null, binName: 'cloudflared' };
    case 'win32-x64':
      return { asset: 'cloudflared-windows-amd64.exe', archive: null, binName: 'cloudflared.exe' };
    case 'win32-ia32':
      return { asset: 'cloudflared-windows-386.exe', archive: null, binName: 'cloudflared.exe' };
    default:
      throw new Error(
        `cloudflared: unsupported platform ${platform}/${arch}. Install cloudflared manually and make sure it is on your PATH.`,
      );
  }
}

/** Download URL for a release asset; BPMN_EDIT_CLOUDFLARED_URL_BASE overrides the release location. */
export function downloadUrl(asset, baseUrl = process.env.BPMN_EDIT_CLOUDFLARED_URL_BASE || DEFAULT_URL_BASE) {
  return `${baseUrl.replace(/\/+$/, '')}/${asset}`;
}

/** First public quick-tunnel URL in `text` (ignores api.trycloudflare.com), or null. */
export function parseTunnelUrl(text) {
  const re = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/gi;
  for (const match of String(text).matchAll(re)) {
    if (match[1].toLowerCase() !== 'api') return match[0];
  }
  return null;
}

async function isExecutableFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of executable `name` on PATH, or null. Pure Node (no `which`).
 * `env` and `platform` are injectable for tests.
 */
export async function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const isWin = platform === 'win32';
  const pathValue = (isWin ? env.Path ?? env.PATH : env.PATH) ?? '';
  const delimiter = isWin ? ';' : ':';
  let candidates = [name];
  if (isWin && !path.extname(name)) {
    const exts = (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
    candidates = [...exts.map((ext) => name + ext.toLowerCase()), name];
  }
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.resolve(dir.replace(/^"(.*)"$/, '$1'), candidate);
      if (await isExecutableFile(full)) return full;
    }
  }
  return null;
}

/** In-flight downloads, keyed by target binary path, so concurrent callers share one download. */
const inFlight = new Map();

/**
 * Resolves to an absolute path of a runnable cloudflared: from PATH, from the cache in `<home>/bin`,
 * or freshly downloaded into that cache. Progress is reported through `onProgress`:
 *   { phase: 'path', path } | { phase: 'cached', path } | { phase: 'download', received, total }
 *   | { phase: 'extract' } | { phase: 'done', path }
 * The download is aborted if the server does not answer, or the body stops arriving, for `stallMs`.
 */
export async function ensureCloudflared({
  home = defaultHome(),
  onProgress = () => {},
  baseUrl,
  usePath = true,
  platform = process.platform,
  arch = process.arch,
  stallMs = DOWNLOAD_STALL_MS,
} = {}) {
  // PATH first, so an installed cloudflared works even where no release asset is known.
  const binName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  if (usePath) {
    const onPath = await findOnPath(binName, { platform });
    if (onPath) {
      onProgress({ phase: 'path', path: onPath });
      return onPath;
    }
  }
  const binDir = path.join(path.resolve(home), 'bin');
  const target = path.join(binDir, binName);
  if (await isExecutableFile(target)) {
    onProgress({ phase: 'cached', path: target });
    return target;
  }
  let pending = inFlight.get(target);
  if (!pending) {
    const { asset, archive } = assetFor(platform, arch);
    const url = downloadUrl(asset, baseUrl);
    pending = download({ url, archive, binName, binDir, target, onProgress, stallMs }).finally(() => inFlight.delete(target));
    inFlight.set(target, pending);
  }
  return pending;
}

async function download({ url, archive, binName, binDir, target, onProgress, stallMs }) {
  await mkdir(binDir, { recursive: true });
  // All temporary files live in a private dir inside the cache, removed whatever happens.
  const tmpDir = await mkdtemp(path.join(binDir, '.cloudflared-'));
  // Stall timer: armed until the response arrives, re-armed on every chunk of the body.
  const abort = new AbortController();
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => abort.abort(new Error(`no data for ${stallMs} ms`)), stallMs);
  };
  const stalled = () => (abort.signal.aborted ? `timed out (${abort.signal.reason.message})` : null);
  try {
    let res;
    armStall();
    try {
      res = await fetch(url, { redirect: 'follow', signal: abort.signal });
    } catch (err) {
      throw new Error(`Failed to download cloudflared from ${url}: ${stalled() || err.cause?.message || err.message}`);
    }
    armStall();
    if (!res.ok || !res.body) {
      res.body?.cancel().catch(() => {});
      throw new Error(`Failed to download cloudflared from ${url}: HTTP ${res.status}`);
    }
    const lengthHeader = Number(res.headers.get('content-length'));
    const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        armStall();
        received += chunk.length;
        onProgress({ phase: 'download', received, total });
        done(null, chunk);
      },
    });
    const downloaded = path.join(tmpDir, archive ? 'download.tgz' : binName);
    try {
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(downloaded, { mode: 0o600 }));
    } catch (err) {
      throw new Error(`Failed to download cloudflared from ${url}: ${stalled() || err.message}`);
    }
    clearTimeout(stallTimer);
    if (total !== null && received !== total) {
      throw new Error(`Failed to download cloudflared from ${url}: incomplete download (${received} of ${total} bytes)`);
    }

    let binary = downloaded;
    if (archive === 'tgz') {
      onProgress({ phase: 'extract' });
      const outDir = path.join(tmpDir, 'out');
      await mkdir(outDir);
      try {
        await execFileAsync('tar', ['-xzf', downloaded, '-C', outDir]);
      } catch (err) {
        throw new Error(`Failed to extract cloudflared from ${url}: ${err.stderr?.trim() || err.message}`);
      }
      binary = await findFile(outDir, binName);
      if (!binary) throw new Error(`Failed to extract cloudflared from ${url}: no ${binName} in the archive`);
    }
    await chmod(binary, 0o755);
    await rename(binary, target);
    onProgress({ phase: 'done', path: target });
    return target;
  } finally {
    clearTimeout(stallTimer);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

// --- child process bookkeeping -------------------------------------------------------------------

/** Tunnel children still running; killed hard if the parent exits without stopping them. */
const liveChildren = new Set();
let exitHookInstalled = false;

function track(child) {
  if (child.pid === undefined) return; // never started
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const c of liveChildren) {
        try { c.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once the child has actually exited. */
function terminate(child, exited, graceMs = STOP_GRACE_MS) {
  if (hasExited(child)) return exited;
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (!hasExited(child)) child.kill('SIGKILL'); }, graceMs);
  return exited.finally(() => clearTimeout(timer));
}

/** True if a probe result is Cloudflare saying the tunnel has no live connection yet (530 / error 1033). */
function tunnelNotReady({ status, server, body }) {
  if (status === 530) return true;
  if (status >= 500 && server?.toLowerCase() === 'cloudflare') {
    return /\b1033\b|Argo Tunnel error|Cloudflare Tunnel error/i.test(body);
  }
  return false;
}

/** Reads at most `limit` characters of a 5xx body (enough to recognise a Cloudflare error page). */
const ERROR_BODY_LIMIT = 64 * 1024;

/**
 * GET `url` without following redirects. With `address`, the hostname is not looked up through the system
 * resolver but connected to directly (TLS SNI and Host header stay the hostname). Resolves to
 * { status, server, body } or rejects on network errors.
 */
export function probeHttps(url, { address, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const options = { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'bpmn-edit' } };
    if (address) {
      options.lookup = (_host, opts, cb) => (opts?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4));
    }
    const req = https.request(url, options, (res) => {
      const status = res.statusCode;
      const server = res.headers.server;
      if (status < 500) {
        res.resume();
        resolve({ status, server, body: '' });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < ERROR_BODY_LIMIT) body += chunk;
      });
      res.on('end', () => resolve({ status, server, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Authoritative name server addresses per zone, looked up once per process. */
const authoritativeServers = new Map();

async function lookupAuthoritativeServers(zone) {
  if (!authoritativeServers.has(zone)) {
    const pending = (async () => {
      const resolver = new Resolver({ timeout: 3_000, tries: 2 });
      const names = await resolver.resolveNs(zone);
      const addresses = (await Promise.all(names.map((name) => resolver.resolve4(name).catch(() => [])))).flat();
      if (!addresses.length) throw new Error(`no name server addresses for ${zone}`);
      return addresses;
    })();
    authoritativeServers.set(zone, pending);
    pending.catch(() => authoritativeServers.delete(zone)); // retry on the next call
  }
  return authoritativeServers.get(zone);
}

/**
 * Asks the zone's authoritative name servers whether `hostname` exists yet. Resolves to { state, address }
 * where state is 'found' (with an IPv4 address), 'missing' (NXDOMAIN / no data) or 'unavailable' (the
 * name servers cannot be reached from here, e.g. outbound DNS is blocked).
 *
 * Why not just try the URL: quick-tunnel hostnames appear in DNS some seconds after cloudflared prints them.
 * Any recursive resolver asked too early caches the NXDOMAIN (for about a minute), and the URL then stays
 * unreachable for everyone behind it, including the host's own browser. Authoritative servers do not cache,
 * so polling them is harmless; once they know the name, the HTTP probe connects to the returned address
 * directly and the system resolver is first consulted only after the tunnel is known to work.
 */
export async function probeTunnelDns(hostname, { servers, timeoutMs = 2_000 } = {}) {
  try {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers(servers ?? (await lookupAuthoritativeServers(hostname.split('.').slice(-2).join('.'))));
    const addresses = await resolver.resolve4(hostname);
    return addresses.length ? { state: 'found', address: addresses[0] } : { state: 'missing' };
  } catch (err) {
    return { state: ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code) ? 'missing' : 'unavailable' };
  }
}

// --- providers -----------------------------------------------------------------------------------

/**
 * Cloudflare quick tunnel (no account). Passing `bin` skips the binary lookup/download. `timeoutMs` is the
 * overall deadline from the first spawn of cloudflared until the public URL actually answers, including
 * retries. Cloudflare rate-limits quick-tunnel provisioning per IP (HTTP 429); such attempts are retried up
 * to `retries` times with doubling backoff starting at `retryDelayMs`, then rejected with
 * `err.code === 'TUNNEL_RATE_LIMITED'`. `spawn`, `probeDns` and
 * `probeHttp` (url, { address, timeoutMs }) -> { status, server, body } are injectable for tests.
 */
export function cloudflareProvider({
  home,
  onProgress = () => {},
  bin,
  baseUrl,
  usePath,
  timeoutMs = 30_000,
  reachabilityTimeoutMs = 5_000,
  pollIntervalMs = 500,
  retries = 2,
  retryDelayMs = 3_000,
  spawn = nodeSpawn,
  probeDns = probeTunnelDns,
  probeHttp = probeHttps,
} = {}) {
  return {
    name: 'cloudflare',
    async start(port) {
      const executable = bin || (await ensureCloudflared({ home, onProgress, baseUrl, usePath }));
      const deadline = Date.now() + timeoutMs;
      for (let attempt = 0; ; attempt++) {
        try {
          return await startOnce(executable, port, deadline);
        } catch (err) {
          if (err.code !== 'TUNNEL_RATE_LIMITED' || attempt >= retries) throw err;
          const delay = retryDelayMs * 2 ** attempt;
          if (Date.now() + delay >= deadline) throw err;
          onProgress({ phase: 'retry', attempt: attempt + 1, delayMs: delay, reason: 'rate-limited' });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
  };

  async function startOnce(executable, port, deadline) {
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(executable, ['tunnel', '--url', origin, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    onProgress({ phase: 'spawn', pid: child.pid });

    const lines = [];
    // A spawn failure (e.g. ENOENT) emits 'error' without 'exit'; treat it as the child being gone.
    let spawnError = null;
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (err) => {
        if (child.pid === undefined) {
          spawnError = err;
          resolve({ code: null, signal: null });
        }
      });
    });
    track(child);

    let rateLimited = false;
    let onUrl;
    const urlSeen = new Promise((resolve) => { onUrl = resolve; });
    let url = null;
    const feed = (stream) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      let partial = '';
      // Keep draining output for the child's whole life, otherwise a full pipe would block cloudflared.
      stream.on('data', (chunk) => {
        partial += chunk;
        const parts = partial.split(/\r?\n/);
        partial = parts.pop();
        for (const line of parts) {
          lines.push(line);
          if (lines.length > OUTPUT_LINES_KEPT) lines.shift();
          if (!url && isRateLimitLine(line)) {
            rateLimited = true;
            stop(); // cloudflared exits on its own as well; make sure of it
          }
          if (!url) {
            const found = parseTunnelUrl(line);
            if (found) { url = found; onUrl(found); }
          }
        }
      });
    };
    feed(child.stdout);
    feed(child.stderr);

    let stopping = null;
    const stop = () => {
      if (!stopping) stopping = terminate(child, exited).then(() => {});
      return stopping;
    };
    const recentOutput = () => (lines.length ? `\nLast output:\n${lines.join('\n')}` : '');

    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    });
    const earlyExit = exited.then(() => 'exit');

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const gone = () => Boolean(stopping) || hasExited(child) || Boolean(spawnError);

    const waitReachable = async (publicUrl) => {
      onProgress({ phase: 'url', url: publicUrl });
      const { hostname } = new URL(publicUrl);
      let address;
      for (;;) {
        const dns = await probeDns(hostname);
        if (dns.state === 'found') { address = dns.address; break; }
        // Authoritative DNS unreachable from here: fall back to probing through the system resolver.
        if (dns.state === 'unavailable') break;
        if (gone()) return 'exit';
        await sleep(pollIntervalMs);
      }
      onProgress({ phase: 'dns', url: publicUrl, address });
      for (;;) {
        try {
          const res = await probeHttp(publicUrl, { address, timeoutMs: reachabilityTimeoutMs });
          if (!tunnelNotReady(res)) return 'ready';
        } catch {
          // Connection errors: the edge does not route the hostname yet.
        }
        if (gone()) return 'exit';
        await sleep(pollIntervalMs);
      }
    };

    try {
      const ready = urlSeen.then(waitReachable);
      const outcome = await Promise.race([ready, timedOut, earlyExit]);
      if (outcome === 'ready') {
        onProgress({ phase: 'ready', url });
        return { url, stop, process: child };
      }
      if (outcome === 'timeout') {
        const output = recentOutput();
        await stop();
        const what = url ? `${url} did not become reachable` : 'cloudflared did not print a tunnel URL';
        if (rateLimited) throw rateLimitError(output);
        throw new Error(`Tunnel failed to start: ${what} within ${timeoutMs} ms.${output}`);
      }
      if (spawnError) {
        throw new Error(`Tunnel failed to start: could not run ${executable}: ${spawnError.message}`);
      }
      const { code, signal } = await exited;
      if (rateLimited) throw rateLimitError(recentOutput());
      throw new Error(
        `Tunnel failed to start: cloudflared exited early (code ${code}${signal ? `, signal ${signal}` : ''}).${recentOutput()}`,
      );
    } catch (err) {
      if (!spawnError) await stop().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True for cloudflared's log line when quick-tunnel provisioning is refused with HTTP 429. */
export function isRateLimitLine(line) {
  return /\bstatus 429\b|429 Too Many Requests|error code: 1015/i.test(line);
}

function rateLimitError(output) {
  const err = new Error(
    `Cloudflare is rate-limiting quick tunnels from this network (HTTP 429). Try again in a few minutes.${output}`,
  );
  err.code = 'TUNNEL_RATE_LIMITED';
  return err;
}

/**
 * Starts a public tunnel to the local server on `port`. Resolves to { url, provider, stop, process }.
 * Only a process 'exit' hook kills leftover tunnel processes; SIGINT/SIGTERM are left to the caller, so
 * callers must call stop() from their signal handlers.
 */
export async function startTunnel({ port, provider, ...opts } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`startTunnel: invalid port ${port}`);
  }
  const chosen = provider ?? cloudflareProvider(opts);
  const tunnel = await chosen.start(port, opts);
  return { url: tunnel.url, provider: chosen.name, stop: tunnel.stop, process: tunnel.process };
}
