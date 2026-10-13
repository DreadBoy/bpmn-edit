// Q2: an edit in the browser racing a save made on disk by another program (an IDE). Neither side is
// ever lost silently: the change on disk becomes the base and browser edits not yet on disk are
// re-applied on top of it (per element, as for concurrent windows); a true same-element conflict keeps
// the file's version and says so in the window whose edit lost; at shutdown, if nobody can re-apply
// any more, the file keeps its content and the editor's version is saved next to it.
import { expect, test } from '@playwright/test';
import { open as openFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { collectPageErrors, startCli } from './helpers/cli.js';
import {
  clickEmptyCanvas, dragBy, dragNewTask, expectNoTempFiles, git, label, status, typeLabel,
} from './helpers/editor.js';
import {
  ackAfter, asideFiles, ideRename, instrument, nameInXml, openWindow, renameInXml, setupRepoWithAutocrlf, toastsSince,
  windowNames,
} from './helpers/q2.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const IDS = ['Task_ShipOrder', 'Task_CheckStock'];

/** Side files holding the editor's version (`<name>.local-bpmn-unsaved-<time>.bpmn`). */
async function unsavedFiles(dir) {
  return (await asideFiles(dir)).filter((n) => /\.local-bpmn-unsaved-\d{8}-\d{6}(-\d+)?\.bpmn$/.test(n));
}

/** Broken files the host replaced, kept under a second name at Ctrl-C (`<name>.local-bpmn-replaced-<time>.bpmn`). */
async function replacedFiles(dir) {
  return (await asideFiles(dir)).filter((n) => /\.local-bpmn-replaced-\d{8}-\d{6}(-\d+)?\.bpmn$/.test(n));
}

/** Reconnect schedule for windows whose connection the test cuts (see web/app.js, S8). */
const PATIENT = { delays: [100, 200, 400], jitter: 0, giveUpAttempts: 1000, giveUpMs: 600_000, heartbeatMs: 1000 };

/**
 * Routes a page's WebSocket through the test (as in s8-session.spec.js): cut() closes the page side
 * and leaves the host side open (a dead network path the host has not noticed; cut('closed') closes
 * the host side too), `blocking` refuses new connections, `drop` lists message types from the host
 * that are swallowed.
 */
async function proxy(page) {
  const state = { blocking: false, drop: new Set(), connections: 0, current: null };
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    state.connections += 1;
    if (state.blocking) {
      ws.close({ code: 1001, reason: 'test: no connection' });
      return;
    }
    state.url = ws.url();
    const server = ws.connectToServer();
    const conn = { ws, server, cut: false };
    state.current = conn;
    ws.onClose((code, reason) => { if (!conn.cut) server.close({ code, reason }); });
    server.onClose((code, reason) => { if (!conn.cut) ws.close({ code, reason }); });
    ws.onMessage((message) => { if (!conn.cut) server.send(message); });
    server.onMessage((message) => {
      if (conn.cut || state.drop.has(JSON.parse(String(message)).type)) return;
      ws.send(message);
    });
  });
  return {
    state,
    cut(mode = 'silent') {
      state.current.cut = true;
      if (mode === 'closed') state.current.server.close({ code: 1000, reason: 'test: connection lost' });
      state.current.ws.close({ code: 1001, reason: 'test: connection lost' });
    },
  };
}

function toast(page) {
  return page.locator('#toast');
}

