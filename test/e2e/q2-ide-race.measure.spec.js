// Q2 measurements: an edit in the browser racing a save of a different change made on disk by
// another program (an IDE). Not part of the regular suite (see playwright.config.js); run with
//
//   LOCAL_BPMN_MEASURE=1 LOCAL_BPMN_MEASURE_OUT=/some/dir npx playwright test q2-ide-race.measure
//
// Real CLI, two Chrome windows (A edits, B watches), the file in a temp git repo (core.autocrlf=false).
// The browser edit renames "Ship order" in window A with the real keyboard/mouse; the "IDE save" reads
// the file and writes it back with "Check stock" renamed (fs.writeFile, in place). Each trial uses
// fresh names, so what survived is read from the file on disk and from each window afterwards.
import { test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectPageErrors, startCli } from './helpers/cli.js';
import { typeLabel } from './helpers/editor.js';
import {
  ackAfter, asideFiles, ideRename, nameInXml, openWindow, settleWindows, setupRepoWithAutocrlf, toastsSince, windowNames,
} from './helpers/q2.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TRIALS = Number(process.env.LOCAL_BPMN_MEASURE_TRIALS || 15);
const SIGINT_TRIALS = Number(process.env.LOCAL_BPMN_MEASURE_SIGINT_TRIALS || 10);
const OUT = process.env.LOCAL_BPMN_MEASURE_OUT;

const UI = 'Task_ShipOrder';
const DISK = 'Task_CheckStock';
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

test.use({ actionTimeout: 10_000 });

async function report(name, result) {
  console.log(JSON.stringify(result, null, 1));
  if (OUT) {
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, `${name}.json`), JSON.stringify(result, null, 1));
  }
}

function summarise(trials) {
  const lost = trials.filter((t) => !t.disk.ui || !t.disk.disk);
  return {
    trials: trials.length,
    bothOnDisk: trials.filter((t) => t.disk.ui && t.disk.disk).length,
    uiLost: trials.filter((t) => !t.disk.ui).length,
    diskLost: trials.filter((t) => !t.disk.disk).length,
    windowsDisagree: trials.filter((t) => t.windowsDisagree).length,
    lostWithToast: lost.filter((t) => t.toasts.length).length,
    silentLoss: lost.filter((t) => !t.toasts.length && !t.aside.length).length,
    keptAside: trials.filter((t) => t.aside.length).length,
    stderrWarnings: trials.filter((t) => t.stderr.length).length,
  };
}

// Scenarios a–c share one CLI and two windows; each trial is independent (new names).
const SCENARIOS = {
  // a: browser edit, then the disk save d ms after the label commit (client debounce 300 ms + host
  //    write debounce 250 ms: the whole window in which the edit is not on disk yet).
  a: { describe: 'UI edit, then disk save 0–600 ms later' },
  // b: disk save, then the browser edit d ms later (before / while the host notices the change).
  b: { describe: 'disk save, then UI edit 0–400 ms later' },
  // c: the disk save lands 20–140 ms before the host writes the accepted edit (host write = ack + 250 ms).
  c: { describe: 'disk save 20–140 ms before the host writes the accepted UI edit' },
};

