// Shared helpers for driving the editor page and the test repo like a user would.
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { TEMP_FILE_RE } from '../../../src/file.js';
import { copyFixture } from './cli.js';

const GIT = ['-c', 'user.name=bpmn-edit tests', '-c', 'user.email=tests@bpmn-edit.invalid', '-c', 'commit.gpgsign=false'];

/** Runs git in `dir` with a fixed test identity; returns stdout. */
export function git(dir, ...args) {
  return execFileSync('git', [...GIT, ...args], { cwd: dir, encoding: 'utf8' });
}

/** Fixture copy in a fresh git repo with the file committed. */
export async function setupRepo() {
  const fixture = await copyFixture('order.bpmn');
  git(fixture.dir, 'init', '-q');
  git(fixture.dir, 'add', 'order.bpmn');
  git(fixture.dir, 'commit', '-q', '-m', 'initial');
  return fixture;
}

export function status(page) {
  return page.locator('#save-status');
}

export function shape(page, id) {
  return page.locator(`.djs-element.djs-shape[data-element-id="${id}"]`);
}

/** Opens the editor at the CLI's URL and waits until the diagram is shown and saved. */
export async function openEditor(page, cli) {
  await page.goto(cli.url);
  await expect(shape(page, 'Task_CheckStock')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-state', 'saved');
  await expect(status(page)).toHaveText('Saved');
}

/** The text of an element's label. */
export function label(page, id) {
  return shape(page, id).locator('text');
}

/** Drags a shape by (`dx`, `dy`) screen pixels like a user; `dy` alone drags it down. */
export async function dragBy(page, id, dy, dx = 0) {
  const from = await center(shape(page, id));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

/** The canvas viewbox (zoom/scroll) of the page. */
export function viewbox(page) {
  return page.evaluate(() => {
    const { x, y, width, height, scale } = window.bpmnModeler.get('canvas').viewbox();
    return { x, y, width, height, scale };
  });
}

export function selectedIds(page) {
  return page.evaluate(() => window.bpmnModeler.get('selection').get().map((e) => e.id));
}

export function expectViewboxUnchanged(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.scale - expected.scale), 'scale').toBeLessThanOrEqual(0.01);
}

/**
 * The centre of an element on screen. A remote update re-renders the diagram, so the element found
 * can be replaced right before it is measured (boundingBox() is then null): measured again.
 */
export async function center(locator) {
  let box = null;
  await expect.poll(async () => (box = await locator.boundingBox()), { timeout: 2000 }).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drags the Task tool from the palette onto the canvas (by default below "Cancel order") and waits
 * for the new task; returns its id. The label editor of the new task is open afterwards.
 */
export async function dragNewTask(page, to = null) {
  const tool = page.locator('.djs-palette .entry.bpmn-icon-task');
  const from = await center(tool);
  if (!to) {
    const cancel = await shape(page, 'Task_CancelOrder').boundingBox();
    to = { x: cancel.x + cancel.width / 2, y: cancel.y + cancel.height + 130 };
  }

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

/** Ids of tasks created in the editor (bpmn-js names them Activity_…). */
export function newTaskIds(page) {
  return page.locator('.djs-element.djs-shape[data-element-id^="Activity_"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-element-id')));
}

/** A canvas point away from every shape, the palette and the watermark. */
export async function emptyCanvasPoint(page) {
  const canvas = await page.locator('#canvas').boundingBox();
  return { x: canvas.x + canvas.width * 0.88, y: canvas.y + 80 };
}

export async function clickEmptyCanvas(page) {
  const p = await emptyCanvasPoint(page);
  await page.mouse.click(p.x, p.y);
}

/** Double-clicks an element, replaces its label by typing, optionally commits by clicking empty canvas. */
export async function typeLabel(page, id, text, { commit = true } = {}) {
  await shape(page, id).dblclick();
  await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  if (commit) await clickEmptyCanvas(page);
}

export async function expectNoTempFiles(dir) {
  const names = await readdir(dir);
  expect(names.filter((n) => TEMP_FILE_RE.test(n) || n.endsWith('.tmp'))).toEqual([]);
}
