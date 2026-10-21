// V2-6: colours. The colour picker (bpmn-js-color-picker, vendored in web/vendor/bpmn-js-color-picker) is
// used like a user would: select elements, context pad "Set color", a colour or "Default" in the popup.
// Real CLI (BPMN_EDIT_DEBUG_WRITES=1, every write must be `minimal` and lose nothing), real browser, the
// file in a real git repo; what is on disk and `git diff` are checked after every edit.
import { expect, test } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPageErrors, FIXTURES, startCli } from './helpers/cli.js';
import { git } from './helpers/editor.js';
import { rgb } from './helpers/presence.js';
import { load } from '../../src/minimal-diff.js';

const COLOURS = join(FIXTURES, 'colours');
const BIOC = 'http://bpmn.io/schema/bpmn/biocolor/1.0';
const COLOR = 'http://www.omg.org/spec/BPMN/non-normative/color/1.0';
// The picker's palette (bpmn-js writes the values in lower case).
const BLUE = { id: 'blue-color', fill: '#bbdefb', stroke: '#0d4372' };
const ORANGE = { id: 'orange-color', fill: '#ffe0b2', stroke: '#6b3c00' };
const GREEN = { id: 'green-color', fill: '#c8e6c9', stroke: '#205022' };
const RED = { id: 'red-color', fill: '#ffcdd2', stroke: '#831311' };
const DEFAULT = { id: 'default-color' };
// bpmn-js' default colours (no colour set).
const WHITE = 'rgb(255, 255, 255)';
const BLACKISH = 'rgb(34, 36, 42)';

