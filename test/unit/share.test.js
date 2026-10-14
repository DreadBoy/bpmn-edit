// Share routes and the security model on a real server, with stand-in tunnel providers (no network).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createServer, wildcardListenerOn } from '../../src/server.js';
import { describeProgress, ShareManager } from '../../src/share.js';
import { testProviderFactory } from '../../src/test-tunnel.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;

/** Raw request (Host and other headers exactly as given). Resolves to { status, headers, body }. */
function request(port, path, { method = 'GET', headers = {}, address = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const json = (res) => JSON.parse(res.body);

/** A token that differs from `token` in its last character only (never equal to it). */
function otherToken(token) {
  const other = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.notEqual(other, token);
  return other;
}

/** Opens a WebSocket; resolves to { ws, messages, closed } once open, or rejects with the HTTP status. */
function openSocket(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { host: `localhost:${port}`, ...headers } });
    const messages = [];
    const closed = new Promise((done) => ws.once('close', (code, reason) => done({ code, reason: String(reason) })));
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, messages, closed }));
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('share routes and security model', () => {
  let server;
  let port;
  let host; // headers making a request a host request
  const remote = (extra = {}) => ({ 'cf-ray': '8a1b2c3d4e5f-LJU', 'cf-connecting-ip': '203.0.113.9', ...extra });

  before(async () => {
    server = createServer({ filePath: FIXTURE, port: 0, createTunnelProvider: testProviderFactory('fake', { delayMs: 30 }) });
    port = await server.listen();
    host = { 'x-bpmn-edit-host': server.hostSecret };
  });
  after(() => server.close());
  afterEach(() => server.share.stop());

  async function startSharing() {
    const res = await request(port, '/api/share', { method: 'POST', headers: host });
    assert.equal(res.status, 200, res.body);
    const status = json(res);
    const url = new URL(status.url);
    return { ...status, tunnelHost: url.host, path: url.pathname, token: url.pathname.split('/')[2] };
  }

  it('hostUrl carries the host secret; url does not', () => {
    assert.equal(server.hostUrl, `http://localhost:${port}/?host=${server.hostSecret}`);
    assert.match(server.hostSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(server.url.includes(server.hostSecret), false);
  });

  it('host-only endpoints need the host secret (403 without, or with a wrong one)', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal((await request(port, '/api/share', { method })).status, 403, method);
      assert.equal((await request(port, '/api/share', { method, headers: { 'x-bpmn-edit-host': 'wrong' } })).status, 403, method);
    }
    // ?host= in the URL is not how host-only HTTP calls authenticate.
    assert.equal((await request(port, `/api/share?host=${server.hostSecret}`, { method: 'POST' })).status, 403);
    assert.equal(server.share.state, 'idle');
    const res = await request(port, '/api/share', { headers: host });
    assert.equal(res.status, 200);
    assert.deepEqual(json(res), { state: 'idle' });
  });

  it('POST starts sharing: public URL https://<tunnel>/s/<token>, token >= 128 bit; DELETE stops', async () => {
    const shared = await startSharing();
    assert.equal(shared.state, 'active');
    assert.match(shared.url, /^https:\/\/test-[0-9a-f]+\.trycloudflare\.com\/s\/[A-Za-z0-9_-]{32}$/);
    assert.ok(Buffer.from(shared.token, 'base64url').length * 8 >= 128);
    assert.equal(json(await request(port, '/api/share', { headers: host })).url, shared.url);
    // A second POST while active returns the same link.
    assert.equal(json(await request(port, '/api/share', { method: 'POST', headers: host })).url, shared.url);

    const res = await request(port, '/api/share', { method: 'DELETE', headers: host });
    assert.equal(res.status, 200);
    assert.deepEqual(json(res), { state: 'idle' });
    assert.equal((await request(port, `${shared.path}/`)).status, 404);
  });

  it('remote requests: only /s/<token>/ works; everything else 404, even with the host secret', async () => {
    const shared = await startSharing();
    const h = (extra) => remote({ host: shared.tunnelHost, ...extra });
    // the collaborator page, its assets and its API
    const page = await request(port, `${shared.path}/`, { headers: h() });
    assert.equal(page.status, 200);
    assert.match(page.body, /id="canvas"/);
    assert.equal((await request(port, `${shared.path}/app.js`, { headers: h() })).status, 200);
    assert.equal((await request(port, `${shared.path}/vendor/bpmn-js/bpmn-modeler.production.min.js`, { headers: h() })).status, 200);
    const file = await request(port, `${shared.path}/api/file`, { headers: h() });
    assert.equal(file.status, 200);
    assert.equal(json(file).name, 'order.bpmn');
    // without the trailing slash: redirect into the share
    const redirect = await request(port, shared.path, { headers: h() });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, `${shared.path}/`);

    const notFound = [
      ['GET', '/'], ['GET', '/index.html'], ['GET', '/app.js'], ['GET', '/api/file'],
      ['GET', '/api/share'], ['POST', '/api/share'], ['DELETE', '/api/share'],
      ['POST', `${shared.path}/api/share`], ['GET', `${shared.path}/api/share`], ['DELETE', `${shared.path}/api/share`],
      ['GET', `/s/${'A'.repeat(32)}/`], ['GET', `/s/${'A'.repeat(32)}`], ['GET', `/s/${otherToken(shared.token)}/`],
      ['GET', '/s/'], ['GET', '/s/x/'], ['GET', '/nope'], ['GET', `${shared.path}/../api/file`],
    ];
    for (const [method, path] of notFound) {
      const res = await request(port, path, { method, headers: h({ 'x-bpmn-edit-host': server.hostSecret }) });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    // Same with each Cloudflare header alone.
    assert.equal((await request(port, '/', { headers: { host: shared.tunnelHost, 'cf-ray': 'x' } })).status, 404);
    assert.equal((await request(port, '/', { headers: { host: shared.tunnelHost, 'cf-connecting-ip': '203.0.113.9' } })).status, 404);
    assert.equal((await request(port, '/api/share', { method: 'POST', headers: { 'cf-ray': 'x', ...host } })).status, 404);
    assert.equal(server.share.state, 'active');
  });

  it('remote requests 404 while nothing is shared', async () => {
    assert.equal((await request(port, '/', { headers: remote() })).status, 404);
    assert.equal((await request(port, `/s/${'A'.repeat(32)}/`, { headers: remote() })).status, 404);
  });

  it('Host check: unknown hosts get 421 (HTTP); the tunnel host only while it exists', async () => {
    for (const hostHeader of ['evil.example', `evil.example:${port}`, 'localhost', `localhost:${port + 1}`, 'test-00000000.trycloudflare.com']) {
      const res = await request(port, '/api/file', { headers: { host: hostHeader } });
      assert.equal(res.status, 421, hostHeader);
    }
    for (const hostHeader of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      assert.equal((await request(port, '/api/file', { headers: { host: hostHeader } })).status, 200, hostHeader);
    }
    const shared = await startSharing();
    assert.equal((await request(port, `${shared.path}/api/file`, { headers: { host: shared.tunnelHost } })).status, 200);
    await server.share.stop();
    assert.equal((await request(port, '/api/file', { headers: { host: shared.tunnelHost } })).status, 421);
  });

  it('Origin check: other sites get 403, also with the host secret', async () => {
    for (const origin of ['https://evil.example', 'null', `http://localhost:${port + 1}`]) {
      assert.equal((await request(port, '/api/file', { headers: { origin } })).status, 403, origin);
      assert.equal((await request(port, '/api/share', { method: 'POST', headers: { origin, ...host } })).status, 403, origin);
    }
    assert.equal(server.share.state, 'idle');
    assert.equal((await request(port, '/api/file', { headers: { origin: `http://localhost:${port}` } })).status, 200);
  });

  it('responses never send a Referer to other sites and refuse framing', async () => {
    const res = await request(port, '/');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(res.body, /<meta name="referrer" content="no-referrer">/);
  });

  it('WebSocket: Host and Origin are checked; remote /ws is 404; the host socket gets share status', async () => {
    await assert.rejects(openSocket(port, '/ws', { host: 'evil.example' }), { status: 421 });
    await assert.rejects(openSocket(port, '/ws', { origin: 'https://evil.example' }), { status: 403 });
    await assert.rejects(openSocket(port, '/ws', remote()), { status: 404 });
    await assert.rejects(openSocket(port, `/ws?host=${server.hostSecret}`, remote()), { status: 404 });

    const plain = await openSocket(port, '/ws');
    const wrong = await openSocket(port, '/ws?host=wrong');
    const hostSocket = await openSocket(port, `/ws?host=${server.hostSecret}`, { origin: `http://localhost:${port}` });
    await waitFor(() => hostSocket.messages.some((m) => m.type === 'share'));
    assert.deepEqual(hostSocket.messages.find((m) => m.type === 'share'), { type: 'share', state: 'idle' });

    await startSharing();
    await waitFor(() => hostSocket.messages.some((m) => m.type === 'share' && m.state === 'active'));
    const states = hostSocket.messages.filter((m) => m.type === 'share').map((m) => m.state);
    assert.deepEqual([...new Set(states)], ['idle', 'starting', 'active']);
    assert.ok(hostSocket.messages.some((m) => m.type === 'share' && m.progress === 'Downloading cloudflared… 50%'));
    // Others never learn anything about sharing (or the secret).
    for (const other of [plain, wrong]) {
      assert.deepEqual(other.messages.map((m) => m.type), ['init']);
      assert.equal(JSON.stringify(other.messages).includes(server.hostSecret), false);
    }
    for (const s of [plain, wrong, hostSocket]) s.ws.close();
  });

  it('WebSocket under /s/<token>/ws: works remotely with the token; stopping disconnects it (4001), not the host', async () => {
    const shared = await startSharing();
    const h = remote({ host: shared.tunnelHost, origin: `https://${shared.tunnelHost}` });
    await assert.rejects(openSocket(port, `/s/${'A'.repeat(32)}/ws`, h), { status: 404 });
    await assert.rejects(openSocket(port, `${shared.path}/ws`, { ...h, origin: 'https://evil.example' }), { status: 403 });
    await assert.rejects(openSocket(port, `${shared.path}/ws`, { ...h, host: 'evil.example' }), { status: 421 });

    const collaborator = await openSocket(port, `${shared.path}/ws?host=${server.hostSecret}`, h);
    await waitFor(() => collaborator.messages.length > 0);
    assert.equal(collaborator.messages[0].type, 'init');
    assert.equal(collaborator.messages[0].name, 'order.bpmn');
    const hostSocket = await openSocket(port, `/ws?host=${server.hostSecret}`);

    await request(port, '/api/share', { method: 'DELETE', headers: host });
    const closed = await collaborator.closed;
    assert.deepEqual(closed, { code: 4001, reason: 'share-stopped' });
    // No host powers for the collaborator even though it sent the secret.
    assert.equal(collaborator.messages.some((m) => m.type === 'share'), false);
    assert.equal(hostSocket.ws.readyState, WebSocket.OPEN);
    // The tunnel hostname is unknown again (421); locally the old token is simply gone (404).
    await assert.rejects(openSocket(port, `${shared.path}/ws`, h), { status: 421 });
    await assert.rejects(openSocket(port, `${shared.path}/ws`), { status: 404 });
    hostSocket.ws.close();

    // A new share has a new token; the old one stays dead.
    const again = await startSharing();
    assert.notEqual(again.token, shared.token);
    assert.equal((await request(port, `${shared.path}/`, { headers: remote({ host: again.tunnelHost }) })).status, 404);
    assert.equal((await request(port, `${again.path}/`, { headers: remote({ host: again.tunnelHost }) })).status, 200);
  });
  it('collaborators never get the host\'s absolute file path (init, api/file, write errors)', async () => {
    const shared = await startSharing();
    const h = remote({ host: shared.tunnelHost });
    const collaborator = await openSocket(port, `${shared.path}/ws`, h);
    const localCollaborator = await openSocket(port, `${shared.path}/ws`); // the link opened on the host's machine
    const hostSocket = await openSocket(port, `/ws?host=${server.hostSecret}`);
    const plain = await openSocket(port, '/ws');
    const all = [collaborator, localCollaborator, hostSocket, plain];
    await waitFor(() => all.every((c) => c.messages.some((m) => m.type === 'init')));
    const init = (c) => c.messages.find((m) => m.type === 'init');
    for (const c of [collaborator, localCollaborator]) {
      assert.equal(init(c).name, 'order.bpmn');
      assert.equal('path' in init(c), false);
    }
    assert.equal(init(hostSocket).path, FIXTURE);
    assert.equal(init(plain).path, FIXTURE);

    const file = json(await request(port, `${shared.path}/api/file`, { headers: h }));
    assert.equal(file.name, 'order.bpmn');
    assert.equal('path' in file, false);
    assert.equal(json(await request(port, '/api/file')).path, FIXTURE);

    const failure = Object.assign(new Error(`Could not write ${FIXTURE}: EACCES: permission denied, open '${FIXTURE}.tmp'`), { code: 'EACCES' });
    server.session.emit('write-error', failure);
    await waitFor(() => all.every((c) => c.messages.some((m) => m.type === 'error')));
    const error = (c) => c.messages.find((m) => m.type === 'error');
    for (const c of [collaborator, localCollaborator]) {
      assert.deepEqual(error(c), { type: 'error', code: 'write-failed', message: 'Could not save order.bpmn on the host\'s machine (EACCES)' });
    }
    assert.equal(error(hostSocket).message, failure.message);
    assert.equal(error(plain).message, failure.message);
    // Nothing a collaborator received mentions the directory.
    const dir = FIXTURE.slice(0, FIXTURE.lastIndexOf('/'));
    for (const c of [collaborator, localCollaborator]) assert.equal(JSON.stringify(c.messages).includes(dir), false);
    for (const c of all) c.ws.close();
  });
});

