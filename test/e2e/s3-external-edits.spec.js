// S3: external edits show up in the browser.
import { expect, test } from '@playwright/test';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCompleteBpmn } from '../../src/file.js';
import { collectPageErrors, startCli } from './helpers/cli.js';
import {
  clickEmptyCanvas, dragBy, expectNoTempFiles, expectViewboxUnchanged, git, label, openEditor, selectedIds, setupRepo,
  shape, status, typeLabel, viewbox,
} from './helpers/editor.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** External changes must show up this fast (watcher + settle + push + import). */
const VISIBLE_MS = 1500;
/** How long to watch the file for a write-back after an external change. */
const STABLE_MS = 2000;

function notice(page) {
  return page.locator('#notice');
}

/** `xml` with the element named `from` renamed to `to`. */
function withName(xml, from, to) {
  const out = xml.replace(`name="${from}"`, `name="${to}"`);
  if (out === xml) throw new Error(`no element named "${from}"`);
  return out;
}

/** y of Task_CancelOrder's shape in the file (260 in the fixture). */
function cancelOrderY(xml) {
  return Number(/id="Task_CancelOrder_di"[^>]*>\s*<dc:Bounds x="\d+" y="(\d+)"/.exec(xml)?.[1]);
}

/** Writes `xml` like an editor saving in place; returns the file's stat afterwards. */
async function writeInPlace(file, xml) {
  await writeFile(file, xml);
  return stat(file);
}

/** Saves like VS Code / vim with atomic saves: a temp file in the same directory renamed over the target. */
async function writeAtomically(file, xml) {
  const tmp = join(file, '..', '.order.bpmn.editor-save');
  await writeFile(tmp, xml);
  await rename(tmp, file);
  return stat(file);
}

