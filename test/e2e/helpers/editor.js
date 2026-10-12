// Shared helpers for driving the editor page and the test repo like a user would.
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { TEMP_FILE_RE } from '../../../src/file.js';
import { copyFixture } from './cli.js';

const GIT = ['-c', 'user.name=local-bpmn tests', '-c', 'user.email=tests@local-bpmn.invalid', '-c', 'commit.gpgsign=false'];

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

export async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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
