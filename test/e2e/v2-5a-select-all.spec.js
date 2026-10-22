// V2-5a: the Name field of a signal (and of a message, error or escalation) selects its whole text
// when the user focuses it, so typing replaces the generated id ("Signal_3imqgu0") instead of being
// appended to it. A second click places the caret as usual; other fields are unchanged; the focus
// given back after someone else's update never selects (it would wipe what is being typed).
// Real CLI, real browser, real disk (BPMN_EDIT_DEBUG_WRITES=1 reports each write).
import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { collectPageErrors, copyFixture, startCli } from './helpers/cli.js';
import {
  center, clickEmptyCanvas, expectNoTempFiles, git, shape, status,
} from './helpers/editor.js';

/** The writes the CLI reported with BPMN_EDIT_DEBUG_WRITES=1, as "mode lost=n". */
function writes(stderr) {
  return [...stderr.matchAll(/^bpmn-edit: debug: write (.*)$/gm)].map(([, line]) => (
    `${/(?:^| )mode=(\S+)/.exec(line)?.[1]} lost=${/(?:^| )lost=(\d+)/.exec(line)?.[1] ?? 0}`));
}

/** The `bpmn:<kind>` root elements on disk (signal, message, error, escalation): [{ id, name }]. */
function rootsIn(xml, kind) {
  return [...xml.matchAll(new RegExp(`<bpmn:${kind}\\b([^>]*?)/?>`, 'g'))].map(([, attrs]) => ({
    id: /\bid="([^"]*)"/.exec(attrs)?.[1],
    name: /\bname="([^"]*)"/.exec(attrs)?.[1],
  }));
}

const panel = (page) => page.locator('#properties-panel');
const refSelect = (page, kind) => panel(page).locator(`#bio-properties-panel-${kind}Ref`);
const refName = (page, kind) => panel(page).locator(`#bio-properties-panel-${kind}Name`);

/** [selectionStart, selectionEnd, value length] of a field. */
const selection = (locator) => locator.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length]);

const selectedIds = (page) => page.evaluate(() => window.bpmnModeler.get('selection').get().map((e) => e.id));

/** Clicks an element on the canvas (unless it is the selection already); the panel then shows it. */
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

/**
 * Clicks inside a field near its right end (past the text: the caret goes to the end). A textarea
 * (the element Name) shows a button at its right end on hover that opens a popup editor: kept clear.
 */
async function clickNearEnd(locator) {
  const box = await locator.boundingBox();
  const inset = (await locator.evaluate((el) => el.tagName)) === 'TEXTAREA' ? 48 : 6;
  await locator.page().mouse.click(box.x + box.width - inset, box.y + box.height / 2);
}

