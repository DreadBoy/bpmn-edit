import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../../src/server.js';
import { createPresence } from '../../src/presence.js';
import { Session } from '../../src/session.js';
import {
  MAX_ID_LENGTH, MAX_NAME_LENGTH, MAX_SELECTION, PALETTE, cleanName, isColor, randomName,
} from '../../web/presence-shared.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;

/** Opens a client and collects its messages; `next(type)` resolves with the next message of that type. */
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.on('error', () => {});
  return {
    ws,
    inbox,
    next(type) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    send(obj) { ws.send(JSON.stringify(obj)); },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', resolve);
        ws.close();
      });
    },
  };
}

/** Connects and joins with `hello`; resolves to { client, me } once welcomed. */
async function joinSession(port, hello = {}) {
  const client = connect(port);
  await client.next('init');
  client.send({ type: 'hello', ...hello });
  const { user: me } = await client.next('welcome');
  return { client, me };
}

/** Waits for the next 'presence' message that satisfies `test`. */
async function presenceWhere(client, test) {
  for (;;) {
    const message = await client.next('presence');
    if (test(message.users)) return message.users;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('presence helpers', () => {
  it('randomName gives "Adjective Animal"', () => {
    for (let i = 0; i < 50; i++) assert.match(randomName(), /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal(randomName(() => 0), randomName(() => 0), 'deterministic for a given random source');
    assert.match(randomName(() => 0.9999999), /^\S+ \S+$/);
  });

  it('cleanName trims, collapses whitespace, strips invisible characters and limits the length', () => {
    assert.equal(cleanName('  Ada   Lovelace \n'), 'Ada Lovelace');
    assert.equal(cleanName('Ad\u0000a\u200b \u202eX'), 'Ada X');
    assert.equal(cleanName('<b>Bob</b>'), '<b>Bob</b>', 'markup is kept as text (rendered with textContent)');
    assert.equal(cleanName('x'.repeat(100)).length, MAX_NAME_LENGTH);
    assert.equal(Array.from(cleanName('\u{1f600}'.repeat(40))).length, MAX_NAME_LENGTH, 'counts characters, not UTF-16 units');
    for (const bad of ['', '   ', '\u200b', null, undefined, 42, {}, ['a']]) assert.equal(cleanName(bad), '', String(bad));
  });

  it('isColor accepts palette slots only', () => {
    assert.ok(PALETTE.length >= 6);
    for (const color of PALETTE) assert.match(color, /^#[0-9a-f]{6}$/);
    assert.ok(isColor(0) && isColor(PALETTE.length - 1));
    for (const bad of [-1, PALETTE.length, 1.5, '1', null, undefined, '#ff0000']) assert.equal(isColor(bad), false, String(bad));
  });

  it('createPresence assigns the least used colours first', () => {
    const sent = [];
    const presence = createPresence({ send: (ws, m) => sent.push([ws, m]), random: () => 0 });
    const sockets = PALETTE.map((_, i) => ({ i }));
    sockets.forEach((ws, i) => presence.handleMessage(ws, { type: 'hello' }, `c${i}`));
    assert.deepEqual(presence.users.map((u) => u.color).sort((a, b) => a - b), PALETTE.map((_, i) => i));
    presence.handleMessage({}, { type: 'hello' }, 'extra');
    assert.equal(presence.users.length, PALETTE.length + 1);
  });
});

describe('presence over WebSocket', () => {
  let dir;
  let server;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-bpmn-presence-'));
    const file = join(dir, 'order.bpmn');
    await copyFile(FIXTURE, file);
    server = createServer({ filePath: file, session: new Session({ xml: await readFile(file, 'utf8') }), port: 0 });
    await server.listen();
  });
  after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('hello -> welcome with a random name and a colour; everyone gets the list on join and leave', async () => {
    const { client: a, me: userA } = await joinSession(server.port);
    assert.match(userA.id, /^c\d+$/);
    assert.match(userA.name, /^\S+ \S+$/);
    assert.ok(isColor(userA.color));
    assert.deepEqual((await a.next('presence')).users, [userA]);

    const { client: b, me: userB } = await joinSession(server.port, { name: 'Bea', color: 3 });
    assert.deepEqual(userB, { id: userB.id, name: 'Bea', color: 3, selection: [] });
    assert.notEqual(userB.id, userA.id);
    assert.deepEqual((await b.next('presence')).users, [userA, userB]);
    assert.deepEqual((await a.next('presence')).users, [userA, userB]);

    await b.close();
    assert.deepEqual((await a.next('presence')).users, [userA]);
    await a.close();
  });

  it('uses the id from init and keeps a stored colour; invalid ones are replaced', async () => {
    const c = connect(server.port);
    const init = await c.next('init');
    c.send({ type: 'hello', name: '  \u200b ', color: 99 });
    const { user } = await c.next('welcome');
    assert.equal(user.id, init.clientId);
    assert.match(user.name, /^\S+ \S+$/, 'empty name -> random');
    assert.ok(isColor(user.color), 'invalid colour -> palette slot');
    c.send({ type: 'hello', name: 'x'.repeat(200), color: '#ff0000' });
    const again = (await c.next('welcome')).user;
    assert.equal(again.name, 'x'.repeat(MAX_NAME_LENGTH), 'clamped');
    assert.equal(again.color, user.color, 'invalid colour keeps the current one');
    await c.close();
  });

  it('rename is cleaned and broadcast; invalid renames are ignored without an error', async () => {
    const { client: a, me: userA } = await joinSession(server.port, { name: 'Ann', color: 1 });
    const { client: b, me: userB } = await joinSession(server.port, { name: 'Ben', color: 2 });
    await presenceWhere(a, (users) => users.length === 2);
    await presenceWhere(b, (users) => users.length === 2);

    a.send({ type: 'rename', name: '  Ann\u202e  Marie  ' });
    const users = await presenceWhere(b, (list) => list[0].name !== 'Ann');
    assert.deepEqual(users, [{ ...userA, name: 'Ann Marie' }, userB]);
    await presenceWhere(a, (list) => list[0].name === 'Ann Marie');

    for (const name of ['', '   ', 42, null, { x: 1 }]) a.send({ type: 'rename', name });
    a.send({ type: 'rename', name: 'Ann Marie' }); // unchanged: no broadcast
    await delay(200);
    assert.deepEqual(b.inbox.filter((m) => m.type === 'presence' || m.type === 'error'), []);
    assert.deepEqual(a.inbox.filter((m) => m.type === 'error'), []);
    await a.close();
    await b.close();
  });

  it('connections that never said hello get no presence messages and are not listed', async () => {
    const silent = connect(server.port);
    await silent.next('init');
    const { client: a, me } = await joinSession(server.port);
    assert.deepEqual((await a.next('presence')).users, [me]);
    silent.send({ type: 'rename', name: 'Ghost' }); // not joined: ignored
    await delay(200);
    assert.deepEqual(silent.inbox.filter((m) => m.type !== 'init'), []);
    assert.deepEqual(a.inbox, []);
    await silent.close();
    await delay(100);
    assert.deepEqual(a.inbox, [], 'a silent connection leaving is not announced');
    await a.close();
  });

  it('selection is relayed to the others (not the sender) and kept for late joiners', async () => {
    const { client: a, me: userA } = await joinSession(server.port, { name: 'Ann', color: 0 });
    const { client: b } = await joinSession(server.port, { name: 'Ben', color: 1 });
    await presenceWhere(a, (users) => users.length === 2);
    await presenceWhere(b, (users) => users.length === 2);

    a.send({ type: 'selection', ids: ['Task_CheckStock', 'Task_CheckStock', 'Flow_1'] });
    assert.deepEqual(await b.next('selection'), { type: 'selection', userId: userA.id, ids: ['Task_CheckStock', 'Flow_1'] });
    a.send({ type: 'selection', ids: ['Task_CheckStock', 'Flow_1'] }); // unchanged: not relayed again

    // A late joiner gets everyone's current selection with the list.
    const { client: c } = await joinSession(server.port, { name: 'Cy', color: 2 });
    const users = await presenceWhere(c, (list) => list.length === 3);
    assert.deepEqual(users.map((u) => [u.name, u.selection]), [['Ann', ['Task_CheckStock', 'Flow_1']], ['Ben', []], ['Cy', []]]);

    // Invalid selections are ignored (no relay, no error); a valid one still goes through.
    for (const ids of [null, 'Task_CheckStock', [1], [''], ['x'.repeat(MAX_ID_LENGTH + 1)], [{}]]) a.send({ type: 'selection', ids });
    a.send({ type: 'selection', ids: [] });
    assert.deepEqual(await b.next('selection'), { type: 'selection', userId: userA.id, ids: [] });
    assert.deepEqual(await c.next('selection'), { type: 'selection', userId: userA.id, ids: [] });
    await delay(100);
    assert.deepEqual([...a.inbox, ...b.inbox, ...c.inbox].filter((m) => m.type === 'selection' || m.type === 'error'), []);

    // Long selections are cut off.
    const many = Array.from({ length: MAX_SELECTION + 10 }, (_, i) => `E_${i}`);
    a.send({ type: 'selection', ids: many });
    assert.deepEqual((await b.next('selection')).ids, many.slice(0, MAX_SELECTION));

    // Leaving clears the selection for everyone (the user is gone from the list).
    await a.close();
    assert.deepEqual((await presenceWhere(b, (list) => list.length === 2)).map((u) => u.name), ['Ben', 'Cy']);
    await b.close();
    await c.close();
  });

  it('a selection before hello is ignored', async () => {
    const silent = connect(server.port);
    await silent.next('init');
    const { client: a } = await joinSession(server.port);
    await a.next('presence');
    silent.send({ type: 'selection', ids: ['Task_CheckStock'] });
    await delay(200);
    assert.deepEqual(a.inbox, []);
    assert.deepEqual(silent.inbox, []);
    await silent.close();
    await a.close();
  });

  it('sync messages work unchanged next to presence', async () => {
    const { client: a } = await joinSession(server.port);
    const { version } = server.session.getState();
    const xml = (await readFile(FIXTURE, 'utf8')).replace('name="Check stock"', 'name="Check stock P"');
    a.send({ type: 'update', xml, baseVersion: version });
    assert.deepEqual(await a.next('ack'), { type: 'ack', version: version + 1 });
    a.send({ type: 'nonsense' });
    assert.equal((await a.next('error')).code, 'bad-message');
    await a.close();
  });
});