for (const [key, scenario] of Object.entries(SCENARIOS)) {
  test(`measure Q2 scenario ${key}: ${scenario.describe}`, async ({ browser }) => {
    test.setTimeout(600_000);
    const fixture = await setupRepoWithAutocrlf('false');
    const cli = await startCli(fixture.file, { cwd: fixture.dir });
    const windows = [];
    const trials = [];
    try {
      for (let i = 0; i < 2; i++) windows.push(await openWindow(browser, cli));
      const [A, B] = windows.map((w) => w.page);
      const errors = [...collectPageErrors(A), ...collectPageErrors(B)];
      for (let i = 0; i < TRIALS; i++) {
        const uiName = `Ship ${key}${i}`;
        const diskName = `Check ${key}${i}`;
        const stderrBefore = cli.stderr().length;
        const start = Date.now();
        let offset;
        if (key === 'a') {
          offset = Math.round(rand(0, 600));
          await typeLabel(A, UI, uiName);
          await delay(offset);
          await ideRename(fixture.file, DISK, diskName);
        } else if (key === 'b') {
          offset = Math.round(rand(0, 400));
          await ideRename(fixture.file, DISK, diskName);
          await delay(offset);
          await typeLabel(A, UI, uiName);
        } else {
          offset = Math.round(rand(20, 140));
          const committed = Date.now();
          await typeLabel(A, UI, uiName);
          const ack = await ackAfter(A, committed);
          await delay(Math.max(0, ack + 250 - offset - Date.now()));
          await ideRename(fixture.file, DISK, diskName);
        }
        await settleWindows([A, B]);
        const xml = await readFile(fixture.file, 'utf8');
        const onDisk = { [UI]: nameInXml(xml, UI), [DISK]: nameInXml(xml, DISK) };
        const shown = [await windowNames(A, [UI, DISK]), await windowNames(B, [UI, DISK])];
        const toasts = [...await toastsSince(A, start), ...await toastsSince(B, start)];
        trials.push({
          offset,
          disk: { ui: onDisk[UI] === uiName, disk: onDisk[DISK] === diskName },
          onDisk,
          shown,
          windowsDisagree: shown.some((s) => s[UI] !== onDisk[UI] || s[DISK] !== onDisk[DISK]),
          toasts,
          aside: await asideFiles(fixture.dir),
          stderr: cli.stderr().slice(stderrBefore).split('\n').filter((l) => /warning|kept/.test(l)),
        });
      }
      await report(`q2-${key}`, { scenario: key, describe: scenario.describe, summary: summarise(trials), errors, trials });
    } finally {
      for (const w of windows) await w.context.close();
      await cli.stop();
      await fixture.cleanup();
    }
  });
}

// d: the disk save lands right before Ctrl-C while an accepted UI edit still waits for its write.
test('measure Q2 scenario d: disk save just before Ctrl-C', async ({ browser }) => {
  test.setTimeout(600_000);
  const trials = [];
  for (let i = 0; i < SIGINT_TRIALS; i++) {
    const fixture = await setupRepoWithAutocrlf('false');
    const cli = await startCli(fixture.file, { cwd: fixture.dir });
    const windows = [];
    try {
      for (let w = 0; w < 2; w++) windows.push(await openWindow(browser, cli));
      const [A, B] = windows.map((w) => w.page);
      const uiName = `Ship d${i}`;
      const diskName = `Check d${i}`;
      const start = Date.now();
      await typeLabel(A, UI, uiName);
      await ackAfter(A, start);
      await ideRename(fixture.file, DISK, diskName);
      const offset = Math.round(rand(0, 100));
      await delay(offset);
      cli.child.kill('SIGINT'); // the real node process (spawned with process.execPath)
      const exit = await cli.exited;
      const xml = await readFile(fixture.file, 'utf8');
      const aside = await asideFiles(fixture.dir);
      const asideXml = aside.length ? await readFile(join(fixture.dir, aside[0]), 'utf8') : '';
      const toasts = [...await toastsSince(A, start), ...await toastsSince(B, start)];
      trials.push({
        offset,
        exit,
        disk: { ui: nameInXml(xml, UI) === uiName, disk: nameInXml(xml, DISK) === diskName },
        onDisk: { [UI]: nameInXml(xml, UI), [DISK]: nameInXml(xml, DISK) },
        aside,
        asideHasUi: nameInXml(asideXml, UI) === uiName,
        toasts,
        windowsDisagree: false,
        stderr: cli.stderr().split('\n').filter((l) => /warning|kept/.test(l)),
      });
    } finally {
      for (const w of windows) await w.context.close();
      await cli.stop();
      await fixture.cleanup();
    }
  }
  await report('q2-d', { scenario: 'd', describe: 'disk save 0–100 ms before SIGINT, UI edit accepted but not written', summary: summarise(trials), trials });
});
