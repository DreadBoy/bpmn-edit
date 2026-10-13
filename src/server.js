// HTTP + WebSocket server: serves the editor shell from web/, the document via /api/file, the sync
// protocol on /ws (including changes made to the file on disk) and, for the host only, /api/share.
//
// Who may do what (see src/security.js and PLAN.md "Security model"):
// - Every request and WebSocket upgrade must name this server in its Host header (localhost /
//   127.0.0.1 / [::1] with our port, or the active tunnel hostname) and, if it has an Origin, come
//   from one of those; otherwise 421 / 403 (DNS rebinding, other web sites).
// - Local requests (no Cloudflare header): the editor at `/`, `/api/file`, `/ws`. Host-only calls
//   (`/api/share`) also need the host secret in the `X-Local-Bpmn-Host` header (403 otherwise); a
//   WebSocket opened with `?host=<secret>` is the host's and receives 'share' messages.
// - The same editor is served under `/s/<token>/` (assets, `api/file`, `ws` relative to it) while
//   sharing is active with that token; `/s/<token>` redirects there.
// - Remote requests (a `cf-connecting-ip` / `cf-ray` header, i.e. through the tunnel) only get
//   `/s/<token>/…` with the current token, never a host-only route even with the host secret. Wrong
//   token, no active share, or any other path: 404.
// - Stopping the share rotates the token and disconnects the WebSockets opened with the old one.
//
// HTTP API (host only):
//   GET    /api/share  -> 200 status
//   POST   /api/share  -> starts sharing; waits until done: 200 status ('active', url) or 502 / 429
//                         status ('error', error: { code: 'TUNNEL_FAILED' | 'TUNNEL_RATE_LIMITED', message })
//   DELETE /api/share  -> stops sharing: 200 status ('idle')
//   status = { state: 'idle' | 'starting' | 'active' | 'error', url?, progress?, error? } (src/share.js)
//
// WebSocket protocol (JSON text frames, each with a `type`):
//   (WebSocket URL: `?page=<key>` optional, the page's random key, as in presence 'hello'.)
//   server -> client  { type: 'init', xml, version, name, path?, clientId, role, instance, saved, discards,
//                       lastDisk, lastEdit, staleSaves, accepted }
//                                                               on connect; clientId ('c1', 'c2', …) is
//                                                               unique for the server's lifetime;
//                                                               path (absolute, on the host) is left
//                                                               out for sockets under /s/<token>/;
//                                                               role: 'host' | 'local' | 'collaborator'
//                                                               (how this socket was opened; a page
//                                                               whose host secret is from an earlier
//                                                               run of the CLI is 'local').
//                                                               instance: id of this session (versions
//                                                               only compare within one); saved: every
//                                                               version up to this is on disk;
//                                                               discards: [{ after, version }] accepted
//                                                               updates with a version in between were
//                                                               replaced by the change on disk at
//                                                               `version` before they were written (a
//                                                               reconnecting client re-applies its own,
//                                                               see 'remote-update' discardedAfter; Q2);
//                                                               lastDisk / lastEdit: newest version
//                                                               from disk (or null) / from an update;
//                                                               accepted: { seq, version } of the
//                                                               newest update accepted from this page
//                                                               key (or null), so a page whose 'ack'
//                                                               was lost with its connection knows
//                                                               whether its update in flight was
//                                                               accepted (and at which version);
//                                                               staleSaves: [{ name, version }] recent
//                                                               'kept-aside' stale saves (see below)
//   client -> server  { type: 'update', xml, baseVersion, overrides?, seq?, reapplied? }
//                                                               full XML after an edit, based on the
//                                                               version the client last received or
//                                                               had acknowledged; at most one update
//                                                               per client is in flight. overrides:
//                                                               [{ id, name, kind? }] of elements it
//                                                               deletes although someone else changed
//                                                               them concurrently; kind 'connection' =
//                                                               a connection someone added to an
//                                                               element it deletes (name = that
//                                                               element). Passed on unchanged.
//                                                               seq: per-page update number (see
//                                                               'init' accepted). reapplied: versions
//                                                               of this page's discarded updates
//                                                               (discardedAfter) re-applied in it.
//   client -> server  { type: 'reapplied', versions }           the same when nothing was left to send
//   server -> client  { type: 'ack', version }                  update accepted (the sender gets no
//                                                               remote-update for its own edit)
//   server -> client  { type: 'conflict', version, message }    update refused: another update replaced
//                                                               its baseVersion first (the client has
//                                                               already been sent that newer version as
//                                                               'remote-update'). The client re-applies
//                                                               its edits on it and sends a new update.
//                                                               A change made on disk counts like
//                                                               another client's update (Q2).
//   server -> client  { type: 'error', code, message }          code: 'bad-message' | 'invalid-xml' |
//                                                               'write-failed' (pushed) | 'internal'
//   server -> client  { type: 'flush' }                         shutting down: send pending edits now
//   client -> server  { type: 'flushed' }                       nothing pending any more
//   server -> client  { type: 'remote-update', xml, version, origin, overrides? }
//                                                               the document was replaced by someone
//                                                               else: origin 'disk' = changed on disk
//                                                               (sent to every client), otherwise the
//                                                               clientId of the editing client (sent to
//                                                               every other client). Versions only
//                                                               grow. discardedAfter (disk only):
//                                                               accepted updates with a higher
//                                                               version never reached the disk; their
//                                                               senders re-apply them on this one.
//                                                               stale (disk only): it is a save from an
//                                                               older copy that also replaced written
//                                                               edits; 'kept-aside' follows
//   server -> client  { type: 'saved', version }                every version up to this is on disk
//   server -> client  { type: 'kept-aside', reason: 'stale-save', name }
//                                                               a save from an older copy replaced the
//                                                               last write shortly after it; the
//                                                               editor's version was saved next to
//                                                               the file as `name` (file name only)
//   server -> client  { type: 'file-status', state, message? }  state of the file on disk: 'ok' |
//                                                               'missing' | 'invalid'; pushed on change
//                                                               and after 'init' when not 'ok'
//   client -> server  { type: 'import-failed', version, message }
//                                                               the client could not display that
//                                                               version; if it came from disk, the file
//                                                               is reported 'invalid' (nothing written)
//   server -> client  { type: 'share', state, url?, progress?, error? }
//                                                               host's sockets only: sharing status
//                                                               (see /api/share), after 'init' and on
//                                                               every change
//   presence messages ('hello', 'welcome', 'presence', 'rename', 'selection'): see src/presence.js;
//                                                               the same for host, local and
//                                                               collaborator sockets (no paths, no
//                                                               secrets in them)
//   client -> server  { type: 'ping' }                          heartbeat of the page (see
//   server -> client  { type: 'pong' }                          web/connection-shared.js)
//   close 4001 'share-stopped'                                  collaborator socket whose link was
//                                                               revoked (sharing stopped)
//   close 4002 'session-ended'                                  the host is shutting down (endSession)
//
// Keepalive: every `keepaliveMs` the server sends a WebSocket ping to every socket and terminates the
// ones that did not answer the previous ping (nor sent anything) since. This keeps idle sockets
// through the Cloudflare tunnel open (it cuts them after ~125 s idle) and drops connections that
// died without closing (they would stay in the users list otherwise).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  CLIENT_KEY_RE, CLOSE_SESSION_ENDED, CLOSE_SHARE_STOPPED, KEEPALIVE_MS,
} from '../web/connection-shared.js';
import { createFileStore } from './file.js';
import { createPresence } from './presence.js';
import {
  HOST_SECRET_HEADER, HOST_SECRET_PARAM, hostAllowed, isRemoteRequest, newHostSecret, originAllowed, safeEqual,
  splitSharePath,
} from './security.js';
import { Session, SessionError } from './session.js';
import { ShareManager } from './share.js';

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