/** The fixture committed to a fresh git repo. */
async function setupRepo(name) {
  const dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-v2-6-'));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const file = join(repo, name);
  await copyFile(join(COLOURS, name), file);
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', 'original');
  return { dir, repo, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The writes the CLI reported (BPMN_EDIT_DEBUG_WRITES=1) as "mode lost=n (reason)". */
function writes(cli) {
  return [...cli.stderr().matchAll(/^bpmn-edit: debug: write (.*)$/gm)].map(([, line]) => {
    const mode = /(?:^| )mode=(\S+)/.exec(line)?.[1];
    const lost = /(?:^| )lost=(\d+)/.exec(line)?.[1] ?? 0;
    const reason = /(?:^| )reason=(.*)$/.exec(line)?.[1];
    return `${mode} lost=${lost}${reason ? ` (${reason})` : ''}`;
  });
}

function expectMinimalWrites(cli) {
  const all = writes(cli);
  expect(all).toEqual(all.map(() => 'minimal lost=0'));
}

/** `git diff --numstat` of the repo's working tree (added + deleted lines). */
function gitDiffLines(repo) {
  const out = git(repo, 'diff', '--numstat').trim();
  if (!out) return 0;
  return out.split('\n').reduce((sum, line) => sum + line.split('\t').slice(0, 2).map(Number).reduce((x, y) => x + y, 0), 0);
}

/**
 * External label bounds (the `dc:Bounds` of a `BPMNLabel`) that differ between two texts of the same
 * length in lines. bpmn-js re-measures the label of an element whose colour changes, with the
 * browser's font metrics; the fixtures have Chrome's measurements, so in Chrome there are none.
 */
function relabelled(before, after) {
  const [a, b] = [before.split('\n'), after.split('\n')];
  if (a.length !== b.length) return 0;
  return a.filter((line, k) => line !== b[k] && /<dc:Bounds /.test(line) && /<bpmndi:BPMNLabel/.test(a[k - 1])).length;
}

/** `git diff` has `lines` changed lines, plus labels bpmn-js re-measured (none in Chrome). */
function expectDiff(repo, original, now, lines) {
  const labels = relabelled(original, now);
  if (test.info().project.name === 'chrome') expect(labels, 'labels re-measured').toBe(0);
  expect(gitDiffLines(repo)).toBe(lines + 2 * labels);
}

/** `now` is `expected`, apart from labels bpmn-js re-measured (none in Chrome). */
function expectSameFile(now, expected) {
  const strip = (xml) => xml.replace(/(<bpmndi:BPMNLabel[^>]*>\s*)<dc:Bounds [^>]*\/>/g, '$1<dc:Bounds/>');
  if (test.info().project.name === 'chrome') expect(now).toBe(expected);
  else expect(strip(now)).toBe(strip(expected));
}

/**
 * Waits until the edit just made is on disk: a write after `before` writes, the page saved, and no
 * further write for a moment. Resolves to the file's text.
 */
async function saved(page, cli, file, before) {
  await expect.poll(() => writes(cli).length, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  let count = writes(cli).length;
  await expect.poll(async () => {
    const now = writes(cli).length;
    const stable = now === count;
    count = now;
    return stable;
  }, { intervals: [400, 400, 400], timeout: 10_000 }).toBe(true);
  return readFile(file, 'utf8');
}

const elementOf = (page, id) => page.locator(`.djs-element[data-element-id="${id}"]`);

/** Where to click to select element `id` (shapes: the middle, or inside the top-left corner for containers). */
async function clickPoint(page, id) {
  const kind = await page.evaluate((elId) => window.bpmnModeler.get('elementRegistry').get(elId).type, id);
  const box = await elementOf(page, id).boundingBox();
  if (kind === 'bpmn:Participant') return { x: box.x + 15, y: box.y + box.height / 2 };
  if (kind === 'bpmn:Lane') return { x: box.x + box.width - 30, y: box.y + box.height - 15 };
  if (kind === 'bpmn:SubProcess') return { x: box.x + 15, y: box.y + box.height - 15 };
  if (kind === 'bpmn:SequenceFlow') {
    // On its longest segment.
    const points = await page.evaluate((elId) => {
      const m = window.bpmnModeler;
      const { waypoints } = m.get('elementRegistry').get(elId);
      const ctm = m.get('canvas')._svg.querySelector('.viewport').getScreenCTM();
      return waypoints.map((p) => ({ x: p.x * ctm.a + ctm.e, y: p.y * ctm.d + ctm.f }));
    }, id);
    let best = null;
    for (let k = 1; k < points.length; k++) {
      const [a, b] = [points[k - 1], points[k]];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      // A third along it (its middle may be under its label).
      if (!best || length > best.length) best = { length, x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
    }
    return best;
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Clicks the canvas away from every shape (right of the diagram). */
async function clickEmptyCanvas(page) {
  const canvas = await page.locator('#canvas').boundingBox();
  await page.mouse.click(canvas.x + canvas.width - 60, canvas.y + 60);
}

/** Selects the elements like a user: click the first, Shift+click the others. */
async function select(page, ids) {
  await clickEmptyCanvas(page);
  for (const [k, id] of ids.entries()) {
    const p = await clickPoint(page, id);
    if (k > 0) await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    if (k > 0) await page.keyboard.up('Shift');
  }
  await expect.poll(() => page.evaluate(() => window.bpmnModeler.get('selection').get().map((e) => e.id).sort()))
    .toEqual([...ids].sort());
}

/** Context pad "Set color", then `colour` in the popup. */
async function setColour(page, ids, colour) {
  await select(page, ids);
  const pad = page.locator('.djs-context-pad.open');
  await expect(pad).toBeVisible();
  await pad.locator('.entry[data-action="set-color"]').click();
  const popup = page.locator('.djs-popup.color-picker');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.entry')).toHaveCount(6);
  await popup.locator(`.entry[data-id="${colour.id}"]`).click();
  await expect(popup).toBeHidden();
  await deselect(page);
}

async function deselect(page) {
  await clickEmptyCanvas(page);
  await expect.poll(() => page.evaluate(() => window.bpmnModeler.get('selection').get().length)).toBe(0);
}

/** Computed fill and stroke of an element's main graphic (shape body or connection line) in a window. */
function shown(page, id) {
  return elementOf(page, id).locator('.djs-visual > :is(rect, circle, polygon, path)').first()
    .evaluate((el) => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).stroke }));
}

/** Computed fill of an external label's text in a window. */
function labelShown(page, id) {
  return elementOf(page, `${id}_label`).locator('.djs-visual > text').first().evaluate((el) => getComputedStyle(el).fill);
}

async function expectShown(page, id, colour) {
  if (colour.fill === undefined) {
    await expect.poll(() => shown(page, id)).toEqual(expect.objectContaining({ stroke: BLACKISH }));
    return;
  }
  const isFlow = id.startsWith('Flow_');
  await expect.poll(() => shown(page, id)).toEqual(isFlow ? expect.objectContaining({ stroke: rgb(colour.stroke) }) : { fill: rgb(colour.fill), stroke: rgb(colour.stroke) });
}

/** The colour attributes of the DI of `id` in `xml`, as { 'bioc:fill': …, … } by namespace URI. */
function diColours(xml, id) {
  const doc = load(xml);
  const di = [...doc.ids.values()].find((e) => e.attrs.some((a) => a.local === 'bpmnElement' && a.value === id));
  const result = {};
  for (const a of di.attrs) {
    if (a.uri === BIOC) result[`bioc:${a.local}`] = a.value;
    if (a.uri === COLOR) result[`color:${a.local}`] = a.value;
  }
  return result;
}

const shapeAttrs = (c) => ({ 'bioc:stroke': c.stroke, 'bioc:fill': c.fill, 'color:background-color': c.fill, 'color:border-color': c.stroke });
const edgeAttrs = (c) => ({ 'bioc:stroke': c.stroke, 'color:border-color': c.stroke });

/** How many times the root declares namespace `uri` (any prefix), and how many declarations exist in all. */
function declarations(xml, uri) {
  return (xml.match(new RegExp(`xmlns(:[\\w.-]+)?="${uri.replace(/[./]/g, '\\$&')}"`, 'g')) ?? []).length;
}

async function openWindow(browser, cli) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await page.goto(cli.url);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  await expect(elementOf(page, 'Task_Review')).toBeVisible();
  return { context, page, errors };
}

test.describe('V2-6: colours', () => {
  let fixture;
  let cli;
  let windows;

  async function start(name, browser, count = 1) {
    fixture = await setupRepo(name);
    cli = await startCli(fixture.file, { cwd: fixture.repo, env: { BPMN_EDIT_DEBUG_WRITES: '1' } });
    windows = [];
    for (let k = 0; k < count; k++) windows.push(await openWindow(browser, cli));
    return windows.map((w) => w.page);
  }

  test.afterEach(async () => {
    for (const w of windows ?? []) {
      expect(w.errors).toEqual([]);
      await w.context.close();
    }
    windows = null;
    await cli?.stop();
    cli = null;
    await fixture?.cleanup();
    fixture = null;
  });

  test('a task, a gateway and a flow: on disk in place, namespaces declared once, live in a second window, after reopening', async ({ browser }) => {
    const [page, other] = await start('plain.bpmn', browser, 2);
    const original = await readFile(fixture.file, 'utf8');

    await setColour(page, ['Task_Review'], BLUE);
    let now = await saved(page, cli, fixture.file, 0);
    expect(diColours(now, 'Task_Review')).toEqual(shapeAttrs(BLUE));
    expect(gitDiffLines(fixture.repo)).toBe(4); // the root's start tag (declarations) and the shape's

    await setColour(page, ['Gateway_Ok'], ORANGE);
    now = await saved(page, cli, fixture.file, writes(cli).length);
    await setColour(page, ['Flow_Yes'], GREEN);
    now = await saved(page, cli, fixture.file, writes(cli).length);

    expect(diColours(now, 'Task_Review')).toEqual(shapeAttrs(BLUE));
    expect(diColours(now, 'Gateway_Ok')).toEqual(shapeAttrs(ORANGE));
    expect(diColours(now, 'Flow_Yes')).toEqual(edgeAttrs(GREEN));
    expect(declarations(now, BIOC)).toBe(1);
    expect(declarations(now, COLOR)).toBe(1);
    expect(now).toContain(`xmlns:bioc="${BIOC}"`);
    expect(now).toContain(`xmlns:color="${COLOR}"`);
    // The root line and three DI lines changed, nothing else.
    expectDiff(fixture.repo, original, now, 8);
    const lines = (xml) => xml.split('\n');
    const changed = lines(now).filter((line, k) => line !== lines(original)[k] && !/<dc:Bounds /.test(line));
    expect(changed.map((line) => /<bpmn:definitions|id="(Task_Review|Gateway_Ok|Flow_Yes)_di"/.test(line))).toEqual([true, true, true, true]);
    expectMinimalWrites(cli);

    // Both windows show the colours.
    for (const p of [page, other]) {
      await expectShown(p, 'Task_Review', BLUE);
      await expectShown(p, 'Gateway_Ok', ORANGE);
      await expectShown(p, 'Flow_Yes', GREEN);
      await expectShown(p, 'Task_Fix', {}); // untouched
    }

    // Reopen: a new bpmn-edit and a new window show the colours; opening writes nothing.
    for (const w of windows) await w.context.close();
    windows = [];
    await cli.stop();
    cli = await startCli(fixture.file, { cwd: fixture.repo, env: { BPMN_EDIT_DEBUG_WRITES: '1' } });
    windows.push(await openWindow(browser, cli));
    const again = windows[0].page;
    await expectShown(again, 'Task_Review', BLUE);
    await expectShown(again, 'Gateway_Ok', ORANGE);
    await expectShown(again, 'Flow_Yes', GREEN);
    await again.waitForTimeout(1000);
    expect(writes(cli)).toEqual([]);
    expect(await readFile(fixture.file, 'utf8')).toBe(now);
  });

  test('multi-selection of every kind of element, "Default", undo and redo', async ({ browser }) => {
    const [page] = await start('plain.bpmn', browser);
    const original = await readFile(fixture.file, 'utf8');
    const shapes = ['Participant_Team', 'Lane_Editor', 'StartEvent_Draft', 'Task_Review', 'Gateway_Ok', 'SubProcess_Fix', 'DataObjectReference_Notes', 'EndEvent_Done'];
    const flows = ['Flow_No', 'Flow_ToReview'];

    await setColour(page, [...shapes, ...flows], RED);
    const coloured = await saved(page, cli, fixture.file, 0);
    for (const id of shapes) expect(diColours(coloured, id), id).toEqual(shapeAttrs(RED));
    for (const id of flows) expect(diColours(coloured, id), id).toEqual(edgeAttrs(RED));
    expect(diColours(coloured, 'Task_Fix')).toEqual({});
    expect(declarations(coloured, BIOC)).toBe(1);
    expect(declarations(coloured, COLOR)).toBe(1);
    expectDiff(fixture.repo, original, coloured, 2 * (1 + shapes.length + flows.length));
    for (const id of [...shapes, ...flows]) await expectShown(page, id, RED);

    // Undo: back to the file as it was (the declarations go with the last colour).
    let count = writes(cli).length;
    await page.keyboard.press('ControlOrMeta+z');
    let now = await saved(page, cli, fixture.file, count);
    expect(now).toBe(original);
    expect(gitDiffLines(fixture.repo)).toBe(0);
    await expectShown(page, 'Task_Review', {});

    // Redo: the colours again, byte for byte as before.
    count = writes(cli).length;
    await page.keyboard.press('ControlOrMeta+Shift+z');
    now = await saved(page, cli, fixture.file, count);
    expect(now).toBe(coloured);
    await expectShown(page, 'Task_Review', RED);

    // "Default" on part of them: their attributes go, the others' and the declarations stay.
    count = writes(cli).length;
    await setColour(page, ['Task_Review', 'Flow_No', 'Lane_Editor'], DEFAULT);
    now = await saved(page, cli, fixture.file, count);
    for (const id of ['Task_Review', 'Flow_No', 'Lane_Editor']) expect(diColours(now, id), id).toEqual({});
    expect(diColours(now, 'Gateway_Ok')).toEqual(shapeAttrs(RED));
    expect(declarations(now, BIOC)).toBe(1);
    await expectShown(page, 'Task_Review', {});
    await expectShown(page, 'Flow_No', {});

    // "Default" on the rest: the file is as it was, `git diff` is empty.
    count = writes(cli).length;
    await setColour(page, shapes.filter((id) => !['Task_Review', 'Lane_Editor'].includes(id)).concat('Flow_ToReview'), DEFAULT);
    now = await saved(page, cli, fixture.file, count);
    expectSameFile(now, original);
    expectDiff(fixture.repo, original, now, 0);

    // Undo of "Default" brings that colour back; redo removes it again.
    count = writes(cli).length;
    await page.keyboard.press('ControlOrMeta+z');
    now = await saved(page, cli, fixture.file, count);
    expect(diColours(now, 'Gateway_Ok')).toEqual(shapeAttrs(RED));
    expect(diColours(now, 'Task_Review')).toEqual({});
    await expectShown(page, 'Gateway_Ok', RED);
    count = writes(cli).length;
    await page.keyboard.press('ControlOrMeta+Shift+z');
    now = await saved(page, cli, fixture.file, count);
    expectSameFile(now, original);
    expectMinimalWrites(cli);
  });

  test('a collaborator (share link) colours too; host and collaborator see each other\'s colours', async ({ browser }) => {
    // The stand-in tunnel of s7-share.spec.js: a collaborator is a page whose requests carry Cloudflare's headers.
    fixture = await setupRepo('plain.bpmn');
    cli = await startCli(fixture.file, { cwd: fixture.repo, env: { BPMN_EDIT_DEBUG_WRITES: '1', BPMN_EDIT_TEST_TUNNEL: 'fake', BPMN_EDIT_TEST_TUNNEL_DELAY_MS: '0' } });
    windows = [await openWindow(browser, cli)];
    const host = windows[0].page;
    await host.locator('#share-start').click();
    await expect(host.locator('#share-url')).toBeVisible({ timeout: 10_000 });
    const token = /\/s\/([A-Za-z0-9_-]+)$/.exec(await host.locator('#share-url').inputValue())[1];
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, extraHTTPHeaders: { 'cf-ray': '8d0e3c7b5a1f2e4d-LJU', 'cf-connecting-ip': '203.0.113.9' } });
    const collab = await context.newPage();
    windows.push({ context, page: collab, errors: collectPageErrors(collab) });
    await collab.goto(`${cli.baseUrl}s/${token}`);
    await expect(collab.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await expect(elementOf(collab, 'Task_Review')).toBeVisible();
    await expect(collab.locator('#share')).toBeHidden();

    await setColour(collab, ['Task_Review', 'Flow_Yes'], BLUE);
    let now = await saved(collab, cli, fixture.file, 0);
    expect(diColours(now, 'Task_Review')).toEqual(shapeAttrs(BLUE));
    expect(diColours(now, 'Flow_Yes')).toEqual(edgeAttrs(BLUE));
    await expectShown(host, 'Task_Review', BLUE);
    await expectShown(host, 'Flow_Yes', BLUE);

    await setColour(host, ['Task_Review'], DEFAULT);
    now = await saved(host, cli, fixture.file, writes(cli).length);
    expect(diColours(now, 'Task_Review')).toEqual({});
    await expectShown(collab, 'Task_Review', {});
    await expectShown(collab, 'Flow_Yes', BLUE);
    expectMinimalWrites(cli);
  });

  test('a colour changed on disk (IDE edit) shows in the open window', async ({ browser }) => {
    const [page] = await start('camunda-coloured.bpmn', browser);
    await expectShown(page, 'Task_Review', BLUE);
    const original = await readFile(fixture.file, 'utf8');
    const edited = original
      .replace('bioc:stroke="#0d4372" bioc:fill="#bbdefb" color:background-color="#bbdefb" color:border-color="#0d4372"',
        'bioc:stroke="#205022" bioc:fill="#c8e6c9" color:background-color="#c8e6c9" color:border-color="#205022"');
    expect(edited).not.toBe(original);
    await writeFile(fixture.file, edited);
    await expectShown(page, 'Task_Review', GREEN);
    // Then an edit in the window keeps the IDE's colour.
    await setColour(page, ['Task_Fix'], ORANGE);
    const now = await saved(page, cli, fixture.file, 0);
    expect(diColours(now, 'Task_Review')).toEqual(shapeAttrs(GREEN));
    expect(diColours(now, 'Task_Fix')).toEqual(shapeAttrs(ORANGE));
    expectMinimalWrites(cli);
  });

  for (const [name, prefixes] of [
    ['camunda-coloured.bpmn', ['bioc', 'color']],
    ['bioc-only.bpmn', ['bioc', 'color']],
    ['color-only.bpmn', ['bioc', 'color']],
    ['other-prefixes.bpmn', ['bc', 'omgc']],
  ]) {
    test(`${name}: opens with its colours, survives an unrelated edit byte for byte, new colours use its prefixes`, async ({ browser }) => {
      const [page] = await start(name, browser);
      const original = await readFile(fixture.file, 'utf8');
      await expectShown(page, 'Task_Review', BLUE);
      await expectShown(page, 'Gateway_Ok', ORANGE);
      await expectShown(page, 'Lane_Editor', { fill: '#e1bee7', stroke: '#5b176d' });
      await expectShown(page, 'DataObjectReference_Notes', RED);
      await expectShown(page, 'Flow_Yes', GREEN);
      expect(await labelShown(page, 'Gateway_Ok')).toBe(rgb(ORANGE.stroke));

      // Unrelated edit (a rename through the label editor): only that line changes.
      await elementOf(page, 'Task_Fix').dblclick();
      await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('Fix it now');
      await page.keyboard.press('Enter');
      let now = await saved(page, cli, fixture.file, 0);
      expect(now).toBe(original.replace('name="Fix it" />', 'name="Fix it now" />'));

      // A new colour: written with the file's prefixes; a missing namespace declared once.
      const count = writes(cli).length;
      await setColour(page, ['Task_Fix'], GREEN);
      now = await saved(page, cli, fixture.file, count);
      const [bioc, color] = prefixes;
      expect(now).toContain(`bpmnElement="Task_Fix" ${bioc}:stroke="${GREEN.stroke}" ${bioc}:fill="${GREEN.fill}" ${color}:background-color="${GREEN.fill}" ${color}:border-color="${GREEN.stroke}">`);
      expect(declarations(now, BIOC)).toBe(1);
      expect(declarations(now, COLOR)).toBe(1);
      expect(now).toContain(`xmlns:${bioc}="${BIOC}"`);
      expect(now).toContain(`xmlns:${color}="${COLOR}"`);
      expect(gitDiffLines(fixture.repo)).toBe(name === 'bioc-only.bpmn' || name === 'color-only.bpmn' ? 6 : 4);
      await expectShown(page, 'Task_Fix', GREEN);
      expectMinimalWrites(cli);
    });
  }
});