describe('share errors', () => {
  it('rate limit: 429 with TUNNEL_RATE_LIMITED and a readable message; Share can be retried', async () => {
    const server = createServer({ filePath: FIXTURE, port: 0, createTunnelProvider: testProviderFactory('rate-limited-once', { delayMs: 0 }) });
    const port = await server.listen();
    const host = { 'x-bpmn-edit-host': server.hostSecret };
    try {
      const res = await request(port, '/api/share', { method: 'POST', headers: host });
      assert.equal(res.status, 429);
      const body = json(res);
      assert.equal(body.state, 'error');
      assert.equal(body.error.code, 'TUNNEL_RATE_LIMITED');
      assert.match(body.error.message, /limiting new quick tunnels.*try Share again/i);
      assert.deepEqual(json(await request(port, '/api/share', { headers: host })), body);
      const retry = await request(port, '/api/share', { method: 'POST', headers: host });
      assert.equal(retry.status, 200);
      assert.equal(json(retry).state, 'active');
    } finally {
      await server.close();
    }
  });

  it('other failures: 502 TUNNEL_FAILED with the first line of the error only', async () => {
    const server = createServer({ filePath: FIXTURE, port: 0, createTunnelProvider: testProviderFactory('fail', { delayMs: 0 }) });
    const port = await server.listen();
    try {
      const res = await request(port, '/api/share', { method: 'POST', headers: { 'x-bpmn-edit-host': server.hostSecret } });
      assert.equal(res.status, 502);
      assert.deepEqual(json(res).error, { code: 'TUNNEL_FAILED', message: 'Could not start the public tunnel: cloudflared exited early (code 1).' });
    } finally {
      await server.close();
    }
  });
});

