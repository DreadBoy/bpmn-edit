// S4: live sync between several browser windows.
import { expect, test } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { collectPageErrors, startCli } from './helpers/cli.js';
import {
  center, clickEmptyCanvas, dragBy, dragNewTask, expectNoTempFiles, expectViewboxUnchanged, git, label, openEditor,
  selectedIds, setupRepo, shape, status, typeLabel, viewbox,
} from './helpers/editor.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** An edit in one window must show up in the others this fast (debounce + host + import). */
const VISIBLE_MS = 1500;
/** An edit must be on disk this fast (debounce + host write). */
const ON_DISK_MS = 2000;
/** How long to watch for further messages / writes after an edit. */
const STABLE_MS = 2000;

/** Bounds of an element in a window, from its element registry (null if it does not exist). */
function bounds(page, id) {
  return page.evaluate((elementId) => {
    const element = window.bpmnModeler.get('elementRegistry').get(elementId);
    return element ? { x: element.x, y: element.y, width: element.width, height: element.height } : null;
  }, id);
}

/** Ids of the connections from `sourceId` to `targetId` in a window. */
function connectionIds(page, sourceId, targetId) {
  return page.evaluate(([source, target]) => window.bpmnModeler.get('elementRegistry')
    .filter((e) => e.waypoints && e.source?.id === source && e.target?.id === target)
    .map((e) => e.id), [sourceId, targetId]);
}

/** Every element of a window's diagram: id, type, name, bounds / waypoints (sorted by id). */
function snapshot(page) {
  return page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll()
    .map((e) => ({
      id: e.id,
      type: e.type,
      name: e.businessObject?.name ?? null,
      bounds: e.waypoints ? e.waypoints.map(({ x, y }) => [x, y]) : [e.x, e.y, e.width, e.height],
    }))
    .sort((p, q) => p.id.localeCompare(q.id)));
}

