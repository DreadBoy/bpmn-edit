import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readdir, readFile, rename, rm, stat, symlink, lstat, unlink, utimes, writeFile } from 'node:fs/promises';
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
    const store = createFileStore(file, { debounceMs: 40, log });
    await store.read();
    const writes = await countWrites(store);
    for (let i = 1; i <= 5; i++) {
      store.write(variant(i));
      await delay(5);
    }
    assert.equal(await readFile(file, 'utf8'), original, 'nothing written before the debounce elapsed');
    assert.ok(store.pending);
    await delay(120);
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

  it('drops a pending write when an external change arrives after it, and says so (discarded)', async () => {
    await start({ debounceMs: 60_000 });
    store.write(variant(1));
    assert.ok(store.pending);
    const changed = next('external-change');
    await writeFile(file, variant(2));
    assert.deepEqual(await changed, { xml: variant(2), discarded: true });
    assert.equal(store.pending, false);
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(2), 'the external change was not overwritten');
    assert.deepEqual(logs, []);
  });

  it('never writes over an external change it has not seen yet: holds the write back and reports it', async () => {
    await start({ debounceMs: 0, settleMs: 300 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    await writeFile(file, variant(2)); // not reported yet (settle delay)
    const changed = next('external-change');
    store.write(variant(1)); // due right away
    assert.deepEqual(await changed, { xml: variant(2), discarded: true });
    assert.equal(await readFile(file, 'utf8'), variant(2));
    assert.ok(!events.some((e) => e.type === 'written'));
    assert.deepEqual(saved, []);
    assert.equal(store.pending, false);

    // The next write (based on the change) goes through.
    store.write(variant(3));
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(3));
    assert.deepEqual(saved, [variant(3)]);
    assert.deepEqual((await readdir(dir)).filter((n) => TEMP_FILE_RE.test(n)), []);
  });

  it('flush() keeps an external change it has not seen and saves the pending content next to the file', async () => {
    await start({ debounceMs: 60_000, settleMs: 60_000 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    store.write(variant(1));
    await writeFile(file, variant(2));
    await store.unwatch();
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(2), 'the change on disk is kept');
    assert.equal(asides.length, 1);
    assert.match(asides[0].path, /order\.local-bpmn-unsaved-\d{8}-\d{6}\.bpmn$/);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1), 'the editor version is saved aside');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^local-bpmn: warning: .* changed on disk while the editor's last changes were being saved; .*saved to .*local-bpmn-unsaved/);
    assert.equal(store.pending, false);
  });

  it('checkNow() reports a change before it settled; flush() keeps the dropped write aside unless rewritten', async () => {
    await start({ debounceMs: 60_000, settleMs: 60_000 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    store.write(variant(1));
    await writeFile(file, variant(2));
    const changed = next('external-change');
    await store.checkNow();
    assert.deepEqual(await changed, { xml: variant(2), discarded: true });
    await store.unwatch();
    await store.flush(); // nobody re-applied the edits: kept aside
    assert.equal(await readFile(file, 'utf8'), variant(2));
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));

    // Re-applied (a new write after the check): written, nothing kept aside.
    await store.watch();
    store.write(variant(3));
    await writeFile(file, variant(4));
    await store.checkNow();
    store.write(variant(5));
    await store.unwatch();
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(5));
    assert.equal(asides.length, 1);
  });

  for (const before of ['invalid', 'missing']) {
    it(`a valid save not reported yet, after the file was ${before}, holds back the write`, async () => {
      await start({ debounceMs: 0, settleMs: 300 });
      const reported = next(before === 'invalid' ? 'external-invalid' : 'external-missing');
      if (before === 'invalid') await writeFile(file, original.slice(0, 200));
      else await unlink(file);
      await reported;
      await writeFile(file, variant(2)); // not reported yet (settle delay)
      const changed = next('external-change');
      store.write(variant(1));
      assert.deepEqual(await changed, { xml: variant(2), discarded: true });
      assert.equal(await readFile(file, 'utf8'), variant(2));
    });
  }

  it('a write over an invalid file is confirmed only after confirmMs; a valid save before that replaces it (discarded)', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 400 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    const reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200)); // a slow save, half done
    await reported;
    store.write(variant(1));
    await next('written');
    assert.equal(await readFile(file, 'utf8'), variant(1));
    assert.deepEqual(saved, [], 'not confirmed yet');
    const changed = next('external-change');
    await writeFile(file, variant(2)); // the other program finishes its save from its own copy
    assert.deepEqual(await changed, { xml: variant(2), discarded: true });
    await delay(500);
    assert.deepEqual(saved, []);

    // Left alone: confirmed after confirmMs.
    const again = next('external-invalid');
    await writeFile(file, original.slice(0, 300));
    await again;
    store.write(variant(3));
    await next('written');
    await delay(500);
    assert.deepEqual(saved, [variant(3)]);
  });

  it('an unconfirmed write the file no longer holds stays unconfirmed, and flush() keeps it aside', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 200 });
    const saved = [];
    const asides = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    store.on('kept-aside', (a) => asides.push(a));
    let reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200));
    await reported;
    store.write(variant(1));
    await next('written');
    reported = next('external-invalid');
    await writeFile(file, original.slice(0, 300)); // broken again by the other program
    await reported;
    await delay(400);
    assert.deepEqual(saved, [], 'never confirmed: the file does not hold it');
    await store.unwatch();
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), original.slice(0, 300));
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));
  });

  it('flush() also keeps aside an unconfirmed write the file still holds (the other program may finish later)', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 5000 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    const reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200));
    await reported;
    store.write(variant(1));
    await next('written');
    await store.unwatch();
    const started = Date.now();
    await store.flush();
    assert.ok(Date.now() - started < 1000, 'no waiting');
    assert.equal(await readFile(file, 'utf8'), variant(1));
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));
    assert.match(logs.at(-1), /the editor replaced the broken order\.bpmn \d+\.\d s ago; its version was also saved to .*local-bpmn-unsaved/);
  });

  it('an unconfirmed write is confirmed later if the confirm read saw other content but the file then holds ours', async () => {
    // The confirm read can race one of our own writes and return the content before it. Simulated
    // here without the watcher: the file briefly holds something else when the confirm reads it.
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 100 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    const reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200));
    await reported;
    store.write(variant(1));
    await next('written');
    await store.unwatch();
    await writeFile(file, variant(9)); // what the racing read returns
    await delay(130); // the confirm read happened
    assert.deepEqual(saved, []);
    await writeFile(file, variant(1)); // our write has landed
    await delay(150);
    assert.deepEqual(saved, [variant(1)], 'confirmed, not stuck');
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    await store.flush();
    assert.deepEqual(asides, [], 'no side file at a later shutdown');
  });

  it('does not replace an invalid file that is still changing (waits until it settles)', async () => {
    await start({ debounceMs: 0, settleMs: 300 });
    const reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200));
    await reported;
    await writeFile(file, ''); // truncated by another program that is about to write again
    store.write(variant(1));
    await delay(100);
    assert.equal(await readFile(file, 'utf8'), '', 'held back while the file changes');
    await writeFile(file, variant(2));
    const changed = await next('external-change');
    assert.deepEqual(changed, { xml: variant(2), discarded: true });
    assert.equal(await readFile(file, 'utf8'), variant(2));
  });

  it('still replaces a file that is still invalid', async () => {
    await start({ debounceMs: 0, settleMs: 100 });
    const reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200));
    await reported;
    store.write(variant(1));
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(1));
  });

  it('a touched file (same content, new mtime) does not hold back a write', async () => {
    await start({ debounceMs: 0, settleMs: 60_000 });
    const now = new Date(Date.now() + 5000);
    await utimes(file, now, now);
    store.write(variant(1));
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), variant(1));
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