describe('ShareManager', () => {
  const quiet = () => {};

  /** Provider whose start() waits for release(); its tunnel records stop() and can "crash". */
  function controllableProvider() {
    const state = { stops: 0, starts: 0, release: null, process: new EventEmitter() };
    const factory = ({ onProgress }) => ({
      name: 'controllable',
      async start() {
        state.starts += 1;
        onProgress({ phase: 'url', url: 'https://slow-tunnel.trycloudflare.com' });
        await new Promise((resolve) => { state.release = resolve; });
        return { url: 'https://slow-tunnel.trycloudflare.com', stop: async () => { state.stops += 1; }, process: state.process };
      },
    });
    return { state, factory };
  }

  it('stop() while starting cancels at once; the tunnel is closed as soon as it comes up', async () => {
    const { state, factory } = controllableProvider();
    const share = new ShareManager({ getPort: () => 1234, createProvider: factory, log: quiet });
    const starting = share.start();
    await waitFor(() => state.release);
    assert.equal(share.state, 'starting');
    assert.equal(share.tunnelHost, 'slow-tunnel.trycloudflare.com');
    assert.deepEqual(await share.stop(), { state: 'idle' });
    assert.equal(share.tunnelHost, null);
    state.release();
    assert.deepEqual(await starting, { state: 'idle' });
    assert.equal(state.stops, 1);
    assert.equal(share.state, 'idle');
  });

  it('concurrent start() calls share one tunnel', async () => {
    const { state, factory } = controllableProvider();
    const share = new ShareManager({ getPort: () => 1234, createProvider: factory, log: quiet });
    const a = share.start();
    const b = share.start();
    await waitFor(() => state.release);
    state.release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(state.starts, 1);
    assert.equal(ra.url, rb.url);
    await share.stop();
    assert.equal(state.stops, 1);
  });

  it('an unexpected tunnel exit revokes the token and reports an error', async () => {
    const { state, factory } = controllableProvider();
    const share = new ShareManager({ getPort: () => 1234, createProvider: factory, log: quiet });
    const revoked = [];
    share.on('revoked', (t) => revoked.push(t));
    const starting = share.start();
    await waitFor(() => state.release);
    state.release();
    const { url } = await starting;
    const token = new URL(url).pathname.split('/')[2];
    assert.equal(share.isValidToken(token), true);
    assert.equal(share.isValidToken(otherToken(token)), false);
    state.process.emit('exit', 1, null);
    assert.equal(share.isValidToken(token), false);
    assert.deepEqual(revoked, [token]);
    assert.equal(share.status().state, 'error');
    assert.equal(share.status().error.code, 'TUNNEL_EXITED');
    assert.equal(share.tunnelHost, null);
  });

  it('describes progress for the spinner', () => {
    assert.equal(describeProgress({ phase: 'download', received: 5, total: 10 }), 'Downloading cloudflared… 50%');
    assert.equal(describeProgress({ phase: 'download', received: 3 * 1024 * 1024, total: null }), 'Downloading cloudflared… 3.0 MB');
    assert.equal(describeProgress({ phase: 'spawn' }), 'Starting tunnel…');
    assert.equal(describeProgress({ phase: 'url' }), 'Waiting for the public link to come online…');
  });
});