test.describe('V2-5a: select all on focus in a signal name', () => {
  let fixture;
  let cli;
  let contexts;

  test.afterEach(async () => {
    for (const context of contexts ?? []) await context.close();
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = fixture = contexts = undefined;
  });

  const disk = () => readFile(fixture.file, 'utf8');

  /** Starts the CLI on a fresh copy of `name` in a git repo. */
  async function start(name) {
    contexts = [];
    fixture = await copyFixture(name);
    git(fixture.dir, 'init', '-q');
    git(fixture.dir, 'add', name);
    git(fixture.dir, 'commit', '-q', '-m', 'initial');
    cli = await startCli(fixture.file, { cwd: fixture.dir, env: { BPMN_EDIT_DEBUG_WRITES: '1' } });
  }

  /** A window (own browser context) showing `firstId`, with the panel opened by the user. */
  async function open(browser, firstId) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
    contexts.push(context);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await page.goto(cli.url);
    await expect(shape(page, firstId)).toBeVisible();
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    await page.locator('#properties-toggle').click();
    await expect(panel(page)).toBeVisible();
    return { page, errors };
  }

  /** Picks "Create new ..." in the `kind` group of the selected element; returns the pre-filled name (a generated id). */
  async function createNew(page, kind) {
    await openGroup(page, kind);
    await refSelect(page, kind).selectOption({ label: 'Create new ...' });
    await expect(refName(page, kind)).toBeVisible();
    await expect(refName(page, kind)).toBeFocused(); // the panel focuses it (after a render)
    // (When the event had one, the field shows the old name for a render first.)
    await expect(refName(page, kind)).toHaveValue(new RegExp(`^${kind[0].toUpperCase()}${kind.slice(1)}_\\w+$`));
    return refName(page, kind).inputValue();
  }

  const finish = async (page, errors) => {
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    for (const write of writes(cli.stderr())) expect(write).toBe('minimal lost=0');
    expect(errors).toEqual([]);
  };

  test('new signal: a click in Name selects the generated id, typing replaces it; a second click places the caret',
    async ({ browser }) => {
      await start('signal.bpmn');
      const { page, errors } = await open(browser, 'EndEvent_Shipped');
      await select(page, 'EndEvent_Shipped');
      const prefill = await createNew(page, 'signal');
      const name = refName(page, 'signal');

      // The click the requester made: Name, then type.
      await name.click();
      await expect.poll(() => selection(name)).toEqual([0, prefill.length, prefill.length]);
      await page.keyboard.type('OrderShipped');
      await expect(name).toHaveValue('OrderShipped');
      await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: expect.stringMatching(/^Signal_/), name: 'OrderShipped' }]);

      // The field has the focus: a second click places the caret, typing inserts.
      await clickNearEnd(name);
      await expect.poll(() => selection(name)).toEqual([12, 12, 12]);
      await page.keyboard.type('Now');
      await expect(name).toHaveValue('OrderShippedNow');
      // And a click after typing too.
      await clickNearEnd(name);
      await page.keyboard.type('!');
      await expect(name).toHaveValue('OrderShippedNow!');
      await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: expect.stringMatching(/^Signal_/), name: 'OrderShippedNow!' }]);

      // Leaving the field and clicking into it again selects all again.
      await clickEmptyCanvas(page);
      await select(page, 'EndEvent_Shipped');
      await name.click();
      await expect.poll(() => selection(name)).toEqual([0, 16, 16]);
      await page.keyboard.type('OrderSent');
      await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: expect.stringMatching(/^Signal_/), name: 'OrderSent' }]);
      const [{ id }] = rootsIn(await disk(), 'signal');
      expect(git(fixture.dir, 'diff')).toContain(`<bpmn:signal id="${id}" name="OrderSent" />`);
      await finish(page, errors);
    });

  test('new signal: typing right after "Create new ..." replaces the id; so does Tab into Name', async ({ browser, browserName }) => {
    await start('signal.bpmn');
    const { page, errors } = await open(browser, 'EndEvent_Shipped');

    // The panel itself moves the focus to Name after "Create new ...", all selected.
    await select(page, 'EndEvent_Shipped');
    await createNew(page, 'signal');
    await expect(refName(page, 'signal')).toBeFocused();
    await page.keyboard.type('OrderShipped');
    await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: expect.stringMatching(/^Signal_/), name: 'OrderShipped' }]);

    // Another event: create, leave the field, come back with Tab from the signal select.
    await select(page, 'Event_Notify');
    const second = await createNew(page, 'signal');
    await refSelect(page, 'signal').focus();
    // WebKit, like Safari, tabs from a select only with Option (Alt) held.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const name = refName(page, 'signal');
    await expect(name).toBeFocused();
    await expect.poll(() => selection(name)).toEqual([0, second.length, second.length]);
    await page.keyboard.type('WarehouseNotified');
    await expect.poll(async () => rootsIn(await disk(), 'signal').map((s) => s.name).sort())
      .toEqual(['OrderShipped', 'WarehouseNotified']);
    // After Tab, a click places the caret (it is the second way in).
    await clickNearEnd(name);
    await page.keyboard.type('Now');
    await expect(name).toHaveValue('WarehouseNotifiedNow');
    await expect.poll(async () => rootsIn(await disk(), 'signal').map((s) => s.name).sort())
      .toEqual(['OrderShipped', 'WarehouseNotifiedNow']);
    await finish(page, errors);
  });

  test('renaming an existing signal, and new messages, errors and escalations: a click selects all', async ({ browser }) => {
    await start('references.bpmn');
    const { page, errors } = await open(browser, 'EndEvent_Signal');

    await select(page, 'EndEvent_Signal');
    await openGroup(page, 'signal');
    const signal = refName(page, 'signal');
    await expect(signal).toHaveValue('OrderShipped');
    await signal.click();
    await expect.poll(() => selection(signal)).toEqual([0, 12, 12]);
    await page.keyboard.type('OrderDispatched');
    await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: 'Signal_Shipped', name: 'OrderDispatched' }]);

    for (const [element, kind, typed] of [
      ['EndEvent_Message', 'message', 'CustomerTold'],
      ['EndEvent_Error', 'error', 'OrderInvalid'],
      ['EndEvent_Escalation', 'escalation', 'OrderStuck'],
    ]) {
      await clickEmptyCanvas(page);
      await select(page, element);
      const prefill = await createNew(page, kind);
      await clickEmptyCanvas(page); // the panel's own focus out of the way: a fresh click into it
      await select(page, element);
      await openGroup(page, kind);
      const name = refName(page, kind);
      await name.click();
      await expect.poll(() => selection(name), kind).toEqual([0, prefill.length, prefill.length]);
      await page.keyboard.type(typed);
      await expect.poll(async () => rootsIn(await disk(), kind).map((x) => x.name), kind).toEqual([typed]);
    }
    await finish(page, errors);
  });

  test('element Name, ID, documentation and an error code: a click places the caret, as before', async ({ browser }) => {
    await start('references.bpmn');
    const { page, errors } = await open(browser, 'EndEvent_Error');
    await select(page, 'Task_Check');
    await openGroup(page, 'general');
    const name = panel(page).locator('#bio-properties-panel-name');
    await clickNearEnd(name);
    await expect.poll(() => selection(name)).toEqual([11, 11, 11]);
    await page.keyboard.type(' twice');
    await expect(name).toHaveValue('Check order twice');
    await expect.poll(async () => (await disk()).includes('<bpmn:task id="Task_Check" name="Check order twice">')).toBe(true);

    const id = panel(page).locator('#bio-properties-panel-id');
    await clickNearEnd(id);
    await expect.poll(() => selection(id)).toEqual([10, 10, 10]);

    await openGroup(page, 'documentation');
    const documentation = panel(page).locator('#bio-properties-panel-documentation');
    await documentation.click();
    await page.keyboard.type('Stock and address.');
    await page.keyboard.press('Home');
    await documentation.click(); // a second click in a filled textarea does not select all
    const [from, to] = await selection(documentation);
    expect(from).toBe(to);

    await clickEmptyCanvas(page);
    await select(page, 'EndEvent_Error');
    await createNew(page, 'error');
    const code = panel(page).locator('#bio-properties-panel-errorCode');
    await code.click();
    await page.keyboard.type('E42');
    await clickNearEnd(code);
    await expect.poll(() => selection(code)).toEqual([3, 3, 3]);
    await page.keyboard.type('1');
    await expect.poll(async () => (await disk()).includes('errorCode="E421"')).toBe(true);
    await finish(page, errors);
  });

  test('someone else\'s edits while a signal name is typed: the focus given back selects nothing, no key is lost',
    async ({ browser }) => {
      await start('references.bpmn');
      const { page: a, errors: aErrors } = await open(browser, 'EndEvent_Signal');
      const { page: b, errors: bErrors } = await open(browser, 'EndEvent_Signal');
      await select(a, 'EndEvent_Signal');
      await openGroup(a, 'signal');
      const name = refName(a, 'signal');
      await name.click();
      await expect.poll(() => selection(name)).toEqual([0, 12, 12]);
      await a.evaluate(() => {
        window.bpmnTestImports = 0;
        window.bpmnModeler.on('import.done', () => { window.bpmnTestImports += 1; });
        window.bpmnTestRefocus = 0;
        window.addEventListener('focusin', (event) => {
          if (event.target.id === 'bio-properties-panel-signalName') window.bpmnTestRefocus += 1;
        });
      });
      const text = 'The order left the warehouse on time';
      const typing = a.keyboard.type(text, { delay: 70 });
      for (let i = 0; i < 5; i += 1) {
        await b.waitForTimeout(400);
        await b.evaluate(() => {
          const modeler = window.bpmnModeler;
          modeler.get('modeling').moveElements([modeler.get('elementRegistry').get('Task_Check')], { x: 0, y: 5 });
        });
      }
      await typing;
      expect(await a.evaluate(() => window.bpmnTestImports)).toBeGreaterThanOrEqual(2); // a window sends edits close together as one update
      // The panel's fields were re-mounted and the focus given back to the new one.
      expect(await a.evaluate(() => window.bpmnTestRefocus)).toBeGreaterThanOrEqual(1);
      await expect(name).toHaveValue(text);
      await expect(name).toBeFocused();
      // Nothing selected after the last update: the next key is added, not a replacement.
      const [from, to] = await selection(name);
      expect(from).toBe(to);
      // And the given-back focus is no new focus: a click in the field places the caret.
      await clickNearEnd(name);
      await expect.poll(() => selection(name)).toEqual([text.length, text.length, text.length]);
      await a.keyboard.type('!');
      await expect(name).toHaveValue(`${text}!`);
      await expect.poll(async () => rootsIn(await disk(), 'signal'), { timeout: 10_000 })
        .toEqual([{ id: 'Signal_Shipped', name: `${text}!` }]);
      await expect(a.locator('#toast')).toBeHidden();
      await expect(status(b)).toHaveAttribute('data-state', 'saved');
      await expect.poll(() => b.evaluate(() => window.bpmnModeler.get('elementRegistry').get('EndEvent_Signal')
        .businessObject.eventDefinitions[0].signalRef.name)).toBe(`${text}!`);
      await finish(a, aErrors);
      expect(bErrors).toEqual([]);
    });

  test('another tab and back while a signal name is typed: the focus the browser gives back selects nothing',
    async ({ browser, browserName }) => {
      // Playwright makes every page look focused; Chrome's DevTools protocol can turn that off, so the
      // window really loses and regains the focus (blur, then focus/focusin on the field).
      test.skip(browserName !== 'chromium', 'needs the DevTools protocol to switch tabs for real');
      await start('references.bpmn');
      const { page, errors } = await open(browser, 'EndEvent_Signal');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await page.bringToFront();
      await select(page, 'EndEvent_Signal');
      await openGroup(page, 'signal');
      const name = refName(page, 'signal');
      await name.click();
      await page.keyboard.type('Order');
      await page.evaluate(() => {
        window.bpmnTestFocusins = 0;
        document.getElementById('bio-properties-panel-signalName')
          .addEventListener('focusin', () => { window.bpmnTestFocusins += 1; });
      });
      const other = await page.context().newPage();
      await other.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
      expect(await page.evaluate(() => window.bpmnTestFocusins)).toBe(1); // the browser did focus it again
      await expect(name).toBeFocused();
      await expect.poll(() => selection(name)).toEqual([5, 5, 5]);
      await page.keyboard.type('Shipped');
      await expect(name).toHaveValue('OrderShipped');
      await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: 'Signal_Shipped', name: 'OrderShipped' }]);
      // A real new focus after that selects all again.
      await clickEmptyCanvas(page);
      await select(page, 'EndEvent_Signal');
      await name.click();
      await expect.poll(() => selection(name)).toEqual([0, 12, 12]);
      await finish(page, errors);
    });

  /**
   * Real focus for `page` (Chrome only: Playwright makes every page look focused otherwise); returns
   * `awayAndBack(whileAway)`, which switches to another tab, runs `whileAway`, and comes back.
   */
  async function realFocus(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.bringToFront();
    let other = null;
    return async (whileAway = async () => {}) => {
      other ??= await page.context().newPage();
      await other.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      await whileAway();
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    };
  }

  /** Starts counting the page's imports (someone else's update, or the file changed on disk). */
  const countImports = (page) => page.evaluate(() => {
    window.bpmnTestImports = 0;
    window.bpmnModeler.on('import.done', () => { window.bpmnTestImports += 1; });
  });
  const imports = (page) => page.evaluate(() => window.bpmnTestImports);

  /** Someone else (window `other`) moves Task_Check a little. */
  const moveTask = (other) => other.evaluate(() => {
    const modeler = window.bpmnModeler;
    modeler.get('modeling').moveElements([modeler.get('elementRegistry').get('Task_Check')], { x: 0, y: 10 });
  });

  for (const source of ['another window', 'the file on disk']) {
    test(`a signal name half typed, another tab, an update from ${source} meanwhile, back: typing goes on`,
      async ({ browser, browserName }) => {
        test.skip(browserName !== 'chromium', 'needs the DevTools protocol to switch tabs for real');
        await start('references.bpmn');
        const { page, errors } = await open(browser, 'EndEvent_Signal');
        const other = source === 'another window' ? await open(browser, 'EndEvent_Signal') : null;
        const awayAndBack = await realFocus(page);
        await select(page, 'EndEvent_Signal');
        await openGroup(page, 'signal');
        const name = refName(page, 'signal');
        await name.click();
        await page.keyboard.type('OrderShipped');
        await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: 'Signal_Shipped', name: 'OrderShipped' }]);
        await expect(status(page)).toHaveAttribute('data-state', 'saved');
        await countImports(page);
        await awayAndBack(async () => {
          if (other) await moveTask(other.page);
          else await writeFile(fixture.file, (await disk()).replace('name="Check order"', 'name="Check the order"'));
          await expect.poll(() => imports(page)).toBeGreaterThanOrEqual(1);
          await page.waitForTimeout(200); // the panel re-renders while the tab is away
        });
        await expect(name).toBeFocused();
        await expect.poll(() => selection(name)).toEqual([12, 12, 12]);
        await page.keyboard.type('Now');
        await expect(name).toHaveValue('OrderShippedNow');
        await expect.poll(async () => rootsIn(await disk(), 'signal')).toEqual([{ id: 'Signal_Shipped', name: 'OrderShippedNow' }]);
        if (!other) expect(await disk()).toContain('<bpmn:task id="Task_Check" name="Check the order">');
        await finish(page, errors);
        if (other) expect(other.errors).toEqual([]);
      });
  }

  test('"Create new ...", then someone else\'s update: the first click in Name still selects all', async ({ browser }) => {
    await start('references.bpmn');
    const { page, errors } = await open(browser, 'EndEvent_Signal');
    const { page: b, errors: bErrors } = await open(browser, 'EndEvent_Signal');
    for (const [element, kind, typed] of [
      ['EndEvent_Signal', 'signal', 'OrderSent'],
      ['EndEvent_Message', 'message', 'CustomerTold'],
    ]) {
      await clickEmptyCanvas(page);
      await select(page, element);
      const prefill = await createNew(page, kind);
      const name = refName(page, kind);
      await expect(name).toBeFocused();
      await countImports(page);
      await moveTask(b);
      await expect.poll(() => imports(page)).toBeGreaterThanOrEqual(1);
      await expect(name).toBeFocused();
      await expect(name).toHaveValue(prefill);
      await name.click();
      await expect.poll(() => selection(name), kind).toEqual([0, prefill.length, prefill.length]);
      await page.keyboard.type(typed);
      await expect.poll(async () => rootsIn(await disk(), kind).map((x) => x.name).includes(typed), kind).toBe(true);
      expect(rootsIn(await disk(), kind).map((x) => x.name).filter((n) => n.includes(typed))).toEqual([typed]);
    }
    await finish(page, errors);
    expect(bErrors).toEqual([]);
  });

  test('"Create new ..." on an event that already has a named signal or message: typing at once replaces the id',
    async ({ browser }) => {
      await start('references.bpmn');
      const { page, errors } = await open(browser, 'EndEvent_Signal');

      // Signal: the end event refers to "OrderShipped".
      await select(page, 'EndEvent_Signal');
      await openGroup(page, 'signal');
      await expect(refName(page, 'signal')).toHaveValue('OrderShipped');
      const prefill = await createNew(page, 'signal');
      await expect.poll(() => selection(refName(page, 'signal'))).toEqual([0, prefill.length, prefill.length]);
      await page.keyboard.type('OrderSent');
      await expect.poll(async () => rootsIn(await disk(), 'signal').map((x) => x.name)).toEqual(['OrderShipped', 'OrderSent']);
      expect(git(fixture.dir, 'diff')).not.toContain('Signal_Shipped" name="OrderSent'); // the old one is kept
      await expect(page.locator('#toast')).toBeHidden();

      // Message: a first one named, then a new one in its place.
      await clickEmptyCanvas(page);
      await select(page, 'EndEvent_Message');
      await createNew(page, 'message');
      await page.keyboard.type('CustomerTold');
      await expect.poll(async () => rootsIn(await disk(), 'message').map((x) => x.name)).toEqual(['CustomerTold']);
      await clickEmptyCanvas(page);
      await select(page, 'EndEvent_Message');
      await openGroup(page, 'message');
      await expect(refName(page, 'message')).toHaveValue('CustomerTold');
      await createNew(page, 'message');
      await page.keyboard.type('CustomerCalled'); // at once, without looking
      await expect.poll(async () => rootsIn(await disk(), 'message').map((x) => x.name)).toEqual(['CustomerTold', 'CustomerCalled']);
      await finish(page, errors);
    });

  for (const source of ['another window', 'the file on disk']) {
    test(`"Create new ..." in place of a named signal, typing while an update from ${source} arrives: no key is lost`,
      async ({ browser }) => {
        await start('references.bpmn');
        const { page, errors } = await open(browser, 'EndEvent_Signal');
        const other = source === 'another window' ? await open(browser, 'EndEvent_Signal') : null;
        for (const [round, typed] of [[1, 'FreshSignalName'], [2, 'SecondSignal']]) {
          await clickEmptyCanvas(page);
          await select(page, 'EndEvent_Signal');
          await openGroup(page, 'signal');
          await createNew(page, 'signal');
          // The new signal is on disk (the IDE below edits that file, not an older one).
          await expect.poll(async () => rootsIn(await disk(), 'signal').length).toBe(round + 1);
          await expect(status(page)).toHaveAttribute('data-state', 'saved');
          await countImports(page);
          const typing = page.keyboard.type(typed, { delay: 60 }); // nothing committed until it ends
          await page.waitForTimeout(400);
          if (other) await moveTask(other.page);
          else await writeFile(fixture.file, (await disk()).replace(/name="Check[^"]*"/, `name="Check ${round}"`));
          await typing;
          expect(await imports(page), 'an import came in while typing').toBeGreaterThanOrEqual(1);
          await expect(refName(page, 'signal')).toHaveValue(typed);
          await expect.poll(async () => rootsIn(await disk(), 'signal').map((x) => x.name), { timeout: 10_000 })
            .toContain(typed);
          expect(rootsIn(await disk(), 'signal').map((x) => x.name).filter((n) => n.startsWith('Signal_'))).toEqual([]);
          await expect(page.locator('#toast')).toBeHidden();
        }
        expect(rootsIn(await disk(), 'signal').map((x) => x.name)).toEqual(['OrderShipped', 'FreshSignalName', 'SecondSignal']);
        await finish(page, errors);
        if (other) expect(other.errors).toEqual([]);
      });
  }

  /** Someone else's update: window `other` moves Task_Check, or (no window) an IDE renames it on disk. */
  async function update(other, n) {
    if (other) await moveTask(other.page);
    else await writeFile(fixture.file, (await disk()).replace(/(<bpmn:task id="Task_Check" name=")[^"]*"/, `$1IDE ${n}"`));
  }

  const messageEndName = async () => /<bpmn:endEvent id="EndEvent_Message" name="([^"]*)"/.exec(await disk())?.[1];

  for (const source of ['another window', 'the file on disk']) {
    test(`a name typed, the element left before its commit, typed again during an update from ${source}: no key is lost`,
      async ({ browser }) => {
        await start('references.bpmn');
        const { page, errors } = await open(browser, 'EndEvent_Message');
        const other = source === 'another window' ? await open(browser, 'EndEvent_Message') : null;
        await select(page, 'EndEvent_Message');
        await openGroup(page, 'general');
        const name = panel(page).locator('#bio-properties-panel-name');
        await name.click();
        await page.keyboard.press('End');
        await page.keyboard.type('Abc', { delay: 40 });
        await select(page, 'StartEvent_Placed'); // before the commit: it runs with the field gone
        await expect.poll(messageEndName).toBe('Customer toldAbc');
        await page.waitForTimeout(1000);

        await select(page, 'EndEvent_Message');
        await openGroup(page, 'general');
        await name.click();
        await page.keyboard.press('End');
        await countImports(page);
        const typing = page.keyboard.type('Def', { delay: 120 });
        await page.waitForTimeout(150);
        await update(other, 1);
        await typing;
        await expect.poll(() => imports(page)).toBeGreaterThanOrEqual(1);
        await page.keyboard.type('Ghi', { delay: 60 });
        await expect(name).toHaveValue('Customer toldAbcDefGhi');
        await expect.poll(messageEndName, { timeout: 10_000 }).toBe('Customer toldAbcDefGhi');
        await expect(page.locator('#toast')).toBeHidden();
        await finish(page, errors);
        if (other) expect(other.errors).toEqual([]);
      });

    test(`typed text put back after an update from ${source} and committed, then typed again during another: no key is lost`,
      async ({ browser }) => {
        await start('references.bpmn');
        const { page, errors } = await open(browser, 'EndEvent_Message');
        const other = source === 'another window' ? await open(browser, 'EndEvent_Message') : null;
        await select(page, 'EndEvent_Message');
        await openGroup(page, 'general');
        const name = panel(page).locator('#bio-properties-panel-name');
        await name.click();
        await page.keyboard.press('End');
        await countImports(page);
        await page.keyboard.type('Abc', { delay: 60 });
        await update(other, 1); // before the commit: the text is carried over the import
        await expect.poll(() => imports(page)).toBe(1);
        await expect.poll(messageEndName).toBe('Customer toldAbc'); // put back, then committed
        await page.waitForTimeout(800);
        await page.keyboard.type('Def', { delay: 60 });
        await update(other, 2);
        await expect.poll(() => imports(page)).toBe(2);
        await page.keyboard.type('Ghi', { delay: 60 });
        await expect(name).toHaveValue('Customer toldAbcDefGhi');
        await expect.poll(messageEndName, { timeout: 10_000 }).toBe('Customer toldAbcDefGhi');
        await expect(page.locator('#toast')).toBeHidden();
        await finish(page, errors);
        if (other) expect(other.errors).toEqual([]);
      });
  }

  test('"Create new ...", another tab and back: the first click in Name still selects all', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs the DevTools protocol to switch tabs for real');
    await start('signal.bpmn');
    const { page, errors } = await open(browser, 'EndEvent_Shipped');
    const awayAndBack = await realFocus(page);
    await select(page, 'EndEvent_Shipped');
    const prefill = await createNew(page, 'signal');
    const name = refName(page, 'signal');
    await expect(name).toBeFocused();
    await awayAndBack();
    await expect(name).toBeFocused();
    await name.click();
    await expect.poll(() => selection(name)).toEqual([0, prefill.length, prefill.length]);
    await page.keyboard.type('OrderShipped');
    await expect.poll(async () => rootsIn(await disk(), 'signal').map((x) => x.name)).toEqual(['OrderShipped']);
    // Once typed, away and back again: a click places the caret.
    await awayAndBack();
    await clickNearEnd(name);
    await page.keyboard.type('Now');
    await expect.poll(async () => rootsIn(await disk(), 'signal').map((x) => x.name)).toEqual(['OrderShippedNow']);
    await finish(page, errors);
  });
});
