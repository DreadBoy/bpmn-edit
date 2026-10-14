// Q4 experiment, step 1 of 2: capture what the real editor writes to disk after small UI edits.
//
// For every fixture in test/fixtures/q4/ (or the names given as arguments):
//   1. copy it into a fresh git repo under $Q4_WORK (default: $TMPDIR/bpmn-edit-q4) and commit it;
//   2. start the real CLI on it (node bin/bpmn-edit.js <file> --no-open) and open the URL in real
//      Chrome (Playwright, channel 'chrome', headless);
//   3. save 1: double-click task A, select all, type a new name, press Enter; wait until the file
//      on disk changed and is stable; record git diff (plain, --stat, -w, --word-diff); commit;
//   4. save 2: the same for task B (diff vs save 1); commit;
//   5. save 3: drag task A 40 px to the right (a layout edit, used to judge the diff-preserving
//      writer options); diff vs save 2.
// Everything lands in docs/q4-evidence/<fixture>/; numbers are computed by q4-churn-analyse.mjs.
//
//   node scripts/q4-churn-measure.mjs [fixture.bpmn ...]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCli } from '../test/e2e/helpers/cli.js';

const ROOT = new URL('..', import.meta.url).pathname;
const FIXTURES = join(ROOT, 'test', 'fixtures', 'q4');
const EVIDENCE = join(ROOT, 'docs', 'q4-evidence');
const WORK = process.env.Q4_WORK || join(tmpdir(), 'bpmn-edit-q4');

// Task A (renamed in save 1 and moved in save 3) and task B (renamed in save 2) per fixture.
// Fixtures not listed use the first two named tasks found in the diagram.
const TARGETS = {
  'camunda7-modeler.bpmn': ['Activity_09yexpb', 'Activity_1navjv9'],
  'camunda7-loan-approval.bpmn': ['UserTask_1', 'UserTask_1'], // the only task
  'camunda8-modeler.bpmn': ['Activity_1kpg3ok', 'Activity_0kzg0nb'],
  'bpmnio-demo-export.bpmn': ['task_id', 'user_task_id'],
  'signavio-export.bpmn': ['sid-35027A00-C747-43EC-A8BB-9F8BA65FC08C', 'sid-28CA9418-A686-4DD4-9576-2611515C414F'],
  'bizagi-export.bpmn': ['_5a972b87-735d-454a-b31c-f52fb3afc5c7', '_4f7d62d7-f0e6-46bc-be00-69e02da38f65'],
};
const DEFAULT_TARGETS = ['Task_CheckStock', 'Task_ShipOrder'];
const NAME_1 = 'Q4 first rename';
const NAME_2 = 'Q4 zweite Änderung';

