// Q1: concurrent edits in several windows. Edits of different elements are never lost, an edit that
// cannot be applied any more is dropped on its own with a notice, and a window in the middle of an
// edit is not disturbed by other windows' edits.
import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { generateLargeBpmn } from '../../scripts/gen-large-bpmn.js';
import { collectPageErrors, startCli } from './helpers/cli.js';
import {
  center, emptyCanvasPoint, expectNoTempFiles, expectViewboxUnchanged, label, selectedIds, setupRepo,
  shape, status, typeLabel, viewbox,
} from './helpers/editor.js';
import { diskSnapshot, windowSnapshot } from './helpers/snapshot.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** An edit in one window must show up in the others this fast (debounce + host + import + rebase). */
const VISIBLE_MS = 2500;

function bounds(page, id) {
  return page.evaluate((elementId) => {
    const e = window.bpmnModeler.get('elementRegistry').get(elementId);
    return e ? { x: e.x, y: e.y } : null;
  }, id);
}

function elementIds(page) {
  return page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll().map((e) => e.id));
}

function connectionIds(page, sourceId, targetId) {
  return page.evaluate(([source, target]) => window.bpmnModeler.get('elementRegistry')
    .filter((e) => e.waypoints && e.source?.id === source && e.target?.id === target)
    .map((e) => e.id), [sourceId, targetId]);
}

/**
 * Routes the page's WebSocket through the test: while `hold()` is on, 'update' frames the page sends
 * are kept back until `release()` (one at a time, in order) or `open()` (all, and stop holding).
 */
async function gateUpdates(page) {
  const held = [];
  let holding = false;
  let server = null;
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    server = ws.connectToServer();
    ws.onMessage((message) => {
      if (holding && JSON.parse(String(message)).type === 'update') held.push(message);
      else server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return {
    hold() { holding = true; },
    held: () => held.length,
    /** Waits for a held update and lets it through (holding goes on). */
    async release() {
      await expect.poll(() => held.length, { timeout: 5000 }).toBeGreaterThan(0);
      server.send(held.shift());
    },
    open() {
      holding = false;
      for (const message of held.splice(0)) server.send(message);
    },
  };
}

/** Every sequence flow of a window as id -> "source->target". */
function page2flows(page) {
  return page.evaluate(() => Object.fromEntries(window.bpmnModeler.get('elementRegistry')
    .filter((e) => e.waypoints).map((e) => [e.id, `${e.source.id}->${e.target.id}`])));
}

function isDragging(page) {
  return page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()));
}

function toast(page) {
  return page.locator('#toast');
}

/** Presses the mouse on a shape and drags it by `dy` (and `dx`) pixels without releasing. */
async function dragHold(page, id, dy, dx = 0) {
  const from = await center(shape(page, id));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
}

async function dragBy(page, id, dy, dx = 0) {
  await dragHold(page, id, dy, dx);
  await page.mouse.up();
}

