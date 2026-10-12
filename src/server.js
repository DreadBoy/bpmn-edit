// HTTP + WebSocket server: serves the editor shell from web/, the document via /api/file, and the
// sync protocol on /ws. Host secret and share routes are added in later steps.
//
// WebSocket protocol (JSON text frames, each with a `type`):
//   server -> client  { type: 'init', xml, version, name, path } on connect
//   client -> server  { type: 'update', xml, baseVersion }      full XML after an edit
//   server -> client  { type: 'ack', version }                  update accepted
//   server -> client  { type: 'error', code, message }          code: 'bad-message' | 'invalid-xml' |
//                                                               'write-failed' (pushed) | 'internal'
//   server -> client  { type: 'flush' }                         shutting down: send pending edits now
//   client -> server  { type: 'flushed' }                       nothing pending any more
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createFileStore } from './file.js';
import { Session, SessionError } from './session.js';

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
/** Largest accepted WebSocket message; bigger ones close the connection with 1009. */
export const WS_MAX_PAYLOAD = 10 * 1024 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
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
 */
export function createServer({ filePath, session = null, port = 3000, host = 'localhost' }) {
  const fileName = basename(filePath);
  const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];

  // Exact-match API routes: "METHOD /path" -> handler. Everything else falls through to static files.
  const routes = {
    'GET /api/file': async (req, res) => {
      const { xml, version } = session.getState();
      sendJson(res, 200, { name: fileName, path: filePath, xml, version });
    },
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  /** Per-client callbacks waiting for a 'flushed' reply (see drainClients). */
  const flushWaiters = new Map();

  function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcast(message) {
    for (const ws of wss.clients) send(ws, message);
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
    switch (message.type) {
      case 'update': {
        const { xml, baseVersion } = message;
        if (typeof xml !== 'string' || !Number.isInteger(baseVersion) || baseVersion < 0) {
          return sendError(ws, 'bad-message', 'update needs a string "xml" and an integer "baseVersion"');
        }
        try {
          const version = session.applyUpdate(xml, baseVersion, ws);
          return send(ws, { type: 'ack', version });
        } catch (err) {
          if (err instanceof SessionError) return sendError(ws, err.code, err.message);
          throw err;
        }
      }
      case 'flushed':
        flushWaiters.get(ws)?.();
        return undefined;
      default:
        return sendError(ws, 'bad-message', `Unknown message type: ${JSON.stringify(message.type)}`);
    }
  }

  wss.on('connection', (ws) => {
    // Without a listener, protocol errors (e.g. an oversize frame -> close 1009) would crash the process.
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      try {
        handleMessage(ws, data, isBinary);
      } catch (err) {
        process.stderr.write(`local-bpmn: error handling message: ${err.message}\n`);
        sendError(ws, 'internal', 'Internal server error');
      }
    });
    ws.on('close', () => flushWaiters.get(ws)?.());
    const { xml, version } = session.getState();
    send(ws, { type: 'init', xml, version, name: fileName, path: filePath });
  });

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      pathname = null;
    }
    if (pathname !== WS_PATH || closing) {
      socket.once('finish', () => socket.destroy());
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  function onWriteError(err) {
    broadcast({ type: 'error', code: 'write-failed', message: err.message });
  }

  function attachSession(newSession) {
    session = newSession;
    session.on('write-error', onWriteError);
  }
  if (session) attachSession(session);

  let closing = false;
  let closePromises = null;

  async function handleRequest(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
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
    requestedPort: port,
    port: undefined,
    url: undefined,

    /** Starts listening; resolves to the actual port (may differ from the requested one). */
    async listen() {
      if (!session) {
        const store = createFileStore(filePath);
        attachSession(new Session({ xml: await store.read(), store }));
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

    /** Stops accepting connections, disconnects WebSocket clients and closes open connections. */
    async close() {
      self.stopAccepting();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolveClose) => wss.close(() => resolveClose()));
      for (const server of httpServers) server.closeAllConnections();
      await Promise.all(closePromises);
      session?.off('write-error', onWriteError);
    },
  };
  return self;
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
