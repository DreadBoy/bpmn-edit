import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readdir, readFile, rename, rm, stat, symlink, lstat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createFileStore, sha256, TEMP_FILE_RE } from '../../src/file.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;
const original = await readFile(FIXTURE, 'utf8');
const variant = (n) => original.replace('name="Check stock"', `name="Check stock ${n}"`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createFileStore', () => {
  let dir;
  let file;
  let logs;
  const log = (m) => logs.push(m);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-bpmn-store-'));
    file = join(dir, 'order.bpmn');
    await copyFile(FIXTURE, file);
    logs = [];
  });
  afterEach(async () => {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  async function countWrites(store) {
    const writes = [];
    store.on('written', (w) => writes.push(w));
    return writes;
  }

  it('read() returns the file content and records it as on disk', async () => {
    const store = createFileStore(file, { log });
    assert.equal(await store.read(), original);
    assert.equal(store.diskXml, original);
    assert.equal(store.lastWrite, null);
  });

  it('coalesces writes within the debounce window into one disk write of the latest content', async () => {
    // A generous window, so five writes 5 ms apart stay inside it even on a loaded machine.
    const store = createFileStore(file, { debounceMs: 200, log });
    await store.read();
    const writes = await countWrites(store);
    for (let i = 1; i <= 5; i++) {
      store.write(variant(i));
      await delay(5);
    }
    assert.equal(await readFile(file, 'utf8'), original, 'nothing written before the debounce elapsed');
    assert.ok(store.pending);
    // Wait for the write itself (no fixed sleep), then long enough for a second one to show up.
    for (const start = Date.now(); writes.length === 0; await delay(10)) {
      assert.ok(Date.now() - start < 5_000, 'the debounced write never happened');
    }
    await delay(400);
    assert.equal(writes.length, 1);
    assert.equal(await readFile(file, 'utf8'), variant(5));
    assert.equal(store.pending, false);
  });

  it('flush() writes pending content immediately and is safe to repeat', async () => {
    const store = createFileStore(file, { debounceMs: 60_000, log });
    await store.read();
    await store.flush(); // nothing pending
    store.write(variant(1));
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(1));
    await store.flush();
    await Promise.all([store.flush(), store.flush()]);
    assert.equal(await readFile(file, 'utf8'), variant(1));
  });

  it('skips writing content identical to what is on disk', async () => {
    const store = createFileStore(file, { debounceMs: 10, log });
    await store.read();
    const before = await stat(file);
    const writes = await countWrites(store);
    store.write(original);
    await store.flush();
    assert.equal(writes.length, 0);
    assert.equal((await stat(file)).ino, before.ino, 'file was not replaced');

    store.write(variant(1));
    await store.flush();
    store.write(variant(1));
    await store.flush();
    assert.equal(writes.length, 1);
  });

  it('writes atomically: replaces the file via rename and leaves no temp files', async () => {
    const store = createFileStore(file, { debounceMs: 0, log });
    await store.read();
    const before = await stat(file);
    store.write(variant(1));
    await store.flush();
    const after = await stat(file);
    assert.notEqual(after.ino, before.ino, 'new inode: written to a temp file and renamed');
    assert.deepEqual(await readdir(dir), ['order.bpmn']);
  });

  it('preserves the file mode', async () => {
    await chmod(file, 0o600);
    const store = createFileStore(file, { debounceMs: 0, log });
    await store.read();
    store.write(variant(1));
    await store.flush();
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it('writes through a symlink and keeps the link', async () => {
    const link = join(dir, 'link.bpmn');
    await symlink(file, link);
    const store = createFileStore(link, { debounceMs: 0, log });
    await store.read();
    store.write(variant(1));
    await store.flush();
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.equal(await readFile(file, 'utf8'), variant(1));
  });

  it('serialises writes: a write requested during a write runs afterwards with the latest content', async () => {
    const store = createFileStore(file, { debounceMs: 0, log });
    await store.read();
    const writes = await countWrites(store);
    let concurrent = 0;
    let maxConcurrent = 0;
    // Observe overlap through the temp files present while writes happen.
    const watcher = setInterval(async () => {
      const temps = (await readdir(dir).catch(() => [])).filter((n) => TEMP_FILE_RE.test(n));
      concurrent = temps.length;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }, 1);
    try {
      store.write(variant(1));
      await delay(5);
      for (let i = 2; i <= 20; i++) {
        store.write(variant(i));
        await delay(1);
      }
      await store.flush();
    } finally {
      clearInterval(watcher);
    }
    assert.ok(maxConcurrent <= 1, `at most one temp file at a time (saw ${maxConcurrent})`);
    assert.equal(await readFile(file, 'utf8'), variant(20));
    assert.equal(writes.at(-1).xml, variant(20));
    assert.deepEqual(await readdir(dir), ['order.bpmn']);
  });

  it('records the last own write for self-write detection', async () => {
    const store = createFileStore(file, { debounceMs: 0, log });
    await store.read();
    assert.equal(store.isOwnWrite(original), false, 'content read at startup is not an own write');
    store.write(variant(1));
    await store.flush();
    const info = await stat(file);
    assert.deepEqual(store.lastWrite, {
      xml: variant(1),
      hash: sha256(variant(1)),
      mtimeMs: info.mtimeMs,
      size: info.size,
    });
    assert.equal(store.isOwnWrite(variant(1)), true);
    assert.equal(store.isOwnWrite(variant(2)), false);
  });

  it('reports write errors via stderr log and a write-error event, without throwing', async () => {
    const store = createFileStore(file, { debounceMs: 0, log });
    await store.read();
    const errors = [];
    store.on('write-error', (e) => errors.push(e));
    await chmod(dir, 0o555); // cannot create the temp file
    store.write(variant(1));
    await store.flush();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, new RegExp(`^Could not write ${file}: `));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^local-bpmn: Could not write /);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal(store.diskXml, original);

    await chmod(dir, 0o755);
    store.write(variant(1));
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(1), 'a later write succeeds');
    assert.deepEqual(await readdir(dir), ['order.bpmn']);
  });

  it('temp file names match TEMP_FILE_RE', () => {
    assert.ok(TEMP_FILE_RE.test(`.order.bpmn.${process.pid}.0a1b2c3d4e5f.tmp`));
    assert.ok(!TEMP_FILE_RE.test('order.bpmn'));
  });
});