/** y of a shape's bounds in the XML (null if it has no shape). */
function shapeY(xml, id) {
  const match = new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="[\\d.-]+" y="([\\d.-]+)"`).exec(xml);
  return match ? Number(match[1]) : null;
}

/** The label editor's current (uncommitted) text. */
function editorText(page) {
  return page.locator('.djs-direct-editing-parent');
}

function notice(page) {
  return page.locator('#notice');
}

/** `xml` with the element named `from` renamed to `to`. */
function withName(xml, from, to) {
  const out = xml.replace(`name="${from}"`, `name="${to}"`);
  if (out === xml) throw new Error(`no element named "${from}"`);
  return out;
}

/** Records the protocol messages a page sends and receives over its WebSocket. */
function recordFrames(page) {
  const frames = { sent: [], received: [] };
  const parse = (payload) => {
    try {
      return JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    } catch {
      return { type: '(unparsable)' };
    }
  };
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => frames.sent.push(parse(payload)));
    ws.on('framereceived', ({ payload }) => frames.received.push(parse(payload)));
  });
  return {
    frames,
    clear() {
      frames.sent.length = 0;
      frames.received.length = 0;
    },
    count(direction, type) {
      return frames[direction].filter((m) => m.type === type).length;
    },
  };
}

/** Starts a connection from `sourceId` with the context pad's connect tool and drops it on `targetId`. */
async function connectWithContextPad(page, sourceId, targetId) {
  await shape(page, sourceId).click();
  const tool = page.locator('.djs-context-pad .entry[data-action="connect"]');
  await expect(tool).toBeVisible();
  await tool.click();
  const to = await center(shape(page, targetId));
  await page.mouse.move(to.x - 20, to.y - 10, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.click(to.x, to.y);
}

test.describe('S4: live sync between several browser windows', () => {
  let fixture;
  let cli;
  let original;
  let contexts;
  let windows;

  test.beforeEach(async () => {
    fixture = await setupRepo();
    original = await readFile(fixture.file, 'utf8');
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

  /** Opens a separate browser window (own context) on the host URL; `ready` = wait for the diagram. */
  async function openWindow(browser, { ready = true } = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const win = { page, errors: collectPageErrors(page), ws: recordFrames(page), warnings: [] };
    page.on('console', (msg) => { if (msg.type() === 'warning') win.warnings.push(msg.text()); });
    windows.push(win);
    if (ready) {
      await openEditor(page, cli);
      await page.evaluate(() => { window.__noReload = true; });
    } else {
      await page.goto(cli.url);
    }
    return win;
  }

  async function openWindows(browser, n) {
    const result = [];
    for (let i = 0; i < n; i++) result.push(await openWindow(browser));
    return result;
  }

  const disk = () => readFile(fixture.file, 'utf8');

  /** Every window collected no page errors, was never reloaded and is saved. */
  async function expectHealthyWindows() {
    for (const { page, errors } of windows) {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => window.__noReload)).toBe(true);
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
    }
  }

  test('create, move, delete and connect in A show up in B, on disk and in git diff', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    const ids = await Promise.all([a, b].map((w) => w.page.evaluate(() => window.bpmnEdit.clientId)));
    expect(ids[0]).toMatch(/^c\d+$/);
    expect(ids[1]).toMatch(/^c\d+$/);
    expect(ids[0]).not.toBe(ids[1]);

    // Create: a task from the palette, named in the label editor that opens on drop.
    const taskId = await dragNewTask(a.page);
    await expect(a.page.locator('.djs-direct-editing-parent')).toBeVisible();
    await a.page.keyboard.type('Approve refund');
    await clickEmptyCanvas(a.page);
    await expect(label(b.page, taskId)).toHaveText('Approve refund', { timeout: VISIBLE_MS });
    expect(await bounds(b.page, taskId)).toEqual(await bounds(a.page, taskId));
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain(`<bpmn:task id="${taskId}" name="Approve refund"`);
    expect(git(fixture.dir, 'diff', '--', 'order.bpmn')).toMatch(new RegExp(`^\\+\\s*<bpmn:task id="${taskId}" name="Approve refund"`, 'm'));
    await expect(status(b.page)).toHaveAttribute('data-state', 'saved');

    // Move.
    const before = await bounds(b.page, 'Task_CancelOrder');
    await dragBy(a.page, 'Task_CancelOrder', 60);
    const moved = await bounds(a.page, 'Task_CancelOrder');
    expect(moved.y).toBeGreaterThan(before.y + 20);
    await expect.poll(() => bounds(b.page, 'Task_CancelOrder'), { timeout: VISIBLE_MS }).toEqual(moved);
    await expect.poll(async () => shapeY(await disk(), 'Task_CancelOrder'), { timeout: ON_DISK_MS }).toBe(moved.y);
    expect(git(fixture.dir, 'diff', '--', 'order.bpmn')).toMatch(new RegExp(`^\\+\\s*<dc:Bounds x="${moved.x}" y="${moved.y}" width="100" height="80"`, 'm'));

    // Delete with the keyboard.
    await shape(a.page, 'EndEvent_OrderShipped').click();
    await a.page.keyboard.press('Delete');
    await expect(shape(a.page, 'EndEvent_OrderShipped')).toHaveCount(0);
    await expect(shape(b.page, 'EndEvent_OrderShipped')).toHaveCount(0, { timeout: VISIBLE_MS });
    await expect.poll(disk, { timeout: ON_DISK_MS }).not.toContain('id="EndEvent_OrderShipped"');
    expect(git(fixture.dir, 'diff', '--', 'order.bpmn')).toMatch(/^-\s*<bpmn:endEvent id="EndEvent_OrderShipped"/m);

    // Connect with the context pad.
    await connectWithContextPad(a.page, 'Task_ShipOrder', taskId);
    await expect.poll(() => connectionIds(a.page, 'Task_ShipOrder', taskId)).toHaveLength(1);
    const [flowId] = await connectionIds(a.page, 'Task_ShipOrder', taskId);
    await expect.poll(() => connectionIds(b.page, 'Task_ShipOrder', taskId), { timeout: VISIBLE_MS }).toEqual([flowId]);
    await expect(b.page.locator(`.djs-connection[data-element-id="${flowId}"] .djs-visual > path`)).toHaveAttribute('d', /^M.*L/); // drawn (a straight line has an empty box)
    await expect.poll(disk, { timeout: ON_DISK_MS })
      .toContain(`<bpmn:sequenceFlow id="${flowId}" sourceRef="Task_ShipOrder" targetRef="${taskId}"`);
    expect(git(fixture.dir, 'diff', '--', 'order.bpmn')).toMatch(new RegExp(`^\\+\\s*<bpmn:sequenceFlow id="${flowId}"`, 'm'));

    // B shows the same diagram as A.
    expect(await snapshot(b.page)).toEqual(await snapshot(a.page));
    await expect(notice(b.page)).toBeHidden();
    await expectHealthyWindows();
  });

  test('an edit in B reaches A and disk', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);
    await typeLabel(b.page, 'Task_CheckStock', 'Check inventory');
    await expect(label(a.page, 'Task_CheckStock')).toHaveText('Check inventory', { timeout: VISIBLE_MS });
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('<bpmn:task id="Task_CheckStock" name="Check inventory"');
    expect(git(fixture.dir, 'diff', '--', 'order.bpmn')).toMatch(/^\+\s*<bpmn:task id="Task_CheckStock" name="Check inventory"/m);
    await expect(notice(a.page)).toBeHidden();
    await expectHealthyWindows();
  });

  test('three windows: an edit in C reaches A and B, an edit in A reaches B and C', async ({ browser }) => {
    const [a, b, c] = await openWindows(browser, 3);

    await dragBy(c.page, 'Task_ShipOrder', -40);
    const moved = await bounds(c.page, 'Task_ShipOrder');
    for (const w of [a, b]) {
      await expect.poll(() => bounds(w.page, 'Task_ShipOrder'), { timeout: VISIBLE_MS }).toEqual(moved);
    }
    await expect.poll(async () => shapeY(await disk(), 'Task_ShipOrder'), { timeout: ON_DISK_MS }).toBe(moved.y);

    await typeLabel(a.page, 'Task_CancelOrder', 'Cancel and refund');
    for (const w of [b, c]) {
      await expect(label(w.page, 'Task_CancelOrder')).toHaveText('Cancel and refund', { timeout: VISIBLE_MS });
      expect(await bounds(w.page, 'Task_ShipOrder')).toEqual(moved);
    }
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('name="Cancel and refund"');
    expect(shapeY(await disk(), 'Task_ShipOrder')).toBe(moved.y);
    await expectHealthyWindows();
  });

  test('a receiving window keeps its viewport and selection', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    // B selects a task, then scrolls and zooms like a user.
    await shape(b.page, 'Task_ShipOrder').click();
    expect(await selectedIds(b.page)).toEqual(['Task_ShipOrder']);
    const canvasBox = await b.page.locator('#canvas').boundingBox();
    await b.page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    const initial = await viewbox(b.page);
    await b.page.mouse.wheel(0, 120);
    await b.page.mouse.wheel(60, 0);
    await b.page.keyboard.down('Control');
    await b.page.mouse.wheel(0, -100);
    await b.page.keyboard.up('Control');
    await expect.poll(async () => (await viewbox(b.page)).scale).not.toBeCloseTo(initial.scale, 2);
    const view = await viewbox(b.page);

    await typeLabel(a.page, 'Task_CheckStock', 'Check inventory');
    await expect(label(b.page, 'Task_CheckStock')).toHaveText('Check inventory', { timeout: VISIBLE_MS });
    expectViewboxUnchanged(await viewbox(b.page), view);
    expect(await selectedIds(b.page)).toEqual(['Task_ShipOrder']);
    await expect(notice(b.page)).toBeHidden(); // no notice for a normal edit from another window
    await expectHealthyWindows();
  });

  test('an open label editor in B survives an edit from A; both edits end up everywhere', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    await typeLabel(b.page, 'Task_ShipOrder', 'Ship parcel', { commit: false });
    const before = await bounds(a.page, 'Task_CancelOrder');
    await dragBy(a.page, 'Task_CancelOrder', 60);
    const moved = await bounds(a.page, 'Task_CancelOrder');
    expect(moved.y).toBeGreaterThan(before.y + 20);
    await expect.poll(async () => shapeY(await disk(), 'Task_CancelOrder'), { timeout: ON_DISK_MS }).toBe(moved.y);

    // Held back in B while the label editor is open, and B is told so.
    await expect(notice(b.page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    await expect(notice(b.page)).toHaveText('Someone else edited; shown after your edit');
    await expect(editorText(b.page)).toBeVisible();
    await expect(editorText(b.page)).toHaveText('Ship parcel');
    expect(await bounds(b.page, 'Task_CancelOrder')).toEqual(before);

    await clickEmptyCanvas(b.page); // commit the label
    for (const w of [a, b]) {
      await expect(label(w.page, 'Task_ShipOrder')).toHaveText('Ship parcel', { timeout: VISIBLE_MS });
      await expect.poll(() => bounds(w.page, 'Task_CancelOrder'), { timeout: VISIBLE_MS }).toEqual(moved);
    }
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('<bpmn:task id="Task_ShipOrder" name="Ship parcel"');
    expect(shapeY(await disk(), 'Task_CancelOrder')).toBe(moved.y);
    await expect(notice(b.page)).toBeHidden();
    expect(b.warnings.filter((w) => /replace/.test(w))).toEqual([]); // merged, not last write wins
    await expectHealthyWindows();
  });

  test('a drag in progress in B survives a rename in A; both edits end up everywhere', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    const before = await bounds(b.page, 'Task_CheckStock');
    const from = await center(shape(b.page, 'Task_CheckStock'));
    await b.page.mouse.move(from.x, from.y);
    await b.page.mouse.down();
    await b.page.mouse.move(from.x, from.y + 30, { steps: 5 });
    await b.page.mouse.move(from.x, from.y + 60, { steps: 5 });
    expect(await b.page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()))).toBe(true);

    await typeLabel(a.page, 'Task_CancelOrder', 'Cancel and refund');
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('name="Cancel and refund"');
    await expect(notice(b.page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    expect(await b.page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()))).toBe(true);

    await b.page.mouse.up();
    // B shows A's rename with its own move re-applied on top.
    await expect(label(b.page, 'Task_CancelOrder')).toHaveText('Cancel and refund', { timeout: VISIBLE_MS });
    const moved = await bounds(b.page, 'Task_CheckStock');
    expect(moved.y).toBeGreaterThan(before.y + 20);
    for (const w of [a, b]) {
      await expect(label(w.page, 'Task_CancelOrder')).toHaveText('Cancel and refund', { timeout: VISIBLE_MS });
      await expect.poll(() => bounds(w.page, 'Task_CheckStock'), { timeout: VISIBLE_MS }).toEqual(moved);
    }
    await expect.poll(async () => shapeY(await disk(), 'Task_CheckStock'), { timeout: ON_DISK_MS }).toBe(moved.y);
    expect(await disk()).toContain('<bpmn:task id="Task_CancelOrder" name="Cancel and refund"');
    await expect(notice(b.page)).toBeHidden();
    expect(b.warnings.filter((w) => /replace/.test(w))).toEqual([]);
    await expectHealthyWindows();
  });

  test('a task B is creating from the palette while A edits is kept, with its id, position and label', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    // B picks up the Task tool and is dragging it over the canvas...
    const from = await center(b.page.locator('.djs-palette .entry.bpmn-icon-task'));
    const cancel = await shape(b.page, 'Task_CancelOrder').boundingBox();
    const to = { x: cancel.x + cancel.width / 2, y: cancel.y + cancel.height + 130 };
    await b.page.mouse.move(from.x, from.y);
    await b.page.mouse.down();
    await b.page.mouse.move(from.x + 40, from.y + 40, { steps: 5 });
    await b.page.mouse.move(to.x, to.y, { steps: 15 });
    expect(await b.page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()))).toBe(true);

    // ...while A renames a task.
    await typeLabel(a.page, 'Task_CheckStock', 'Check inventory');
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('name="Check inventory"');
    await expect(notice(b.page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });

    // B drops the task and names it in the label editor that opens.
    await b.page.mouse.up();
    await expect(b.page.locator('.djs-direct-editing-parent')).toBeVisible();
    await b.page.keyboard.type('Pack items');
    await clickEmptyCanvas(b.page);

    await expect(label(b.page, 'Task_CheckStock')).toHaveText('Check inventory', { timeout: VISIBLE_MS });
    const [taskId] = await b.page.evaluate(() => window.bpmnModeler.get('elementRegistry')
      .filter((e) => e.id.startsWith('Activity_')).map((e) => e.id));
    expect(taskId).toMatch(/^Activity_/);
    await expect(label(b.page, taskId)).toHaveText('Pack items');
    await expect(label(a.page, taskId)).toHaveText('Pack items', { timeout: VISIBLE_MS });
    expect(await bounds(a.page, taskId)).toEqual(await bounds(b.page, taskId));
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain(`<bpmn:task id="${taskId}" name="Pack items"`);
    expect(await disk()).toContain('<bpmn:task id="Task_CheckStock" name="Check inventory"');
    expect(await snapshot(a.page)).toEqual(await snapshot(b.page));
    expect(b.warnings.filter((w) => /replace/.test(w))).toEqual([]);
    await expectHealthyWindows();
  });

  test('a connection B is drawing while A edits is kept', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);

    // B starts the connect tool on "Cancel order"...
    await shape(b.page, 'Task_CancelOrder').click();
    await b.page.locator('.djs-context-pad .entry[data-action="connect"]').click();
    const to = await center(shape(b.page, 'EndEvent_OrderShipped'));
    await b.page.mouse.move(to.x - 20, to.y - 10, { steps: 5 });
    expect(await b.page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()))).toBe(true);

    // ...while A moves a shape.
    await dragBy(a.page, 'Task_ShipOrder', -40);
    const moved = await bounds(a.page, 'Task_ShipOrder');
    await expect.poll(async () => shapeY(await disk(), 'Task_ShipOrder'), { timeout: ON_DISK_MS }).toBe(moved.y);
    await expect(notice(b.page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });

    // B finishes the connection.
    await b.page.mouse.move(to.x, to.y, { steps: 5 });
    await b.page.mouse.click(to.x, to.y);

    await expect.poll(() => bounds(b.page, 'Task_ShipOrder'), { timeout: VISIBLE_MS }).toEqual(moved);
    const flowIds = await connectionIds(b.page, 'Task_CancelOrder', 'EndEvent_OrderShipped');
    expect(flowIds).toHaveLength(1);
    await expect.poll(() => connectionIds(a.page, 'Task_CancelOrder', 'EndEvent_OrderShipped'), { timeout: VISIBLE_MS })
      .toEqual(flowIds);
    await expect.poll(disk, { timeout: ON_DISK_MS })
      .toContain(`<bpmn:sequenceFlow id="${flowIds[0]}" sourceRef="Task_CancelOrder" targetRef="EndEvent_OrderShipped"`);
    expect(shapeY(await disk(), 'Task_ShipOrder')).toBe(moved.y);
    expect(await snapshot(a.page)).toEqual(await snapshot(b.page));
    expect(b.warnings.filter((w) => /replace/.test(w))).toEqual([]);
    await expectHealthyWindows();
  });

  test('no echo loops: one edit is sent once and received once per other window', async ({ browser }) => {
    const [a, b, c] = await openWindows(browser, 3);
    for (const w of [a, b, c]) w.ws.clear();

    await typeLabel(a.page, 'Task_CheckStock', 'Check inventory');
    for (const w of [b, c]) await expect(label(w.page, 'Task_CheckStock')).toHaveText('Check inventory', { timeout: VISIBLE_MS });
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('name="Check inventory"');
    const xml = await disk();
    const info = await stat(fixture.file);

    await delay(STABLE_MS);
    expect(a.ws.count('sent', 'update')).toBe(1);
    expect(a.ws.count('received', 'ack')).toBe(1);
    expect(a.ws.count('received', 'remote-update')).toBe(0);
    for (const w of [b, c]) {
      expect(w.ws.count('received', 'remote-update')).toBe(1);
      expect(w.ws.count('sent', 'update')).toBe(0);
      expect(w.ws.frames.received.find((m) => m.type === 'remote-update').origin)
        .toBe(await a.page.evaluate(() => window.bpmnEdit.clientId));
    }
    expect(await disk()).toBe(xml);
    const now = await stat(fixture.file);
    expect(now.mtimeMs).toBe(info.mtimeMs);
    expect(now.ino).toBe(info.ino);
    await expectHealthyWindows();
  });

  test('a window that could not render the file recovers when another window edits it', async ({ browser }) => {
    const a = await openWindow(browser);

    // Well-formed BPMN that cannot be displayed (no diagram): a window opened now has nothing to show.
    const noDiagram = original.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, '');
    await writeFile(fixture.file, noDiagram);
    await expect(notice(a.page)).toHaveAttribute('data-kind', 'invalid', { timeout: VISIBLE_MS });
    const b = await openWindow(browser, { ready: false });
    await expect(b.page.locator('#error')).toContainText('Could not render order.bpmn');
    await expect(shape(b.page, 'Task_CheckStock')).toHaveCount(0);
    await b.page.evaluate(() => { window.__noReload = true; });

    await dragBy(a.page, 'Task_CancelOrder', 60);
    const moved = await bounds(a.page, 'Task_CancelOrder');
    await expect(shape(b.page, 'Task_CheckStock')).toBeVisible({ timeout: VISIBLE_MS });
    await expect(b.page.locator('#error')).toBeHidden();
    await expect.poll(() => bounds(b.page, 'Task_CancelOrder')).toEqual(moved);
    for (const id of ['StartEvent_OrderReceived', 'Task_CancelOrder', 'EndEvent_OrderCancelled']) {
      await expect(shape(b.page, id)).toBeInViewport(); // fitted into view
    }
    for (const w of [a, b]) await expect(notice(w.page)).not.toHaveAttribute('data-kind', 'invalid', { timeout: ON_DISK_MS });
    await expect.poll(async () => shapeY(await disk(), 'Task_CancelOrder'), { timeout: ON_DISK_MS }).toBe(moved.y);
    expect(await b.page.evaluate(() => window.__noReload)).toBe(true);

    // The recovered window edits normally.
    await typeLabel(b.page, 'Task_ShipOrder', 'Ship parcel');
    await expect(label(a.page, 'Task_ShipOrder')).toHaveText('Ship parcel', { timeout: VISIBLE_MS });
    await expect.poll(disk, { timeout: ON_DISK_MS }).toContain('name="Ship parcel"');
    await expectHealthyWindows();
  });

  test('a change on disk reaches every open window', async ({ browser }) => {
    const [a, b] = await openWindows(browser, 2);
    await writeFile(fixture.file, withName(original, 'Check stock', 'Check stock levels'));
    for (const w of [a, b]) {
      await expect(label(w.page, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: VISIBLE_MS });
      await expect(notice(w.page)).toHaveAttribute('data-kind', 'reloaded');
      expect(w.ws.count('sent', 'update')).toBe(0);
    }
    await expectHealthyWindows();
  });
});
