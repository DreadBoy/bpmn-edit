import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, lstat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { containsChanges, createFileStore, looksStale, sha256, TEMP_FILE_RE } from '../../src/file.js';

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
    dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-store-'));
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
    assert.match(logs[0], /^bpmn-edit: Could not write /);
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
    dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-watch-'));
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
    assert.match(asides[0].path, /order\.bpmn-edit-unsaved-\d{8}-\d{6}\.bpmn$/);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1), 'the editor version is saved aside');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^bpmn-edit: warning: .* changed on disk while the editor's last changes were being saved; .*saved to .*bpmn-edit-unsaved/);
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

  it('a slow save in place through one file descriptor, finished after our write replaced the file: it is put back and reported (discarded)', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 400 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    const ide = variant('ide');
    const half = Math.floor(ide.length / 2);
    const reported = next('external-invalid');
    const handle = await open(file, 'w'); // the other program truncates and writes half
    await handle.write(ide.slice(0, half));
    await reported;
    store.write(variant(1));
    await next('written');
    assert.equal(await readFile(file, 'utf8'), variant(1));
    const changed = next('external-change');
    await handle.write(ide.slice(half), half); // the rest goes to the file we replaced
    await handle.close();
    assert.deepEqual(await changed, { xml: ide, discarded: true });
    assert.equal(await readFile(file, 'utf8'), ide, 'the save is back in place');
    assert.match(logs.join(''), /another program finished saving .*order\.bpmn after the editor had replaced the half-written file/);
    await delay(600);
    assert.deepEqual(saved, [], 'our write was never confirmed');
    assert.deepEqual(await readdir(dir), ['order.bpmn']);
  });

  it('a write over a broken file stays unconfirmed while the file it replaced is still being written', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 300 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    const reported = next('external-invalid');
    const handle = await open(file, 'w');
    await handle.write(original.slice(0, 200));
    await reported;
    store.write(variant(1));
    await next('written');
    for (let i = 0; i < 4; i++) { // keeps writing (still incomplete) for longer than confirmMs
      await delay(150);
      await handle.write('<!-- more -->');
    }
    assert.deepEqual(saved, [], 'not confirmed while the replaced file changes');
    await handle.close();
    await delay(700); // left alone for confirmMs: confirmed
    assert.deepEqual(saved, [variant(1)]);
    assert.equal(await readFile(file, 'utf8'), variant(1));
  });

  it('flush() puts back a save finished in the replaced file and keeps our version aside', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 5000 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    const ide = variant('ide');
    const half = Math.floor(ide.length / 2);
    const reported = next('external-invalid');
    const handle = await open(file, 'w');
    await handle.write(ide.slice(0, half));
    await reported;
    store.write(variant(1));
    await next('written');
    await handle.write(ide.slice(half), half);
    await handle.close();
    await store.unwatch();
    await store.flush(); // right away: not settled yet, read anyway
    assert.equal(await readFile(file, 'utf8'), ide);
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));
  });

  it('flush() looks again right after its last write: a save from a stale copy just after it keeps ours aside', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    await store.unwatch();
    store.write(variant(1));
    const flushed = store.flush();
    await next('written');
    await writeFile(file, variant(2)); // another program saves its copy (without our change) right after
    const started = Date.now();
    await flushed;
    assert.ok(Date.now() - started < 1000);
    assert.equal(await readFile(file, 'utf8'), variant(2));
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));
    assert.match(logs.at(-1), /another program saved .*order\.bpmn right after the editor's last save/);
  });

  it('flush() keeps nothing aside when the save right after its last write contains that write', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    await store.unwatch();
    store.write(variant(1));
    const flushed = store.flush();
    await next('written');
    const fresh = variant(1).replace('name="Ship order"', 'name="Ship it"'); // made from our version
    await writeFile(file, fresh);
    await flushed;
    assert.equal(await readFile(file, 'utf8'), fresh);
    assert.deepEqual(asides, []);
  });

  it('a save from an older copy shortly after our write is taken, and our version kept aside (reason stale)', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    store.write(variant(1));
    await next('written');
    const changed = next('external-change');
    await writeFile(file, original.replace('name="Ship order"', 'name="Ship it"')); // its copy predates our write
    assert.deepEqual(await changed, { xml: original.replace('name="Ship order"', 'name="Ship it"'), stale: true });
    await delay(100);
    assert.equal(asides.length, 1);
    assert.equal(asides[0].reason, 'stale');
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));
    assert.match(logs.at(-1), /was saved on disk from a copy without the editor's last changes; the file keeps that save/);

    // A save made from our version (it has our change) is not reported.
    const ours2 = original.replace('name="Ship order"', 'name="Ship it"').replace('name="Check stock"', 'name="Check stock 2"');
    store.write(ours2);
    await next('written');
    const fresh = next('external-change');
    await writeFile(file, ours2.replace('name="Cancel order"', 'name="Cancel it"'));
    await fresh;
    await delay(100);
    assert.equal(asides.length, 1);
  });

  it('a stale save is judged against all our recent writes, not only the last one', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    const added = original.replace(/( *)<bpmn:task id="Task_CancelOrder"/, '$1<bpmn:task id="Task_New" />\n$1<bpmn:task id="Task_CancelOrder"');
    store.write(added); // first write: a new task
    await next('written');
    store.write(added.replace('<bpmn:task id="Task_New" />', '<bpmn:task id="Task_New" name="Named" />')); // then its name
    await next('written');
    const changed = next('external-change');
    await writeFile(file, original.replace('name="Check stock"', 'name="Check it"')); // copy from before both
    assert.equal((await changed).stale, true);
    await delay(100);
    assert.equal(asides.length, 1);
    assert.match(await readFile(asides[0].path, 'utf8'), /name="Named"/);
  });

  it('a stale save that also replaces a pending write: kept aside with the pending content, flagged stale and discarded', async () => {
    await start({ debounceMs: 400, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    store.write(variant(1));
    await next('written');
    store.write(variant(1).replace('name="Ship order"', 'name="Ship parcel"')); // pending (debounce)
    const changed = next('external-change');
    await writeFile(file, original.replace('name="Cancel order"', 'name="Cancel it"')); // predates both
    const event = await changed;
    assert.equal(event.discarded, true);
    assert.equal(event.stale, true);
    await delay(100);
    assert.equal(asides.length, 1);
    const kept = await readFile(asides[0].path, 'utf8');
    assert.match(kept, /name="Check stock 1"/);
    assert.match(kept, /name="Ship parcel"/);
  });

  it('a normal write during an unconfirmed one keeps the replaced file of the unconfirmed write watched', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 3000 });
    const ide = variant('ide');
    const half = Math.floor(ide.length / 2);
    const reported = next('external-invalid');
    const handle = await open(file, 'w');
    await handle.write(ide.slice(0, half));
    await reported;
    store.write(variant(1)); // replaces the half-written file (unconfirmed, watched)
    await next('written');
    store.write(variant(2)); // a normal write over our own file
    await next('written');
    const changed = next('external-change');
    await handle.write(ide.slice(half), half); // the rest goes to the file replaced by the first write
    await handle.close();
    assert.deepEqual(await changed, { xml: ide, discarded: true });
    assert.equal(await readFile(file, 'utf8'), ide);
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes('.bpmn-edit-replaced-')), []);
  });

  it('a second flush() waits for the one running and keeps nothing aside twice', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    await store.unwatch();
    store.write(variant(1));
    const first = store.flush({ final: true });
    await next('written');
    setTimeout(() => writeFile(file, variant(2)), 60); // a stale save right after the final write
    await delay(200);
    const second = store.flush({ final: true }); // e.g. a second Ctrl-C, before the first looked again
    await second;
    assert.equal(asides.length, 1, 'the first flush looked again before the second returned');
    await first;
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), variant(1));
  });

  it('looksStale: an element we changed has its base form again in the save (element level, by id)', () => {
    const before = '<a>\n  <t id="1" name="x"/>\n</a>\n';
    const ours = '<a>\n  <t id="1" name="y"/>\n</a>\n';
    assert.equal(looksStale('<a>\n  <t id="1" name="x"/>\n  <u id="9"/>\n</a>\n', before, ours), true, 'old label back');
    assert.equal(looksStale('<a>\n  <t id="1" name="z"/>\n</a>\n', before, ours), false, 'renamed again from our version');
    assert.equal(looksStale('<a>\n  <t name="y" id="1"></t>\n  <u id="9"/>\n</a>\n', before, ours), false, 'fresh, reformatted');
    const added = '<a>\n  <t id="1" name="x"/>\n  <n id="2"><b x="1"/></n>\n</a>\n';
    assert.equal(looksStale('<a>\n  <t id="1" name="q"/>\n</a>\n', before, added), true, 'added element missing');
    assert.equal(looksStale('<a>\n  <t id="1" name="q"/>\n  <n id="2"><b x="1"/></n>\n</a>\n', before, added), false);
    const withDeleted = '<a>\n  <t id="1" name="x"/>\n  <e id="2"/>\n</a>\n';
    assert.equal(looksStale(withDeleted, withDeleted, before), true, 'deleted element back');
    // Two writes in a row (added, then named): against the base before the first, the old copy lacks it.
    assert.equal(looksStale(before.replace('name="x"', 'name="w"'), before, added.replace('<n id="2">', '<n id="2" name="N">')), true);
    // A copy from between two of our writes (it has the first, not the second) is old too.
    const middle = '<a>\n  <t id="1" name="m"/>\n</a>\n';
    assert.equal(looksStale('<a><t id="1" name="m"/><u id="9"/></a>', before, ours, [middle]), true, 'copy from between');
    assert.equal(looksStale('<a><t id="1" name="m"/><u id="9"/></a>', before, ours), false, 'without the history: looks concurrent');
    assert.equal(looksStale('<a/>', null, ours), false, 'unknown before');
    assert.equal(looksStale('<a><t id="1" name="x"/>', before, ours), true, 'not readable: keep a copy');
  });

  it('looksStale: an older copy that also changed an element we changed still counts as old (per attribute and child)', () => {
    // DEF-E1: we renamed the task; the other program saves its older copy with its own change to that
    // same task (documentation, a new outgoing): the old name is back, so the save is old.
    const base = '<p id="p">\n  <t id="1" name="x">\n    <in>f0</in>\n  </t>\n</p>\n';
    const ours = base.replace('name="x"', 'name="y"');
    const doc = (xml) => xml.replace('<in>f0</in>', '<in>f0</in><documentation>D</documentation>');
    const out = (xml) => xml.replace('<in>f0</in>', '<in>f0</in><out>f9</out>');
    assert.equal(looksStale(doc(base), base, ours), true, 'old name, with documentation added');
    assert.equal(looksStale(out(base), base, ours), true, 'old name, with an outgoing added');
    assert.equal(looksStale(doc(ours), base, ours), false, 'fresh copy, with documentation added');
    assert.equal(looksStale(doc(base).replace('name="x"', 'name="z"'), base, ours), false, 'renamed again: concurrent');
    // Children we changed count the same way: a moved shape's bounds back as they were.
    const shapeBase = '<s id="s_di"><b x="1" y="1"/></s>';
    const shapeOurs = '<s id="s_di"><b x="5" y="1"/></s>';
    assert.equal(looksStale('<s id="s_di" stroke="red"><b x="1" y="1"/></s>', shapeBase, shapeOurs), true, 'old bounds, new colour');
    assert.equal(looksStale('<s id="s_di" stroke="red"><b x="5" y="1"/></s>', shapeBase, shapeOurs), false, 'our bounds, new colour');
    // A child we added (an outgoing of an appended flow) missing from an element the save changed.
    const appended = base.replace('<in>f0</in>', '<in>f0</in><out>f1</out>');
    assert.equal(looksStale(doc(base), base, appended), true, 'our outgoing missing, documentation added');
    assert.equal(looksStale(doc(appended), base, appended), false, 'our outgoing there, documentation added');
    // A copy from between two of our writes, with its own change to the element: old too.
    const middle = base.replace('name="x"', 'name="m"');
    const twice = base.replace('name="x"', 'name="n"');
    assert.equal(looksStale(doc(middle), base, twice, [middle]), true, 'from between, with documentation added');
    // An attribute we added (base: absent) is missing again.
    const marked = base.replace('<t id="1"', '<t id="1" default="f0"');
    assert.equal(looksStale(doc(base), base, marked), true, 'attribute we added missing');
    // Duplicate ids are compared as a whole only.
    const dup = '<p id="p"><t id="1" name="x"/><t id="1" name="q"/></p>';
    assert.equal(looksStale(dup.replace('name="q"/>', 'name="q"><d/></t>'), dup, dup.replace('name="x"', 'name="y"')), false);
  });

  it('containsChanges: every element our write changed has our form in the save (element level, by id)', () => {
    const base = '<p id="p">\n  <t id="1" name="x"/>\n  <e id="2"><b x="1"/></e>\n</p>\n';
    const ours = '<p id="p">\n  <t id="1" name="y"/>\n</p>\n'; // renamed 1, deleted 2
    assert.equal(containsChanges('<p id="p"><t id="1" name="y"/><n id="3"/></p>', base, ours), true, 'fresh, with an addition');
    assert.equal(containsChanges('<p id="p"><t id="1" name="x"/></p>', base, ours), false, 'rename undone');
    assert.equal(containsChanges('<p id="p"><t id="1" name="y"/><e id="2"><b x="1"/></e></p>', base, ours), false, 'delete undone');
    assert.equal(containsChanges('<p id="p"><t id="1" name="z"/></p>', base, ours), false, 'renamed again: not ours');
    assert.equal(containsChanges('<p id="p"><t id="1" name="y"/>', base, ours), false, 'not readable');
    assert.equal(containsChanges('<p id="p"><t id="1" name="y"/></p>', null, ours), false, 'unknown base');
    assert.equal(containsChanges(null, base, ours), false);
    // Formatting does not count: attribute order, indentation, CRLF, expanded empty elements.
    assert.equal(containsChanges('<p id="p">\r\n    <t name="y" id="1"></t>\r\n</p>\r\n', base, ours), true, 'fresh, reformatted');
    // Lines without an id (bounds, waypoints, closing tags) belong to their element: a fresh save
    // that adds a shape next to a delete is not mistaken for an old copy.
    const diBase = '<d id="d"><s id="a_di"><b x="1"/></s><s id="b_di"><b x="2"/></s></d>';
    const diOurs = '<d id="d"><s id="a_di"><b x="1"/></s></d>';
    assert.equal(containsChanges('<d id="d"><s id="a_di"><b x="1"/></s><s id="c_di"><b x="2"/></s></d>', diBase, diOurs), true);
  });

  it('flush() keeps ours aside when a stale save right after its last write brings a deleted element back', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    await store.unwatch();
    const withoutTask = original.replace(/ *<bpmn:task id="Task_CancelOrder"[\s\S]*?<\/bpmn:task>\n/, '');
    assert.notEqual(withoutTask, original);
    store.write(withoutTask);
    const flushed = store.flush();
    await next('written');
    await writeFile(file, variant(2)); // a copy from before the delete, with another change
    await flushed;
    assert.equal(await readFile(file, 'utf8'), variant(2));
    assert.equal(asides.length, 1);
    assert.equal(await readFile(asides[0].path, 'utf8'), withoutTask);
  });

  it('flush() waits for a save still being written right after its last write, then judges it', async () => {
    await start({ debounceMs: 0, settleMs: 50 });
    const asides = [];
    store.on('kept-aside', (a) => asides.push(a));
    await store.unwatch();
    store.write(variant(1));
    const flushed = store.flush();
    await next('written');
    const fresh = variant(1).replace('name="Ship order"', 'name="Ship it"'); // made from our version
    await writeFile(file, fresh.slice(0, 300)); // half written at the re-check
    setTimeout(() => writeFile(file, fresh), 400);
    await flushed;
    assert.equal(await readFile(file, 'utf8'), fresh);
    assert.deepEqual(asides, [], 'it contains our change: nothing kept aside');
  });

  it('a write that finds the file missing is unconfirmed: a save arriving afterwards is reported as replacing it', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 400 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    await unlink(file); // deleted just before our write, not reported yet
    store.write(variant(1));
    await next('written');
    assert.equal(await readFile(file, 'utf8'), variant(1));
    assert.deepEqual(saved, [], 'not confirmed');
    const changed = next('external-change');
    await writeFile(file, variant(2)); // the program that removed it writes its own copy
    assert.deepEqual(await changed, { xml: variant(2), discarded: true });
    await delay(500);
    assert.deepEqual(saved, []);
  });

  it('a write that finds the file missing is confirmed after confirmMs if nothing else happens', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 300 });
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    await unlink(file);
    store.write(variant(1));
    await next('written');
    await delay(700);
    assert.deepEqual(saved, [variant(1)]);
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
    assert.match(logs.at(-2), /the editor replaced the broken order\.bpmn \d+\.\d s ago; its version was also saved to .*bpmn-edit-unsaved/);
    // The half-written file it replaced is kept under a second name (its writer may finish after exit).
    const replaced = (await readdir(dir)).filter((n) => /^order\.bpmn-edit-replaced-\d{8}-\d{6}\.bpmn$/.test(n));
    assert.equal(replaced.length, 1);
    assert.equal(await readFile(join(dir, replaced[0]), 'utf8'), original.slice(0, 200));
    assert.match(logs.at(-1), /the half-written order\.bpmn the editor replaced was kept as .*order\.bpmn-edit-replaced-/);
  });

  it('the second name of a replaced broken file is removed once the write is confirmed, or a save there put back', async () => {
    await start({ debounceMs: 0, settleMs: 50, confirmMs: 300 });
    const replacedFiles = async () => (await readdir(dir)).filter((n) => n.includes('.bpmn-edit-replaced-'));
    let reported = next('external-invalid');
    await writeFile(file, original.slice(0, 200));
    await reported;
    store.write(variant(1));
    await next('written');
    assert.equal((await replacedFiles()).length, 1, 'kept while unconfirmed');
    await delay(700);
    assert.deepEqual(await replacedFiles(), [], 'confirmed: removed');

    // Put back (a slow save through one descriptor): removed too.
    const ide = variant('ide');
    reported = next('external-invalid');
    const handle = await open(file, 'w');
    await handle.write(ide.slice(0, 300));
    await reported;
    store.write(variant(2));
    await next('written');
    assert.equal((await replacedFiles()).length, 1);
    const changed = next('external-change');
    await handle.write(ide.slice(300), 300);
    await handle.close();
    await changed;
    assert.deepEqual(await replacedFiles(), []);

    // A save by path while unconfirmed (discarded): removed too.
    reported = next('external-invalid');
    await writeFile(file, original.slice(0, 250));
    await reported;
    store.write(variant(3));
    await next('written');
    const again = next('external-change');
    await writeFile(file, variant(4));
    await again;
    assert.deepEqual(await replacedFiles(), []);
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