/** The file keeps exactly `xml` and the given stat (no write-back by the host) for STABLE_MS. */
async function expectNoWriteBack(file, xml, info) {
  await delay(STABLE_MS);
  const now = await stat(file);
  expect(await readFile(file, 'utf8')).toBe(xml);
  expect(now.mtimeMs).toBe(info.mtimeMs);
  expect(now.ino).toBe(info.ino);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

test.describe('S3: external edits show up in the browser', () => {
  let fixture;
  let cli;
  let original;

  test.beforeEach(async () => {
    fixture = await setupRepo();
    original = await readFile(fixture.file, 'utf8');
    cli = await startCli(fixture.file, { cwd: fixture.dir });
  });

  test.afterEach(async () => {
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
  });

  test('an in-place save shows up without reload, keeping viewport and selection, with no write-back', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    // Select a task, then scroll and zoom like a user (wheel, Ctrl+wheel over the canvas).
    await shape(page, 'Task_ShipOrder').click();
    expect(await selectedIds(page)).toEqual(['Task_ShipOrder']);
    const canvasBox = await page.locator('#canvas').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    const initial = await viewbox(page);
    await page.mouse.wheel(0, 120);
    await page.mouse.wheel(60, 0);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await viewbox(page)).scale).not.toBeCloseTo(initial.scale, 2);
    const before = await viewbox(page);
    expect(before.y).not.toBeCloseTo(initial.y, 0);

    await page.evaluate(() => { window.__noReload = true; });
    const changed = withName(original, 'Check stock', 'Check stock levels');
    const info = await writeInPlace(fixture.file, changed);

    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: VISIBLE_MS });
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toHaveAttribute('data-kind', 'reloaded');
    await expect(notice(page)).toHaveText('Reloaded from disk');
    expect(await page.evaluate(() => window.__noReload)).toBe(true);
    expectViewboxUnchanged(await viewbox(page), before);
    expect(await selectedIds(page)).toEqual(['Task_ShipOrder']);
    await expect(status(page)).toHaveAttribute('data-state', 'saved');

    await expectNoWriteBack(fixture.file, changed, info);
    expect(cli.stderr()).toContain('bpmn-edit: reloaded order.bpmn (changed on disk)');
    // The "reloaded" notice goes away on its own.
    await expect(notice(page)).toBeHidden({ timeout: 3000 });
    expect(errors).toEqual([]);
  });

  test('atomic saves, git checkout and git stash show up in the browser', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);
    await page.evaluate(() => { window.__noReload = true; });

    // Atomic save (temp file + rename), as VS Code / vim do.
    const atomic = withName(withName(original, 'Check stock', 'Check inventory'), 'Ship order', 'Ship it');
    await writeAtomically(fixture.file, atomic);
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check inventory', { timeout: VISIBLE_MS });
    await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship it');

    // git checkout -- file: back to the committed version.
    git(fixture.dir, 'checkout', '--', 'order.bpmn');
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock', { timeout: VISIBLE_MS });
    await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship order');

    // An external change, then git stash reverts it.
    await writeInPlace(fixture.file, withName(original, 'Cancel order', 'Cancel and refund'));
    await expect(label(page, 'Task_CancelOrder')).toHaveText('Cancel and refund', { timeout: VISIBLE_MS });
    git(fixture.dir, 'stash', '-q');
    await expect(label(page, 'Task_CancelOrder')).toHaveText('Cancel order', { timeout: VISIBLE_MS });

    const info = await stat(fixture.file);
    await expectNoWriteBack(fixture.file, original, info);
    expect(git(fixture.dir, 'status', '--porcelain')).toBe('');
    expect(await page.evaluate(() => window.__noReload)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a UI edit after an external change keeps both changes on disk', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await writeInPlace(fixture.file, withName(original, 'Check stock', 'Check stock levels'));
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: VISIBLE_MS });

    await typeLabel(page, 'Task_ShipOrder', 'Ship parcel');
    await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship parcel');
    await expect.poll(() => readFile(fixture.file, 'utf8'), { timeout: 2000 }).toContain('name="Ship parcel"');
    const xml = await readFile(fixture.file, 'utf8');
    expect(xml).toContain('<bpmn:task id="Task_CheckStock" name="Check stock levels"');
    expect(xml).toContain('<bpmn:task id="Task_ShipOrder" name="Ship parcel"');
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect(errors).toEqual([]);
  });

  test('a half-written file keeps the last good diagram and is not overwritten', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    const truncated = original.slice(0, Math.floor(original.length * 0.6));
    expect(isCompleteBpmn(truncated)).toBe(false);
    const info = await writeInPlace(fixture.file, truncated);

    await expect(notice(page)).toHaveAttribute('data-kind', 'invalid', { timeout: VISIBLE_MS });
    await expect(notice(page)).toHaveText('File on disk is not valid BPMN; showing the last good version');
    for (const [id, text] of [['Task_CheckStock', 'Check stock'], ['Task_ShipOrder', 'Ship order'], ['Task_CancelOrder', 'Cancel order']]) {
      await expect(label(page, id)).toHaveText(text);
      await expect(shape(page, id)).toBeVisible();
    }
    await expectNoWriteBack(fixture.file, truncated, info);
    await expect(notice(page)).toHaveAttribute('data-kind', 'invalid'); // persistent

    // The editor finishes writing a valid file: it shows up and the notice clears.
    await writeInPlace(fixture.file, withName(original, 'Check stock', 'Check stock levels'));
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: VISIBLE_MS });
    await expect(notice(page)).not.toHaveAttribute('data-kind', 'invalid');
    expect(errors).toEqual([]);
  });

  test('a deleted file is reported, not recreated, and comes back on recreate or the next edit', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await unlink(fixture.file);
    await expect(notice(page)).toHaveAttribute('data-kind', 'missing', { timeout: VISIBLE_MS });
    await expect(notice(page)).toHaveText('File deleted on disk');
    await expect(notice(page)).toHaveAttribute('title', 'Your next edit will recreate it');
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock');
    await delay(STABLE_MS);
    expect(await exists(fixture.file)).toBe(false);
    expect(cli.child.exitCode).toBeNull();
    expect(cli.stderr()).toContain('bpmn-edit: order.bpmn was deleted on disk');

    // Recreated externally with a modified diagram.
    const recreated = withName(original, 'Ship order', 'Ship today');
    await writeInPlace(fixture.file, recreated);
    await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship today', { timeout: VISIBLE_MS });
    await expect(notice(page)).not.toHaveAttribute('data-kind', 'missing');

    // Deleted again, then edited in the browser: the edit recreates the file.
    await unlink(fixture.file);
    await expect(notice(page)).toHaveAttribute('data-kind', 'missing', { timeout: VISIBLE_MS });
    await typeLabel(page, 'Task_CancelOrder', 'Cancel and refund');
    await expect.poll(() => exists(fixture.file), { timeout: 2000 }).toBe(true);
    const xml = await readFile(fixture.file, 'utf8');
    expect(xml).toContain('<bpmn:task id="Task_CancelOrder" name="Cancel and refund"');
    expect(xml).toContain('<bpmn:task id="Task_ShipOrder" name="Ship today"');
    expect(isCompleteBpmn(xml)).toBe(true);
    await expect(notice(page)).toBeHidden();
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect(errors).toEqual([]);
  });

  test('a change on disk during a label edit is shown when the editor closes without changes', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await shape(page, 'Task_CancelOrder').dblclick();
    await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
    const external = withName(original, 'Check stock', 'Check stock levels');
    await writeInPlace(fixture.file, external);
    // Held back while the label editor is open, and the user is told so.
    await expect(notice(page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    await expect(notice(page)).toHaveText('Disk changed; reloads after your edit');
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock');
    await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: VISIBLE_MS });
    await expect(notice(page)).toHaveAttribute('data-kind', 'reloaded');
    const info = await stat(fixture.file);
    await expectNoWriteBack(fixture.file, external, info);

    // A later unrelated edit keeps the change made on disk.
    await typeLabel(page, 'Task_ShipOrder', 'Ship parcel');
    await expect.poll(() => readFile(fixture.file, 'utf8'), { timeout: 2000 }).toContain('name="Ship parcel"');
    expect(await readFile(fixture.file, 'utf8')).toContain('<bpmn:task id="Task_CheckStock" name="Check stock levels"');
    expect(errors).toEqual([]);
  });

  test('a label committed after a change on disk is applied on top of it (Q2: both kept), browser and disk agree', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await typeLabel(page, 'Task_CancelOrder', 'Cancel and refund', { commit: false });
    await writeInPlace(fixture.file, withName(original, 'Check stock', 'Check stock levels'));
    await expect(notice(page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    await clickEmptyCanvas(page); // commit the label

    await expect.poll(() => readFile(fixture.file, 'utf8'), { timeout: 2000 }).toContain('name="Cancel and refund"');
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    await expect(notice(page)).not.toHaveAttribute('data-kind', 'deferred');
    // The label was re-applied on top of the change on disk: both are kept, both sides show the same.
    const xml = await readFile(fixture.file, 'utf8');
    expect(xml).toContain('<bpmn:task id="Task_CheckStock" name="Check stock levels"');
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock levels');
    await expect(label(page, 'Task_CancelOrder')).toHaveText('Cancel and refund');
    await expect(page.locator('#toast')).toHaveAttribute('data-kind', 'merged');
    const info = await stat(fixture.file);
    await expectNoWriteBack(fixture.file, xml, info);
    await expect(label(page, 'Task_CancelOrder')).toHaveText('Cancel and refund');
    expect(cli.stderr()).not.toContain('replaced a change made on disk');
    expect(errors).toEqual([]);
  });

  test('broken files on disk: open tabs keep the last good diagram, new tabs recover once the file is fixed', async ({ page, browser }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);
    await page.evaluate(() => { window.__noReload = true; });

    // Broken in the middle (unclosed attribute) but still ending with the closing tag.
    const broken = original.replace('name="Ship order">', 'name="Ship <order> broken');
    await writeInPlace(fixture.file, broken);
    await expect(notice(page)).toHaveAttribute('data-kind', 'invalid', { timeout: VISIBLE_MS });
    await expect(label(page, 'Task_ShipOrder')).toHaveText('Ship order');
    // A tab opened now gets the last good diagram and the notice.
    const tabB = await browser.newPage();
    const errorsB = collectPageErrors(tabB);
    await openEditor(tabB, cli);
    await expect(notice(tabB)).toHaveAttribute('data-kind', 'invalid');
    await expect(label(tabB, 'Task_ShipOrder')).toHaveText('Ship order');

    // Well-formed BPMN that the editor cannot display (no diagram): reported by the browser.
    const noDiagram = original.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, '');
    const info = await writeInPlace(fixture.file, noDiagram);
    await expect(notice(page)).toHaveAttribute('title', /no diagram to display/, { timeout: VISIBLE_MS });
    await expect(notice(page)).toHaveAttribute('data-kind', 'invalid');
    await expect(page.locator('#error')).toBeHidden(); // one indicator: the notice
    for (const id of ['Task_CheckStock', 'Task_ShipOrder', 'Task_CancelOrder']) await expect(shape(page, id)).toBeVisible();

    // A tab opened now cannot render anything...
    const tabC = await browser.newPage();
    const errorsC = collectPageErrors(tabC);
    await tabC.goto(cli.url);
    await expect(tabC.locator('#error')).toContainText('Could not render order.bpmn');
    await expect(notice(tabC)).toHaveAttribute('data-kind', 'invalid');
    await expect(shape(tabC, 'Task_CheckStock')).toHaveCount(0);
    await tabC.evaluate(() => { window.__noReload = true; });
    await expectNoWriteBack(fixture.file, noDiagram, info);

    // ...until a valid file is saved: every tab shows it, without reload, and the errors are gone.
    await writeInPlace(fixture.file, withName(original, 'Check stock', 'Check stock levels'));
    for (const tab of [page, tabB, tabC]) {
      await expect(label(tab, 'Task_CheckStock')).toHaveText('Check stock levels', { timeout: VISIBLE_MS });
      await expect(tab.locator('#error')).toBeHidden();
      await expect(notice(tab)).not.toHaveAttribute('data-kind', 'invalid');
    }
    await expect(shape(tabC, 'Task_CancelOrder')).toBeVisible(); // fitted into view
    expect(await tabC.evaluate(() => window.__noReload)).toBe(true);
    expect(await page.evaluate(() => window.__noReload)).toBe(true);

    // The recovered tab edits normally.
    await typeLabel(tabC, 'Task_ShipOrder', 'Ship parcel');
    await expect.poll(() => readFile(fixture.file, 'utf8'), { timeout: 2000 }).toContain('name="Ship parcel"');
    expect(await readFile(fixture.file, 'utf8')).toContain('name="Check stock levels"');
    await tabB.close();
    await tabC.close();
    expect([...errors, ...errorsB, ...errorsC]).toEqual([]);
  });

  test('an undisplayable file is fixed by the next edit in the browser', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    const noDiagram = original.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, '');
    await writeInPlace(fixture.file, noDiagram);
    await expect(notice(page)).toHaveAttribute('data-kind', 'invalid', { timeout: VISIBLE_MS });
    await expect(page.locator('#error')).toBeHidden();
    await expect(shape(page, 'Task_CancelOrder')).toBeVisible();

    await dragBy(page, 'Task_CancelOrder', 60);
    await expect.poll(async () => isCompleteBpmn(await readFile(fixture.file, 'utf8')) && (await readFile(fixture.file, 'utf8')).includes('BPMNDiagram'), { timeout: 2000 }).toBe(true);
    expect(cancelOrderY(await readFile(fixture.file, 'utf8'))).toBeGreaterThanOrEqual(300);
    await expect(notice(page)).toBeHidden();
    await expect(page.locator('#error')).toBeHidden();
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect(errors).toEqual([]);
  });

  test('a change on disk during a drag does not drop the drag (Q2: both kept), browser and disk agree', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    const task = shape(page, 'Task_CancelOrder');
    const box = await task.boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + 30, { steps: 5 });
    await page.mouse.move(from.x, from.y + 60, { steps: 5 });
    expect(await page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()))).toBe(true);

    await writeInPlace(fixture.file, withName(original, 'Check stock', 'Check stock levels'));
    await expect(notice(page)).toHaveAttribute('data-kind', 'deferred', { timeout: VISIBLE_MS });
    await page.mouse.up();

    await expect.poll(async () => cancelOrderY(await readFile(fixture.file, 'utf8')), { timeout: 2000 }).toBeGreaterThanOrEqual(300);
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    await expect(notice(page)).not.toHaveAttribute('data-kind', 'deferred');
    const xml = await readFile(fixture.file, 'utf8');
    // The move was re-applied on top of the change on disk: both are kept.
    expect(xml).toContain('<bpmn:task id="Task_CheckStock" name="Check stock levels"');
    await expect(label(page, 'Task_CheckStock')).toHaveText('Check stock levels');
    const info = await stat(fixture.file);
    await expectNoWriteBack(fixture.file, xml, info);
    expect(cancelOrderY(await readFile(fixture.file, 'utf8'))).toBeGreaterThanOrEqual(300);
    expect(errors).toEqual([]);
  });
});