/** Opens the label editor on `id` and types `text` (not committed). */
async function startLabel(page, id, text) {
  await shape(page, id).dblclick();
  await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

/** Returns a function that commits the open label editor by clicking empty canvas. */
async function labelCommitter(page) {
  const p = await emptyCanvasPoint(page);
  return () => page.mouse.click(p.x, p.y);
}

test.describe('Q1: concurrent edits in several windows', () => {
  let fixture;
  let cli;
  let contexts;
  let windows;

  test.beforeEach(async () => {
    fixture = await setupRepo();
    contexts = [];
    windows = [];
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
  });

  async function start(xml = null) {
    if (xml) await writeFile(fixture.file, xml);
    cli = await startCli(fixture.file, { cwd: fixture.dir });
  }

  /**
   * Opens `n` windows. Windows whose index is in `gated` get a `gate` on their WebSocket that can
   * hold back the updates they send (like a slow network), to force a given order at the host.
   */
  async function openWindows(browser, n, readyId = 'Task_CheckStock', { gated = [] } = {}) {
    for (let i = 0; i < n; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      contexts.push(context);
      const page = await context.newPage();
      const win = { page, errors: collectPageErrors(page), warnings: [] };
      page.on('console', (msg) => { if (msg.type() === 'warning') win.warnings.push(msg.text()); });
      if (gated.includes(i)) win.gate = await gateUpdates(page);
      windows.push(win);
      await page.goto(cli.url);
      await expect(shape(page, readyId)).toBeVisible();
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      await page.evaluate(() => { window.__noReload = true; });
    }
    return windows;
  }

  const disk = () => readFile(fixture.file, 'utf8');

  /**
   * Waits until every window is saved and nothing is held back, then checks that every window shows
   * exactly the diagram on disk (ids, names, bounds, waypoints). Returns that snapshot.
   */
  async function expectConverged() {
    for (const { page } of windows) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved', { timeout: VISIBLE_MS });
      await expect(page.locator('#notice[data-kind="deferred"]')).toHaveCount(0);
    }
    let expected;
    await expect.poll(async () => {
      expected = diskSnapshot(await disk());
      const snapshots = await Promise.all(windows.map(({ page }) => windowSnapshot(page)));
      return snapshots.every((s) => JSON.stringify(s) === JSON.stringify(expected));
    }, { timeout: VISIBLE_MS }).toBe(true);
    for (const { page } of windows) await expect(status(page)).toHaveAttribute('data-state', 'saved');
    return expected;
  }

  function expectHealthy() {
    for (const { errors } of windows) expect(errors).toEqual([]);
    return Promise.all(windows.map(async ({ page }) => expect(await page.evaluate(() => window.__noReload)).toBe(true)));
  }

  /** Every window moves its own element; all mouse buttons are released at the same time. */
  async function simultaneousMoves(ids, dy) {
    for (let i = 0; i < ids.length; i++) await dragHold(windows[i].page, ids[i], dy);
    await Promise.all(windows.slice(0, ids.length).map(({ page }) => page.mouse.up()));
    const expected = [];
    for (let i = 0; i < ids.length; i++) expected.push(await bounds(windows[i].page, ids[i]));
    return expected;
  }

  for (const n of [2, 3]) {
    test(`simultaneous moves of different elements in ${n} windows are all kept`, async ({ browser }) => {
      await start();
      await openWindows(browser, n);
      const rounds = [
        ['Task_CheckStock', 'Task_ShipOrder', 'Task_CancelOrder'],
        ['StartEvent_OrderReceived', 'EndEvent_OrderCancelled', 'Task_CheckStock'],
        ['Task_ShipOrder', 'Task_CancelOrder', 'Task_CheckStock'],
      ];
      for (const [round, ids] of rounds.entries()) {
        const moved = ids.slice(0, n);
        const before = await Promise.all(moved.map((id) => bounds(windows[0].page, id)));
        const expected = await simultaneousMoves(moved, round === 2 ? -40 : 40);
        moved.forEach((id, i) => expect(expected[i].y, id).not.toBe(before[i].y));
        const final = await expectConverged();
        for (const [i, id] of moved.entries()) {
          expect(final.find((e) => e.id === id).geometry.slice(0, 2), id).toEqual([expected[i].x, expected[i].y]);
        }
      }
      for (const { page } of windows) await expect(toast(page)).toBeHidden();
      await expectHealthy();
    });
  }

  test('create, append, delete, rename, connect and move at the same time in 3 windows are all kept', async ({ browser }) => {
    await start();
    const [a, b, c] = await openWindows(browser, 3);

    // Round 1: A drops a new task from the palette, B appends a task to "Ship order" with the context
    // pad, C deletes "Order cancelled" with the keyboard; all at the same moment.
    const before = await elementIds(a.page);
    const tool = await center(a.page.locator('.djs-palette .entry.bpmn-icon-task'));
    const cancel = await shape(a.page, 'Task_CancelOrder').boundingBox();
    const drop = { x: cancel.x + cancel.width / 2, y: cancel.y + cancel.height + 130 };
    await a.page.mouse.move(tool.x, tool.y);
    await a.page.mouse.down();
    await a.page.mouse.move(tool.x + 40, tool.y + 40, { steps: 5 });
    await a.page.mouse.move(drop.x, drop.y, { steps: 10 });
    await shape(b.page, 'Task_ShipOrder').click();
    const append = b.page.locator('.djs-context-pad .entry[data-action="append.append-task"]');
    await expect(append).toBeVisible();
    const appendAt = await center(append);
    await b.page.mouse.move(appendAt.x, appendAt.y);
    await shape(c.page, 'EndEvent_OrderCancelled').click();
    await Promise.all([a.page.mouse.up(), b.page.mouse.click(appendAt.x, appendAt.y), c.page.keyboard.press('Delete')]);

    const created = (await elementIds(a.page)).filter((id) => !before.includes(id) && id.startsWith('Activity_'));
    expect(created).toHaveLength(1);
    const appended = (await elementIds(b.page)).filter((id) => !before.includes(id) && id.startsWith('Activity_'));
    expect(appended).toHaveLength(1);
    const appendFlow = await connectionIds(b.page, 'Task_ShipOrder', appended[0]);
    expect(appendFlow).toHaveLength(1);
    // Both new tasks open the label editor (other windows' edits are held back until it closes).
    for (const w of [a, b]) {
      await expect(w.page.locator('.djs-direct-editing-parent')).toBeVisible();
      await w.page.keyboard.press('Escape');
    }
    let final = await expectConverged();
    const ids = final.map((e) => e.id);
    expect(ids).toContain(created[0]);
    expect(ids).toContain(appended[0]);
    expect(ids).toContain(appendFlow[0]);
    expect(ids).not.toContain('EndEvent_OrderCancelled');

    // Round 2: A connects "Cancel order" to its new task, B renames "Check stock", C moves the
    // gateway; released together.
    await shape(a.page, 'Task_CancelOrder').click();
    await a.page.locator('.djs-context-pad .entry[data-action="connect"]').click();
    const target = await center(shape(a.page, created[0]));
    await a.page.mouse.move(target.x - 10, target.y - 10, { steps: 5 });
    await a.page.mouse.move(target.x, target.y, { steps: 3 });
    await startLabel(b.page, 'Task_CheckStock', 'Check inventory');
    const commitB = await labelCommitter(b.page);
    await dragHold(c.page, 'Gateway_InStock', 30);
    await Promise.all([a.page.mouse.click(target.x, target.y), commitB(), c.page.mouse.up()]);
    const gateway = await bounds(c.page, 'Gateway_InStock');
    const connected = await connectionIds(a.page, 'Task_CancelOrder', created[0]);
    expect(connected).toHaveLength(1);

    final = await expectConverged();
    expect(final.find((e) => e.id === connected[0])).toBeTruthy();
    expect(final.find((e) => e.id === 'Task_CheckStock').name).toBe('Check inventory');
    expect(final.find((e) => e.id === 'Gateway_InStock').geometry.slice(0, 2)).toEqual([gateway.x, gateway.y]);
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  test('rapid back-and-forth edits about 100 ms apart in two windows are all kept', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);
    const steps = [
      [a, 'move', 'Task_CheckStock', 40], [b, 'move', 'Task_ShipOrder', 40],
      [a, 'label', 'Task_CancelOrder', 'Cancel fast'], [b, 'move', 'Gateway_InStock', 30],
      [a, 'move', 'EndEvent_OrderShipped', 40], [b, 'label', 'Task_CheckStock', 'Check quick'],
      [a, 'move', 'Task_ShipOrder', -40], [b, 'move', 'EndEvent_OrderCancelled', -40],
    ];
    const expectedPositions = {};
    const expectedNames = {};
    for (const [w, kind, id, value] of steps) {
      if (kind === 'move') {
        await dragBy(w.page, id, value);
        expectedPositions[id] = await bounds(w.page, id);
      } else {
        await typeLabel(w.page, id, value);
        expectedNames[id] = value;
      }
      await delay(100);
    }
    const final = await expectConverged();
    for (const [id, p] of Object.entries(expectedPositions)) {
      expect(final.find((e) => e.id === id).geometry.slice(0, 2), id).toEqual([p.x, p.y]);
    }
    for (const [id, name] of Object.entries(expectedNames)) expect(final.find((e) => e.id === id).name, id).toBe(name);
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  test('an edit of an element someone else deleted is dropped with a notice; nothing is resurrected', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);

    // B is renaming "Ship order"...
    await startLabel(b.page, 'Task_ShipOrder', 'Ship parcel');
    // ...while A moves "Check stock" and deletes "Ship order".
    await dragBy(a.page, 'Task_CheckStock', 40);
    const moved = await bounds(a.page, 'Task_CheckStock');
    await shape(a.page, 'Task_ShipOrder').click();
    await a.page.keyboard.press('Delete');
    await expect.poll(disk, { timeout: VISIBLE_MS }).not.toContain('id="Task_ShipOrder"');
    await expect(b.page.locator('#notice')).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    await expect(b.page.locator('.djs-direct-editing-parent')).toHaveText('Ship parcel');

    await (await labelCommitter(b.page))();
    await expect(toast(b.page)).toBeVisible({ timeout: VISIBLE_MS });
    await expect(toast(b.page)).toHaveAttribute('data-kind', 'dropped');
    await expect(toast(b.page)).toContainText('“Ship order” was not applied: someone else deleted it');
    let final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('Task_ShipOrder');
    expect(final.find((e) => e.id === 'Task_CheckStock').geometry.slice(0, 2)).toEqual([moved.x, moved.y]);
    expect(await disk()).not.toContain('Ship parcel');
    await expect(toast(a.page)).toBeHidden();

    // B moves two selected shapes while A deletes one of them: the other one still moves.
    await shape(b.page, 'Task_CancelOrder').click();
    await shape(b.page, 'EndEvent_OrderCancelled').click({ modifiers: ['Shift'] });
    expect((await selectedIds(b.page)).sort()).toEqual(['EndEvent_OrderCancelled', 'Task_CancelOrder']);
    const cancelBefore = await bounds(b.page, 'Task_CancelOrder');
    await dragHold(b.page, 'Task_CancelOrder', 50);
    await shape(a.page, 'EndEvent_OrderCancelled').click();
    await a.page.keyboard.press('Delete');
    await expect.poll(disk, { timeout: VISIBLE_MS }).not.toContain('id="EndEvent_OrderCancelled"');
    await expect(b.page.locator('#notice')).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    expect(await isDragging(b.page)).toBe(true);
    await b.page.mouse.up();
    const cancelMoved = await bounds(b.page, 'Task_CancelOrder');
    expect(cancelMoved.y).toBeGreaterThan(cancelBefore.y + 20);
    await expect(toast(b.page)).toContainText('“Order cancelled” was not applied: someone else deleted it', { timeout: VISIBLE_MS });
    final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('EndEvent_OrderCancelled');
    expect(final.find((e) => e.id === 'Task_CancelOrder').geometry.slice(0, 2)).toEqual([cancelMoved.x, cancelMoved.y]);
    expect(b.warnings.filter((w) => /replace/.test(w))).toEqual([]);
    await expectHealthy();
  });

  test('a re-applied move does not splice the shape into a flow someone else just drew', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);
    const flowsBefore = await page2flows(a.page);

    // B draws "Check stock" -> "Ship order" while A drags the gateway up onto where that new flow
    // will run; B finishes first, so A's move is re-applied on top of B's flow.
    await shape(b.page, 'Task_CheckStock').click();
    await b.page.locator('.djs-context-pad .entry[data-action="connect"]').click();
    const target = await center(shape(b.page, 'Task_ShipOrder'));
    await b.page.mouse.move(target.x - 8, target.y - 8, { steps: 4 });
    await b.page.mouse.move(target.x, target.y, { steps: 2 });
    await dragHold(a.page, 'Gateway_InStock', -40);
    const before = await elementIds(b.page);
    await Promise.all([b.page.mouse.click(target.x, target.y), delay(120).then(() => a.page.mouse.up())]);
    const [flow] = (await elementIds(b.page)).filter((id) => !before.includes(id));
    const gateway = await bounds(a.page, 'Gateway_InStock');

    const final = await expectConverged();
    expect(final.find((e) => e.id === 'Gateway_InStock').geometry.slice(0, 2)).toEqual([gateway.x, gateway.y]);
    const flows = await page2flows(a.page);
    expect(flows[flow]).toBe('Task_CheckStock->Task_ShipOrder');
    for (const [id, ends] of Object.entries(flowsBefore)) expect(flows[id], id).toBe(ends);
    expect(Object.keys(flows).sort()).toEqual([...Object.keys(flowsBefore), flow].sort());
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  test("a task dropped onto a flow is still spliced into it when re-applied after someone else's edit", async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);

    // A drags a new task from the palette onto the vertical part of the "no" flow (420, 262);
    // B moves "Check stock" and releases first, so A's drop is re-applied on top of it.
    const drop = await a.page.evaluate(([x, y]) => {
      const canvas = window.bpmnModeler.get('canvas');
      const vb = canvas.viewbox();
      const box = document.getElementById('canvas').getBoundingClientRect();
      return { x: box.x + (x - vb.x) * vb.scale, y: box.y + (y - vb.y) * vb.scale };
    }, [420, 262]);
    const tool = await center(a.page.locator('.djs-palette .entry.bpmn-icon-task'));
    const before = await elementIds(a.page);
    await a.page.mouse.move(tool.x, tool.y);
    await a.page.mouse.down();
    await a.page.mouse.move(tool.x + 40, tool.y + 40, { steps: 5 });
    await a.page.mouse.move(drop.x + 5, drop.y, { steps: 10 });
    await a.page.mouse.move(drop.x, drop.y, { steps: 2 });
    await dragHold(b.page, 'Task_CheckStock', 40);
    await Promise.all([b.page.mouse.up(), delay(100).then(() => a.page.mouse.up())]);
    const moved = await bounds(b.page, 'Task_CheckStock');
    const [task] = (await elementIds(a.page)).filter((id) => !before.includes(id) && id.startsWith('Activity_'));
    expect(task).toBeTruthy();
    const splicedLocally = await page2flows(a.page);
    expect(Object.values(splicedLocally)).toContain(`Gateway_InStock->${task}`);
    expect(Object.values(splicedLocally)).toContain(`${task}->Task_CancelOrder`);
    await expect(a.page.locator('.djs-direct-editing-parent')).toBeVisible(); // opened on drop
    await a.page.keyboard.press('Escape');

    const final = await expectConverged();
    expect(final.find((e) => e.id === 'Task_CheckStock').geometry.slice(0, 2)).toEqual([moved.x, moved.y]);
    const flows = Object.values(await page2flows(b.page));
    expect(flows).toContain(`Gateway_InStock->${task}`);
    expect(flows).toContain(`${task}->Task_CancelOrder`);
    expect(flows).not.toContain('Gateway_InStock->Task_CancelOrder');
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  for (const kind of ['rename', 'move']) {
    test(`a ${kind} accepted just before someone else's concurrent delete of the same element is reported`, async ({ browser }) => {
      await start();
      const [a, b] = await openWindows(browser, 2);
      // A has "Cancel order" selected; B changes it and A presses Delete 100 ms later (before B's
      // edit reaches A), so B's edit is accepted first and A's delete is re-applied over it.
      await shape(a.page, 'Task_CancelOrder').click();
      let release;
      if (kind === 'rename') {
        await startLabel(b.page, 'Task_CancelOrder', 'Cancel and refund');
        release = await labelCommitter(b.page);
      } else {
        await dragHold(b.page, 'Task_CancelOrder', 40);
        release = () => b.page.mouse.up();
      }
      await Promise.all([release(), delay(100).then(() => a.page.keyboard.press('Delete'))]);

      await expect(toast(b.page)).toHaveAttribute('data-kind', 'conflict', { timeout: VISIBLE_MS });
      await expect(toast(b.page)).toContainText('“Cancel order” was undone: someone else deleted it at the same time');
      const final = await expectConverged();
      expect(final.map((e) => e.id)).not.toContain('Task_CancelOrder');
      await expect(toast(a.page)).toBeHidden();

      // An unrelated delete afterwards does not produce a notice.
      await shape(a.page, 'EndEvent_OrderShipped').click();
      await a.page.keyboard.press('Delete');
      await expectConverged();
      await delay(300);
      await expect(toast(b.page)).not.toContainText('Order shipped');
      await expectHealthy();
    });
  }

  test('the same label edited in two windows: the first one saved wins, the other window is told', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);

    // B is still typing when A's rename of the same task arrives.
    await startLabel(b.page, 'Task_CheckStock', 'Check by B');
    await typeLabel(a.page, 'Task_CheckStock', 'Check by A');
    await expect.poll(disk, { timeout: VISIBLE_MS }).toContain('name="Check by A"');
    await expect(b.page.locator('.djs-direct-editing-parent')).toHaveText('Check by B');
    await (await labelCommitter(b.page))();
    await expect(toast(b.page)).toHaveAttribute('data-kind', 'conflict', { timeout: VISIBLE_MS });
    await expect(toast(b.page)).toContainText('“Check stock” was not applied: someone else changed it first');
    let final = await expectConverged();
    expect(final.find((e) => e.id === 'Task_CheckStock').name).toBe('Check by A');
    await expect(toast(a.page)).toBeHidden();

    // Both commit a rename of the same task at the same moment: exactly one of them is told.
    await startLabel(a.page, 'Task_ShipOrder', 'Ship by A');
    await startLabel(b.page, 'Task_ShipOrder', 'Ship by B');
    const commits = [await labelCommitter(a.page), await labelCommitter(b.page)];
    await Promise.all(commits.map((commit) => commit()));
    final = await expectConverged();
    const name = final.find((e) => e.id === 'Task_ShipOrder').name;
    expect(['Ship by A', 'Ship by B']).toContain(name);
    const loser = name === 'Ship by A' ? b : a;
    const winner = loser === a ? b : a;
    await expect(toast(loser.page)).toHaveAttribute('data-kind', 'conflict', { timeout: VISIBLE_MS });
    await expect(toast(loser.page)).toContainText('“Ship order” was not applied: someone else changed it first');
    // (B may still show the notice from the first part.)
    await expect(toast(winner.page)).not.toContainText('Ship order');
    await expectHealthy();
  });

  test('a drag and a label edit in progress in the receiving window are not interrupted', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);

    // B is dragging "Check stock" while A renames and moves other tasks.
    const before = await bounds(b.page, 'Task_CheckStock');
    await dragHold(b.page, 'Task_CheckStock', 50);
    await typeLabel(a.page, 'Task_CancelOrder', 'Cancel and refund');
    await dragBy(a.page, 'Task_ShipOrder', -30);
    const shipMoved = await bounds(a.page, 'Task_ShipOrder');
    await expect.poll(disk, { timeout: VISIBLE_MS }).toContain('name="Cancel and refund"');
    await delay(500);
    expect(await isDragging(b.page)).toBe(true);
    await expect(b.page.locator('.djs-drag-group')).toHaveCount(1); // the dragged preview is still there
    await b.page.mouse.up();
    const moved = await bounds(b.page, 'Task_CheckStock');
    expect(moved.y).toBeGreaterThan(before.y + 20);

    let final = await expectConverged();
    expect(final.find((e) => e.id === 'Task_CheckStock').geometry.slice(0, 2)).toEqual([moved.x, moved.y]);
    expect(final.find((e) => e.id === 'Task_ShipOrder').geometry.slice(0, 2)).toEqual([shipMoved.x, shipMoved.y]);
    expect(final.find((e) => e.id === 'Task_CancelOrder').name).toBe('Cancel and refund');

    // B is typing a label while A moves something.
    await startLabel(b.page, 'Task_ShipOrder', 'Ship par');
    await dragBy(a.page, 'Task_CancelOrder', 40);
    const cancelMoved = await bounds(a.page, 'Task_CancelOrder');
    await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Task_CancelOrder').geometry[1], { timeout: VISIBLE_MS })
      .toBe(cancelMoved.y);
    await delay(500);
    await b.page.keyboard.type('cel'); // keeps typing in the same editor
    await expect(b.page.locator('.djs-direct-editing-parent')).toHaveText('Ship parcel');
    await (await labelCommitter(b.page))();
    final = await expectConverged();
    expect(final.find((e) => e.id === 'Task_ShipOrder').name).toBe('Ship parcel');
    expect(final.find((e) => e.id === 'Task_CancelOrder').geometry.slice(0, 2)).toEqual([cancelMoved.x, cancelMoved.y]);
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  test('a receiving window keeps its viewport and selection across edits from others', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);

    await shape(b.page, 'Gateway_InStock').click();
    const canvasBox = await b.page.locator('#canvas').boundingBox();
    await b.page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await b.page.mouse.wheel(30, 80);
    await b.page.keyboard.down('Control');
    await b.page.mouse.wheel(0, -100);
    await b.page.keyboard.up('Control');
    await delay(200);
    const view = await viewbox(b.page);

    for (const [id, dy] of [['Task_CheckStock', 40], ['Task_CancelOrder', -40]]) {
      await dragBy(a.page, id, dy);
      const p = await bounds(a.page, id);
      await expect.poll(() => bounds(b.page, id), { timeout: VISIBLE_MS }).toEqual(p);
      expectViewboxUnchanged(await viewbox(b.page), view);
      expect(await selectedIds(b.page)).toEqual(['Gateway_InStock']);
    }
    await typeLabel(a.page, 'Task_ShipOrder', 'Ship parcel');
    await expect(label(b.page, 'Task_ShipOrder')).toHaveText('Ship parcel', { timeout: VISIBLE_MS });
    expectViewboxUnchanged(await viewbox(b.page), view);
    expect(await selectedIds(b.page)).toEqual(['Gateway_InStock']);
    await expectConverged();
    await expectHealthy();
  });

  test('moves of two shapes joined by a flow, one re-applied over the other, are both kept without a notice', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2, 'Task_CheckStock', { gated: [1] });
    for (const [round, dy] of [40, -40, 40].entries()) {
      // B's move reaches the host after A's, so B re-applies it on top of A's move; re-laying out the
      // flow between them moves the gateway's label (a side effect that must not count as a conflict).
      b.gate.hold();
      await dragBy(b.page, 'Task_ShipOrder', dy);
      const ship = await bounds(b.page, 'Task_ShipOrder');
      await expect.poll(() => b.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
      await dragBy(a.page, 'Gateway_InStock', -dy);
      const gateway = await bounds(a.page, 'Gateway_InStock');
      await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Gateway_InStock').geometry[1], { timeout: VISIBLE_MS })
        .toBe(gateway.y);
      b.gate.open();
      const final = await expectConverged();
      expect(final.find((e) => e.id === 'Task_ShipOrder').geometry.slice(0, 2), `round ${round}`).toEqual([ship.x, ship.y]);
      expect(final.find((e) => e.id === 'Gateway_InStock').geometry.slice(0, 2), `round ${round}`).toEqual([gateway.x, gateway.y]);
      for (const { page } of windows) await expect(toast(page)).toBeHidden();
    }
    expect(b.warnings.filter((w) => /undone|not applied/.test(w))).toEqual([]);
    await expectHealthy();
  });

  test('deleting an event whose earlier change was already seen gives nobody a notice', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2, 'Task_CheckStock', { gated: [0] });
    for (const [round, id] of ['EndEvent_OrderShipped', 'EndEvent_OrderCancelled', 'StartEvent_OrderReceived'].entries()) {
      // B moves the event; A sees it. Then A deletes it while B moves something else first, so A's
      // delete is re-applied: it is not concurrent with B's change of the event.
      await dragBy(b.page, id, 40);
      await expectConverged();
      a.gate.hold();
      await shape(a.page, id).click();
      await a.page.keyboard.press('Delete');
      await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
      await dragBy(b.page, 'Task_CheckStock', round % 2 ? -40 : 40);
      const moved = await bounds(b.page, 'Task_CheckStock');
      await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Task_CheckStock').geometry[1], { timeout: VISIBLE_MS })
        .toBe(moved.y);
      a.gate.open();
      const final = await expectConverged();
      expect(final.map((e) => e.id)).not.toContain(id);
      expect(final.find((e) => e.id === 'Task_CheckStock').geometry.slice(0, 2)).toEqual([moved.x, moved.y]);
      await delay(500);
      for (const { page } of windows) await expect(toast(page)).toBeHidden();
    }
    await expectHealthy();
  });

  test('a concurrent move of an event that someone deletes is reported with the event name', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2, 'Task_CheckStock', { gated: [0] });
    // A deletes the event (its update held back), B moves it and is accepted first.
    a.gate.hold();
    await shape(a.page, 'EndEvent_OrderCancelled').click();
    await a.page.keyboard.press('Delete');
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    await dragBy(b.page, 'EndEvent_OrderCancelled', 40);
    await expect(status(b.page)).toHaveAttribute('data-state', 'saved', { timeout: VISIBLE_MS });
    a.gate.open();
    await expect(toast(b.page)).toHaveAttribute('data-kind', 'conflict', { timeout: VISIBLE_MS });
    await expect(toast(b.page)).toContainText('“Order cancelled” was undone: someone else deleted it at the same time');
    const final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('EndEvent_OrderCancelled');
    await expect(toast(a.page)).toBeHidden();
    await expectHealthy();
  });

  test('the notice about a concurrent delete survives the delete being refused twice', async ({ browser }) => {
    await start();
    const [a, b, c] = await openWindows(browser, 3, 'Task_CheckStock', { gated: [0] });
    a.gate.hold();
    // A deletes "Ship order" while B renames it; B is accepted first.
    await shape(a.page, 'Task_ShipOrder').click();
    await startLabel(b.page, 'Task_ShipOrder', 'Ship parcel');
    await a.page.keyboard.press('Delete');
    await (await labelCommitter(b.page))();
    await expect.poll(disk, { timeout: VISIBLE_MS }).toContain('name="Ship parcel"');
    await a.gate.release(); // refused: A re-applies its delete and sends again (held)
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    await dragBy(c.page, 'Task_CancelOrder', 40); // C is accepted before A's second try
    const moved = await bounds(c.page, 'Task_CancelOrder');
    await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Task_CancelOrder').geometry[1], { timeout: VISIBLE_MS })
      .toBe(moved.y);
    await a.gate.release(); // refused again: A re-applies once more
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    a.gate.open();

    await expect(toast(b.page)).toHaveAttribute('data-kind', 'conflict', { timeout: VISIBLE_MS });
    await expect(toast(b.page)).toContainText('“Ship order” was undone: someone else deleted it at the same time');
    const final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('Task_ShipOrder');
    expect(final.find((e) => e.id === 'Task_CancelOrder').geometry.slice(0, 2)).toEqual([moved.x, moved.y]);
    await expect(toast(a.page)).toBeHidden();
    await expect(toast(c.page)).toBeHidden();
    await expectHealthy();
  });

  test('a drop onto a flow stays spliced when it is refused twice', async ({ browser }) => {
    await start();
    const [a, b, c] = await openWindows(browser, 3, 'Task_CheckStock', { gated: [0] });
    a.gate.hold();
    const drop = await a.page.evaluate(([x, y]) => {
      const vb = window.bpmnModeler.get('canvas').viewbox();
      const box = document.getElementById('canvas').getBoundingClientRect();
      return { x: box.x + (x - vb.x) * vb.scale, y: box.y + (y - vb.y) * vb.scale };
    }, [420, 262]);
    const tool = await center(a.page.locator('.djs-palette .entry.bpmn-icon-task'));
    const before = await elementIds(a.page);
    await a.page.mouse.move(tool.x, tool.y);
    await a.page.mouse.down();
    await a.page.mouse.move(tool.x + 40, tool.y + 40, { steps: 5 });
    await a.page.mouse.move(drop.x + 5, drop.y, { steps: 10 });
    await a.page.mouse.move(drop.x, drop.y, { steps: 2 });
    await a.page.mouse.up();
    const [task] = (await elementIds(a.page)).filter((id) => !before.includes(id) && id.startsWith('Activity_'));
    expect(Object.values(await page2flows(a.page))).toContain(`Gateway_InStock->${task}`);
    await a.page.keyboard.press('Escape'); // close the label editor that opens on drop
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);

    await dragBy(b.page, 'Task_CheckStock', 40);
    const moved = await bounds(b.page, 'Task_CheckStock');
    await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Task_CheckStock').geometry[1], { timeout: VISIBLE_MS })
      .toBe(moved.y);
    await a.gate.release(); // refused: re-applied on B's move, sent again (held)
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    await typeLabel(c.page, 'Task_ShipOrder', 'Ship parcel');
    await expect.poll(disk, { timeout: VISIBLE_MS }).toContain('name="Ship parcel"');
    await a.gate.release(); // refused again
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    a.gate.open();

    const final = await expectConverged();
    const flows = Object.values(await page2flows(b.page));
    expect(flows).toContain(`Gateway_InStock->${task}`);
    expect(flows).toContain(`${task}->Task_CancelOrder`);
    expect(flows).not.toContain('Gateway_InStock->Task_CancelOrder');
    expect(final.find((e) => e.id === 'Task_CheckStock').geometry.slice(0, 2)).toEqual([moved.x, moved.y]);
    expect(final.find((e) => e.id === 'Task_ShipOrder').name).toBe('Ship parcel');
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  test('a task appended to an element someone deletes at the same time: the connection loss is reported', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2, 'Task_CheckStock', { gated: [0] });

    /** B appends a task to `id` with the context pad; returns the new task's and connection's ids. */
    async function append(id) {
      await shape(b.page, id).click();
      const before = await elementIds(b.page);
      await b.page.locator('.djs-context-pad .entry[data-action="append.append-task"]').click();
      await expect(b.page.locator('.djs-direct-editing-parent')).toBeVisible();
      await b.page.keyboard.press('Escape');
      const added = (await elementIds(b.page)).filter((e) => !before.includes(e));
      return { task: added.find((e) => e.startsWith('Activity_')), flow: (await connectionIds(b.page, id, added.find((e) => e.startsWith('Activity_'))))[0] };
    }

    // Concurrent: A deletes "Cancel order" (its update held back), B appends a task to it and is
    // accepted first. A's re-applied delete also removes B's new connection: B is told.
    a.gate.hold();
    await shape(a.page, 'Task_CancelOrder').click();
    await a.page.keyboard.press('Delete');
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    const first = await append('Task_CancelOrder');
    await expect.poll(disk, { timeout: VISIBLE_MS }).toContain(`id="${first.flow}"`);
    a.gate.open();
    await expect(toast(b.page)).toHaveAttribute('data-kind', 'conflict', { timeout: VISIBLE_MS });
    await expect(toast(b.page)).toContainText('Your connection to “Cancel order” was removed: someone else deleted it at the same time');
    let final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('Task_CancelOrder');
    expect(final.map((e) => e.id)).not.toContain(first.flow);
    expect(final.map((e) => e.id)).toContain(first.task); // the new task itself stays
    await expect(toast(a.page)).toBeHidden();
    await b.page.evaluate(() => { document.getElementById('toast').hidden = true; });

    // Not concurrent: B appends to "Ship order" and A sees it; A then deletes "Ship order" while B
    // moves something else first (A's delete is re-applied). Nobody is told anything.
    const second = await append('Task_ShipOrder');
    await expectConverged();
    expect(await connectionIds(a.page, 'Task_ShipOrder', second.task)).toEqual([second.flow]);
    a.gate.hold();
    await shape(a.page, 'Task_ShipOrder').click();
    await a.page.keyboard.press('Delete');
    await expect.poll(() => a.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    await dragBy(b.page, 'Task_CheckStock', 40);
    const moved = await bounds(b.page, 'Task_CheckStock');
    await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Task_CheckStock').geometry[1], { timeout: VISIBLE_MS })
      .toBe(moved.y);
    a.gate.open();
    final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('Task_ShipOrder');
    await delay(500);
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });

  test('a connection to an element someone deletes at the same time names the deleted element', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2, 'Task_CheckStock', { gated: [1] });
    // B connects "Cancel order" -> "Check stock" (its update held back) while A deletes "Check stock"
    // and is accepted first: B's connection is re-applied where its target no longer exists.
    b.gate.hold();
    await shape(b.page, 'Task_CancelOrder').click();
    await b.page.locator('.djs-context-pad .entry[data-action="connect"]').click();
    const target = await center(shape(b.page, 'Task_CheckStock'));
    const before = await elementIds(b.page);
    await b.page.mouse.move(target.x - 8, target.y - 8, { steps: 4 });
    await b.page.mouse.move(target.x, target.y, { steps: 2 });
    await b.page.mouse.click(target.x, target.y);
    const [flow] = (await elementIds(b.page)).filter((id) => !before.includes(id));
    expect(await connectionIds(b.page, 'Task_CancelOrder', 'Task_CheckStock')).toEqual([flow]);
    await expect.poll(() => b.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    await shape(a.page, 'Task_CheckStock').click();
    await a.page.keyboard.press('Delete');
    await expect.poll(disk, { timeout: VISIBLE_MS }).not.toContain('id="Task_CheckStock"');
    b.gate.open();

    await expect(toast(b.page)).toHaveAttribute('data-kind', 'dropped', { timeout: VISIBLE_MS });
    await expect(toast(b.page)).toContainText('Your change to “Check stock” was not applied: someone else deleted it');
    const final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('Task_CheckStock');
    expect(final.map((e) => e.id)).not.toContain(flow);
    expect(final.map((e) => e.id)).toContain('Task_CancelOrder');
    await expect(toast(a.page)).toBeHidden();
    await expectHealthy();
  });

  test('a move into a sub-process someone deletes at the same time names the sub-process', async ({ browser }) => {
    // The fixture plus an empty expanded sub-process "Packing" and an unconnected task "Archive order".
    const xml = (await readFile(fixture.file, 'utf8'))
      .replace('</bpmn:process>', `  <bpmn:subProcess id="SubProcess_Packing" name="Packing" />
    <bpmn:task id="Task_Archive" name="Archive order" />
  </bpmn:process>`)
      .replace('</bpmndi:BPMNPlane>', `  <bpmndi:BPMNShape id="SubProcess_Packing_di" bpmnElement="SubProcess_Packing" isExpanded="true">
        <dc:Bounds x="760" y="160" width="260" height="180" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Archive_di" bpmnElement="Task_Archive">
        <dc:Bounds x="240" y="400" width="100" height="80" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>`);
    await start(xml);
    const [a, b] = await openWindows(browser, 2, 'SubProcess_Packing', { gated: [1] });
    const archived = await bounds(a.page, 'Task_Archive');

    // B drags "Archive order" into "Packing" (its update held back) while A deletes "Packing" and is
    // accepted first: B's move is re-applied where its target container no longer exists.
    b.gate.hold();
    const from = await center(shape(b.page, 'Task_Archive'));
    const to = await center(shape(b.page, 'SubProcess_Packing'));
    await dragBy(b.page, 'Task_Archive', to.y - from.y, to.x - from.x);
    await expect.poll(() => b.page.evaluate(() => window.bpmnModeler.get('elementRegistry').get('Task_Archive').parent.id))
      .toBe('SubProcess_Packing');
    await expect.poll(() => b.gate.held(), { timeout: VISIBLE_MS }).toBe(1);
    await shape(a.page, 'SubProcess_Packing').click();
    expect(await selectedIds(a.page)).toEqual(['SubProcess_Packing']);
    await a.page.keyboard.press('Delete');
    await expect.poll(disk, { timeout: VISIBLE_MS }).not.toContain('id="SubProcess_Packing"');
    b.gate.open();

    await expect(toast(b.page)).toHaveAttribute('data-kind', 'dropped', { timeout: VISIBLE_MS });
    await expect(toast(b.page)).toContainText('Your change to “Packing” was not applied: someone else deleted it');
    const final = await expectConverged();
    expect(final.map((e) => e.id)).not.toContain('SubProcess_Packing');
    expect(final.find((e) => e.id === 'Task_Archive').geometry.slice(0, 2)).toEqual([archived.x, archived.y]);
    await expect(toast(a.page)).toBeHidden();
    await expectHealthy();
  });

  test('an edit made right before the window is reloaded is saved', async ({ browser }) => {
    await start();
    const [a, b] = await openWindows(browser, 2);
    await dragBy(a.page, 'Task_CheckStock', 40);
    const moved = await bounds(a.page, 'Task_CheckStock');
    await a.page.reload(); // within the 300 ms send debounce
    await expect.poll(async () => diskSnapshot(await disk()).find((e) => e.id === 'Task_CheckStock').geometry[1], { timeout: VISIBLE_MS })
      .toBe(moved.y);
    await expect.poll(() => bounds(b.page, 'Task_CheckStock'), { timeout: VISIBLE_MS }).toEqual(moved);
    await expect(shape(a.page, 'Task_CheckStock')).toBeVisible();
    await page2flows(a.page); // reloaded page is usable
    expect(await bounds(a.page, 'Task_CheckStock')).toEqual(moved);
    expect(b.errors).toEqual([]);
  });

  test('large diagram: simultaneous edits in 3 windows are kept and show up quickly', async ({ browser }) => {
    await start(generateLargeBpmn());
    const [a, b, c] = await openWindows(browser, 3, 'Task_0_1');

    // A renames, B and C move, released together; twice.
    for (const [round, [renamed, m1, m2]] of [['Task_2_1', 'Task_5_4', 'Task_9_6'], ['Task_12_8', 'Task_3_2', 'Task_14_4']].entries()) {
      const text = `Renamed ${round}`;
      await startLabel(a.page, renamed, text);
      const commit = await labelCommitter(a.page);
      await dragHold(b.page, m1, 25);
      await dragHold(c.page, m2, -25);
      const watchStart = Date.now();
      await Promise.all([commit(), b.page.mouse.up(), c.page.mouse.up()]);
      const p1 = await bounds(b.page, m1);
      const p2 = await bounds(c.page, m2);
      for (const { page } of windows) {
        await expect(label(page, renamed)).toHaveText(text, { timeout: VISIBLE_MS });
        await expect.poll(() => bounds(page, m1), { timeout: VISIBLE_MS }).toEqual(p1);
        await expect.poll(() => bounds(page, m2), { timeout: VISIBLE_MS }).toEqual(p2);
      }
      expect(Date.now() - watchStart).toBeLessThan(2000);
      const final = await expectConverged();
      expect(final).toHaveLength(304);
      expect(final.find((e) => e.id === renamed).name).toBe(text);
      expect(final.find((e) => e.id === m1).geometry.slice(0, 2)).toEqual([p1.x, p1.y]);
      expect(final.find((e) => e.id === m2).geometry.slice(0, 2)).toEqual([p2.x, p2.y]);
    }
    for (const { page } of windows) await expect(toast(page)).toBeHidden();
    await expectHealthy();
  });
});