/** How many consecutive ports to try after the requested one before letting the OS pick. */
const PORT_FALLBACK_RANGE = 20;

export const WS_PATH = '/ws';
/** WebSocket URL parameter with the page's random key (see 'init' accepted). */
const PAGE_PARAM = 'page';
/** How many pages acceptedByPage remembers. */
const MAX_PAGES = 1000;
/** Largest accepted WebSocket message; bigger ones close the connection with 1009. */
export const WS_MAX_PAYLOAD = 10 * 1024 * 1024;

/**
 * Sent with every response. no-referrer: neither the host secret (in the host's first URL) nor a
 * session token (in a collaborator's URL) may leak to another site through Referer, e.g. when the
 * bpmn.io watermark link is followed. The editor is never meant to be framed.
 */
const SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Refuses a WebSocket upgrade with a bare HTTP status. */
function rejectUpgrade(socket, status, reason) {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Serves a file below WEB_ROOT; anything resolving outside it (or missing) is a 404. */
async function serveStatic(res, urlPath, method) {
  let relPath;
  try {
    relPath = decodeURIComponent(urlPath);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (relPath.includes('\0')) return sendText(res, 404, 'Not found');
  if (relPath.endsWith('/')) relPath += 'index.html';

  const filePath = resolve(join(WEB_ROOT, relPath));
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + sep)) {
    return sendText(res, 404, 'Not found');
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!info.isFile()) return sendText(res, 404, 'Not found');

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  if (method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

/**
 * Creates the local-bpmn server for a single file.
 *
 * With the default host 'localhost' it listens on both loopback addresses (127.0.0.1 and ::1, the
 * latter if IPv6 is available) on the same port. Browsers resolve "localhost" to either, so binding
 * only one would let another program on the other address (e.g. a dev server on ::1:3000) answer
 * our URL.
 *
 * @param {object} options
 * @param {string} options.filePath  path of the .bpmn file (as given on the CLI)
 * @param {Session} [options.session]  document session; if omitted, listen() reads the file and
 *   creates one backed by a file store (exposed as `server.session` / `server.store`)
 * @param {number} [options.port=3000]  preferred port; falls back to the next free one (0 = any)
 * @param {string} [options.host='localhost']  'localhost' (both loopbacks) or a single address
 * @param {string} [options.hostSecret]  host secret (default: a new random one); see `hostUrl`
 * @param {Function} [options.createTunnelProvider]  tunnel provider factory for sharing (default:
 *   Cloudflare quick tunnel; tests pass a stand-in, see src/test-tunnel.js)
 * @param {number} [options.keepaliveMs=KEEPALIVE_MS]  WebSocket ping interval (0 = no keepalive)
 */
export function createServer({
  filePath, session = null, port = 3000, host = 'localhost', hostSecret = newHostSecret(), createTunnelProvider,
  keepaliveMs = KEEPALIVE_MS,
}) {
  const fileName = basename(filePath);
  const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const share = new ShareManager({
    getPort: () => self.port,
    ...(createTunnelProvider ? { createProvider: createTunnelProvider } : {}),
  });

  const isHostRequest = (req) => safeEqual(req.headers[HOST_SECRET_HEADER], hostSecret);
  const shareStatusCode = (status) => {
    if (status.state !== 'error') return 200;
    return status.error.code === 'TUNNEL_RATE_LIMITED' ? 429 : 502;
  };

  // Exact-match API routes: "METHOD /path" -> handler(req, res, { shared }), for every caller that may
  // reach the editor. `shared`: the request came in under /s/<token>/ (a collaborator).
  // Collaborators never see where the file lives on the host's machine (user name, directory layout):
  // they get the file name only, here, in 'init' and in error messages.
  const routes = {
    'GET /api/file': async (req, res, { shared = false } = {}) => {
      const { xml, version } = session.getState();
      sendJson(res, 200, { name: fileName, ...(shared ? {} : { path: filePath }), xml, version });
    },
  };

  // Host-only routes (local requests with the host secret). Not reachable under /s/<token>/.
  const hostRoutes = {
    'GET /api/share': async (req, res) => sendJson(res, 200, share.status()),
    'POST /api/share': async (req, res) => {
      const status = await share.start();
      sendJson(res, shareStatusCode(status), status);
    },
    'DELETE /api/share': async (req, res) => sendJson(res, 200, await share.stop()),
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  /** Per-client callbacks waiting for a 'flushed' reply (see drainClients). */
  const flushWaiters = new Map();
  /** Server-assigned id of each connection ('c1', 'c2', …), never reused while the server runs. */
  const clientIds = new WeakMap();
  /** How each connection was opened: { role: 'host' | 'local' | 'collaborator', token? }. */
  const clientAccess = new WeakMap();
  /**
   * Page key each connection gave in its URL, scoped by how it connected ('role:token|key', as for
   * presence keys): a collaborator can never claim the host's page, nor one of another link.
   */
  const clientPages = new WeakMap();
  /** Scoped page key -> { seq, version } of the newest update accepted from that page (oldest dropped first). */
  const acceptedByPage = new Map();

  /** Remembers an accepted update by page and sequence number, for that page's next 'init'. */
  function rememberAccepted(ws, seq, version) {
    const page = clientPages.get(ws);
    if (page === undefined || seq === undefined) return;
    acceptedByPage.delete(page);
    acceptedByPage.set(page, { seq, version });
    if (acceptedByPage.size > MAX_PAGES) acceptedByPage.delete(acceptedByPage.keys().next().value);
  }
  let lastClientNumber = 0;
  /** Connections that answered the last keepalive ping (or sent something) since it was sent. */
  const alive = new WeakSet();
  let keepaliveTimer = null;
  /** Connected users (names, colours); see src/presence.js for its messages. */
  const presence = createPresence({
    send,
    // A page reconnected while its old connection still looked open: that one is dead.
    onReplaced: (stale) => stale.terminate(),
  });

  /** Pings every socket; terminates those that did not answer the previous ping. */
  function keepalive() {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate(); // 'close' follows: it leaves the users list
        continue;
      }
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  /** Sends `message` to every connected client except `except` (if given). */
  function broadcast(message, except = null) {
    for (const ws of wss.clients) if (ws !== except) send(ws, message);
  }

  function sendError(ws, code, message) {
    send(ws, { type: 'error', code, message });
  }

  function handleMessage(ws, data, isBinary) {
    let message;
    try {
      if (isBinary) throw new Error('binary frame');
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return sendError(ws, 'bad-message', 'Messages must be JSON text frames');
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return sendError(ws, 'bad-message', 'Messages must be JSON objects');
    }
    if (presence.handles(message.type)) {
      const access = clientAccess.get(ws);
      return presence.handleMessage(ws, message, clientIds.get(ws), `${access.role}:${access.token ?? ''}`);
    }
    switch (message.type) {
      case 'ping':
        return send(ws, { type: 'pong' });
      case 'update': {
        const { xml, baseVersion, overrides, seq, reapplied } = message;
        if (typeof xml !== 'string' || !Number.isInteger(baseVersion) || baseVersion < 0) {
          return sendError(ws, 'bad-message', 'update needs a string "xml" and an integer "baseVersion"');
        }
        if (overrides !== undefined && !validOverrides(overrides)) {
          return sendError(ws, 'bad-message', 'update "overrides" must be a list of { id, name } strings');
        }
        if (seq !== undefined && !(Number.isInteger(seq) && seq > 0)) {
          return sendError(ws, 'bad-message', 'update "seq" must be a positive integer');
        }
        if (reapplied !== undefined && !validVersions(reapplied)) {
          return sendError(ws, 'bad-message', 'update "reapplied" must be a list of versions');
        }
        try {
          const version = session.applyUpdate(xml, baseVersion, ws, {
            ...(overrides ? { overrides } : {}), reapplied, owner: clientPages.get(ws) ?? null,
          });
          rememberAccepted(ws, seq, version);
          return send(ws, { type: 'ack', version });
        } catch (err) {
          if (err instanceof SessionError && err.code === 'conflict') {
            return send(ws, { type: 'conflict', version: err.details.version, message: err.message });
          }
          if (err instanceof SessionError) return sendError(ws, err.code, err.message);
          throw err;
        }
      }
      case 'flushed':
        flushWaiters.get(ws)?.();
        return undefined;
      case 'reapplied':
        if (!validVersions(message.versions)) {
          return sendError(ws, 'bad-message', 'reapplied needs a list of versions');
        }
        session.reapplied?.(message.versions, clientPages.get(ws) ?? null); // only its own page's versions
        return undefined;
      case 'import-failed': {
        const { version, message: text } = message;
        if (!Number.isInteger(version) || (text !== undefined && typeof text !== 'string')) {
          return sendError(ws, 'bad-message', 'import-failed needs an integer "version" and a string "message"');
        }
        session.reportUnreadable(version, String(text ?? 'unknown error').slice(0, 500));
        return undefined;
      }
      default:
        return sendError(ws, 'bad-message', `Unknown message type: ${JSON.stringify(message.type)}`);
    }
  }

  wss.on('connection', (ws, req, access = { role: 'local' }) => {
    clientAccess.set(ws, access);
    let page = null;
    try {
      page = new URL(req.url, 'http://localhost').searchParams.get(PAGE_PARAM);
    } catch {
      // no page key
    }
    if (page !== null && CLIENT_KEY_RE.test(page)) clientPages.set(ws, `${access.role}:${access.token ?? ''}|${page}`);
    // Without a listener, protocol errors (e.g. an oversize frame -> close 1009) would crash the process.
    ws.on('error', () => {});
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('message', (data, isBinary) => {
      alive.add(ws);
      try {
        handleMessage(ws, data, isBinary);
      } catch (err) {
        process.stderr.write(`local-bpmn: error handling message: ${err.message}\n`);
        sendError(ws, 'internal', 'Internal server error');
      }
    });
    ws.on('close', () => {
      flushWaiters.get(ws)?.();
      // Its accepted edits not on disk yet can no longer be re-applied through this connection (Q2).
      session.originGone?.(ws);
    });
    ws.on('close', () => presence.leave(ws));
    lastClientNumber += 1;
    const clientId = `c${lastClientNumber}`;
    clientIds.set(ws, clientId);
    const { xml, version } = session.getState();
    const shared = access.role === 'collaborator';
    send(ws, {
      type: 'init', xml, version, name: fileName, ...(shared ? {} : { path: filePath }), clientId, role: access.role,
      ...session.syncState(),
      accepted: acceptedByPage.get(clientPages.get(ws)) ?? null,
    });
    const diskStatus = session.diskStatus;
    if (diskStatus.state !== 'ok') send(ws, { type: 'file-status', ...diskStatus });
    if (access.role === 'host') send(ws, { type: 'share', ...share.status() });
  });

  /** Host / Origin check shared by HTTP and WebSocket: null if fine, else [status, reason]. */
  function checkHostAndOrigin(req) {
    const allowed = { port: self.port, tunnelHost: share.tunnelHost };
    if (!hostAllowed(req.headers.host, allowed)) return [421, 'Misdirected Request'];
    if (!originAllowed(req.headers.origin, allowed)) return [403, 'Forbidden'];
    return null;
  }

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const refused = checkHostAndOrigin(req);
    if (refused) return rejectUpgrade(socket, ...refused);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = null;
    }
    let access = null;
    if (url && !closing) {
      const { token, rest } = splitSharePath(url.pathname);
      if (token !== null) {
        if (rest === WS_PATH && share.isValidToken(token)) access = { role: 'collaborator', token };
      } else if (url.pathname === WS_PATH && !isRemoteRequest(req.headers)) {
        const secret = url.searchParams.get(HOST_SECRET_PARAM);
        access = { role: safeEqual(secret, hostSecret) ? 'host' : 'local' };
      }
    }
    if (!access) return rejectUpgrade(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, access));
  }

  share.on('status', (status) => {
    for (const ws of wss.clients) if (clientAccess.get(ws)?.role === 'host') send(ws, { type: 'share', ...status });
  });
  share.on('revoked', (token) => {
    for (const ws of wss.clients) {
      if (clientAccess.get(ws)?.token === token) ws.close(CLOSE_SHARE_STOPPED, 'share-stopped');
    }
  });

  function onWriteError(err) {
    // The message names the absolute path (and fs errors their temp file): host and local windows only.
    const forCollaborators = `Could not save ${fileName} on the host's machine${err.code ? ` (${err.code})` : ''}`;
    for (const ws of wss.clients) {
      const shared = clientAccess.get(ws)?.role === 'collaborator';
      send(ws, { type: 'error', code: 'write-failed', message: shared ? forCollaborators : err.message });
    }
  }

  /**
   * Pushes an accepted change to the clients that do not have it yet: a change on disk to everyone,
   * a client's edit to everyone else (the sender only gets its 'ack').
   */
  function onChange({ xml, version, origin, overrides, discardedAfter, stale }) {
    if (origin === 'disk') {
      return broadcast({
        type: 'remote-update', xml, version, origin,
        ...(discardedAfter !== undefined ? { discardedAfter } : {}), ...(stale ? { stale: true } : {}),
      });
    }
    const sender = clientIds.has(origin) ? origin : null;
    const originId = sender ? clientIds.get(sender) : String(origin ?? 'host');
    const message = { type: 'remote-update', xml, version, origin: originId };
    if (overrides) message.overrides = overrides;
    return broadcast(message, sender);
  }

  function onDiskStatus(status) {
    broadcast({ type: 'file-status', ...status });
  }

  function onSaved({ version }) {
    broadcast({ type: 'saved', version });
  }

  function onStaleSave({ name }) {
    broadcast({ type: 'kept-aside', reason: 'stale-save', name }); // the file name only, no path
  }

  function attachSession(newSession) {
    session = newSession;
    session.on('write-error', onWriteError);
    session.on('change', onChange);
    session.on('disk-status', onDiskStatus);
    session.on('saved', onSaved);
    session.on('stale-save', onStaleSave);
  }
  if (session) attachSession(session);
  let ownStore = null; // store created by listen() (watched by us, unwatched on close)

  let closing = false;
  let closePromises = null;

  async function handleRequest(req, res) {
    const refused = checkHostAndOrigin(req);
    if (refused) return sendText(res, refused[0], refused[0] === 421 ? 'Unknown host' : 'Forbidden origin');
    const { pathname, search } = new URL(req.url, 'http://localhost');
    const { token, rest } = splitSharePath(pathname);

    if (token !== null) {
      // A collaborator's link (also usable locally). Same 404 for every way of being wrong.
      if (!share.isValidToken(token)) return sendText(res, 404, 'Not found');
      if (rest === null) {
        res.writeHead(302, { ...SECURITY_HEADERS, Location: `/s/${token}/${search}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const route = routes[`${req.method} ${rest}`];
      if (route) return route(req, res, { shared: true });
      if (rest.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
      return serveStatic(res, rest, req.method);
    }

    // Through the tunnel, only /s/<token>/ exists.
    if (isRemoteRequest(req.headers)) return sendText(res, 404, 'Not found');

    const hostRoute = hostRoutes[`${req.method} ${pathname}`];
    if (hostRoute) {
      if (!isHostRequest(req)) return sendJson(res, 403, { error: 'Only the host can do this' });
      return hostRoute(req, res);
    }
    const route = routes[`${req.method} ${pathname}`];
    if (route) return route(req, res);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    return serveStatic(res, pathname, req.method);
  }

  function onRequest(req, res) {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) sendText(res, 500, 'Internal server error');
      else res.destroy(err);
    });
  }

  // One http.Server per bound address; all share the request and WebSocket upgrade handlers.
  let httpServers = [];

  /** Binds every address on `candidate`; resolves to the port, or rejects (closing partial binds). */
  async function bindAll(candidate) {
    const bound = [];
    let actualPort = candidate;
    try {
      for (const address of addresses) {
        const server = http.createServer(onRequest);
        server.on('upgrade', onUpgrade);
        try {
          await listenOnce(server, actualPort, address);
        } catch (err) {
          // No IPv6 on this machine: serve IPv4 only.
          if (address === '::1' && bound.length && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)) break;
          throw err;
        }
        bound.push(server);
        actualPort = server.address().port; // port 0 -> reuse the OS-chosen port for the next address
      }
      if (host === 'localhost' && await wildcardListenerOn(actualPort)) {
        throw Object.assign(new Error(`port ${actualPort} is in use (another program listens on all addresses)`), { code: 'EADDRINUSE' });
      }
    } catch (err) {
      await Promise.all(bound.map((s) => new Promise((r) => s.close(r))));
      throw err;
    }
    httpServers = bound;
    return actualPort;
  }

  const self = {
    /** Underlying http.Server instances (one per listening address). */
    get httpServers() { return httpServers; },
    routes,
    /** The WebSocketServer (noServer mode) handling /ws on every bound address. */
    wss,
    get session() { return session; },
    get store() { return session?.store ?? null; },
    /** Sharing state (tunnel + session token). */
    share,
    /** The host secret; only ever part of `hostUrl`. */
    hostSecret,
    requestedPort: port,
    port: undefined,
    /** Base URL (no host powers). */
    url: undefined,
    /** URL the host opens: base URL with the host secret. */
    hostUrl: undefined,

    /** Starts listening; resolves to the actual port (may differ from the requested one). */
    async listen() {
      if (!session) {
        const store = createFileStore(filePath);
        attachSession(new Session({ xml: await store.read(), store }));
        ownStore = store;
        await store.watch();
      }
      const candidates = [];
      if (port !== 0) {
        for (let p = port; p <= Math.min(port + PORT_FALLBACK_RANGE, 65535); p++) candidates.push(p);
      }
      // Last resort: let the OS pick (retried, since the second address may clash).
      candidates.push(0, 0, 0);
      for (const candidate of candidates) {
        try {
          self.port = await bindAll(candidate);
          self.url = `http://localhost:${self.port}/`;
          self.hostUrl = `${self.url}?${HOST_SECRET_PARAM}=${hostSecret}`;
          if (keepaliveMs > 0) {
            keepaliveTimer = setInterval(keepalive, keepaliveMs);
            keepaliveTimer.unref();
          }
          return self.port;
        } catch (err) {
          if (err.code !== 'EADDRINUSE') throw err;
        }
      }
      throw new Error(`No free port found starting at ${port}`);
    },

    /** Stops accepting new connections and WebSockets; open ones keep working until close(). */
    stopAccepting() {
      closing = true;
      closePromises ??= httpServers.map((server) => new Promise((resolveClose) => {
        if (!server.listening) return resolveClose();
        server.close(() => resolveClose());
      }));
    },

    /**
     * Asks every connected client to send its pending edits now ('flush') and waits until each has
     * answered 'flushed', disconnected, or `timeoutMs` elapsed.
     */
    async drainClients(timeoutMs = 1000) {
      const waits = [...wss.clients].filter((ws) => ws.readyState === ws.OPEN).map((ws) => new Promise((done) => {
        flushWaiters.set(ws, done);
        send(ws, { type: 'flush' });
      }));
      if (!waits.length) return;
      let timer;
      await Promise.race([
        Promise.all(waits),
        new Promise((done) => { timer = setTimeout(done, timeoutMs); }),
      ]);
      clearTimeout(timer);
      flushWaiters.clear();
    },

    /**
     * Tells every connected page that the session is over (close 4002 'session-ended', shown as
     * "Session ended"; the page does not reconnect) and waits until they have closed, at most
     * `timeoutMs`; the rest are terminated. Stops accepting new connections first. Call it before
     * stopping the share, which would otherwise close collaborators with 4001 first.
     */
    async endSession(timeoutMs = 1000) {
      self.stopAccepting();
      const open = [...wss.clients];
      if (!open.length) return;
      let timer;
      await Promise.race([
        Promise.all(open.map((ws) => new Promise((done) => {
          if (ws.readyState === ws.CLOSED) return done();
          ws.once('close', done);
          try {
            ws.close(CLOSE_SESSION_ENDED, 'session-ended');
          } catch {
            ws.terminate();
          }
        }))),
        new Promise((done) => { timer = setTimeout(done, timeoutMs); }),
      ]);
      clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
    },

    /** Stops accepting connections, ends the session for WebSocket clients and closes open connections. */
    async close() {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      await self.endSession(500);
      await share.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolveClose) => wss.close(() => resolveClose()));
      for (const server of httpServers) server.closeAllConnections();
      await Promise.all(closePromises);
      session?.off('write-error', onWriteError);
      session?.off('change', onChange);
      session?.off('disk-status', onDiskStatus);
      session?.off('saved', onSaved);
      session?.off('stale-save', onStaleSave);
      await ownStore?.unwatch();
    },
  };
  return self;
}