const GIT = ['-c', 'user.name=q4 experiment', '-c', 'user.email=q4@bpmn-edit.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
const git = (dir, ...args) => execFileSync('git', [...GIT, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFileChange(file, previous, mustContain, log) {
  const started = Date.now();
  for (;;) {
    const now = readFileSync(file, 'utf8');
    if (now !== previous && (!mustContain || now.includes(mustContain))) break;
    if (Date.now() - started > 15_000) throw new Error(`file did not change within 15 s (looking for ${mustContain})`);
    await sleep(50);
  }
  // Stable for 1 s (the CLI debounces writes by 250 ms).
  let last = readFileSync(file, 'utf8');
  for (let stableSince = Date.now(); Date.now() - stableSince < 1000;) {
    await sleep(100);
    const now = readFileSync(file, 'utf8');
    if (now !== last) { last = now; stableSince = Date.now(); }
  }
  log(`file changed after ${Date.now() - started} ms (incl. 1 s stability wait)`);
  return last;
}

function escapeForXmlAttr(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

async function pickTargets(page, name) {
  if (TARGETS[name]) return TARGETS[name];
  const ids = await page.evaluate(() => window.bpmnModeler.get('elementRegistry')
    .filter((e) => /Task$/.test(e.type) && e.businessObject.name && !e.labelTarget).map((e) => e.id));
  const fixed = DEFAULT_TARGETS.filter((id) => ids.includes(id));
  return fixed.length === 2 ? fixed : [ids[0], ids[1] ?? ids[0]];
}

const shapeLocator = (page, id) => page.locator(`.djs-element.djs-shape[data-element-id="${id}"]`);

async function rename(page, id, text) {
  await page.evaluate((elId) => {
    const m = window.bpmnModeler;
    m.get('canvas').scrollToElement(m.get('elementRegistry').get(elId));
  }, id);
  const shape = shapeLocator(page, id);
  await shape.dblclick();
  await page.locator('.djs-direct-editing-parent').waitFor({ state: 'visible' });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter'); // completes the label edit (Shift+Enter would insert a newline)
  await page.locator('.djs-direct-editing-parent').waitFor({ state: 'hidden' });
}

async function moveBy(page, id, dx) {
  const box = await shapeLocator(page, id).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y, { steps: 5 });
  await page.mouse.up();
}

function recordDiff(repo, out, prefix) {
  const files = {
    [`${prefix}.diff`]: ['diff'],
    [`${prefix}.stat`]: ['diff', '--stat'],
    [`${prefix}.numstat`]: ['diff', '--numstat'],
    [`${prefix}.w.diff`]: ['diff', '-w'],
    [`${prefix}.w.numstat`]: ['diff', '-w', '--numstat'],
    [`${prefix}.word.diff`]: ['diff', '--word-diff=plain'],
  };
  for (const [file, args] of Object.entries(files)) writeFileSync(join(out, file), git(repo, ...args));
}

async function runFixture(browser, name) {
  const out = join(EVIDENCE, name.replace(/\.bpmn$/, ''));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const logLines = [];
  const log = (line) => {
    const entry = `[${new Date().toISOString()}] ${line}`;
    logLines.push(entry);
    console.log(`${name}: ${line}`);
  };
  const result = { fixture: name, ok: false };

  const repo = join(WORK, name.replace(/\.bpmn$/, ''));
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const file = join(repo, name);
  copyFileSync(join(FIXTURES, name), file);
  git(repo, 'init', '-q');
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', 'original');
  const original = readFileSync(file, 'utf8');
  writeFileSync(join(out, '0-original.bpmn'), original);

  let cli;
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`pageerror: ${err.message}`));
  try {
    cli = await startCli(file, { cwd: repo });
    log(`CLI ready at ${cli.url}`);
    await page.goto(cli.url);
    await page.locator('.djs-element.djs-shape').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#save-status[data-state="saved"]').waitFor({ timeout: 15_000 });
    await sleep(500);
    if (readFileSync(file, 'utf8') !== original) throw new Error('opening the file changed it on disk');
    log('opened; file unchanged on disk after opening');
    // What bpmn-js would write for the unedited diagram (read-only; used by the diff-preserving
    // writer prototypes as the 3-way-merge base).
    const baseline = await page.evaluate(async () => (await window.bpmnModeler.saveXML({ format: true })).xml);
    writeFileSync(join(out, '0b-bpmnjs-baseline.bpmn'), baseline);

    const [taskA, taskB] = await pickTargets(page, name);
    const oldNames = await page.evaluate((ids) => ids.map((id) => window.bpmnModeler.get('elementRegistry').get(id)?.businessObject.name ?? null), [taskA, taskB]);
    Object.assign(result, { taskA, taskB, oldNameA: oldNames[0], oldNameB: oldNames[1], name1: NAME_1, name2: NAME_2 });
    log(`task A = ${taskA} (${JSON.stringify(oldNames[0])}), task B = ${taskB} (${JSON.stringify(oldNames[1])})`);

    // Save 1: rename task A.
    await rename(page, taskA, NAME_1);
    const save1 = await waitForFileChange(file, original, `"${escapeForXmlAttr(NAME_1)}"`, log);
    writeFileSync(join(out, '1-save1.bpmn'), save1);
    recordDiff(repo, out, 'first');
    git(repo, 'commit', '-q', '-am', 'save 1: rename task A');
    log('save 1 recorded');

    // Save 2: rename task B.
    await rename(page, taskB, NAME_2);
    const save2 = await waitForFileChange(file, save1, `"${escapeForXmlAttr(NAME_2)}"`, log);
    writeFileSync(join(out, '2-save2.bpmn'), save2);
    recordDiff(repo, out, 'second');
    git(repo, 'commit', '-q', '-am', 'save 2: rename task B');
    log('save 2 recorded');

    // Save 3: move task A by 40 px.
    await moveBy(page, taskA, 40);
    const save3 = await waitForFileChange(file, save2, null, log);
    writeFileSync(join(out, '3-save3-move.bpmn'), save3);
    recordDiff(repo, out, 'third');
    git(repo, 'commit', '-q', '-am', 'save 3: move task A');
    log('save 3 recorded');
    result.ok = true;
  } catch (err) {
    result.error = err.message;
    log(`ERROR: ${err.message}`);
    await page.screenshot({ path: join(out, 'error.png') }).catch(() => {});
  } finally {
    await context.close();
    if (cli) {
      const stopped = await cli.stop();
      log(`CLI stopped (code ${stopped.code}, signal ${stopped.signal})`);
      writeFileSync(join(out, 'cli.stderr.log'), cli.stderr());
    }
    if (existsSync(join(repo, '.git'))) writeFileSync(join(out, 'git-log.txt'), git(repo, 'log', '--stat', '--format=%h %s'));
    writeFileSync(join(out, 'browser-console.log'), consoleLines.join('\n') + (consoleLines.length ? '\n' : ''));
    writeFileSync(join(out, 'run.log'), logLines.join('\n') + '\n');
    writeFileSync(join(out, 'run.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

const names = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(FIXTURES).filter((f) => f.endsWith('.bpmn')).sort();
mkdirSync(WORK, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const env = {
  date: new Date().toISOString(),
  node: process.version,
  chrome: browser.version(),
  playwright: JSON.parse(readFileSync(join(ROOT, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version,
  bpmnJs: readFileSync(join(ROOT, 'web', 'vendor', 'bpmn-js', 'VERSION'), 'utf8').trim(),
  git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
  platform: `${process.platform} ${process.arch}`,
};
const results = [];
try {
  for (const name of names) results.push(await runFixture(browser, name));
} finally {
  await browser.close();
}
writeFileSync(join(EVIDENCE, 'environment.json'), JSON.stringify(env, null, 2) + '\n');
// Merge with earlier runs of other fixtures (when called with fixture names).
const runsFile = join(EVIDENCE, 'runs.json');
const previous = existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, 'utf8')) : [];
const merged = [...previous.filter((r) => !names.includes(r.fixture)), ...results].sort((a, b) => a.fixture.localeCompare(b.fixture));
writeFileSync(runsFile, JSON.stringify(merged, null, 2) + '\n');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} fixtures captured${failed.length ? `; failed: ${failed.map((r) => r.fixture).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
