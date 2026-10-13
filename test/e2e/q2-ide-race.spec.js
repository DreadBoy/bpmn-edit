// Q2: an edit in the browser racing a save made on disk by another program (an IDE). Neither side is
// ever lost silently: the change on disk becomes the base and browser edits not yet on disk are
// re-applied on top of it (per element, as for concurrent windows); a true same-element conflict keeps
// the file's version and says so in the window whose edit lost; at shutdown, if nobody can re-apply
// any more, the file keeps its content and the editor's version is saved next to it.
import { expect, test } from '@playwright/test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectPageErrors, startCli } from './helpers/cli.js';
import { dragBy, expectNoTempFiles, git, label, status, typeLabel } from './helpers/editor.js';
import {
  ackAfter, asideFiles, ideRename, nameInXml, openWindow, renameInXml, setupRepoWithAutocrlf, toastsSince, windowNames,
} from './helpers/q2.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const IDS = ['Task_ShipOrder', 'Task_CheckStock'];

function toast(page) {
  return page.locator('#toast');
}

test.describe('Q2: browser edits racing a save on disk', () => {
  let fixture;
  let cli;
  let windows;

  async function start({ writeDelay, autocrlf = 'false', count = 2 } = {}) {
    fixture = await setupRepoWithAutocrlf(autocrlf);
    cli = await startCli(fixture.file, { cwd: fixture.dir, args: writeDelay === undefined ? [] : ['--write-delay', String(writeDelay)] });
    return { cli, fixture };
  }

  async function open(browser, count = 2) {
    windows = [];
    for (let i = 0; i < count; i++) windows.push(await openWindow(browser, cli));
    return windows.map((w) => w.page);
  }

  /** Renames "Ship order" in `page` like a user and waits until the host accepted it; resolves to the ack time. */
  async function renameInBrowser(page, name) {
    const before = Date.now();
    await typeLabel(page, 'Task_ShipOrder', name);
    return ackAfter(page, before);
  }

  const disk = () => readFile(fixture.file, 'utf8');

  test.afterEach(async () => {
    for (const w of windows ?? []) await w.context.close().catch(() => {});
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
    windows = undefined;
  });

  test('an accepted edit still waiting for its write is re-applied on top of a save on disk: both kept everywhere', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const original = await disk();
    const t0 = Date.now();

    await renameInBrowser(A, 'Ship parcel');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship parcel');
    expect(await disk()).toBe(original); // accepted, not written yet

    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    await expect.poll(async () => {
      const xml = await disk();
      return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
    }, { timeout: 6000 }).toEqual(['Ship parcel', 'Check stock levels']);

    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      expect(await windowNames(page, IDS)).toEqual({ Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels' });
    }
    // Told in the window whose edit was re-applied; B saw the reload from disk.
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('merged');
    await expect(toast(A)).toContainText('changed on disk');
    const diff = git(fixture.dir, 'diff');
    expect(diff).toContain('+    <bpmn:task id="Task_ShipOrder" name="Ship parcel">');
    expect(diff).toContain('+    <bpmn:task id="Task_CheckStock" name="Check stock levels">');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a save on disk inside the settle delay, just before the host writes, is never overwritten (autocrlf=input)', async ({ browser }) => {
    // Host write 100 ms after accepting, sooner than the watcher's 150 ms settle delay: the write
    // itself has to notice the change.
    await start({ writeDelay: 100, autocrlf: 'input' });
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];

    await renameInBrowser(A, 'Ship parcel');
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    // From now on, every state of the file has the change made on disk.
    const samples = [];
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      samples.push(nameInXml(await disk(), 'Task_CheckStock'));
      await delay(5);
    }
    expect(samples.filter((name) => name !== 'Check stock levels')).toEqual([]);
    const xml = await disk();
    expect(nameInXml(xml, 'Task_ShipOrder')).toBe('Ship parcel');
    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      expect(await windowNames(page, IDS)).toEqual({ Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels' });
    }
    await expect(toast(A)).toHaveAttribute('data-kind', 'merged');
    expect(git(fixture.dir, 'status', '--porcelain')).toBe(' M order.bpmn\n');
    expect(errors).toEqual([]);
  });

  for (const before of ['invalid', 'missing']) {
    test(`a valid save just before the host writes, after the file was ${before}, is not overwritten`, async ({ browser }) => {
      // Write delay below the settle delay: the host's own write has to notice the save.
      await start({ writeDelay: 100 });
      const [A, B] = await open(browser);
      const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
      const original = await disk();
      if (before === 'invalid') await writeFile(fixture.file, original.slice(0, original.length / 2));
      else await unlink(fixture.file);
      await expect(A.locator('#notice')).toHaveAttribute('data-kind', before, { timeout: 2000 });

      await renameInBrowser(A, 'Ship parcel');
      await writeFile(fixture.file, renameInXml(original, 'Task_CheckStock', 'Check stock levels'));
      await expect.poll(async () => {
        const xml = await disk().catch(() => '');
        return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
      }, { timeout: 4000 }).toEqual(['Ship parcel', 'Check stock levels']);
      for (const page of [A, B]) {
        await expect(status(page)).toHaveAttribute('data-state', 'saved');
        expect(await windowNames(page, IDS)).toEqual({ Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels' });
        await expect(page.locator('#notice')).not.toHaveAttribute('data-kind', before);
      }
      await expect(toast(A)).toHaveAttribute('data-kind', 'merged');
      expect(errors).toEqual([]);
    });
  }

  test('a slow save on disk that finishes after the host replaced the half-written file: the edit is re-applied on it', async ({ browser }) => {
    await start();
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const original = await disk();
    const ideCopy = renameInXml(original, 'Task_CheckStock', 'Check stock levels');

    await writeFile(fixture.file, ideCopy.slice(0, ideCopy.length / 2)); // the IDE has written half
    await expect(A.locator('#notice')).toHaveAttribute('data-kind', 'invalid', { timeout: 2000 });
    await renameInBrowser(A, 'Ship parcel');
    // Replacing a broken file is allowed: the host writes the edit over it...
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 2000 }).toBe('Ship parcel');
    // ...then the IDE finishes its save from its own copy (without the edit).
    await writeFile(fixture.file, ideCopy);

    await expect.poll(async () => {
      const xml = await disk();
      return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
    }, { timeout: 4000 }).toEqual(['Ship parcel', 'Check stock levels']);
    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      expect(await windowNames(page, IDS)).toEqual({ Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels' });
    }
    await expect(toast(A)).toHaveAttribute('data-kind', 'merged');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Ctrl-C while the slow save has broken the file again: the edit written over it is kept next to the file', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const original = await disk();
    const ideCopy = renameInXml(original, 'Task_CheckStock', 'Check stock levels');

    await writeFile(fixture.file, ideCopy.slice(0, ideCopy.length / 2));
    await expect(A.locator('#notice')).toHaveAttribute('data-kind', 'invalid', { timeout: 2000 });
    await renameInBrowser(A, 'Ship parcel');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 2000 }).toBe('Ship parcel');
    await delay(300);
    const broken = ideCopy.slice(0, 1000);
    await writeFile(fixture.file, broken); // the IDE is at it again
    await delay(50);
    cli.child.kill('SIGINT');
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    expect(await disk()).toBe(broken); // left alone: the IDE is still writing it
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain(`the editor's version was saved to ${join(fixture.dir, aside[0])}`);
  });

  for (const pendingEdit of [false, true]) {
    test(`Ctrl-C soon after the host replaced a half-written file, the IDE finishing after exit${pendingEdit ? ' (and a second edit still waiting for its write)' : ''}: nothing is lost`, async ({ browser }) => {
      await start();
      const [A] = await open(browser, 1);
      const original = await disk();
      const ideCopy = renameInXml(original, 'Task_CheckStock', 'Check stock levels');

      await writeFile(fixture.file, ideCopy.slice(0, ideCopy.length / 2));
      await expect(A.locator('#notice')).toHaveAttribute('data-kind', 'invalid', { timeout: 2000 });
      await renameInBrowser(A, 'Ship parcel');
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 2000 }).toBe('Ship parcel');
      if (pendingEdit) {
        // Accepted, still in the host's write debounce when the signal arrives: written by the flush.
        const before = Date.now();
        await typeLabel(A, 'Task_CancelOrder', 'Cancel and refund');
        await ackAfter(A, before);
      } else {
        await delay(300);
      }
      const t0 = Date.now();
      cli.child.kill('SIGINT');
      expect(await cli.exited).toEqual({ code: 0, signal: null });
      expect(Date.now() - t0).toBeLessThan(1500); // no waiting
      await delay(100);
      await writeFile(fixture.file, ideCopy); // the IDE finishes from its own copy, after the host exited

      const aside = await asideFiles(fixture.dir);
      expect(aside).toHaveLength(1);
      const kept = await readFile(join(fixture.dir, aside[0]), 'utf8');
      expect(nameInXml(kept, 'Task_ShipOrder')).toBe('Ship parcel');
      if (pendingEdit) expect(nameInXml(kept, 'Task_CancelOrder')).toBe('Cancel and refund');
      expect(cli.stderr()).toContain(`also saved to ${join(fixture.dir, aside[0])}`);
      expect(nameInXml(await disk(), 'Task_CheckStock')).toBe('Check stock levels');
    });
  }

  test('a normal Ctrl-C is not delayed and keeps nothing aside', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    const [A] = await open(browser, 1);
    await renameInBrowser(A, 'Ship parcel');
    const t0 = Date.now();
    cli.child.kill('SIGINT');
    expect(await cli.exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(nameInXml(await disk(), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(cli.stderr()).not.toContain('warning');
  });

  test('a save on disk that already contains the edit (IDE reloaded it) does not report a false conflict', async ({ browser }) => {
    await start();
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const original = await disk();
    const shipY = (xml) => Number(/id="Task_ShipOrder_di"[^>]*>\s*<dc:Bounds x="[^"]+" y="([^"]+)"/.exec(xml)?.[1]);
    const y0 = shipY(original);

    await writeFile(fixture.file, original.slice(0, original.length / 2));
    await expect(A.locator('#notice')).toHaveAttribute('data-kind', 'invalid', { timeout: 2000 });
    const t0 = Date.now();
    await dragBy(A, 'Task_ShipOrder', 70);
    await expect.poll(async () => shipY(await disk()), { timeout: 2000 }).toBeGreaterThan(y0 + 40);
    const moved = shipY(await disk());
    await delay(400);
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels'); // from the reloaded file

    await expect(label(A, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: 3000 });
    await expect(label(B, 'Task_CheckStock')).toHaveText('Check stock levels');
    await delay(1000);
    const xml = await disk();
    expect(nameInXml(xml, 'Task_CheckStock')).toBe('Check stock levels');
    expect(shipY(xml)).toBe(moved);
    expect((await toastsSince(A, t0)).filter((t) => t.kind === 'conflict' || t.kind === 'dropped')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a save on disk replacing the unwritten edit of a window that has closed: the edit is kept next to the file', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    const [A, B] = await open(browser);
    const errorsB = collectPageErrors(B);

    await renameInBrowser(A, 'Ship parcel');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship parcel');
    await windows[0].context.close(); // nobody left to re-apply A's edit
    windows.shift();
    await delay(300);
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');

    await expect.poll(() => cli.stderr(), { timeout: 3000 }).toContain("the editor's version was saved to");
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(cli.stderr()).toContain(`the editor's version was saved to ${join(fixture.dir, aside[0])}`);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    await expect(label(B, 'Task_CheckStock')).toHaveText('Check stock levels');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship order');
    await delay(2500); // past the write delay: the file keeps the save
    const xml = await disk();
    expect([nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')]).toEqual(['Ship order', 'Check stock levels']);
    expect(errorsB).toEqual([]);
  });

  test('a browser edit right after a save on disk is applied on top of it', async ({ browser }) => {
    await start();
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];

    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    await typeLabel(A, 'Task_ShipOrder', 'Ship parcel'); // before the host has noticed the save
    await expect.poll(async () => {
      const xml = await disk();
      return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
    }, { timeout: 4000 }).toEqual(['Ship parcel', 'Check stock levels']);
    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      expect(await windowNames(page, IDS)).toEqual({ Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels' });
    }
    expect(cli.stderr()).not.toContain('replaced a change made on disk');
    expect(errors).toEqual([]);
  });

  test('the same label changed in the browser and on disk: the file wins, and the browser says so', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];

    await renameInBrowser(A, 'Ship parcel');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship parcel');
    await ideRename(fixture.file, 'Task_ShipOrder', 'Ship by courier');

    await expect(toast(A)).toHaveAttribute('data-kind', 'conflict', { timeout: 4000 });
    await expect(toast(A)).toHaveText('Your change to “Ship order” was not applied: it was changed on disk at the same time (the file\'s version was kept)');
    for (const page of [A, B]) {
      await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship by courier');
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
    }
    await delay(2500); // past the write delay: nothing overwrites the file
    expect(nameInXml(await disk(), 'Task_ShipOrder')).toBe('Ship by courier');
    expect(errors).toEqual([]);
  });

  test('Ctrl-C right after a save on disk still merges the edit waiting for its write', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    const [A] = await open(browser);
    const errors = collectPageErrors(A);

    await renameInBrowser(A, 'Ship parcel');
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    cli.child.kill('SIGINT'); // the real node process (spawned with process.execPath)
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    const xml = await disk();
    expect(nameInXml(xml, 'Task_ShipOrder')).toBe('Ship parcel');
    expect(nameInXml(xml, 'Task_CheckStock')).toBe('Check stock levels');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Ctrl-C after a save on disk with no window left: the file keeps the save, the edit is kept next to it', async ({ browser }) => {
    await start({ writeDelay: 5000 });
    const [A] = await open(browser, 1);

    await renameInBrowser(A, 'Ship parcel');
    await windows[0].context.close(); // nobody left to re-apply the edit
    windows = [];
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    cli.child.kill('SIGINT');
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    const xml = await disk();
    expect(nameInXml(xml, 'Task_CheckStock')).toBe('Check stock levels');
    expect(nameInXml(xml, 'Task_ShipOrder')).toBe('Ship order');
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^order\.local-bpmn-unsaved-\d{8}-\d{6}\.bpmn$/);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain(`the editor's version was saved to ${join(fixture.dir, aside[0])}`);
    expect(git(fixture.dir, 'status', '--porcelain')).toContain(`?? ${aside[0]}`);
  });
});
