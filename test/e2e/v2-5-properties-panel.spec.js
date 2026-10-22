// V2-5: properties panel (bpmn-js-properties-panel, plain BPMN provider), first use case: a signal
// name on a signal end event. Real CLI, real browser, real disk, real `git diff`; a second window is
// a collaborator coming in through the share link (stand-in tunnel), so host and collaborator pages
// are both covered. Every write must be made by the minimal-diff writer without loss
// (BPMN_EDIT_DEBUG_WRITES=1 reports each one).
import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { collectPageErrors, copyFixture, startCli } from './helpers/cli.js';
import {
  center, clickEmptyCanvas, expectNoTempFiles, git, shape, status,
} from './helpers/editor.js';

const CF_HEADERS = { 'cf-ray': '8d0e3c7b5a1f2e4d-LJU', 'cf-connecting-ip': '203.0.113.9' };
const STORAGE_KEY = 'bpmn-edit.properties-panel';

/** The writes the CLI reported with BPMN_EDIT_DEBUG_WRITES=1, as "mode lost=n". */
function writes(stderr) {
  return [...stderr.matchAll(/^bpmn-edit: debug: write (.*)$/gm)].map(([, line]) => (
    `${/(?:^| )mode=(\S+)/.exec(line)?.[1]} lost=${/(?:^| )lost=(\d+)/.exec(line)?.[1] ?? 0}`));
}

/** Lines added + deleted in the repo's working tree (`git diff --numstat`). */
function diffLines(dir) {
  const out = git(dir, 'diff', '--numstat').trim();
  if (!out) return 0;
  return out.split('\n').reduce((sum, line) => sum + line.split('\t').slice(0, 2).map(Number).reduce((a, b) => a + b, 0), 0);
}

/** The bpmn:signal elements on disk: [{ id, name }]. */
function signalsIn(xml) {
  return [...xml.matchAll(/<bpmn:signal\b([^>]*?)\/?>/g)].map(([, attrs]) => ({
    id: /\bid="([^"]*)"/.exec(attrs)?.[1],
    name: /\bname="([^"]*)"/.exec(attrs)?.[1],
  }));
}

/** signalRef of the signalEventDefinition inside the flow node `id` on disk (null if none). */
function signalRefOf(xml, id) {
  const start = xml.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`no ${id} on disk`);
  const end = xml.slice(start).search(/<\/bpmn:\w*Event>/);
  const definition = /<bpmn:signalEventDefinition\b[^>]*>/.exec(xml.slice(start, start + end))?.[0];
  if (!definition) throw new Error(`no signalEventDefinition in ${id}`);
  return /\bsignalRef="([^"]*)"/.exec(definition)?.[1] ?? null;
}

/**
 * Routes the page's WebSocket through the test: while `hold()` is on, 'update' frames the page sends
 * are kept back until `open()` (like a slow network), to force the order in which the host gets them.
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
    open() {
      holding = false;
      for (const message of held.splice(0)) server.send(message);
    },
  };
}

const panel = (page) => page.locator('#properties-panel');
const toggle = (page) => page.locator('#properties-toggle');

const selectedIds = (page) => page.evaluate(() => window.bpmnModeler.get('selection').get().map((e) => e.id));

/**
 * Clicks an element on the canvas, unless it is the selection already (a click on the selected
 * element deselects it); the panel then shows it.
 */
async function select(page, id) {
  const selected = await selectedIds(page);
  if (selected.length !== 1 || selected[0] !== id) {
    const at = await center(shape(page, id));
    await page.mouse.click(at.x, at.y);
  }
  await expect(panel(page).locator('.bio-properties-panel-header-type')).toBeVisible();
  await expect.poll(() => selectedIds(page)).toEqual([id]);
}

/** Opens a group of the panel (e.g. 'signal', 'general') unless it is open. */
async function openGroup(page, id) {
  const header = panel(page).locator(`[data-group-id="group-${id}"] > .bio-properties-panel-group-header`);
  await expect(header).toBeVisible();
  if (!(await header.evaluate((el) => el.classList.contains('open')))) await header.click();
  await expect(header).toHaveClass(/\bopen\b/);
}

const signalSelect = (page) => panel(page).locator('#bio-properties-panel-signalRef');
const signalName = (page) => panel(page).locator('#bio-properties-panel-signalName');
const nameField = (page) => panel(page).locator('#bio-properties-panel-name');

