import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createFileStore } from '../../src/file.js';
import { createServer, WS_MAX_PAYLOAD } from '../../src/server.js';
import { Session } from '../../src/session.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;
const original = await readFile(FIXTURE, 'utf8');
const variant = (n) => original.replace('name="Check stock"', `name="Check stock ${n}"`);

/** Opens a client and collects its messages; `next(type)` resolves with the next message of that type. */
function connect(port, host = '127.0.0.1', path = '/ws') {
  const url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => !w.type || w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const client = {
    ws,
    opened: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }),
    closed: new Promise((resolve) => ws.once('close', (code) => resolve(code))),
    next(type) {
      const i = inbox.findIndex((m) => !type || m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    send(obj) { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
  };
  ws.on('error', () => {});
  return client;
}

async function ipv6Available() {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '::1', resolve); });
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

describe('WebSocket sync', () => {
  let dir;
  let file;
  let store;
  let server;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-bpmn-ws-'));
    file = join(dir, 'order.bpmn');
    await copyFile(FIXTURE, file);
    store = createFileStore(file, { debounceMs: 60_000 });
    const session = new Session({ xml: await store.read(), store });
    server = createServer({ filePath: file, session, port: 0 });
    await server.listen();
  });
  after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('sends init with the XML and version on connect (127.0.0.1)', async () => {
    const c = connect(server.port);
    const init = await c.next();
    assert.equal(init.type, 'init');
    assert.equal(init.version, 1);
    assert.equal(init.xml, original);
    assert.equal(init.name, 'order.bpmn');
    c.ws.close();
  });

  it('sends init on ::1 too (when IPv6 is available)', async (t) => {
    if (!(await ipv6Available())) return t.skip('no IPv6 loopback');
    const c = connect(server.port, '::1');
    assert.equal((await c.next()).type, 'init');
    c.ws.close();
  });

  it('update -> ack with the next version -> file on disk after flush', async () => {
    const c = connect(server.port);
    const init = await c.next('init');
    c.send({ type: 'update', xml: variant(1), baseVersion: init.version });
    const ack = await c.next();
    assert.deepEqual(ack, { type: 'ack', version: init.version + 1 });
    assert.equal(await readFile(file, 'utf8'), original, 'debounced: not written yet');
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(1));
    assert.deepEqual(await readdir(dir), ['order.bpmn']);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/file`);
    const body = await res.json();
    assert.equal(body.xml, variant(1), '/api/file serves the session state');
    assert.equal(body.version, ack.version);

    const c2 = connect(server.port);
    assert.deepEqual(await c2.next('init'), { type: 'init', xml: variant(1), version: ack.version, name: 'order.bpmn', path: file });
    c.ws.close();
    c2.ws.close();
  });

  it('rejects malformed and unknown messages with bad-message', async () => {
    const c = connect(server.port);
    await c.next('init');
    const cases = ['not json', '[1,2]', 'null', { type: 'nope' }, { xml: 'x' }, { type: 'update', xml: variant(9) }, { type: 'update', xml: 5, baseVersion: 1 }];
    for (const msg of cases) {
      c.send(msg);
      const reply = await c.next();
      assert.equal(reply.type, 'error', JSON.stringify(msg));
      assert.equal(reply.code, 'bad-message', JSON.stringify(msg));
      assert.equal(typeof reply.message, 'string');
    }
    c.ws.send(Buffer.from('{"type":"update"}'), { binary: true });
    assert.equal((await c.next()).code, 'bad-message');
    c.ws.close();
  });

  it('rejects non-BPMN XML with invalid-xml and writes nothing', async () => {
    const { version } = server.session.getState();
    const before = await readFile(file, 'utf8');
    const c = connect(server.port);
    await c.next('init');
    c.send({ type: 'update', xml: '<html><body>nope</body></html>', baseVersion: version });
    const reply = await c.next();
    assert.equal(reply.type, 'error');
    assert.equal(reply.code, 'invalid-xml');
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(server.session.getState().version, version);
    c.ws.close();
  });

  it('closes an oversize message with 1009 and keeps serving', async () => {
    const c = connect(server.port);
    await c.next('init');
    c.send({ type: 'update', xml: 'x'.repeat(WS_MAX_PAYLOAD + 1), baseVersion: 1 });
    assert.equal(await c.closed, 1009);
    const c2 = connect(server.port);
    assert.equal((await c2.next()).type, 'init');
    c2.ws.close();
  });

  it('rejects upgrades on other paths with 404', async () => {
    for (const path of ['/', '/socket', '/ws/x', '/api/file']) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
      const status = await new Promise((resolve) => {
        ws.once('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
        ws.once('error', () => resolve('error'));
      });
      assert.equal(status, 404, path);
    }
  });

  it('drainClients() collects pending edits from clients before shutdown', async () => {
    const c = connect(server.port);
    const init = await c.next('init');
    c.ws.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'flush') {
        c.send({ type: 'update', xml: variant(42), baseVersion: init.version });
        c.send({ type: 'flushed' });
      }
    });
    const started = Date.now();
    await server.drainClients(5000);
    assert.ok(Date.now() - started < 2000, 'resolved on flushed, not on timeout');
    assert.equal(server.session.getState().xml, variant(42));
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(42));
    c.ws.close();
  });

  it('drainClients() gives up after the timeout for silent clients', async () => {
    const c = connect(server.port);
    await c.next('init');
    const started = Date.now();
    await server.drainClients(100);
    assert.ok(Date.now() - started < 1000);
    c.ws.close();
  });
});

describe('server close', () => {
  it('disconnects WebSocket clients and stops listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-bpmn-ws-'));
    const file = join(dir, 'order.bpmn');
    await copyFile(FIXTURE, file);
    const server = createServer({ filePath: file, port: 0 });
    await server.listen();
    try {
      const c = connect(server.port);
      await c.next('init');
      await server.close();
      await c.closed;
      await assert.rejects(fetch(`http://127.0.0.1:${server.port}/api/file`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
