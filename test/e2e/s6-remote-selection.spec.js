// S6: remote selection highlighting.
import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { collectPageErrors, startCli } from './helpers/cli.js';
import {
  clickEmptyCanvas, dragBy, dragNewTask, expectNoTempFiles, openEditor, selectedIds, setupRepo, shape, status,
} from './helpers/editor.js';
import {
  PALETTE, connectionStroke, ownEntry, outlineStyle, outlineVisible, remoteMarkers, rgb, userList,
} from './helpers/presence.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A selection change must show up in the other windows this fast. */
const VISIBLE_MS = 2000;

test.describe('S6: remote selection highlighting', () => {
  let fixture;
  let cli;
  let contexts;
  let windows;

  test.beforeEach(async () => {
    fixture = await setupRepo();
    cli = await startCli(fixture.file, { cwd: fixture.dir });
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

  /** Opens a separate browser window (own context) and waits until it is in the users list everywhere. */
  async function openWindow(browser) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const win = { context, page, errors: collectPageErrors(page) };
    windows.push(win);
    await openEditor(page, cli);
    await expect.poll(async () => (await ownEntry(page))?.name ?? '').not.toBe('');
    win.user = await ownEntry(page);
    win.marker = `remote-sel-${win.user.color}`;
    for (const other of windows) {
      await expect.poll(() => userList(other.page).then((l) => l.length)).toBe(windows.length);
    }
    return win;
  }

  async function openWindows(browser, n) {
    const result = [];
    for (let i = 0; i < n; i++) result.push(await openWindow(browser));
    return result;
  }

  /** `id` in `page` carries exactly the markers of `wins` (none if empty). */
  async function expectMarkedBy(page, id, wins, options = {}) {
    const expected = [...new Set(wins.map((w) => w.marker))].sort();
    await expect.poll(() => remoteMarkers(page, id), { timeout: VISIBLE_MS, ...options }).toEqual(expected);
  }

  function expectNoPageErrors() {
    for (const { errors } of windows) expect(errors).toEqual([]);
  }

  test("a task selected in A is outlined in A's colour in B; deselect and close remove it", async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    await shape(a.page, 'Task_CheckStock').click();
    await expectMarkedBy(b.page, 'Task_CheckStock', [a]);

    // The outline is visible and drawn in A's colour, the colour of A's dot in B's users list.
    const aInB = (await userList(b.page)).find((u) => u.id === a.user.id);
    expect(aInB.color).toBe(a.user.color);
    const outline = await outlineStyle(b.page, 'Task_CheckStock');
    expect(outline).toEqual({ visibility: 'visible', stroke: aInB.dot });
    expect(outline.stroke).toBe(rgb(PALETTE[a.user.color]));
    // Nothing else is marked in B, and A does not mark its own selection.
    for (const id of ['Task_ShipOrder', 'Task_CancelOrder', 'Gateway_InStock']) expect(await remoteMarkers(b.page, id)).toEqual([]);
    expect(await outlineVisible(b.page, 'Task_ShipOrder')).toBe(false);
    expect(await remoteMarkers(a.page, 'Task_CheckStock')).toEqual([]);
    expect(await selectedIds(b.page)).toEqual([]); // B's own selection is untouched

    // Selecting something else moves the outline.
    await shape(a.page, 'Task_ShipOrder').click();
    await expectMarkedBy(b.page, 'Task_ShipOrder', [a]);
    await expectMarkedBy(b.page, 'Task_CheckStock', []);

    // Several elements (shift-click), including a sequence flow (its line takes A's colour).
    await shape(a.page, 'Task_CancelOrder').click({ modifiers: ['Shift'] });
    // Click on the flow's (straight) line, between "Order received" and "Check stock".
    const line = await a.page.locator('.djs-connection[data-element-id="Flow_ToCheckStock"] .djs-hit').boundingBox();
    await a.page.keyboard.down('Shift');
    await a.page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
    await a.page.keyboard.up('Shift');
    await expect.poll(() => selectedIds(a.page).then((ids) => ids.sort())).toEqual(['Flow_ToCheckStock', 'Task_CancelOrder', 'Task_ShipOrder']);
    await expectMarkedBy(b.page, 'Task_CancelOrder', [a]);
    await expectMarkedBy(b.page, 'Flow_ToCheckStock', [a]);
    await expectMarkedBy(b.page, 'Task_ShipOrder', [a]);
    expect(await connectionStroke(b.page, 'Flow_ToCheckStock')).toBe(rgb(PALETTE[a.user.color]));
    expect(await connectionStroke(b.page, 'Flow_ToGateway')).not.toBe(rgb(PALETTE[a.user.color]));

    // Deselect: gone.
    await clickEmptyCanvas(a.page);
    for (const id of ['Task_CancelOrder', 'Flow_ToCheckStock', 'Task_ShipOrder']) await expectMarkedBy(b.page, id, []);
    expect(await outlineVisible(b.page, 'Task_ShipOrder')).toBe(false);

    // Select again, then close A's window: gone.
    await shape(a.page, 'Task_CheckStock').click();
    await expectMarkedBy(b.page, 'Task_CheckStock', [a]);
    await a.page.close();
    await expectMarkedBy(b.page, 'Task_CheckStock', [], { timeout: 3000 });
    expect(await outlineVisible(b.page, 'Task_CheckStock')).toBe(false);
    expect(b.errors).toEqual([]);
  });

  test('each user has their own colour; a late joiner sees existing selections; same element selected by two', async ({ browser }) => {
    const [a, b, c] = await openWindows(browser, 3);
    expect(new Set([a.marker, b.marker, c.marker]).size).toBe(3);

    await shape(a.page, 'Task_CheckStock').click();
    await shape(b.page, 'Task_ShipOrder').click();
    await expectMarkedBy(c.page, 'Task_CheckStock', [a]);
    await expectMarkedBy(c.page, 'Task_ShipOrder', [b]);
    await expectMarkedBy(a.page, 'Task_ShipOrder', [b]);
    await expectMarkedBy(b.page, 'Task_CheckStock', [a]);
    expect((await outlineStyle(c.page, 'Task_ShipOrder')).stroke).toBe(rgb(PALETTE[b.user.color]));

    // C selects what A has selected: both markers in B; A sees C's only, C sees A's only.
    await shape(c.page, 'Task_CheckStock').click();
    await expectMarkedBy(b.page, 'Task_CheckStock', [a, c]);
    await expectMarkedBy(a.page, 'Task_CheckStock', [c]);
    await expectMarkedBy(c.page, 'Task_CheckStock', [a]);
    // A deselects: C's marker stays in B.
    await clickEmptyCanvas(a.page);
    await expectMarkedBy(b.page, 'Task_CheckStock', [c]);
    expect((await outlineStyle(b.page, 'Task_CheckStock')).stroke).toBe(rgb(PALETTE[c.user.color]));

    // A late joiner sees the current selections right away.
    const d = await openWindow(browser);
    await expectMarkedBy(d.page, 'Task_CheckStock', [c]);
    await expectMarkedBy(d.page, 'Task_ShipOrder', [b]);
    expectNoPageErrors();
  });

  test("A's marker survives re-imports in B (another window's edit, a change on disk)", async ({ browser }) => {
    const [a, b, c] = await openWindows(browser, 3);
    await shape(a.page, 'Task_CheckStock').click();
    await expectMarkedBy(b.page, 'Task_CheckStock', [a]);

    // C edits: B imports C's document.
    const before = await shape(b.page, 'Task_CancelOrder').boundingBox();
    await dragBy(c.page, 'Task_CancelOrder', 60);
    await expect.poll(async () => (await shape(b.page, 'Task_CancelOrder').boundingBox()).y, { timeout: VISIBLE_MS })
      .toBeGreaterThan(before.y + 20);
    await expectMarkedBy(b.page, 'Task_CheckStock', [a]);
    expect((await outlineStyle(b.page, 'Task_CheckStock')).stroke).toBe(rgb(PALETTE[a.user.color]));
    // A imported it too, kept its selection, and still does not mark it itself.
    expect(await selectedIds(a.page)).toEqual(['Task_CheckStock']);
    expect(await remoteMarkers(a.page, 'Task_CheckStock')).toEqual([]);
    // C's own drag selected the moved task: A and B show that.
    await expectMarkedBy(b.page, 'Task_CancelOrder', [c]);
    await expectMarkedBy(a.page, 'Task_CancelOrder', [c]);

    // A change on disk: every window re-imports.
    await expect(status(c.page)).toHaveAttribute('data-state', 'saved');
    await delay(500); // let the host write C's edit first
    const xml = await readFile(fixture.file, 'utf8');
    await writeFile(fixture.file, xml.replace('name="Ship order"', 'name="Ship order (disk)"'));
    for (const win of [a, b, c]) {
      await expect(shape(win.page, 'Task_ShipOrder').locator('text')).toHaveText('Ship order (disk)', { timeout: 5000 });
    }
    await expectMarkedBy(b.page, 'Task_CheckStock', [a]);
    await expectMarkedBy(c.page, 'Task_CheckStock', [a]);
    await expectMarkedBy(b.page, 'Task_CancelOrder', [c]);
    expect(await remoteMarkers(a.page, 'Task_CheckStock')).toEqual([]);
    expect(await remoteMarkers(c.page, 'Task_CancelOrder')).toEqual([]);
    expectNoPageErrors();
  });

  test('a selected element that is deleted, and one that does not exist yet, cause no errors', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    // A has a task selected that B deletes.
    await shape(a.page, 'Task_CancelOrder').click();
    await expectMarkedBy(b.page, 'Task_CancelOrder', [a]);
    await shape(b.page, 'Task_CancelOrder').click();
    await b.page.keyboard.press('Delete');
    await expect(shape(b.page, 'Task_CancelOrder')).toHaveCount(0);
    await expect(shape(a.page, 'Task_CancelOrder')).toHaveCount(0, { timeout: VISIBLE_MS });
    await expect.poll(() => selectedIds(a.page)).toEqual([]);
    // Undo in B brings it back; A no longer has it selected, so it is not marked.
    await b.page.keyboard.press('ControlOrMeta+z');
    await expect(shape(b.page, 'Task_CancelOrder')).toHaveCount(1);
    await expect(shape(a.page, 'Task_CancelOrder')).toHaveCount(1, { timeout: VISIBLE_MS });
    await delay(300);
    expect(await remoteMarkers(b.page, 'Task_CancelOrder')).toEqual([]);

    // A creates a task: it is selected in A before B has it; B marks it once the task arrives.
    const taskId = await dragNewTask(a.page);
    await a.page.keyboard.type('New task');
    await a.page.keyboard.press('Enter'); // commits the label; the task stays selected
    await expect.poll(() => selectedIds(a.page)).toEqual([taskId]);
    await expect(shape(b.page, taskId)).toHaveCount(1, { timeout: VISIBLE_MS });
    await expectMarkedBy(b.page, taskId, [a]);

    // B deletes it while A still has it selected: no errors anywhere, nothing left marked.
    await shape(b.page, taskId).click();
    await b.page.keyboard.press('Delete');
    await expect(shape(a.page, taskId)).toHaveCount(0, { timeout: VISIBLE_MS });
    await expect.poll(() => selectedIds(a.page)).toEqual([]);
    for (const win of [a, b]) await expect(status(win.page)).toHaveAttribute('data-state', 'saved');
    expect(await b.page.locator('[class*="remote-sel-"]').count()).toBe(0);
    expectNoPageErrors();
  });
});
