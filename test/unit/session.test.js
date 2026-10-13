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
    assert.match(logs[0], /^local-bpmn: warning: an edit from the browser replaced a change made on disk that the editor could not display/);
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
    assert.match(logs[0], /changed on disk before the latest edits were saved/);

    // Nothing unsaved: an external change is a plain one.
    session.applyUpdate(variant(4), 5, 'a'); // v6
    store.emit('saved', { xml: variant(4) });
    assert.deepEqual(saved, [2, 6]);
    store.emit('external-change', { xml: variant(10) });
    assert.deepEqual(changes.at(-1), { xml: variant(10), version: 7, origin: 'disk' });
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