/** `overrides` of an update: at most 1000 { id, name, kind? } (strings; kind only 'connection'). */
function validVersions(versions) {
  return Array.isArray(versions) && versions.length <= 10_000 && versions.every((v) => Number.isInteger(v) && v > 0);
}

function validOverrides(overrides) {
  return Array.isArray(overrides) && overrides.length <= 1000 && overrides.every((o) => o !== null
    && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string'
    && o.id.length <= 1000 && o.name.length <= 1000 && (o.kind === undefined || o.kind === 'connection'));
}

/**
 * True if another program listens on `port` on a wildcard address (0.0.0.0 or ::). On macOS our
 * loopback binds still succeed next to such a listener (they win for loopback connections), but the
 * port is visibly taken: the other program answers on every other address, and on Linux the same
 * binds would fail. Probed by trying to bind the wildcard addresses ourselves, which fails exactly
 * when someone else holds them (our own loopback binds do not block it).
 */
export async function wildcardListenerOn(port) {
  for (const options of [{ host: '0.0.0.0' }, { host: '::', ipv6Only: true }]) {
    const probe = net.createServer();
    try {
      await new Promise((resolveProbe, reject) => {
        probe.once('error', reject);
        probe.listen({ port, ...options, exclusive: true }, resolveProbe);
      });
    } catch (err) {
      if (err.code === 'EADDRINUSE') return true;
      // No IPv6 (EAFNOSUPPORT / EADDRNOTAVAIL) or no permission: nothing to detect there.
    } finally {
      await new Promise((resolveClose) => (probe.listening ? probe.close(() => resolveClose()) : resolveClose()));
    }
  }
  return false;
}

function listenOnce(server, port, host) {
  return new Promise((resolveListen, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
