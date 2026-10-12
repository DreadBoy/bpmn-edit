import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readdir, readFile, rm, stat, symlink, lstat } from 'node:fs/promises';
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
