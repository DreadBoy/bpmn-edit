import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { Session, SessionError } from '../../src/session.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;
const original = await readFile(FIXTURE, 'utf8');
const variant = (n) => original.replace('name="Check stock"', `name="Check stock ${n}"`);

function fakeStore() {
  const store = new EventEmitter();
  store.writes = [];
  store.write = (xml) => store.writes.push(xml);
  return store;
}

describe('Session', () => {
  it('starts at version 1 with the initial XML', () => {
    const session = new Session({ xml: original });
    assert.deepEqual(session.getState(), { xml: original, version: 1 });
  });

  it('rejects non-BPMN initial XML', () => {
    assert.throws(() => new Session({ xml: '<html/>' }), TypeError);
  });

  it('applies updates: increments the version, writes through the store, emits change', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    const changes = [];
    session.on('change', (c) => changes.push(c));

    assert.equal(session.applyUpdate(variant(1), 1, 'a'), 2);
    assert.equal(session.applyUpdate(variant(2), 2, 'b'), 3);
    assert.deepEqual(session.getState(), { xml: variant(2), version: 3 });
    assert.deepEqual(store.writes, [variant(1), variant(2)]);
    assert.deepEqual(changes.map((c) => [c.version, c.origin]), [[2, 'a'], [3, 'b']]);
  });

  it('refuses an update based on a version another update replaced (conflict with the current version)', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    const changes = [];
    session.on('change', (c) => changes.push(c));
    session.applyUpdate(variant(1), 1, 'a');
    assert.throws(() => session.applyUpdate(variant(2), 1, 'b'), (err) => err instanceof SessionError
      && err.code === 'conflict' && err.details.version === 2 && /based on version 1/.test(err.message));
    assert.deepEqual(session.getState(), { xml: variant(1), version: 2 });
    assert.deepEqual(store.writes, [variant(1)]);
    assert.equal(changes.length, 1);
    // Re-sent on top of the current version: accepted.
    assert.equal(session.applyUpdate(variant(2), 2, 'b'), 3);
  });

  it('passes overrides through in the change event', () => {
    const session = new Session({ xml: original });
    const changes = [];
    session.on('change', (c) => changes.push(c));
    session.applyUpdate(variant(1), 1, 'a', { overrides: [{ id: 'X', name: 'x' }] });
    session.applyUpdate(variant(2), 2, 'a');
    assert.deepEqual(changes[0].overrides, [{ id: 'X', name: 'x' }]);
    assert.equal('overrides' in changes[1], false);
  });

  it('refuses a missing, non-integer or future baseVersion', () => {
    const session = new Session({ xml: original });
    for (const base of [undefined, null, '1', 1.5, 2, 99]) {
      assert.throws(() => session.applyUpdate(variant(1), base), (err) => err.code === 'conflict' && err.details.version === 1);
    }
    assert.equal(session.getState().version, 1);
  });

  it('accepts identical content whatever its base (no-op)', () => {
    const session = new Session({ xml: original });
    session.applyUpdate(variant(1), 1);
    assert.equal(session.applyUpdate(variant(1), 1), 2);
  });

  it('treats identical content as a no-op', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    assert.equal(session.applyUpdate(original, 1), 1);
    assert.deepEqual(store.writes, []);
  });

  it('rejects invalid XML without changing state', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    for (const bad of ['<html/>', '', 42, null, undefined]) {
      assert.throws(() => session.applyUpdate(bad, 1), (err) => err instanceof SessionError && err.code === 'invalid-xml');
    }
    assert.deepEqual(session.getState(), { xml: original, version: 1 });
    assert.deepEqual(store.writes, []);
  });

  it('forwards store write errors', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    const errors = [];
    session.on('write-error', (e) => errors.push(e));
    store.emit('write-error', new Error('disk full'));
    assert.deepEqual(errors.map((e) => e.message), ['disk full']);
  });
});

