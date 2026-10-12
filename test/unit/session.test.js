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

  it('accepts a stale baseVersion (last write wins)', () => {
    const session = new Session({ xml: original });
    session.applyUpdate(variant(1), 1);
    assert.equal(session.applyUpdate(variant(2), 1), 3);
    assert.equal(session.getState().xml, variant(2));
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