/** Shows the panel with the toolbar button (it starts closed). */
async function openPanel(page) {
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
}

async function waitSaved(page) {
  await expect(status(page)).toHaveAttribute('data-state', 'saved');
}

test.describe('V2-5: properties panel', () => {
  let fixture;
  let cli;
  let contexts;

  test.beforeEach(async () => {
    contexts = [];
    fixture = await copyFixture('signal.bpmn');
    git(fixture.dir, 'init', '-q');
    git(fixture.dir, 'add', 'signal.bpmn');
    git(fixture.dir, 'commit', '-q', '-m', 'initial');
    cli = await startCli(fixture.file, {
      cwd: fixture.dir,
      env: { BPMN_EDIT_DEBUG_WRITES: '1', BPMN_EDIT_TEST_TUNNEL: 'fake', BPMN_EDIT_TEST_TUNNEL_DELAY_MS: '100' },
    });
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = fixture = undefined;
  });

  const disk = () => readFile(fixture.file, 'utf8');

  /** A host window (own browser context), 1280 px wide, with the panel opened by the user. */
  async function openHost(browser, { width = 1280 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 760 } });
    contexts.push(context);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await page.goto(cli.url);
    await expect(shape(page, 'EndEvent_Shipped')).toBeVisible();
    await waitSaved(page);
    await openPanel(page);
    return { page, errors };
  }

  /** Starts sharing in `host` and opens the share link as a collaborator (own context). */
  async function openCollaborator(browser, host) {
    await host.locator('#share-start').click();
    await expect(host.locator('#share-url')).toBeVisible({ timeout: 5000 });
    const token = /\/s\/([A-Za-z0-9_-]{32})$/.exec(await host.locator('#share-url').inputValue())[1];
    const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, extraHTTPHeaders: CF_HEADERS });
    contexts.push(context);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await page.goto(`${cli.baseUrl}s/${token}/`);
    await expect(shape(page, 'EndEvent_Shipped')).toBeVisible();
    await waitSaved(page);
    await openPanel(page);
    return { page, errors };
  }

  test('signal end event: create, name and rename a signal, reuse it, undo/redo; disk, git diff and a collaborator follow',
    async ({ browser }) => {
      const { page: host, errors: hostErrors } = await openHost(browser);
      const { page: collab, errors: collabErrors } = await openCollaborator(browser, host);

      // Open (by the toolbar button); the canvas leaves room for it.
      const canvasBox = await host.locator('#canvas').boundingBox();
      const panelBox = await panel(host).boundingBox();
      expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(panelBox.x + 0.5);
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1280.5);

      // Create a signal from the end event's panel; its name defaults to its id, then "OrderShipped".
      await select(host, 'EndEvent_Shipped');
      await expect(panel(host).locator('.bio-properties-panel-header-type')).toHaveText(/signal end event/i);
      await openGroup(host, 'signal');
      await signalSelect(host).selectOption({ label: 'Create new ...' });
      await expect(signalName(host)).toBeVisible();
      await signalName(host).fill('OrderShipped');
      await expect.poll(async () => signalsIn(await disk()).map((s) => s.name)).toEqual(['OrderShipped']);
      await waitSaved(host);
      let xml = await disk();
      const [signal] = signalsIn(xml);
      expect(signal.id).toMatch(/^Signal_/);
      expect(signalRefOf(xml, 'EndEvent_Shipped')).toBe(signal.id);
      expect(signalRefOf(xml, 'Event_Notify')).toBeNull();
      // Under definitions, after the process and before the diagram (BPMN schema order).
      expect(xml.indexOf('</bpmn:process>')).toBeLessThan(xml.indexOf('<bpmn:signal '));
      expect(xml.indexOf('<bpmn:signal ')).toBeLessThan(xml.indexOf('<bpmndi:BPMNDiagram'));
      // Small diff: the signalRef attribute and the new bpmn:signal line.
      const diff = git(fixture.dir, 'diff');
      expect(diffLines(fixture.dir), diff).toBeLessThanOrEqual(4);
      expect(diff).toContain(`+  <bpmn:signal id="${signal.id}" name="OrderShipped" />`);
      expect(diff).toContain(`signalRef="${signal.id}"`);
      expect(writes(cli.stderr()).length).toBeGreaterThan(0);
      for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');

      // The collaborator sees it in their panel.
      await select(collab, 'EndEvent_Shipped');
      await openGroup(collab, 'signal');
      await expect(signalName(collab)).toHaveValue('OrderShipped');
      await expect(signalSelect(collab).locator('option:checked')).toHaveText('OrderShipped');

      // The collaborator renames it: disk and the host's open panel follow.
      await signalName(collab).fill('OrderHasShipped');
      await expect.poll(async () => signalsIn(await disk())).toEqual([{ id: signal.id, name: 'OrderHasShipped' }]);
      await expect(signalName(host)).toHaveValue('OrderHasShipped');
      // The host still looks at the end event (its selection survived the collaborator's update).
      await expect(panel(host).locator('.bio-properties-panel-header-label')).toHaveText('Order shipped');

      // Pick the existing signal on the other signal event (host).
      await select(host, 'Event_Notify');
      await openGroup(host, 'signal');
      await signalSelect(host).selectOption({ label: 'OrderHasShipped' });
      await expect.poll(async () => signalRefOf(await disk(), 'Event_Notify')).toBe(signal.id);
      xml = await disk();
      expect(signalsIn(xml)).toHaveLength(1);
      expect(signalRefOf(xml, 'EndEvent_Shipped')).toBe(signal.id);
      await select(collab, 'Event_Notify');
      await openGroup(collab, 'signal');
      await expect(signalName(collab)).toHaveValue('OrderHasShipped');

      // Undo (keyboard, canvas focused) takes the reference back, everywhere; redo restores it.
      await waitSaved(host);
      await clickEmptyCanvas(host);
      await host.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => signalRefOf(await disk(), 'Event_Notify')).toBeNull();
      await host.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(async () => signalRefOf(await disk(), 'Event_Notify')).toBe(signal.id);
      await waitSaved(host);
      // Undo from inside the panel (the panel's own shortcut): the collaborator's rename is not
      // the host's to undo, so the host's last own edit (the reference) is.
      await select(host, 'Event_Notify');
      await openGroup(host, 'signal');
      await signalSelect(host).focus();
      await host.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => signalRefOf(await disk(), 'Event_Notify')).toBeNull();
      await expect(signalSelect(collab).locator('option:checked')).toHaveText('<none>');
      await host.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(async () => signalRefOf(await disk(), 'Event_Notify')).toBe(signal.id);
      await waitSaved(host);
      await waitSaved(collab);

      xml = await disk();
      expect(signalsIn(xml)).toEqual([{ id: signal.id, name: 'OrderHasShipped' }]);
      for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
      expect(diffLines(fixture.dir), git(fixture.dir, 'diff')).toBeLessThanOrEqual(6);
      expect(hostErrors).toEqual([]);
      expect(collabErrors).toEqual([]);
    });

  test('a signal end event made with the palette and the wrench gets a signal', async ({ browser }) => {
    const { page, errors } = await openHost(browser);
    const before = await page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll().map((e) => e.id));

    // Drag an end event from the palette below the task.
    const tool = page.locator('.djs-palette .entry.bpmn-icon-end-event-none');
    const from = await center(tool);
    const task = await shape(page, 'Task_Ship').boundingBox();
    const to = { x: task.x + task.width / 2, y: task.y + task.height + 150 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 40, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await page.mouse.up();
    let id;
    await expect.poll(async () => {
      const ids = await page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll()
        .filter((e) => e.type === 'bpmn:EndEvent').map((e) => e.id));
      id = ids.find((i) => !before.includes(i));
      return id;
    }).toBeTruthy();
    await clickEmptyCanvas(page);

    // Wrench: replace it with a signal end event.
    await select(page, id);
    await page.locator('.djs-context-pad .entry[data-action="replace"]').click();
    await page.locator('.djs-popup [data-id="replace-with-signal-end"]').click();
    await expect.poll(() => page.evaluate((i) => window.bpmnModeler.get('elementRegistry').get(i)
      ?.businessObject.eventDefinitions?.[0]?.$type, id)).toBe('bpmn:SignalEventDefinition');

    await select(page, id);
    await openGroup(page, 'signal');
    await signalSelect(page).selectOption({ label: 'Create new ...' });
    await signalName(page).fill('OrderShipped');
    await expect.poll(async () => signalsIn(await disk()).map((s) => s.name)).toEqual(['OrderShipped']);
    await waitSaved(page);
    const xml = await disk();
    const [signal] = signalsIn(xml);
    expect(signalRefOf(xml, id)).toBe(signal.id);
    for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
    expect(errors).toEqual([]);
  });

  test('name, ID and documentation through the panel reach the disk minimally', async ({ browser }) => {
    const { page, errors } = await openHost(browser);
    await select(page, 'Task_Ship');
    await openGroup(page, 'general');
    await nameField(page).fill('Ship the order');
    await expect.poll(async () => (await disk()).includes('name="Ship the order"')).toBe(true);
    await waitSaved(page);
    expect(diffLines(fixture.dir)).toBe(2);

    await panel(page).locator('#bio-properties-panel-id').fill('Task_ShipIt');
    await panel(page).locator('#bio-properties-panel-id').press('Tab');
    await expect.poll(async () => (await disk()).includes('<bpmn:task id="Task_ShipIt"')).toBe(true);
    await waitSaved(page);
    let xml = await disk();
    expect(xml).toContain('targetRef="Task_ShipIt"');
    expect(xml).toContain('sourceRef="Task_ShipIt"');
    expect(xml).toContain('bpmnElement="Task_ShipIt"');
    expect(xml).not.toContain('"Task_Ship"');

    await openGroup(page, 'documentation');
    await panel(page).locator('#bio-properties-panel-documentation').fill('Hand it to the carrier.');
    await expect.poll(async () => (await disk()).includes('Hand it to the carrier.')).toBe(true);
    await waitSaved(page);
    xml = await disk();
    expect(xml).toMatch(/<bpmn:task id="Task_ShipIt" name="Ship the order">\s*<bpmn:documentation>Hand it to the carrier\.<\/bpmn:documentation>/);
    for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
    expect(errors).toEqual([]);
  });

  test('a change of the signal name made on disk shows in the open panel', async ({ browser }) => {
    const { page, errors } = await openHost(browser);
    await select(page, 'EndEvent_Shipped');
    await openGroup(page, 'signal');
    await signalSelect(page).selectOption({ label: 'Create new ...' });
    await signalName(page).fill('OrderShipped');
    await expect.poll(async () => signalsIn(await disk()).map((s) => s.name)).toEqual(['OrderShipped']);
    await waitSaved(page);
    await clickEmptyCanvas(page);
    await select(page, 'EndEvent_Shipped');

    // An IDE edits the name on disk.
    const xml = await disk();
    await writeFile(fixture.file, xml.replace('name="OrderShipped"', 'name="OrderDispatched"'));
    await expect(signalName(page)).toHaveValue('OrderDispatched');
    await expect(signalSelect(page).locator('option:checked')).toHaveText('OrderDispatched');
    // Still showing the end event, not the process.
    await expect(panel(page).locator('.bio-properties-panel-header-label')).toHaveText('Order shipped');
    expect(errors).toEqual([]);
  });

  test('typing in a panel field while someone else edits: the text and the focus stay', async ({ browser }) => {
    const { page: host, errors: hostErrors } = await openHost(browser);
    const { page: collab, errors: collabErrors } = await openCollaborator(browser, host);
    await select(host, 'Task_Ship');
    await openGroup(host, 'general');
    await nameField(host).click();
    await nameField(host).press('End');
    // The host keeps typing (a key every 120 ms: the panel commits only after a pause) while the
    // collaborator's edits arrive, so they arrive with typed text not committed yet.
    const imports = () => host.evaluate(() => window.bpmnTestImports ?? 0);
    await host.evaluate(() => {
      window.bpmnModeler.on('import.done', () => { window.bpmnTestImports = (window.bpmnTestImports ?? 0) + 1; });
    });
    const typing = host.keyboard.type(' now and then', { delay: 120 });
    await host.waitForTimeout(250);
    await collab.evaluate(() => {
      const modeler = window.bpmnModeler;
      const start = modeler.get('elementRegistry').get('StartEvent_Paid');
      modeler.get('modeling').updateLabel(start, 'Paid (collab)');
    });
    await expect(shape(host, 'StartEvent_Paid_label')).toContainText('collab');
    expect(await imports()).toBe(1);
    await typing;
    // Still in the field, caret at the end: typing goes on.
    await expect(nameField(host)).toBeFocused();
    await host.keyboard.type('!', { delay: 30 });
    await expect(nameField(host)).toHaveValue('Ship order now and then!');
    await expect.poll(async () => (await disk()).includes('name="Ship order now and then!"'), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await disk()).includes('name="Paid (collab)"')).toBe(true);
    await expect(shape(collab, 'Task_Ship')).toContainText('Ship order now and then!');

    // Keys typed in a panel field never act on the diagram (Delete, Backspace, shortcuts).
    await select(host, 'Task_Ship');
    await nameField(host).click();
    for (const key of ['Delete', 'Backspace', 'e', 'ControlOrMeta+a', 'Delete']) await nameField(host).press(key);
    await host.keyboard.type('Ship');
    await expect.poll(async () => (await disk()).includes('<bpmn:task id="Task_Ship" name="Ship">')).toBe(true);
    await expect(shape(host, 'Task_Ship')).toBeVisible();
    await waitSaved(host);
    for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
    expect(hostErrors).toEqual([]);
    expect(collabErrors).toEqual([]);
  });

  test('typing in a field of an element someone else deletes: the text goes nowhere else, with a notice', async ({ browser }) => {
    const { page: a, errors: aErrors } = await openHost(browser);
    const { page: b, errors: bErrors } = await openHost(browser);
    const original = await disk();
    await select(a, 'Task_Ship');
    await openGroup(a, 'general');
    await nameField(a).click();
    await nameField(a).press('ControlOrMeta+a');
    // A types slowly (nothing committed: a key every 100 ms); B deletes the task meanwhile.
    const typing = a.keyboard.type('Pack order', { delay: 100 });
    await a.waitForTimeout(250);
    await select(b, 'Task_Ship');
    await b.keyboard.press('Delete');
    await typing;
    await expect(a.locator('#toast')).toHaveText('Your change to “Ship order” was not applied: someone else deleted it');
    await expect.poll(async () => (await disk()).includes('id="Task_Ship"')).toBe(false);
    await a.waitForTimeout(1200); // longer than the panel's commit delay
    await waitSaved(a);
    const xml = await disk();
    expect(xml).not.toContain('Pack');
    expect(xml).toContain('<bpmn:process id="Process_Shipping" name="Shipping process" isExecutable="false">');
    expect(xml.match(/name="[^"]*"/g).filter((n) => !original.includes(n))).toEqual([]);
    // The panel shows the process, its name untouched.
    await expect(nameField(a)).toHaveValue('Shipping process');
    expect(aErrors).toEqual([]);
    expect(bErrors).toEqual([]);
  });

  test('no keystroke is lost while someone else\'s edits keep arriving', async ({ browser }) => {
    const { page: a, errors: aErrors } = await openHost(browser);
    const { page: b, errors: bErrors } = await openHost(browser);
    await select(a, 'StartEvent_Paid');
    await openGroup(a, 'general');
    await nameField(a).click();
    await nameField(a).press('ControlOrMeta+a');
    const text = 'The order was paid by card or by bank transfer, checked twice!';
    expect(text).toHaveLength(62);
    const imports = await a.evaluate(() => {
      window.bpmnTestImports = 0;
      window.bpmnModeler.on('import.done', () => { window.bpmnTestImports += 1; });
    });
    const typing = a.keyboard.type(text, { delay: 45 });
    for (let i = 0; i < 8; i += 1) {
      await b.waitForTimeout(350);
      await b.evaluate(() => {
        const modeler = window.bpmnModeler;
        modeler.get('modeling').moveElements([modeler.get('elementRegistry').get('Task_Ship')], { x: 0, y: 5 });
      });
    }
    await typing;
    expect(imports).toBeUndefined();
    expect(await a.evaluate(() => window.bpmnTestImports)).toBeGreaterThanOrEqual(3);
    await expect(nameField(a)).toHaveValue(text);
    await expect(nameField(a)).toBeFocused();
    await expect.poll(async () => (await disk()).includes(`<bpmn:startEvent id="StartEvent_Paid" name="${text}">`), { timeout: 10_000 }).toBe(true);
    await waitSaved(a);
    await waitSaved(b);
    await expect(a.locator('#toast')).toBeHidden();
    await expect.poll(() => b.evaluate(() => window.bpmnModeler.get('elementRegistry').get('StartEvent_Paid').businessObject.name)).toBe(text);
    expect(await b.evaluate(() => window.bpmnModeler.get('elementRegistry').get('Task_Ship').y)).toBe(160 + 40);
    for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
    expect(aErrors).toEqual([]);
    expect(bErrors).toEqual([]);
  });

  test('a change on disk of the value being typed wins, with a notice', async ({ browser }) => {
    const { page, errors } = await openHost(browser);
    await select(page, 'EndEvent_Shipped');
    await openGroup(page, 'signal');
    await signalSelect(page).selectOption({ label: 'Create new ...' });
    await signalName(page).fill('OrderShipped');
    await signalName(page).press('Tab');
    await expect.poll(async () => signalsIn(await disk()).map((x) => x.name)).toEqual(['OrderShipped']);
    await waitSaved(page);

    await signalName(page).click();
    await signalName(page).press('End');
    // Typing (a key every 150 ms, nothing committed) while an IDE renames the signal on disk.
    const typing = page.keyboard.type('abcdefghijklmn', { delay: 150 });
    await page.waitForTimeout(300);
    await writeFile(fixture.file, (await disk()).replace('name="OrderShipped"', 'name="OrderDispatched"'));
    await expect(page.locator('#toast')).toHaveText(
      "Your change to “Order shipped” was not applied: it was changed on disk at the same time (the file's version was kept)",
    );
    await typing;
    // The disk's name is kept; what was typed after it arrived goes on from there.
    await expect(signalName(page)).toBeFocused();
    await page.waitForTimeout(1200); // longer than the panel's commit delay
    await waitSaved(page);
    await expect.poll(async () => signalsIn(await disk())[0].name, { timeout: 10_000 }).toBe(await signalName(page).inputValue());
    const name = signalsIn(await disk())[0].name;
    expect(name).toMatch(/^OrderDispatched[a-n]*$/);
    expect('abcdefghijklmn'.endsWith(name.slice('OrderDispatched'.length))).toBe(true);
    for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
    expect(errors).toEqual([]);
  });

  test('concurrent edits: a panel rename is re-applied on top of someone else\'s edit; the same attribute or a new signal is reported',
    async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
      contexts.push(context);
      const a = await context.newPage();
      const aErrors = collectPageErrors(a);
      const gate = await gateUpdates(a);
      await a.goto(cli.url);
      await expect(shape(a, 'EndEvent_Shipped')).toBeVisible();
      await waitSaved(a);
      await openPanel(a);
      const { page: b, errors: bErrors } = await openCollaborator(browser, a);
      const toast = (page) => page.locator('#toast');

      // A signal to work with.
      await select(a, 'EndEvent_Shipped');
      await openGroup(a, 'signal');
      await signalSelect(a).selectOption({ label: 'Create new ...' });
      await signalName(a).fill('OrderShipped');
      await signalName(a).press('Tab');
      await expect.poll(async () => signalsIn(await disk()).map((x) => x.name)).toEqual(['OrderShipped']);
      await waitSaved(a);
      await waitSaved(b);

      // 1. A renames the signal (update held back); B renames a task and is accepted first. A's update
      //    is refused, the rename is re-applied on top of B's document: both are kept, no notice.
      gate.hold();
      await signalName(a).fill('OrderHasShipped');
      await signalName(a).press('Tab');
      await expect.poll(() => gate.held(), { timeout: 3000 }).toBe(1);
      await b.evaluate(() => {
        const modeler = window.bpmnModeler;
        modeler.get('modeling').updateLabel(modeler.get('elementRegistry').get('Task_Ship'), 'Ship it');
      });
      await expect.poll(async () => (await disk()).includes('name="Ship it"')).toBe(true);
      gate.open();
      await expect.poll(async () => signalsIn(await disk()).map((x) => x.name)).toEqual(['OrderHasShipped']);
      await waitSaved(a);
      await waitSaved(b);
      expect(await disk()).toContain('name="Ship it"');
      await expect(signalName(a)).toHaveValue('OrderHasShipped');
      await expect(toast(a)).toBeHidden();

      // 2. Both rename the signal: the one accepted first wins, the other is told.
      await select(b, 'EndEvent_Shipped');
      await openGroup(b, 'signal');
      gate.hold();
      await signalName(a).fill('From A');
      await signalName(a).press('Tab');
      await expect.poll(() => gate.held(), { timeout: 3000 }).toBe(1);
      await signalName(b).fill('From B');
      await signalName(b).press('Tab');
      await expect.poll(async () => signalsIn(await disk()).map((x) => x.name)).toEqual(['From B']);
      gate.open();
      await expect(toast(a)).toHaveText('Your change to “OrderHasShipped” was not applied: someone else changed it first');
      await waitSaved(a);
      await expect(signalName(a)).toHaveValue('From B');
      expect(signalsIn(await disk()).map((x) => x.name)).toEqual(['From B']);

      // 3. Creating a signal is not re-applied: it is dropped, with a notice that reads well.
      await select(a, 'Event_Notify');
      await openGroup(a, 'signal');
      gate.hold();
      await signalSelect(a).selectOption({ label: 'Create new ...' });
      await expect.poll(() => gate.held(), { timeout: 3000 }).toBe(1);
      await b.evaluate(() => {
        const modeler = window.bpmnModeler;
        modeler.get('modeling').updateLabel(modeler.get('elementRegistry').get('Task_Ship'), 'Ship it now');
      });
      await expect.poll(async () => (await disk()).includes('name="Ship it now"')).toBe(true);
      gate.open();
      await expect(toast(a)).toHaveText("Your edit (properties panel change) could not be merged with someone else's and was not applied");
      await waitSaved(a);
      expect(signalsIn(await disk())).toHaveLength(1);
      expect(signalRefOf(await disk(), 'Event_Notify')).toBeNull();

      for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
      expect(aErrors).toEqual([]);
      expect(bErrors).toEqual([]);
    });

  test('the toggle hides and shows the panel, resizes the canvas and is remembered (also with storage blocked)',
    async ({ browser }) => {
      const { page, errors } = await openHost(browser);
      await expect(panel(page)).toBeVisible();
      const wide = (await page.locator('#canvas').boundingBox()).width;
      const svgWidth = () => page.evaluate(() => window.bpmnModeler.get('canvas').getSize().width);
      await toggle(page).click();
      await expect(panel(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
      expect((await page.locator('#canvas').boundingBox()).width).toBeGreaterThan(wide + 250);
      await expect.poll(svgWidth).toBeGreaterThan(wide + 250);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe('closed');

      await page.reload();
      await expect(shape(page, 'EndEvent_Shipped')).toBeVisible();
      await expect(panel(page)).toBeHidden();
      await toggle(page).click();
      await expect(panel(page)).toBeVisible();
      await page.reload();
      await expect(shape(page, 'EndEvent_Shipped')).toBeVisible();
      await expect(panel(page)).toBeVisible();
      expect(errors).toEqual([]);

      // A first visit starts closed; the canvas has the whole window.
      const fresh = await browser.newContext({ viewport: { width: 1280, height: 700 } });
      contexts.push(fresh);
      const first = await fresh.newPage();
      await first.goto(cli.url);
      await expect(shape(first, 'EndEvent_Shipped')).toBeVisible();
      await expect(panel(first)).toBeHidden();
      await expect(toggle(first)).toBeVisible();
      expect((await first.locator('#canvas').boundingBox()).width).toBeGreaterThanOrEqual(1279);

      // Storage blocked (every access throws): closed, and the toggle still works for the page.
      for (const [width, open] of [[1280, false], [1000, false]]) {
        const context = await browser.newContext({ viewport: { width, height: 700 } });
        contexts.push(context);
        await context.addInitScript(() => {
          Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
        });
        const blocked = await context.newPage();
        const blockedErrors = collectPageErrors(blocked);
        await blocked.goto(cli.url);
        await expect(shape(blocked, 'EndEvent_Shipped')).toBeVisible();
        if (open) await expect(panel(blocked)).toBeVisible();
        else await expect(panel(blocked)).toBeHidden();
        await toggle(blocked).click();
        if (open) await expect(panel(blocked)).toBeHidden();
        else await expect(panel(blocked)).toBeVisible();
        // At 1000 px the toolbar and the open panel still fit.
        if (!open) {
          const box = await panel(blocked).boundingBox();
          expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
          const toggleBox = await toggle(blocked).boundingBox();
          expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(width + 0.5);
          expect((await blocked.locator('#canvas').boundingBox()).width).toBeGreaterThan(600);
        }
        expect(blockedErrors).toEqual([]);
      }
    });
});
