// HTTP server: serves the editor shell from web/ and the edited file via /api/file.
// WebSocket upgrades, host secret and share routes are added in later steps.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBpmnFile } from './file.js';

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
 * @param {number} [options.port=3000]  preferred port; falls back to the next free one (0 = any)
 * @param {string} [options.host='localhost']  'localhost' (both loopbacks) or a single address
 */
export function createServer({ filePath, port = 3000, host = 'localhost' }) {
  const fileName = basename(filePath);
  const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];

  // Exact-match API routes: "METHOD /path" -> handler. Everything else falls through to static files.
  const routes = {
    'GET /api/file': async (req, res) => {
      try {
        const xml = await readBpmnFile(filePath);
        sendJson(res, 200, { name: fileName, path: filePath, xml });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  };

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

  // One http.Server per bound address; all share the same request handler. Later steps attach
  // further listeners (e.g. 'upgrade' for WebSockets) to every entry of `httpServers`.
  let httpServers = [];

  /** Binds every address on `candidate`; resolves to the port, or rejects (closing partial binds). */
  async function bindAll(candidate) {
    const bound = [];
    let actualPort = candidate;
    try {
      for (const address of addresses) {
        const server = http.createServer(onRequest);
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
    requestedPort: port,
    port: undefined,
    url: undefined,

    /** Starts listening; resolves to the actual port (may differ from the requested one). */
    async listen() {
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

    /** Stops accepting connections and closes open ones. */
    async close() {
      await Promise.all(
        httpServers.map((server) => new Promise((resolveClose) => {
          if (!server.listening) return resolveClose();
          server.close(() => resolveClose());
          server.closeAllConnections();
        })),
      );
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
