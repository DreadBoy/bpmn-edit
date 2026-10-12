// S2: edits are saved to disk.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { looksLikeBpmn, TEMP_FILE_RE } from '../../src/file.js';
import { collectPageErrors, copyFixture, startCli } from './helpers/cli.js';

const GIT = ['-c', 'user.name=local-bpmn tests', '-c', 'user.email=tests@local-bpmn.invalid', '-c', 'commit.gpgsign=false'];

function git(dir, ...args) {
  return execFileSync('git', [...GIT, ...args], { cwd: dir, encoding: 'utf8' });
}

/** Fixture copy in a fresh git repo with the file committed. */
async function setupRepo() {
  const fixture = await copyFixture('order.bpmn');
  git(fixture.dir, 'init', '-q');
  git(fixture.dir, 'add', 'order.bpmn');
  git(fixture.dir, 'commit', '-q', '-m', 'initial');
  return fixture;
}

function status(page) {
  return page.locator('#save-status');
}

function shape(page, id) {
  return page.locator(`.djs-element.djs-shape[data-element-id="${id}"]`);
}

async function openEditor(page, cli) {
  await page.goto(cli.url);
  await expect(shape(page, 'Task_CheckStock')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-state', 'saved');
  await expect(status(page)).toHaveText('Saved');
}

async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A canvas point away from every shape, the palette and the watermark. */
async function emptyCanvasPoint(page) {
  const canvas = await page.locator('#canvas').boundingBox();
  return { x: canvas.x + canvas.width * 0.88, y: canvas.y + 80 };
}

async function clickEmptyCanvas(page) {
  const p = await emptyCanvasPoint(page);
  await page.mouse.click(p.x, p.y);
}

/** Drags the Task tool from the palette onto the canvas below "Cancel order"; returns the new task's id. */
async function dragNewTask(page) {
  const tool = page.locator('.djs-palette .entry.bpmn-icon-task');
  const from = await center(tool);
  const cancel = await shape(page, 'Task_CancelOrder').boundingBox();
  const to = { x: cancel.x + cancel.width / 2, y: cancel.y + cancel.height + 130 };

  const tasksBefore = await newTaskIds(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 40, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();

  await expect.poll(() => newTaskIds(page)).toHaveLength(tasksBefore.length + 1);
  const ids = await newTaskIds(page);
  return ids.find((id) => !tasksBefore.includes(id));
}

function newTaskIds(page) {
  return page.locator('.djs-element.djs-shape[data-element-id^="Activity_"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-element-id')));
}

/** Double-clicks an element, replaces its label by typing, optionally commits by clicking empty canvas. */
async function typeLabel(page, id, text, { commit = true } = {}) {
  await shape(page, id).dblclick();
  await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  if (commit) await clickEmptyCanvas(page);
}

async function expectNoTempFiles(dir) {
  const names = await readdir(dir);
  expect(names.filter((n) => TEMP_FILE_RE.test(n) || n.endsWith('.tmp'))).toEqual([]);
}