describe('Session and changes on disk', () => {
  it('replaceFromDisk: bumps the version, emits change with origin disk, never writes', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    const changes = [];
    session.on('change', (c) => changes.push(c));

    assert.equal(session.replaceFromDisk(variant(1)), 2);
    assert.deepEqual(session.getState(), { xml: variant(1), version: 2 });
    assert.deepEqual(changes, [{ xml: variant(1), version: 2, origin: 'disk' }]);
    assert.deepEqual(store.writes, []);
  });

  it('replaceFromDisk with the current content is a no-op', () => {
    const session = new Session({ xml: original, store: fakeStore() });
    const changes = [];
    session.on('change', (c) => changes.push(c));
    assert.equal(session.replaceFromDisk(original), 1);
    assert.deepEqual(changes, []);
  });

  it('applies external-change events from the store and tracks the disk status', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    const statuses = [];
    const changes = [];
    session.on('disk-status', (s) => statuses.push(s));
    session.on('change', (c) => changes.push(c));

    store.emit('external-change', { xml: variant(1) });
    assert.deepEqual(session.getState(), { xml: variant(1), version: 2 });
    assert.equal(changes[0].origin, 'disk');

    store.emit('external-missing');
    assert.deepEqual(session.diskStatus, { state: 'missing' });
    store.emit('external-invalid', { message: 'truncated' });
    assert.deepEqual(session.diskStatus, { state: 'invalid', message: 'truncated' });
    store.emit('disk-ok');
    assert.deepEqual(session.diskStatus, { state: 'ok' });
    store.emit('external-missing');
    store.emit('external-change', { xml: variant(1) }); // reappeared with the same content
    assert.deepEqual(statuses.map((s) => s.state), ['missing', 'invalid', 'ok', 'missing', 'ok']);
    assert.equal(session.getState().version, 2);
    assert.deepEqual(store.writes, []);
  });

  it('refuses an update based on a version a change on disk replaced (Q2: re-applied on top instead)', () => {
    const logs = [];
    const store = fakeStore();
    const session = new Session({ xml: original, store, log: (m) => logs.push(m) });
    session.applyUpdate(variant(1), 1, 'a'); // v2
    session.replaceFromDisk(variant(2)); // v3
    session.replaceFromDisk(variant(3)); // v4
    assert.throws(() => session.applyUpdate(variant(4), 2, 'b'), (err) => err.code === 'conflict' && err.details.version === 4);
    assert.throws(() => session.applyUpdate(variant(4), 3, 'b'), (err) => err.code === 'conflict' && err.details.version === 4);
    assert.equal(session.getState().xml, variant(3));
    assert.equal(session.applyUpdate(variant(4), 4, 'b'), 5);
    assert.deepEqual(store.writes, [variant(1), variant(4)]);
    assert.deepEqual(logs, []);
  });

  it('a change on disk the editor cannot display is replaced by an edit based on the version before it', () => {
    const logs = [];
    const session = new Session({ xml: original, store: fakeStore(), log: (m) => logs.push(m) });
    session.applyUpdate(variant(1), 1, 'a'); // v2
    session.replaceFromDisk(variant(2)); // v3, cannot be displayed
    assert.equal(session.reportUnreadable(3, 'no diagram to display'), true);
    assert.equal(session.applyUpdate(variant(3), 2, 'a'), 4);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^bpmn-edit: warning: an edit from the browser replaced a change made on disk that the editor could not display/);
    assert.throws(() => session.applyUpdate(variant(4), 2, 'b'), (err) => err.code === 'conflict');
  });

  it('reports accepted updates a change on disk replaced before they were written (discardedAfter)', () => {
    const logs = [];
    const store = fakeStore();
    const session = new Session({ xml: original, store, log: (m) => logs.push(m) });
    const changes = [];
    const saved = [];
    session.on('change', (c) => changes.push(c));
    session.on('saved', (s) => saved.push(s.version));
    session.applyUpdate(variant(1), 1, 'a'); // v2
    store.emit('saved', { xml: variant(1) });
    assert.deepEqual(saved, [2]);
    session.applyUpdate(variant(2), 2, 'a'); // v3
    session.applyUpdate(variant(3), 3, 'b'); // v4
    store.emit('external-change', { xml: variant(9), discarded: true }); // v3 and v4 never written
    assert.deepEqual(changes.at(-1), { xml: variant(9), version: 5, origin: 'disk', discardedAfter: 2 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /changed on disk before the latest edits were saved; the windows that made them re-apply them/);

    // Nothing unsaved: an external change is a plain one.
    session.applyUpdate(variant(4), 5, 'a'); // v6
    store.emit('saved', { xml: variant(4) });
    assert.deepEqual(saved, [2, 6]);
    store.emit('external-change', { xml: variant(10) });
    assert.deepEqual(changes.at(-1), { xml: variant(10), version: 7, origin: 'disk' });
  });

  it('discarded edits of a window that is gone are kept aside after the grace period, unless re-applied', async () => {
    const logs = [];
    const store = fakeStore();
    store.kept = [];
    store.keepAside = async (xml) => { store.kept.push(xml); return true; };
    const session = new Session({ xml: original, store, log: (m) => logs.push(m), reapplyGraceMs: 100 });
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // Gone before the discard: kept aside after the grace period; the log says so.
    const ws1 = {};
    session.applyUpdate(variant(1), 1, ws1); // v2
    session.originGone(ws1);
    store.emit('external-change', { xml: variant(11), discarded: true }); // v3
    assert.match(logs.at(-1), /window that made them is disconnected: they are re-applied if it reconnects within 0 s, otherwise the editor's version is saved next to the file/);
    assert.deepEqual(store.kept, []);
    await delay(200);
    assert.deepEqual(store.kept, [variant(1)]);

    // Gone before the discard, but re-applied (by its new connection) within the grace period.
    const ws2 = {};
    session.applyUpdate(variant(2), 3, ws2, { owner: 'local:|page2' }); // v4
    session.originGone(ws2);
    store.emit('external-change', { xml: variant(12), discarded: true }); // v5
    session.applyUpdate(variant(3), 5, {}, { reapplied: [4], owner: 'local:|page2' }); // v6, same page reconnected
    await delay(200);
    assert.deepEqual(store.kept, [variant(1)]);

    // Gone after the discard (a dead connection noticed later): kept aside after the grace period.
    const ws3 = {};
    session.applyUpdate(variant(4), 6, ws3); // v7
    store.emit('external-change', { xml: variant(13), discarded: true }); // v8
    session.originGone(ws3);
    await delay(200);
    assert.deepEqual(store.kept, [variant(1), variant(4)]);

    // Still connected, nothing to re-apply in the end ('reapplied' message): nothing kept.
    const ws4 = {};
    session.applyUpdate(variant(5), 8, ws4, { owner: 'local:|page4' }); // v9
    store.emit('external-change', { xml: variant(14), discarded: true }); // v10
    session.reapplied([9]); // no owner: ignored
    session.reapplied([9], 'collaborator:tok|page4'); // another page (same key, other scope): ignored
    session.reapplied([9], 'local:|page4');
    session.originGone(ws4);
    await delay(200);
    assert.deepEqual(store.kept, [variant(1), variant(4)]);

    // Shutdown: whatever was not re-applied is kept aside right away (a claim by another page does
    // not count).
    const ws5 = {};
    session.applyUpdate(variant(6), 10, ws5, { owner: 'local:|page5' }); // v11
    store.emit('external-change', { xml: variant(15), discarded: true }); // v12
    session.applyUpdate(variant(7), 12, {}, { reapplied: [11], owner: 'collaborator:tok|other' }); // v13
    session.reapplied([11, 1, 2, 3, 200], 'collaborator:tok|other');
    assert.equal(await session.keepUnapplied(), 1);
    assert.deepEqual(store.kept, [variant(1), variant(4), variant(6)]);
    assert.equal(await session.keepUnapplied(), 0, 'once');
  });

  it('syncState: instance, saved version and discards for clients that (re)connect', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store, log: () => {} });
    const first = session.syncState();
    assert.match(first.instance, /^[0-9a-f-]{36}$/);
    assert.notEqual(new Session({ xml: original }).syncState().instance, first.instance, 'one id per session');
    assert.deepEqual(first, { instance: first.instance, saved: 1, discards: [], lastDisk: null, lastEdit: 1, staleSaves: [] });
    session.applyUpdate(variant(1), 1, 'a'); // v2
    session.applyUpdate(variant(2), 2, 'a'); // v3
    assert.equal(session.syncState().saved, 1, 'v2 and v3 not written yet');
    store.emit('saved', { xml: variant(1) });
    assert.equal(session.syncState().saved, 2);
    store.emit('external-change', { xml: variant(9), discarded: true }); // v3 never written -> v4
    assert.deepEqual(session.syncState(), {
      instance: first.instance, saved: 4, discards: [{ after: 2, version: 4 }], lastDisk: 4, lastEdit: 3, staleSaves: [],
    });
    // A plain change on disk (nothing discarded) adds no entry.
    store.emit('external-change', { xml: variant(10) }); // v5
    assert.deepEqual(session.syncState().discards, [{ after: 2, version: 4 }]);
    // The copy handed out cannot change the session's list.
    session.syncState().discards[0].after = 99;
    assert.deepEqual(session.syncState().discards, [{ after: 2, version: 4 }]);
  });

  it('reportUnreadable marks the file invalid only for the current version from disk', () => {
    const store = fakeStore();
    const session = new Session({ xml: original, store });
    const statuses = [];
    session.on('disk-status', (st) => statuses.push(st));

    session.replaceFromDisk(variant(1)); // version 2, from disk
    assert.equal(session.reportUnreadable(1, 'old version'), false);
    assert.equal(session.reportUnreadable(2, 'no diagram to display'), true);
    assert.equal(session.diskStatus.state, 'invalid');
    assert.match(session.diskStatus.message, /no diagram to display/);

    session.applyUpdate(variant(2), 2, 'a'); // version 3, from a client
    assert.equal(session.reportUnreadable(3, 'x'), false);
    store.emit('written', {}); // the edit reached the disk
    assert.deepEqual(statuses.map((st) => st.state), ['invalid', 'ok']);
    assert.deepEqual(store.writes, [variant(2)]);
  });
});