describe('createFileStore watching', () => {
  let dir;
  let file;
  let logs;
  let store;
  let events;
  const log = (m) => logs.push(m);
  const EVENTS = ['external-change', 'external-missing', 'external-invalid', 'disk-ok', 'written'];

  /** Resolves with the next `type` event (fails after `timeoutMs`). */
  function next(type, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        store.off(type, onEvent);
        reject(new Error(`no ${type} event within ${timeoutMs} ms (saw ${events.map((e) => e.type)})`));
      }, timeoutMs);
      function onEvent(payload) {
        clearTimeout(timer);
        resolve(payload);
      }
      store.once(type, onEvent);
    });
  }

  async function start(options = {}) {
    store = createFileStore(file, { debounceMs: 0, log, ...options });
    for (const type of EVENTS) store.on(type, (payload) => events.push({ type, payload }));
    await store.read();
    await store.watch();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-bpmn-watch-'));
    file = join(dir, 'order.bpmn');
    await copyFile(FIXTURE, file);
    logs = [];
    events = [];
    store = null;
  });
  afterEach(async () => {
    await store?.unwatch();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports an in-place external write as external-change and records it as on disk', async () => {
    await start();
    const changed = next('external-change');
    await writeFile(file, variant(1));
    assert.deepEqual(await changed, { xml: variant(1) });
    assert.equal(store.diskXml, variant(1));
    assert.equal(store.diskState, 'ok');
  });

  it('reports an atomic save (temp file renamed over the target) once', async () => {
    await start();
    const changed = next('external-change');
    const tmp = join(dir, '.order.bpmn.swp-like');
    await writeFile(tmp, variant(2));
    await rename(tmp, file);
    assert.deepEqual(await changed, { xml: variant(2) });
    await delay(400);
    assert.deepEqual(events.map((e) => e.type), ['external-change']);
  });

  it('does not report its own writes', async () => {
    await start();
    store.write(variant(1));
    await store.flush();
    store.write(variant(2));
    await store.flush();
    await delay(500);
    assert.deepEqual(events.map((e) => e.type), ['written', 'written']);
    assert.equal(await readFile(file, 'utf8'), variant(2));
  });

  it('reports a change back to content it wrote earlier', async () => {
    await start();
    store.write(variant(1));
    await store.flush();
    await delay(300);
    let changed = next('external-change');
    await writeFile(file, variant(2));
    await changed;
    changed = next('external-change');
    await writeFile(file, variant(1)); // e.g. undo in an IDE
    assert.deepEqual(await changed, { xml: variant(1) });
  });

  it('reports truncated content as external-invalid and does not write anything', async () => {
    await start();
    const truncated = original.slice(0, Math.floor(original.length * 0.6));
    const invalid = next('external-invalid');
    await writeFile(file, truncated);
    const { message } = await invalid;
    assert.match(message, /incomplete/);
    assert.equal(store.diskState, 'invalid');
    await delay(400);
    assert.equal(await readFile(file, 'utf8'), truncated);
    assert.ok(!events.some((e) => e.type === 'external-change' || e.type === 'written'));

    const ok = next('disk-ok');
    const changed = next('external-change');
    await writeFile(file, variant(3));
    await ok;
    assert.deepEqual(await changed, { xml: variant(3) });
    assert.equal(store.diskState, 'ok');
  });

  it('reports a deleted file once, does not recreate it, and recreates it on the next write', async () => {
    await start();
    const missing = next('external-missing');
    await unlink(file);
    await missing;
    assert.equal(store.diskState, 'missing');
    await delay(400);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.deepEqual(events.map((e) => e.type), ['external-missing']);

    const ok = next('disk-ok');
    store.write(original); // same content as before the delete: must still be written
    await store.flush();
    await ok;
    assert.equal(await readFile(file, 'utf8'), original);
    await delay(400);
    assert.deepEqual(events.map((e) => e.type), ['external-missing', 'written', 'disk-ok']);
  });

  it('a file recreated externally with valid content is an external change', async () => {
    await start();
    const missing = next('external-missing');
    await unlink(file);
    await missing;
    const changed = next('external-change');
    await writeFile(file, original);
    assert.deepEqual(await changed, { xml: original });
    assert.equal(store.diskState, 'ok');
  });

  it('drops a pending write when an external change arrives after it', async () => {
    await start({ debounceMs: 60_000 });
    store.write(variant(1));
    assert.ok(store.pending);
    const changed = next('external-change');
    await writeFile(file, variant(2));
    await changed;
    assert.equal(store.pending, false);
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(2), 'the external change was not overwritten');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^local-bpmn: warning: .* changed on disk; a pending save from the editor was discarded/);
  });

  it('ignores other files in the directory, including its own temp file names', async () => {
    await start();
    await writeFile(join(dir, 'other.bpmn'), original);
    await writeFile(join(dir, `.order.bpmn.${process.pid}.0a1b2c3d4e5f.tmp`), 'partial');
    await delay(500);
    assert.deepEqual(events, []);
  });

  it('unwatch() stops reporting', async () => {
    await start();
    await store.unwatch();
    await writeFile(file, variant(1));
    await delay(400);
    assert.deepEqual(events, []);
  });
});