test.describe('S2: edits are saved to disk', () => {
  let fixture;
  let cli;

  test.afterEach(async () => {
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
  });

  test('a task added from the palette and renamed is on disk, in git diff, and survives a restart', async ({ page, browser }) => {
    fixture = await setupRepo();
    cli = await startCli(fixture.file, { cwd: fixture.dir });
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    const taskId = await dragNewTask(page);
    expect(taskId).toMatch(/^Activity_/);
    // Commit the (empty) label editor opened by the drop, then rename the task like a user would.
    await clickEmptyCanvas(page);
    await typeLabel(page, taskId, 'Approve refund');
    await expect(shape(page, taskId).locator('text')).toHaveText('Approve refund');

    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    const savedAt = Date.now();
    await expect.poll(() => readFile(fixture.file, 'utf8'), { timeout: 1000 }).toContain('name="Approve refund"');
    expect(Date.now() - savedAt).toBeLessThan(1000);

    const xml = await readFile(fixture.file, 'utf8');
    expect(xml).toContain(`<bpmn:task id="${taskId}" name="Approve refund"`);
    expect(xml).toMatch(new RegExp(`<bpmndi:BPMNShape id="[^"]+" bpmnElement="${taskId}"`));
    expect(looksLikeBpmn(xml)).toBe(true);
    for (const id of ['Task_CheckStock', 'Gateway_InStock', 'Flow_Yes']) expect(xml).toContain(`id="${id}"`);

    const diff = git(fixture.dir, 'diff', '--', 'order.bpmn');
    expect(diff).toMatch(new RegExp(`^\\+\\s*<bpmn:task id="${taskId}" name="Approve refund"`, 'm'));
    await expectNoTempFiles(fixture.dir);
    expect(errors).toEqual([]);

    // Restart the CLI and open the file in a fresh page: the task is there.
    const stopped = await cli.stop();
    expect(stopped.code).toBe(0);
    cli = await startCli(fixture.file, { cwd: fixture.dir });
    const page2 = await browser.newPage();
    const errors2 = collectPageErrors(page2);
    await openEditor(page2, cli);
    await expect(shape(page2, taskId)).toBeVisible();
    await expect(shape(page2, taskId).locator('text')).toHaveText('Approve refund');
    expect(errors2).toEqual([]);
    await page2.close();
  });

  test('Ctrl-C after the edit was acknowledged but before the disk write still persists it', async ({ page }) => {
    fixture = await setupRepo();
    const original = await readFile(fixture.file, 'utf8');
    // Long disk debounce so the write is certainly still pending when the signal arrives.
    cli = await startCli(fixture.file, { cwd: fixture.dir, args: ['--write-delay', '10000'] });
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await typeLabel(page, 'Task_CheckStock', 'Check stock levels');
    await expect(status(page)).toHaveAttribute('data-state', 'saving');
    await expect(status(page)).toHaveText('Saving…');
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect(await readFile(fixture.file, 'utf8')).toBe(original); // acknowledged, not yet on disk

    cli.child.kill('SIGINT');
    const { code, signal } = await cli.exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });

    const xml = await readFile(fixture.file, 'utf8');
    expect(xml).toContain('<bpmn:task id="Task_CheckStock" name="Check stock levels"');
    expect(looksLikeBpmn(xml)).toBe(true);
    expect(git(fixture.dir, 'diff', '--stat')).toContain('order.bpmn');
    await expect(status(page)).toHaveAttribute('data-state', 'disconnected');
    await expect(status(page)).toHaveText('Disconnected');
    expect(errors).toEqual([]);
  });

  test('Ctrl-C while the edit is still being sent ("Saving…") persists it', async ({ page }) => {
    fixture = await setupRepo();
    cli = await startCli(fixture.file, { cwd: fixture.dir });
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await typeLabel(page, 'Task_ShipOrder', 'Ship parcel');
    // Right after the label commit: the browser has not even sent the edit yet.
    expect(await status(page).getAttribute('data-state')).toBe('saving');
    cli.child.kill('SIGINT');
    const { code } = await cli.exited;
    expect(code).toBe(0);

    expect(await readFile(fixture.file, 'utf8')).toContain('<bpmn:task id="Task_ShipOrder" name="Ship parcel"');
    expect(errors).toEqual([]);
  });

  test('Ctrl-C with a label still being typed persists the typed text', async ({ page }) => {
    fixture = await setupRepo();
    cli = await startCli(fixture.file, { cwd: fixture.dir });
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    await typeLabel(page, 'Task_CancelOrder', 'Cancel and refund', { commit: false });
    cli.child.kill('SIGINT');
    const { code } = await cli.exited;
    expect(code).toBe(0);

    expect(await readFile(fixture.file, 'utf8')).toContain('<bpmn:task id="Task_CancelOrder" name="Cancel and refund"');
    expect(errors).toEqual([]);
  });

  test('rapid edits are coalesced into a single disk write', async ({ page }) => {
    fixture = await setupRepo();
    const original = await readFile(fixture.file, 'utf8');
    cli = await startCli(fixture.file, { cwd: fixture.dir });
    const errors = collectPageErrors(page);
    await openEditor(page, cli);

    // Every disk write goes through a uniquely named temp file; count them.
    const tempFiles = new Set();
    const watcher = watch(fixture.dir, (event, name) => {
      if (name && TEMP_FILE_RE.test(name)) tempFiles.add(name);
    });
    try {
      const task = shape(page, 'Task_CancelOrder');
      const yBefore = (await task.boundingBox()).y;
      // Five quick moves of "Cancel order", 20 px down each.
      for (let i = 0; i < 5; i++) {
        const c = await center(task);
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        await page.mouse.move(c.x, c.y + 10, { steps: 2 });
        await page.mouse.move(c.x, c.y + 20, { steps: 2 });
        await page.mouse.up();
      }
      await expect.poll(async () => (await task.boundingBox()).y).toBeGreaterThan(yBefore + 90);
      const commandCount = await page.evaluate(() => window.bpmnModeler.get('commandStack')._stack.length);
      expect(commandCount).toBeGreaterThanOrEqual(5);

      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      await expect.poll(() => readFile(fixture.file, 'utf8')).not.toBe(original);
      await page.waitForTimeout(800); // longer than both debounces: any further write would show up
    } finally {
      watcher.close();
    }

    expect(tempFiles.size).toBeGreaterThanOrEqual(1);
    expect(tempFiles.size).toBeLessThanOrEqual(2);
    const xml = await readFile(fixture.file, 'utf8');
    const y = Number(/id="Task_CancelOrder_di"[^>]*>\s*<dc:Bounds x="\d+" y="(\d+)"/.exec(xml)[1]);
    expect(y).toBeGreaterThanOrEqual(350);
    await expectNoTempFiles(fixture.dir);
    expect(errors).toEqual([]);
  });
});