test.describe('Q2: browser edits racing a save on disk', () => {
  let fixture;
  let cli;
  let windows;

  async function start({ writeDelay, autocrlf = 'false', env = {} } = {}) {
    fixture = await setupRepoWithAutocrlf(autocrlf);
    cli = await startCli(fixture.file, {
      cwd: fixture.dir, args: writeDelay === undefined ? [] : ['--write-delay', String(writeDelay)], env,
    });
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
    const aside = await unsavedFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(await replacedFiles(fixture.dir)).toHaveLength(1); // the half-written file it had replaced
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

      const aside = await unsavedFiles(fixture.dir);
      expect(aside).toHaveLength(1);
      // The half-written file the host had replaced is kept under a second name too (whoever was
      // writing it through an open descriptor finishes there).
      const replaced = await replacedFiles(fixture.dir);
      expect(replaced).toHaveLength(1);
      expect(await readFile(join(fixture.dir, replaced[0]), 'utf8')).toBe(ideCopy.slice(0, ideCopy.length / 2));
      expect(cli.stderr()).toContain(`the half-written order.bpmn the editor replaced was kept as ${join(fixture.dir, replaced[0])}`);
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
    // The edit waits for its window to reconnect (LOCAL_BPMN_REAPPLY_GRACE_MS, default 20 s) first.
    await start({ writeDelay: 2000, env: { LOCAL_BPMN_REAPPLY_GRACE_MS: '500' } });
    const [A, B] = await open(browser);
    const errorsB = collectPageErrors(B);

    await renameInBrowser(A, 'Ship parcel');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship parcel');
    await windows[0].context.close(); // nobody left to re-apply A's edit
    windows.shift();
    await delay(300);
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');

    await expect.poll(() => cli.stderr(), { timeout: 3000 }).toContain('the window that made them is disconnected');
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

  /** Opens a window whose WebSocket goes through proxy(); resolves to { page, net }. */
  async function openProxied(browser) {
    const context = await browser.newContext();
    await context.addInitScript((p) => { window.localBpmnTestConnection = p; }, PATIENT);
    const page = await context.newPage();
    windows.push({ context, page });
    await instrument(page);
    const net = await proxy(page);
    await page.goto(cli.url);
    await expect(status(page)).toHaveText('Saved');
    return { page, net };
  }

  test('a save on disk replaced the accepted edit of a window that was disconnected: it re-applies it on reconnect, with its offline edit', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    windows = [];
    const { page: A, net } = await openProxied(browser);
    windows.push(await openWindow(browser, cli));
    const B = windows.at(-1).page;
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const original = await disk();
    const t0 = Date.now();

    await renameInBrowser(A, 'Ship parcel');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship parcel');
    expect(await disk()).toBe(original); // accepted, not written yet

    // A's connection dies; the host does not notice (its side stays open), so it does not keep A's
    // edit aside: A has to re-apply it itself.
    net.state.blocking = true;
    net.cut();
    await expect(status(A)).toHaveText('Reconnecting…');
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    // The save replaced the unwritten edit: B shows the file's version.
    await expect(label(B, 'Task_CheckStock')).toHaveText('Check stock levels');
    await expect(label(B, 'Task_ShipOrder')).toHaveText('Ship order');
    expect(cli.stderr()).toContain('changed on disk before the latest edits were saved');
    // An edit made while disconnected.
    await typeLabel(A, 'Task_CancelOrder', 'Cancel order (offline)');
    await expect(status(A)).toHaveText('Reconnecting…');

    net.state.blocking = false;
    await expect.poll(async () => {
      const xml = await disk();
      return ['Task_ShipOrder', 'Task_CheckStock', 'Task_CancelOrder'].map((id) => nameInXml(xml, id));
    }, { timeout: 8000 }).toEqual(['Ship parcel', 'Check stock levels', 'Cancel order (offline)']);
    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      expect(await windowNames(page, [...IDS, 'Task_CancelOrder'])).toEqual({
        Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels', Task_CancelOrder: 'Cancel order (offline)',
      });
    }
    // A says its edits were re-applied on top of the change on disk; nothing was reported as lost.
    const kinds = (await toastsSince(A, t0)).map((t) => t.kind);
    expect(kinds).toContain('merged');
    expect(kinds).not.toContain('conflict');
    expect(kinds).not.toContain('dropped');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    const xml = await disk();
    expect(xml.match(/name="Ship parcel"/g)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('an edit already written before the connection dropped is not re-applied after a reconnect', async ({ browser }) => {
    await start();
    windows = [];
    const { page: A, net } = await openProxied(browser);
    const errors = collectPageErrors(A);
    net.state.drop.add('saved'); // A never hears that its edit was written
    const t0 = Date.now();

    await renameInBrowser(A, 'Ship parcel');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
    await delay(300);
    net.state.blocking = true;
    net.cut();
    await expect(status(A)).toHaveText('Reconnecting…');
    // The IDE changes the same label after the edit was written.
    await ideRename(fixture.file, 'Task_ShipOrder', 'Ship it');
    await delay(500); // the host has taken the change (settle delay 150 ms)
    net.state.blocking = false;

    await expect(label(A, 'Task_ShipOrder')).toHaveText('Ship it', { timeout: 5000 });
    await expect(status(A)).toHaveAttribute('data-state', 'saved');
    await delay(1500); // a re-applied edit would be sent and written within this
    expect(nameInXml(await disk(), 'Task_ShipOrder')).toBe('Ship it');
    await expect(label(A, 'Task_ShipOrder')).toHaveText('Ship it');
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toEqual([]);
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a window whose connection died unnoticed and that closed before re-applying: Ctrl-C keeps its discarded edit next to the file', async ({ browser }) => {
    await start({ writeDelay: 2000 });
    windows = [];
    const { page: A, net } = await openProxied(browser);
    windows.push(await openWindow(browser, cli));
    const B = windows.at(-1).page;

    await renameInBrowser(A, 'Ship parcel');
    net.state.blocking = true;
    net.cut(); // the host still thinks A is connected
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    await expect(label(B, 'Task_CheckStock')).toHaveText('Check stock levels');
    await expect(status(A)).toHaveText('Reconnecting…');
    await expect(status(A)).toHaveAttribute('title', 'Your changes are kept and saved once the connection is back');
    await windows[0].context.close(); // the user gives up on the tab
    windows.shift();
    await delay(300);
    expect(await asideFiles(fixture.dir)).toEqual([]); // still waiting for A (it might reconnect)
    cli.child.kill('SIGINT');
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    const xml = await disk();
    expect([nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')]).toEqual(['Ship order', 'Check stock levels']);
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain(`the editor's version was saved to ${join(fixture.dir, aside[0])}`);
  });

  test('a window the host saw disconnect re-applies its discarded edit on reconnect: no copy is kept aside', async ({ browser }) => {
    await start({ writeDelay: 2000, env: { LOCAL_BPMN_REAPPLY_GRACE_MS: '3000' } });
    windows = [];
    const { page: A, net } = await openProxied(browser);
    const errors = collectPageErrors(A);
    const t0 = Date.now();

    await renameInBrowser(A, 'Ship parcel');
    net.state.blocking = true;
    net.cut('closed'); // the host sees the connection close
    await delay(300);
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    await expect.poll(() => cli.stderr(), { timeout: 3000 })
      .toContain('the window that made them is disconnected: they are re-applied if it reconnects within 3 s');
    net.state.blocking = false;
    await expect.poll(async () => {
      const xml = await disk();
      return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
    }, { timeout: 8000 }).toEqual(['Ship parcel', 'Check stock levels']);
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('merged');
    await delay(3500); // past the grace period
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(cli.stderr()).not.toContain('saved to');
    expect(errors).toEqual([]);
  });

  test('an update whose ack was lost, written, then reverted on disk while the window was away is not re-applied', async ({ browser }) => {
    await start();
    windows = [];
    const { page: A, net } = await openProxied(browser);
    const errors = collectPageErrors(A);
    const original = await disk();
    net.state.drop.add('ack');
    net.state.drop.add('saved');
    const t0 = Date.now();

    await typeLabel(A, 'Task_ShipOrder', 'Ship parcel');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
    await expect(status(A)).toHaveText('Saving…'); // the ack never came
    net.state.blocking = true;
    net.cut();
    await writeFile(fixture.file, original); // reverted, e.g. by a checkout of the committed version
    await delay(500);
    net.state.drop.clear();
    net.state.blocking = false;

    await expect(label(A, 'Task_ShipOrder')).toHaveText('Ship order', { timeout: 5000 });
    await expect(status(A)).toHaveAttribute('data-state', 'saved');
    await delay(1500); // a re-applied edit would be sent and written within this
    expect(await disk()).toBe(original);
    await expect(label(A, 'Task_ShipOrder')).toHaveText('Ship order');
    // A revert this soon after the write looks like a save from an older copy: the file keeps it, the
    // edit is also kept next to it (visible, never lost). A was away when it happened; it is told when
    // it reconnects (init 'staleSaves'), and nothing else is reported.
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    await expect(toast(A)).toHaveText(
      `The file was saved on disk from an older copy, without the latest changes; they were saved next to it as ${aside[0]}`,
    );
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toEqual(['conflict']);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain('was saved on disk from a copy without the editor\'s last changes');
    expect(errors).toEqual([]);
  });

  test('an edit made while disconnected that conflicts with a save on disk is reported with the disk wording', async ({ browser }) => {
    await start();
    windows = [];
    const { page: A, net } = await openProxied(browser);
    const errors = collectPageErrors(A);
    const t0 = Date.now();

    net.state.blocking = true;
    net.cut();
    await expect(status(A)).toHaveText('Reconnecting…');
    await typeLabel(A, 'Task_ShipOrder', 'Ship parcel'); // offline
    await ideRename(fixture.file, 'Task_ShipOrder', 'Ship it');
    await delay(500);
    net.state.blocking = false;

    await expect(toast(A)).toHaveText(
      'Your change to “Ship order” was not applied: it was changed on disk at the same time (the file\'s version was kept)',
      { timeout: 5000 },
    );
    await expect(status(A)).toHaveAttribute('data-state', 'saved');
    await expect(label(A, 'Task_ShipOrder')).toHaveText('Ship it');
    await delay(800);
    expect(nameInXml(await disk(), 'Task_ShipOrder')).toBe('Ship it');
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toEqual(['conflict']);
    expect(errors).toEqual([]);
  });

  test('a slow save in place through one file descriptor, finished after the host replaced the half-written file: both kept', async ({ browser }) => {
    await start();
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const next = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels');
    const half = Math.floor(next.length / 2);
    const t0 = Date.now();

    const ide = await openFile(fixture.file, 'w'); // the IDE truncates the file and writes half
    try {
      await ide.write(next.slice(0, half));
      await expect(A.locator('#notice')).toBeVisible(); // the file is not valid BPMN
      await renameInBrowser(A, 'Ship parcel');
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
      // The rest of the IDE's save goes through its file descriptor, i.e. to the file the host replaced.
      await ide.write(next.slice(half), half);
    } finally {
      await ide.close();
    }

    await expect.poll(async () => {
      const xml = await disk();
      return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
    }, { timeout: 6000 }).toEqual(['Ship parcel', 'Check stock levels']);
    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      expect(await windowNames(page, IDS)).toEqual({ Task_ShipOrder: 'Ship parcel', Task_CheckStock: 'Check stock levels' });
    }
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('merged');
    expect(cli.stderr()).toContain('its save was put back in place');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Ctrl-C right after a slow save finished through the replaced file: both kept', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const next = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels');
    const half = Math.floor(next.length / 2);

    const ide = await openFile(fixture.file, 'w');
    try {
      await ide.write(next.slice(0, half));
      await expect(A.locator('#notice')).toBeVisible();
      await renameInBrowser(A, 'Ship parcel');
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
      await ide.write(next.slice(half), half);
    } finally {
      await ide.close();
    }
    cli.child.kill('SIGINT'); // before the host's next poll of the replaced file has settled
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    const xml = await disk();
    expect([nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')]).toEqual(['Ship parcel', 'Check stock levels']);
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a save from a stale copy right after the final write at Ctrl-C: the file keeps it, the edit is kept next to it', async ({ browser }) => {
    await start({ writeDelay: 5000 });
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const original = await disk();

    await renameInBrowser(A, 'Ship parcel'); // accepted, waiting for its write
    cli.child.kill('SIGINT');
    const stale = renameInXml(original, 'Task_CheckStock', 'Check stock levels'); // IDE buffer without the edit
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 2000, intervals: [5] }).toBe('Ship parcel');
    await writeFile(fixture.file, stale); // the final write landed; the IDE saves its copy right after
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    expect(await disk()).toBe(stale);
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain(`right after the editor's last save, from a copy without the editor's last changes; the file keeps that save, the editor's version was saved to ${join(fixture.dir, aside[0])}`);
    expect(errors).toEqual([]);
  });

  test('a stale save right after the final write at Ctrl-C that brings a deleted element back: the delete is kept next to the file', async ({ browser }) => {
    // First bring the file into the editor's own formatting, so the delete below is the only change
    // (lines removed, none added).
    await start();
    {
      const [W] = await open(browser, 1);
      await renameInBrowser(W, 'Ship it');
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship it');
      cli.child.kill('SIGINT');
      await cli.exited;
      for (const w of windows.splice(0)) await w.context.close();
    }
    cli = await startCli(fixture.file, { cwd: fixture.dir, args: ['--write-delay', '5000'] });
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const before = await disk();

    const t0 = Date.now();
    await A.locator('[data-element-id="EndEvent_OrderCancelled"]').click();
    await A.locator('.djs-context-pad .entry[data-action="delete"]').click();
    await ackAfter(A, t0);
    const stale = renameInXml(before, 'Task_CheckStock', 'Check stock levels'); // IDE buffer without the delete
    cli.child.kill('SIGINT');
    await expect.poll(async () => (await disk()).includes('id="EndEvent_OrderCancelled"'), { timeout: 2000, intervals: [5] }).toBe(false);
    await writeFile(fixture.file, stale); // the final write landed; the IDE saves its copy right after
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    expect(await disk()).toBe(stale);
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(await readFile(join(fixture.dir, aside[0]), 'utf8')).not.toContain('id="EndEvent_OrderCancelled"');
    expect(cli.stderr()).toContain(`from a copy without the editor's last changes; the file keeps that save, the editor's version was saved to ${join(fixture.dir, aside[0])}`);
    expect(errors).toEqual([]);
  });

  test('the file deleted just before the host writes, then saved from an older copy: the edit is re-applied on top', async ({ browser }) => {
    await start({ writeDelay: 1500 });
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const copy = await disk(); // the IDE's buffer
    const t0 = Date.now();

    const ack = await renameInBrowser(A, 'Ship parcel');
    await delay(Math.max(0, ack + 1500 - 80 - Date.now()));
    await unlink(fixture.file); // 80 ms before the host's write: not reported yet when it writes
    await expect.poll(async () => nameInXml(await disk().catch(() => ''), 'Task_ShipOrder'), { timeout: 3000, intervals: [5] }).toBe('Ship parcel');
    await delay(200);
    await writeFile(fixture.file, renameInXml(copy, 'Task_CheckStock', 'Check stock levels')); // its copy, without the edit

    await expect.poll(async () => {
      const xml = await disk();
      return [nameInXml(xml, 'Task_ShipOrder'), nameInXml(xml, 'Task_CheckStock')];
    }, { timeout: 6000 }).toEqual(['Ship parcel', 'Check stock levels']);
    for (const page of [A, B]) await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('merged');
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a collaborator claiming another window\'s discarded versions does not stop them from being kept aside', async ({ browser }) => {
    await start({ writeDelay: 2000, env: { LOCAL_BPMN_TEST_TUNNEL: 'fake', LOCAL_BPMN_TEST_TUNNEL_DELAY_MS: '100' } });
    const [H] = await open(browser, 1);
    await H.locator('#share-start').click();
    await expect(H.locator('#share-url')).toBeVisible({ timeout: 5000 });
    const token = /\/s\/([A-Za-z0-9_-]+)$/.exec(await H.locator('#share-url').inputValue())[1];
    const { page: A, net } = await openProxied(browser);
    // The collaborator uses A's page key, from its own link.
    const pageKey = new URL(net.state.url).searchParams.get('page');
    expect(pageKey).toMatch(/^[0-9a-f]{32}$/);
    const collab = new WebSocket(`ws://127.0.0.1:${cli.port}/s/${token}/ws?page=${pageKey}`, {
      headers: { 'cf-ray': '8d0e3c7b5a1f2e4d-LJU', 'cf-connecting-ip': '203.0.113.9', Origin: `http://127.0.0.1:${cli.port}` },
    });
    await new Promise((resolveOpen, rejectOpen) => { collab.once('open', resolveOpen); collab.once('error', rejectOpen); });

    await renameInBrowser(A, 'Ship parcel');
    net.state.blocking = true;
    net.cut(); // the host still thinks A is connected
    await ideRename(fixture.file, 'Task_CheckStock', 'Check stock levels');
    await expect(label(H, 'Task_CheckStock')).toHaveText('Check stock levels');
    collab.send(JSON.stringify({ type: 'reapplied', versions: Array.from({ length: 200 }, (_, k) => k + 1) }));
    await delay(300);
    await windows[1].context.close();
    windows.splice(1, 1);
    cli.child.kill('SIGINT');
    expect(await cli.exited).toEqual({ code: 0, signal: null });
    collab.close();

    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
  });

  test('Ctrl-C while another program is rewriting the file from an older copy: the written edit is kept next to it', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const stale = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels'); // its copy, without the edit

    await renameInBrowser(A, 'Ship parcel');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
    await delay(500); // written and confirmed long ago
    const ide = await openFile(fixture.file, 'w'); // a slow in-place save of the older copy begins
    try {
      await ide.write(stale.slice(0, 400));
      await expect(A.locator('#notice')).toBeVisible(); // seen half-written
      cli.child.kill('SIGINT');
      expect(await cli.exited).toEqual({ code: 0, signal: null });
      await ide.write(stale.slice(400), 400); // it finishes after local-bpmn has exited
    } finally {
      await ide.close();
    }

    expect(await disk()).toBe(stale);
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain(`another program was still writing ${fixture.file} when local-bpmn stopped`);
    expect(errors).toEqual([]);
  });

  test('Ctrl-C while another program has just begun a slow in-place save: the file is left to it, the edit is kept next to it', async ({ browser }) => {
    await start({ writeDelay: 5000 });
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const next = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels');
    const half = Math.floor(next.length / 2);

    await renameInBrowser(A, 'Ship parcel'); // accepted, waiting for its write
    const ide = await openFile(fixture.file, 'w'); // the IDE truncates the file and writes half
    try {
      await ide.write(next.slice(0, half));
      cli.child.kill('SIGINT');
      expect(await cli.exited).toEqual({ code: 0, signal: null });
      await ide.write(next.slice(half), half); // it finishes after local-bpmn has exited
    } finally {
      await ide.close();
    }

    expect(await disk()).toBe(next); // the IDE's save, complete, in the file
    const aside = await asideFiles(fixture.dir);
    expect(aside).toHaveLength(1);
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(cli.stderr()).toContain(`another program is rewriting ${fixture.file} (it was broken just now); local-bpmn left it alone`);
    expect(errors).toEqual([]);
  });

  test('a second Ctrl-C while the first is still looking after the final write: a stale save is still caught', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const stale = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels'); // IDE buffer without the edit

    await renameInBrowser(A, 'Ship parcel');
    const sigAt = Date.now();
    cli.child.kill('SIGINT');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 2000, intervals: [5] }).toBe('Ship parcel');
    await delay(60);
    await writeFile(fixture.file, stale); // right after the final write
    await delay(Math.max(0, sigAt + 320 - Date.now()));
    cli.child.kill('SIGINT'); // second Ctrl-C, before the first has looked again
    expect(await cli.exited).toEqual({ code: 0, signal: null });

    expect(await disk()).toBe(stale);
    const aside = await unsavedFiles(fixture.dir);
    expect(aside).toHaveLength(1); // once, not once per signal
    expect(nameInXml(await readFile(join(fixture.dir, aside[0]), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect(errors).toEqual([]);
  });

  test('a save from an older copy during the session: the file keeps it, the edit is kept next to it and the windows say so', async ({ browser }) => {
    await start();
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const copy = await disk(); // the IDE's buffer, loaded before the browser edit
    const t0 = Date.now();

    await renameInBrowser(A, 'Ship parcel');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
    await delay(200);
    const stale = renameInXml(copy, 'Task_CheckStock', 'Check stock levels');
    await writeFile(fixture.file, stale); // saved without reloading

    await expect.poll(async () => (await unsavedFiles(fixture.dir)).length, { timeout: 3000 }).toBe(1);
    const [name] = await unsavedFiles(fixture.dir);
    for (const page of [A, B]) {
      await expect(toast(page)).toHaveText(
        `The file was saved on disk from an older copy, without the latest changes; they were saved next to it as ${name}`,
      );
      await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship order'); // the file's version is shown
    }
    expect(await disk()).toBe(stale);
    expect(nameInXml(await readFile(join(fixture.dir, name), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('conflict');
    expect(errors).toEqual([]);
  });

  for (const change of ['documentation', 'outgoing']) {
    test(`a save from an older copy that also changed the task renamed in the browser (${change}): the rename is kept next to it`, async ({ browser }) => {
      // DEF-E1: the save changes the same element the browser just renamed, so it is not the old
      // element as a whole; its old name still makes it an old copy.
      await start();
      const [A, B] = await open(browser);
      const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
      await renameInBrowser(A, 'Ship order now');
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship order now');
      await delay(5500); // that write is no longer recent: the IDE's copy below starts a new chain
      const copy = await disk(); // the IDE's buffer, loaded before the next browser edit
      const t0 = Date.now();

      await renameInBrowser(A, 'Ship parcel');
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
      await delay(200);
      const own = change === 'documentation'
        ? '<bpmn:documentation>Use the tracked service</bpmn:documentation>'
        : '<bpmn:outgoing>Flow_Extra</bpmn:outgoing>';
      const stale = copy.replace(/(<bpmn:task id="Task_ShipOrder" name="[^"]*">)/, `$1\n      ${own}`);
      expect(stale).not.toBe(copy);
      await writeFile(fixture.file, stale); // saved without reloading, with its own change to that task

      await expect.poll(async () => (await unsavedFiles(fixture.dir)).length, { timeout: 3000 }).toBe(1);
      const [name] = await unsavedFiles(fixture.dir);
      for (const page of [A, B]) {
        await expect(toast(page)).toHaveText(
          `The file was saved on disk from an older copy, without the latest changes; they were saved next to it as ${name}`,
        );
        await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship order now'); // the file's version is shown
      }
      expect(await disk()).toBe(stale);
      expect(nameInXml(await readFile(join(fixture.dir, name), 'utf8'), 'Task_ShipOrder')).toBe('Ship parcel');
      expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('conflict');
      expect(cli.stderr()).toContain(name);
      expect(errors).toEqual([]);
    });
  }

  test('normal use with an IDE that reloads before it saves gives no stale-save notice', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const t0 = Date.now();
    for (const i of [0, 1, 2]) {
      await renameInBrowser(A, `Name ${i}`);
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder') === `Name ${i}`, { timeout: 3000 }).toBe(true);
      await ideRename(fixture.file, 'Task_CheckStock', `Check ${i}`); // reads the current file, changes another element
      await expect(label(A, 'Task_CheckStock')).toHaveText(`Check ${i}`);
      await delay(300);
    }
    await ideRename(fixture.file, 'Task_ShipOrder', 'Ship it'); // the same element, from the current file
    await expect(label(A, 'Task_ShipOrder')).toHaveText('Ship it');
    await delay(500);
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toEqual([]);
    expect(cli.stderr()).not.toContain('warning');
    expect(errors).toEqual([]);
  });

  test('Ctrl-C while a slow save through one descriptor is still under way: its save ends up in the kept half-written file', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const next = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels');
    const half = Math.floor(next.length / 2);

    const ide = await openFile(fixture.file, 'w');
    try {
      await ide.write(next.slice(0, half));
      await expect(A.locator('#notice')).toBeVisible();
      await renameInBrowser(A, 'Ship parcel'); // written over the half-written file
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
      cli.child.kill('SIGINT');
      expect(await cli.exited).toEqual({ code: 0, signal: null });
      await ide.write(next.slice(half), half); // the IDE finishes after local-bpmn has exited
    } finally {
      await ide.close();
    }

    expect(nameInXml(await disk(), 'Task_ShipOrder')).toBe('Ship parcel'); // the file keeps the edit
    const replaced = await replacedFiles(fixture.dir);
    expect(replaced).toHaveLength(1);
    expect(await readFile(join(fixture.dir, replaced[0]), 'utf8')).toBe(next); // the IDE's whole save
    expect(cli.stderr()).toContain(`was kept as ${join(fixture.dir, replaced[0])}`);
    expect(errors).toEqual([]);
  });

  test('a slow save through one descriptor, with a second browser edit while the first write is unconfirmed: all kept', async ({ browser }) => {
    await start();
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const next = renameInXml(await disk(), 'Task_CheckStock', 'Check stock levels');
    const half = Math.floor(next.length / 2);
    const t0 = Date.now();

    const ide = await openFile(fixture.file, 'w');
    try {
      await ide.write(next.slice(0, half));
      await expect(A.locator('#notice')).toBeVisible();
      await renameInBrowser(A, 'Ship parcel'); // replaces the half-written file (unconfirmed)
      await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship parcel');
      const before = Date.now();
      await typeLabel(A, 'Task_CancelOrder', 'Cancel it'); // a normal write over our own file
      await ackAfter(A, before);
      await expect.poll(async () => nameInXml(await disk(), 'Task_CancelOrder'), { timeout: 3000 }).toBe('Cancel it');
      await ide.write(next.slice(half), half); // the rest goes to the file the first write replaced
    } finally {
      await ide.close();
    }

    await expect.poll(async () => {
      const xml = await disk();
      return ['Task_ShipOrder', 'Task_CheckStock', 'Task_CancelOrder'].map((id) => nameInXml(xml, id));
    }, { timeout: 6000 }).toEqual(['Ship parcel', 'Check stock levels', 'Cancel it']);
    for (const page of [A, B]) await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toContain('merged');
    expect(await asideFiles(fixture.dir)).toEqual([]); // no side file, no leftover second name
    expect(errors).toEqual([]);
  });

  test('a save from an older copy while another edit waits for its write: the written edit is kept aside, the pending one re-applied', async ({ browser }) => {
    await start({ writeDelay: 1500 });
    const [A, B] = await open(browser);
    const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
    const copy = await disk(); // the IDE's buffer, before both edits

    await renameInBrowser(A, 'Ship parcel');
    await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 4000 }).toBe('Ship parcel');
    const t0 = Date.now();
    const before = Date.now();
    await typeLabel(B, 'Task_CancelOrder', 'Cancel it'); // accepted, waiting for its write
    await ackAfter(B, before);
    await writeFile(fixture.file, renameInXml(copy, 'Task_CheckStock', 'Check stock levels')); // saved without reloading

    await expect.poll(async () => (await unsavedFiles(fixture.dir)).length, { timeout: 4000 }).toBe(1);
    const [name] = await unsavedFiles(fixture.dir);
    const kept = await readFile(join(fixture.dir, name), 'utf8');
    expect([nameInXml(kept, 'Task_ShipOrder'), nameInXml(kept, 'Task_CancelOrder')]).toEqual(['Ship parcel', 'Cancel it']);
    // The pending edit is re-applied on top of the save; the written one stays in the side file.
    await expect.poll(async () => {
      const xml = await disk();
      return ['Task_ShipOrder', 'Task_CheckStock', 'Task_CancelOrder'].map((id) => nameInXml(xml, id));
    }, { timeout: 6000 }).toEqual(['Ship order', 'Check stock levels', 'Cancel it']);
    const text = `The file was saved on disk from an older copy, without the latest changes; they were saved next to it as ${name}`;
    for (const page of [A, B]) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      await expect(toast(page)).toHaveText(text);
      expect((await toastsSince(page, t0)).map((t) => t.kind)).not.toContain('merged'); // not "merged": it was not
    }
    expect(errors).toEqual([]);
  });

  for (const chain of ['renameTwice', 'addThenName', 'copyBetween']) {
    test(`a save from a copy older than the last of two consecutive writes (${chain}) is noticed`, async ({ browser }) => {
      await start();
      const [A] = await open(browser, 1);
      const errors = collectPageErrors(A);
      let copy = await disk(); // before both writes
      if (chain === 'renameTwice' || chain === 'copyBetween') {
        await renameInBrowser(A, 'Ship p');
        await expect.poll(async () => nameInXml(await disk(), 'Task_ShipOrder'), { timeout: 3000 }).toBe('Ship p');
        if (chain === 'copyBetween') copy = await disk(); // the IDE reloaded after the first write only
        await renameInBrowser(A, 'Ship parcel'); // corrects the name
      } else {
        const id = await dragNewTask(A); // added: first write
        await clickEmptyCanvas(A);
        await expect.poll(async () => (await disk()).includes(`id="${id}"`), { timeout: 3000 }).toBe(true);
        await typeLabel(A, id, 'New task'); // then named: second write
      }
      const done = chain === 'addThenName' ? 'name="New task"' : 'name="Ship parcel"';
      await expect.poll(async () => (await disk()).includes(done), { timeout: 4000 }).toBe(true);
      await delay(300);
      await writeFile(fixture.file, renameInXml(copy, 'Task_CheckStock', 'Check stock levels'));

      await expect.poll(async () => (await unsavedFiles(fixture.dir)).length, { timeout: 4000 }).toBe(1);
      const [name] = await unsavedFiles(fixture.dir);
      expect(await readFile(join(fixture.dir, name), 'utf8')).toContain(done);
      await expect(toast(A)).toContainText('saved on disk from an older copy');
      expect(errors).toEqual([]);
    });
  }

  test('a delete, then a save from a fresh copy that adds an element: no stale notice', async ({ browser }) => {
    await start();
    const [A] = await open(browser, 1);
    const errors = collectPageErrors(A);
    const t0 = Date.now();
    await A.locator('[data-element-id="EndEvent_OrderCancelled"]').click();
    await A.locator('.djs-context-pad .entry[data-action="delete"]').click();
    await expect.poll(async () => (await disk()).includes('id="EndEvent_OrderCancelled"'), { timeout: 3000 }).toBe(false);
    await delay(300);
    // The IDE reloaded the file (has the delete) and adds a task with its shape.
    const fresh = (await disk())
      .replace('</bpmn:process>', '  <bpmn:task id="Task_FromIde" name="From IDE" />\n  </bpmn:process>')
      .replace('</bpmndi:BPMNPlane>', '  <bpmndi:BPMNShape id="Task_FromIde_di" bpmnElement="Task_FromIde">\n        <dc:Bounds x="700" y="300" width="100" height="80" />\n      </bpmndi:BPMNShape>\n    </bpmndi:BPMNPlane>');
    await writeFile(fixture.file, fresh);
    await expect(A.locator('[data-element-id="Task_FromIde"]')).toBeVisible({ timeout: 3000 });
    await delay(500);
    expect(await asideFiles(fixture.dir)).toEqual([]);
    expect((await toastsSince(A, t0)).map((t) => t.kind)).toEqual([]);
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
