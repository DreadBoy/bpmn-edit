// S8: keepalive, close codes, roles in 'init', reconnect policy, and replacing a reconnected page's entry.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createPresence } from '../../src/presence.js';
import { createServer } from '../../src/server.js';
import { Session } from '../../src/session.js';
import { testProviderFactory } from '../../src/test-tunnel.js';
import {
  CLOSE_SESSION_ENDED, CLOSE_SHARE_STOPPED, HEARTBEAT_MS, KEEPALIVE_MS, RECONNECT, probeVerdict, reconnectDelay,
  shouldGiveUp,
} from '../../web/connection-shared.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;
const xml = await readFile(FIXTURE, 'utf8');

/** Opens a client; resolves once open to { ws, messages, closed, next(type) }. */
function open(port, path = '/ws', options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
    const messages = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else messages.push(msg);
    });
    const closed = new Promise((done) => ws.once('close', (code, reason) => done({ code, reason: String(reason) })));
    ws.once('error', reject);
    ws.once('open', () => resolve({
      ws,
      closed,
      send: (obj) => ws.send(JSON.stringify(obj)),
      next(type) {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
        return new Promise((done) => waiters.push({ type, resolve: done }));
      },
    }));
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('reconnect policy (web/connection-shared.js)', () => {
  it('keeps the keepalive and heartbeat well below the ~125 s idle cut of the tunnel', () => {
    assert.ok(KEEPALIVE_MS <= 60_000);
    assert.ok(HEARTBEAT_MS <= 60_000);
    assert.equal(CLOSE_SHARE_STOPPED, 4001);
    assert.equal(CLOSE_SESSION_ENDED, 4002);
  });

  it('backs off 0.5, 1, 2, 4, 8 s, then every 10 s, with ±20% jitter', () => {
    const exact = (attempt) => reconnectDelay(attempt, RECONNECT, () => 0.5);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(exact), [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    assert.equal(reconnectDelay(1, RECONNECT, () => 0), 400);
    assert.equal(reconnectDelay(1, RECONNECT, () => 1), 600);
    assert.equal(reconnectDelay(0, RECONNECT, () => 0.5), 500);
  });

  it('gives up only after 8 failed attempts AND 60 s, or once a probe says the link is gone', () => {
    const since = 1_000_000;
    const at = (attempts, elapsed, tunnelGoneFor = null) => shouldGiveUp(
      { attempts, since, tunnelGoneSince: tunnelGoneFor === null ? null : since + elapsed - tunnelGoneFor }, since + elapsed,
    );
    assert.equal(at(7, 120_000), false); // a long sleep, but only 7 attempts
    assert.equal(at(20, 59_000), false);
    assert.equal(at(8, 60_000), true);
    assert.equal(at(1, 9_000, 9_000), false); // Cloudflare 530 for 9 s: maybe cloudflared reconnecting
    assert.equal(at(1, 10_000, 10_000), true);
    // The default schedule reaches the limit after about a minute.
    let elapsed = 0;
    let attempts = 0;
    while (!shouldGiveUp({ attempts, since: 0, tunnelGoneSince: null }, elapsed)) {
      attempts += 1;
      elapsed += reconnectDelay(attempts, RECONNECT, () => 0.5);
    }
    assert.ok(elapsed >= 60_000 && elapsed <= 75_000, String(elapsed));
  });

  it('reads 404 as gone, 530 as tunnel gone, anything else as retry', () => {
    assert.equal(probeVerdict(404), 'gone');
    assert.equal(probeVerdict(530), 'tunnel-gone');
    for (const status of [null, 200, 403, 502, 503]) assert.equal(probeVerdict(status), 'retry');
  });
});

describe('presence: a reconnected page replaces its old entry', () => {
  const sent = [];
  const replaced = [];
  const presence = createPresence({
    send: (ws, message) => sent.push({ ws, message }), onReplaced: (ws) => replaced.push(ws), random: () => 0,
  });
  const KEY = 'a'.repeat(32);

  it('takes over the entry (place, name, colour) of the same key and scope, under the new id', () => {
    const [a, b, a2] = [{ n: 'a' }, { n: 'b' }, { n: 'a2' }];
    presence.handleMessage(a, { type: 'hello', name: 'Ann', color: 3, key: KEY }, 'c1', 'local:');
    presence.handleMessage(b, { type: 'hello', name: 'Bob', color: 4 }, 'c2', 'local:');
    presence.handleMessage(a2, { type: 'hello', name: 'Ann', color: 3, key: KEY }, 'c3', 'local:');
    assert.deepEqual(replaced, [a]);
    assert.deepEqual(presence.users.map(({ id, name, color }) => ({ id, name, color })),
      [{ id: 'c3', name: 'Ann', color: 3 }, { id: 'c2', name: 'Bob', color: 4 }]);
    presence.leave(a); // the old connection's close: nothing left to remove
    assert.equal(presence.users.length, 2);
    // The key is never sent to anyone.
    assert.ok(sent.every(({ message }) => !JSON.stringify(message).includes(KEY)));
  });

  it('ignores the key across scopes (e.g. a collaborator link) and when malformed', () => {
    replaced.length = 0;
    const c = { n: 'c' };
    const d = { n: 'd' };
    presence.handleMessage(c, { type: 'hello', name: 'Cat', key: KEY }, 'c4', 'collaborator:tok');
    presence.handleMessage(d, { type: 'hello', name: 'Dan', key: 'short' }, 'c5', 'local:');
    assert.deepEqual(replaced, []);
    assert.equal(presence.users.length, 4);
  });
});

describe('server: keepalive, session end, roles', () => {
  let server;

  before(async () => {
    server = createServer({
      filePath: FIXTURE,
      session: new Session({ xml }),
      port: 0,
      keepaliveMs: 100,
      createTunnelProvider: testProviderFactory('fake', { delayMs: 10 }),
    });
    await server.listen();
  });
  after(() => server.close());

  it("tells each socket its role in 'init': host (current secret), local (none or a stale one), collaborator", async () => {
    const roles = {};
    for (const [name, path] of [['host', `/ws?host=${server.hostSecret}`], ['plain', '/ws'], ['stale', '/ws?host=from-an-earlier-run']]) {
      const c = await open(server.port, path);
      roles[name] = (await c.next('init')).role;
      c.ws.close();
    }
    const { url } = await server.share.start();
    const token = url.split('/s/')[1];
    const c = await open(server.port, `/s/${token}/ws`);
    roles.collaborator = (await c.next('init')).role;
    await server.share.stop();
    assert.deepEqual(await c.closed, { code: CLOSE_SHARE_STOPPED, reason: 'share-stopped' });
    assert.deepEqual(roles, { host: 'host', plain: 'local', stale: 'local', collaborator: 'collaborator' });
  });

  it('answers ping with pong', async () => {
    const c = await open(server.port);
    await c.next('init');
    c.send({ type: 'ping' });
    assert.deepEqual(await c.next('pong'), { type: 'pong' });
    c.ws.close();
  });

  it('pings every socket and terminates one that stops answering; it leaves the users list', async () => {
    const live = await open(server.port);
    const dead = await open(server.port, '/ws', { autoPong: false });
    let pings = 0;
    live.ws.on('ping', () => { pings += 1; });
    live.send({ type: 'hello', name: 'Live' });
    dead.send({ type: 'hello', name: 'Dead' });
    await waitFor(() => server.wss.clients.size >= 2 && pings >= 1);
    const { code } = await dead.closed;
    assert.equal(code, 1006); // terminated, no close frame
    await waitFor(() => pings >= 5); // the live one is still pinged and kept
    assert.equal(live.ws.readyState, WebSocket.OPEN);
    live.send({ type: 'ping' });
    assert.equal((await live.next('pong')).type, 'pong');
    live.ws.close();
  });

  it('endSession() closes every socket with 4002 and stops accepting new ones', async () => {
    const other = createServer({ filePath: FIXTURE, session: new Session({ xml }), port: 0, keepaliveMs: 0 });
    await other.listen();
    const a = await open(other.port);
    const b = await open(other.port);
    await other.endSession(1000);
    assert.deepEqual(await a.closed, { code: CLOSE_SESSION_ENDED, reason: 'session-ended' });
    assert.deepEqual(await b.closed, { code: CLOSE_SESSION_ENDED, reason: 'session-ended' });
    await assert.rejects(open(other.port));
    await other.close();
  });
});