describe('port fallback with a wildcard listener in another process', () => {
  const children = [];
  after(() => { for (const c of children) c.kill('SIGKILL'); });

  /** Starts a separate process listening on `address` (port 0); resolves to { port, child }. */
  async function foreignListener(address) {
    const child = spawn(process.execPath, ['-e', `
      const s = require('node:net').createServer();
      s.listen(0, ${JSON.stringify(address)}, () => console.log(s.address().port));
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    const port = Number(await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d)))));
    return { port, child };
  }

  for (const address of ['0.0.0.0', '::']) {
    it(`detects *:${address === '::' ? '[::]' : address} and uses another port`, async () => {
      const { port: busy, child } = await foreignListener(address);
      assert.equal(await wildcardListenerOn(busy), true);
      const server = createServer({ filePath: FIXTURE, port: busy });
      try {
        const port = await server.listen();
        assert.notEqual(port, busy);
        assert.equal((await request(port, '/api/file')).status, 200);
      } finally {
        await server.close();
        child.kill();
      }
    });
  }

  it('no false positive on a free port (our own loopback binds do not count)', async () => {
    const server = createServer({ filePath: FIXTURE, port: 0 });
    try {
      const port = await server.listen();
      assert.equal(await wildcardListenerOn(port), false);
    } finally {
      await server.close();
    }
  });
});
