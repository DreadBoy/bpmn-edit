// V2-1: create a new file (asked in a terminal, --create elsewhere).
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLANK_DIAGRAM } from '../../src/blank.js';
import { isCompleteBpmn, looksLikeBpmn, readBpmnFile } from '../../src/file.js';
import {
  CLI, collectPageErrors, copyFixture, randomPort, runCli, startCli,
} from './helpers/cli.js';
import {
  center, clickEmptyCanvas, dragNewTask, expectNoTempFiles, git, shape, status, typeLabel,
} from './helpers/editor.js';
import { ptyAvailable, startInPty } from './helpers/pty.js';

const READY = /bpmn-edit: editing (\S+) at (http:\/\/\S+?)\r?\n/;

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-e2e-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Opens the editor at `url` and waits for the blank diagram's start event, saved. */
async function openBlank(page, url) {
  await page.goto(url);
  await expect(shape(page, 'StartEvent_1')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-state', 'saved');
}

/** The writes the CLI reported with BPMN_EDIT_DEBUG_WRITES=1, as "mode lost=n". */
function writes(stderr) {
  return [...stderr.matchAll(/^bpmn-edit: debug: write (.*)$/gm)].map(([, line]) => (
    `${/(?:^| )mode=(\S+)/.exec(line)?.[1]} lost=${/(?:^| )lost=(\d+)/.exec(line)?.[1] ?? 0}`));
}

test.describe('V2-1: create a new file', () => {
  let tmp;
  let cli;

  test.afterEach(async () => {
    await cli?.stop();
    await tmp?.cleanup();
    cli = undefined;
    tmp = undefined;
  });

  test('not interactive (stdin /dev/null, pipes): exits 1 at once, says to pass --create, creates nothing', async () => {
    tmp = await tempDir();
    const started = Date.now();
    const result = await runCli(['new.bpmn', '--no-open'], { cwd: tmp.dir, timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('bpmn-edit: error: File not found: new.bpmn (pass --create to create it)\n');
    expect(result.stdout).toBe('');
    expect(await readdir(tmp.dir)).toEqual([]);
  });

  test('not interactive with stdin a pipe that stays open: still does not wait for input', async () => {
    tmp = await tempDir();
    const child = spawn(process.execPath, [CLI, 'new.bpmn', '--no-open'], { cwd: tmp.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [code, signal] = await new Promise((r) => { child.on('exit', (...a) => r(a)); });
    clearTimeout(timer);
    expect({ code, signal }).toEqual({ code: 1, signal: null });
    expect(stderr).toContain('pass --create to create it');
    expect(await readdir(tmp.dir)).toEqual([]);
  });

  test('refuses a missing folder or a name without .bpmn, even with --create, and creates nothing', async () => {
    tmp = await tempDir();
    let result = await runCli(['sub/new.bpmn', '--create', '--no-open'], { cwd: tmp.dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('bpmn-edit: error: cannot create sub/new.bpmn: folder sub does not exist (bpmn-edit does not create folders)\n');
    result = await runCli(['new.xml', '--create', '--no-open'], { cwd: tmp.dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('bpmn-edit: error: cannot create new.xml: the name must end in .bpmn\n');
    result = await runCli(['new.xml', '--no-open'], { cwd: tmp.dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the name must end in .bpmn');
    expect(await readdir(tmp.dir)).toEqual([]);
  });

  test('--create: writes the blank diagram, the editor shows its start event, and edits save minimally', async ({ page }) => {
    tmp = await tempDir();
    git(tmp.dir, 'init', '-q');
    const file = join(tmp.dir, 'new.bpmn');
    cli = await startCli(file, { cwd: tmp.dir, args: ['--create'], env: { BPMN_EDIT_DEBUG_WRITES: '1' } });
    expect(cli.stderr()).toContain(`bpmn-edit: created ${file}\n`);
    expect(await readFile(file, 'utf8')).toBe(BLANK_DIAGRAM);
    git(tmp.dir, 'add', 'new.bpmn');
    git(tmp.dir, 'commit', '-q', '-m', 'blank');

    const errors = collectPageErrors(page);
    await openBlank(page, cli.url);
    await expect(page.locator('.djs-palette')).toBeVisible();
    // Opening the file does not change it.
    expect(await readFile(file, 'utf8')).toBe(BLANK_DIAGRAM);

    await typeLabel(page, 'StartEvent_1', 'Order received');
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    await expect.poll(() => readFile(file, 'utf8')).toContain('name="Order received"');
    // A task next to the start event, too.
    const start = await center(shape(page, 'StartEvent_1'));
    const taskId = await dragNewTask(page, { x: start.x + 200, y: start.y });
    await clickEmptyCanvas(page);
    await expect.poll(() => readFile(file, 'utf8')).toContain(`<bpmn:task id="${taskId}"`);
    await expect(status(page)).toHaveAttribute('data-state', 'saved');

    const xml = await readFile(file, 'utf8');
    expect(looksLikeBpmn(xml)).toBe(true);
    expect(isCompleteBpmn(xml)).toBe(true);
    expect(xml).toContain('<bpmn:startEvent id="StartEvent_1" name="Order received"');
    expect(xml).toMatch(new RegExp(`<bpmndi:BPMNShape id="[^"]+" bpmnElement="${taskId}"`));
    // The rename is a one-line diff: the minimal-diff writer handled the file.
    const diff = git(tmp.dir, 'diff', '--', 'new.bpmn');
    expect(diff).toContain('-    <bpmn:startEvent id="StartEvent_1" />');
    expect(writes(cli.stderr()).length).toBeGreaterThanOrEqual(2);
    expect(writes(cli.stderr())).toEqual(writes(cli.stderr()).map(() => 'minimal lost=0'));
    expect(errors).toEqual([]);

    expect((await cli.stop()).code).toBe(0);
    await expectNoTempFiles(tmp.dir);
    // The saved file opens again (startup check) and shows the edits.
    await readBpmnFile(file);
    cli = await startCli(file, { cwd: tmp.dir });
    await page.goto(cli.url);
    await expect(shape(page, taskId)).toBeVisible();
    await expect(shape(page, 'StartEvent_1')).toBeVisible();
  });

  test('--create on an existing file opens it unchanged, byte for byte', async ({ page }) => {
    const fixture = await copyFixture('order.bpmn');
    tmp = { dir: fixture.dir, cleanup: fixture.cleanup };
    const before = await readFile(fixture.file);
    cli = await startCli(fixture.file, { cwd: fixture.dir, args: ['--create'] });
    expect(cli.stderr()).not.toContain('created');
    await page.goto(cli.url);
    await expect(shape(page, 'Task_CheckStock')).toBeVisible();
    await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expect((await cli.stop()).code).toBe(0);
    expect(await readFile(fixture.file)).toEqual(before);
  });
});

test.describe('V2-1: the question in a terminal', () => {
  test.skip(!ptyAvailable, 'needs python3 (pty module) to drive a pseudo-terminal');
  let tmp;
  let term;

  test.afterEach(async () => {
    await term?.stop();
    await tmp?.cleanup();
    term = undefined;
    tmp = undefined;
  });

  test('"y" creates the blank diagram and opens it; Ctrl-C then stops normally', async ({ page }) => {
    tmp = await tempDir();
    term = startInPty(['new.bpmn', '--no-open', '--port', String(randomPort())], { cwd: tmp.dir });
    await term.waitFor(/new\.bpmn does not exist\. Create it\? \[y\/N\] /);
    expect(await readdir(tmp.dir)).toEqual([]); // nothing before the answer
    term.type('y\r');
    const out = await term.waitFor(READY);
    expect(out).toContain('bpmn-edit: created new.bpmn');
    expect(await readFile(join(tmp.dir, 'new.bpmn'), 'utf8')).toBe(BLANK_DIAGRAM);
    await openBlank(page, READY.exec(out)[2]);
    term.type('\x03');
    expect(await term.exited).toEqual({ code: 0, signal: null });
    expect(await readFile(join(tmp.dir, 'new.bpmn'), 'utf8')).toBe(BLANK_DIAGRAM);
  });

  test('"YES" (any case) also creates it', async () => {
    tmp = await tempDir();
    term = startInPty(['new.bpmn', '--no-open', '--port', String(randomPort())], { cwd: tmp.dir });
    await term.waitFor(/Create it\? \[y\/N\] /);
    term.type('YES\r');
    await term.waitFor(READY);
    expect(await readFile(join(tmp.dir, 'new.bpmn'), 'utf8')).toBe(BLANK_DIAGRAM);
  });

  for (const [what, keys] of [['"n"', 'n\r'], ['an empty answer', '\r'], ['"maybe"', 'maybe\r'], ['Ctrl-C', '\x03'], ['Ctrl-D (end of input)', '\x04']]) {
    test(`${what} exits 1 and creates nothing`, async () => {
      tmp = await tempDir();
      term = startInPty(['new.bpmn', '--no-open'], { cwd: tmp.dir });
      await term.waitFor(/Create it\? \[y\/N\] /);
      term.type(keys);
      const started = Date.now();
      expect(await term.exited).toEqual({ code: 1, signal: null });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(term.output()).toContain('bpmn-edit: error: new.bpmn was not created');
      expect(term.output()).not.toContain('editing');
      expect(await readdir(tmp.dir)).toEqual([]);
    });
  }

  test('stdout piped (stdin still a terminal): no question, the --create hint', async () => {
    tmp = await tempDir();
    term = startInPty(['new.bpmn', '--no-open'], { cwd: tmp.dir, pipeStdout: true });
    await term.exited;
    expect(term.output()).toContain('exit=1');
    expect(term.output()).toContain('File not found: new.bpmn (pass --create to create it)');
    expect(term.output()).not.toContain('Create it?');
    expect(await readdir(tmp.dir)).toEqual([]);
  });
});
