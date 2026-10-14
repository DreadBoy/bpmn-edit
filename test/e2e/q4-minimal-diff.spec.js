// Q4-impl: a save changes only what was edited (docs/decisions.md "Q4-impl", src/minimal-diff.js).
// Every file of the Q4 corpus (test/fixtures/q4) is committed to a fresh git repo, opened with the
// real CLI in a real browser, and edited like a user would: two renames and a 40 px drag through the
// UI, then structural edits through the editor's modeling API (append, connect, colour, annotation,
// sub-process, move into it, replace, delete with connections). After each save the `git diff` is
// measured: lines unrelated to the edit, information kept, the file's style kept, and every write must
// have been made by the minimal-diff writer (no fallback; BPMN_EDIT_DEBUG_WRITES=1 reports each one).
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES, startCli } from './helpers/cli.js';
import { git } from './helpers/editor.js';
import { detectStyle, escapeAttr, facts, load, parse } from '../../src/minimal-diff.js';

const CORPUS = join(FIXTURES, 'q4');
const FILES = (await readdir(CORPUS)).filter((name) => name.endsWith('.bpmn')).sort();

/** The two tasks renamed in each file (the same as in the Q4 measurement, docs/q4-diff-churn.md). */
const TARGETS = {
  'bizagi-export.bpmn': ['_5a972b87-735d-454a-b31c-f52fb3afc5c7', '_4f7d62d7-f0e6-46bc-be00-69e02da38f65'],
  'bpmnio-demo-export.bpmn': ['task_id', 'user_task_id'],
  'camunda7-loan-approval.bpmn': ['UserTask_1', 'UserTask_1'],
  'camunda7-modeler.bpmn': ['Activity_09yexpb', 'Activity_1navjv9'],
  'camunda8-modeler.bpmn': ['Activity_1kpg3ok', 'Activity_0kzg0nb'],
  'comments-nonascii.bpmn': ['Task_CheckStock', 'Task_ShipOrder'],
  'crlf.bpmn': ['Task_CheckStock', 'Task_ShipOrder'],
  'doctype.bpmn': ['Task_CheckStock', 'Task_ShipOrder'],
  'hand-4space.bpmn': ['Task_CheckStock', 'Task_ShipOrder'],
  'hand-tabs.bpmn': ['Task_CheckStock', 'Task_ShipOrder'],
  'no-trailing-newline.bpmn': ['Task_CheckStock', 'Task_ShipOrder'],
  'signavio-export.bpmn': ['sid-35027A00-C747-43EC-A8BB-9F8BA65FC08C', 'sid-28CA9418-A686-4DD4-9576-2611515C414F'],
};
const NAME_1 = 'Q4 first rename';
const NAME_2 = 'Q4 zweite Änderung & "mehr"';

test('every corpus file has rename targets', () => {
  expect(Object.keys(TARGETS).sort()).toEqual(FILES);
});

/** The file committed to a fresh repo with `core.autocrlf` set explicitly. */
async function setupRepo(name, autocrlf) {
  const dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-q4-'));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  const file = join(repo, name);
  await copyFile(join(CORPUS, name), file);
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', autocrlf);
  git(repo, 'config', 'core.safecrlf', 'false');
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', 'original');
  return { dir, repo, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Lines added + deleted between two texts, as `git diff --numstat` counts them (byte exact). */
async function changedLines(dir, a, b) {
  const fa = join(dir, 'a.txt');
  const fb = join(dir, 'b.txt');
  await writeFile(fa, a);
  await writeFile(fb, b);
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--numstat', fa, fb], { encoding: 'utf8' });
  const line = r.stdout.trim();
  if (!line) return 0;
  const [added, deleted] = line.split('\t').map(Number);
  return added + deleted;
}

/** `git diff --numstat` of the repo's working tree (added + deleted lines). */
function gitDiffLines(repo) {
  const out = git(repo, 'diff', '--numstat').trim();
  if (!out) return 0;
  return out.split('\n').reduce((sum, line) => sum + line.split('\t').slice(0, 2).map(Number).reduce((x, y) => x + y, 0), 0);
}

/** `xml` with only the name of element `id` replaced, in place (the ideal edit of a rename). */
function idealRename(xml, id, name) {
  const doc = parse(xml);
  const stack = [doc.root];
  while (stack.length) {
    const el = stack.pop();
    if (el.attrs.some((a) => a.local === 'id' && a.uri === null && a.value === id)) {
      const attr = el.attrs.find((a) => a.local === 'name' && a.uri === null);
      if (attr) return xml.slice(0, attr.valueStart) + escapeAttr(name, attr.quote) + xml.slice(attr.valueEnd);
      return `${xml.slice(0, el.nameEnd)} name=${attr?.quote ?? '"'}${escapeAttr(name)}"${xml.slice(el.nameEnd)}`;
    }
    stack.push(...el.children.filter((c) => c.kind === 'element'));
  }
  throw new Error(`no element ${id}`);
}

/** The writes the CLI reported (BPMN_EDIT_DEBUG_WRITES=1): { mode, lost, reason } (fields parsed one by one). */
function writes(cli) {
  return [...cli.stderr().matchAll(/^bpmn-edit: debug: write (.*)$/gm)].map(([, line]) => ({
    mode: /(?:^| )mode=(\S+)/.exec(line)?.[1] ?? null,
    lost: Number(/(?:^| )lost=(\d+)/.exec(line)?.[1] ?? 0),
    reason: /(?:^| )reason=(.*)$/.exec(line)?.[1] ?? null,
  }));
}

/** Every write minimal and lossless (a clear failure, not a timeout, if one was not). */
function expectMinimalWrites(cli, what = 'writes') {
  const all = writes(cli);
  expect(all.map((w) => `${w.mode} lost=${w.lost}${w.reason ? ` (${w.reason})` : ''}`), what).toEqual(all.map(() => 'minimal lost=0'));
}

/**
 * Waits until the edit just made is on disk: the CLI wrote after `before` writes and the page has
 * every version saved (and the write count stayed put for a moment). Resolves to the file's text.
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

async function rename(page, id, text) {
  await page.evaluate((elId) => {
    const m = window.bpmnModeler;
    m.get('canvas').scrollToElement(m.get('elementRegistry').get(elId));
  }, id);
  await page.locator(`.djs-element.djs-shape[data-element-id="${id}"]`).dblclick();
  await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.djs-direct-editing-parent')).toBeHidden();
}

async function moveBy(page, id, dx, dy = 0) {
  const box = await page.locator(`.djs-element.djs-shape[data-element-id="${id}"]`).boundingBox();
  // Vertical and diagonal moves: grab near the top-left inside the shape (away from its label).
  const from = dy === 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : { x: box.x + Math.min(15, box.width / 4), y: box.y + Math.min(15, box.height / 4) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

/** Ids of all elements in document order. */
function idOrder(xml) {
  return [...load(xml).ids.keys()];
}

/**
 * Model facts that differ between two texts (src/minimal-diff.js facts: elements, attributes, texts,
 * CDATA, comments, PIs, XML declaration, DOCTYPE), apart from those `allowed(key)` accepts.
 */
function factChanges(before, after, allowed = () => false) {
  const [fa, fb] = [facts(load(before)), facts(load(after))];
  return [...new Set([...fa.keys(), ...fb.keys()])]
    .filter((key) => fa.get(key) !== fb.get(key) && !allowed(key))
    .map((key) => `${key.replaceAll('\u0000', ' ')}: ${JSON.stringify(fa.get(key))} -> ${JSON.stringify(fb.get(key))}`);
}

/** The text before the root element and after it (XML declaration, comments, PIs, DOCTYPE, final newline). */
function outside(xml) {
  const { root } = parse(xml);
  return [xml.slice(0, root.start), xml.slice(root.end)];
}

/** Lone LF line ends in a CRLF file, or CRLF in an LF file. */
function foreignLineEnds(xml, original) {
  const crlf = /\r\n/.test(original);
  return crlf ? (xml.match(/(^|[^\r])\n/g) || []).length : (xml.match(/\r\n/g) || []).length;
}

/** Structural edits through the editor's modeling API, one save each (as in the Q4 stress test). */
const STRUCTURAL = [
  ['append a task', ({ a }) => {
    const m = window.bpmnModeler;
    const src = m.get('elementRegistry').get(a);
    window.__q4Appended = m.get('modeling').appendShape(src, { type: 'bpmn:Task' }, {
      x: src.x + src.width / 2 + 60, y: src.y + src.height + 120,
    }).id;
  }],
  ['connect it', ({ b }) => {
    const m = window.bpmnModeler;
    const reg = m.get('elementRegistry');
    m.get('modeling').connect(reg.get(window.__q4Appended), reg.get(b));
  }],
  ['colour a task', ({ a }) => {
    const m = window.bpmnModeler;
    m.get('modeling').setColor([m.get('elementRegistry').get(a)], { fill: '#bbdefb', stroke: '#0d4372' });
  }],
  ['annotate a task', ({ a }) => {
    const m = window.bpmnModeler;
    const src = m.get('elementRegistry').get(a);
    const note = m.get('elementFactory').createShape({ type: 'bpmn:TextAnnotation' });
    m.get('modeling').createShape(note, { x: src.x + 50, y: src.y - 80 }, src.parent);
    m.get('modeling').updateProperties(note, { text: 'Note – Änderung <&>' });
    m.get('modeling').connect(src, note);
  }],
  ['add a sub-process', ({ a }) => {
    const m = window.bpmnModeler;
    const src = m.get('elementRegistry').get(a);
    const parent = src.parent;
    const lowest = Math.max(...parent.children.filter((c) => !c.waypoints).map((c) => c.y + c.height), src.y + src.height);
    const sub = m.get('elementFactory').createShape({ type: 'bpmn:SubProcess', isExpanded: true });
    window.__q4Sub = m.get('modeling').createShape(sub, { x: src.x + 200, y: lowest + 150 }, parent).id;
  }],
  ['move a task into the sub-process', () => {
    const m = window.bpmnModeler;
    const reg = m.get('elementRegistry');
    const task = reg.get(window.__q4Appended);
    const sub = reg.get(window.__q4Sub);
    m.get('modeling').moveElements([task], {
      x: sub.x + sub.width / 2 - (task.x + task.width / 2), y: sub.y + sub.height / 2 - (task.y + task.height / 2),
    }, sub);
  }],
  ['replace a task by another type', ({ b }) => {
    const m = window.bpmnModeler;
    const el = m.get('elementRegistry').get(b);
    m.get('bpmnReplace').replaceElement(el, { type: el.type === 'bpmn:UserTask' ? 'bpmn:ServiceTask' : 'bpmn:UserTask' });
  }],
  ['delete a task with its connections', ({ b }) => {
    const m = window.bpmnModeler;
    m.get('modeling').removeElements([m.get('elementRegistry').get(b)]);
  }],
];

/** BPMN_EDIT_Q4_DUMP=<dir>: every saved version is also copied there (for inspection). */
async function dump(name, autocrlf, step, text) {
  const dir = process.env.BPMN_EDIT_Q4_DUMP;
  if (!dir) return;
  const to = join(dir, `${name.replace(/\.bpmn$/, '')}-${autocrlf}`);
  await mkdir(to, { recursive: true });
  await writeFile(join(to, step.endsWith('stderr') ? `${step}.txt` : `${step}.bpmn`), text);
}

/** Per-file numbers, printed at the end (they go into docs/decisions.md "Q4-impl"). */
const report = [];
test.afterAll(({ browserName }) => {
  if (!report.length) return;
  const lines = report.map((r) => `${browserName} ${r.file.padEnd(28)} autocrlf=${r.autocrlf.padEnd(5)} `
    + `unrelated ${r.unrelated.join('/')} git ${r.git.join('/')} move ${r.move}${r.moves ? ` (v/d ${r.moves.join('/')})` : ''}`
    + `${r.structural ? ` structural ${r.structural.join(',')}` : ''} writes ${r.writes} fallbacks ${r.fallbacks}`);
  process.stdout.write(`\nQ4 minimal diff:\n${lines.join('\n')}\n`);
});

for (const autocrlf of ['false', 'input']) {
  test.describe(`core.autocrlf=${autocrlf}`, () => {
    for (const name of FILES) {
      test(`${name}: saves change only what was edited`, async ({ browser }) => {
        test.setTimeout(autocrlf === 'false' ? 180_000 : 90_000);
        const [taskA, taskB] = TARGETS[name];
        const fixture = await setupRepo(name, autocrlf);
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        const cli = await startCli(fixture.file, { cwd: fixture.repo, env: { BPMN_EDIT_DEBUG_WRITES: '1' } });
        const row = { file: name, autocrlf, unrelated: [], git: [], move: null, structural: null, writes: 0, fallbacks: 0 };
        try {
          const original = await readFile(fixture.file, 'utf8');
          await page.goto(cli.url);
          await expect(page.locator(`.djs-element.djs-shape[data-element-id="${taskA}"]`)).toBeVisible({ timeout: 15_000 });
          await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
          expect(writes(cli)).toEqual([]); // opening never writes
          const style = detectStyle(load(original));
          let step = 0;
          await dump(name, autocrlf, `${step++}-original`, original);

          // Two renames: at most one changed line unrelated to the edit, on the first save and later.
          let previous = original;
          for (const [id, newName] of [[taskA, NAME_1], [taskB, NAME_2]]) {
            const count = writes(cli).length;
            await rename(page, id, newName);
            const now = await saved(page, cli, fixture.file, count);
            await dump(name, autocrlf, `${step++}-rename`, now);
            const ideal = idealRename(previous, id, newName);
            const unrelated = await changedLines(fixture.dir, ideal, now);
            const idealLines = await changedLines(fixture.dir, previous, ideal);
            const gitLines = gitDiffLines(fixture.repo);
            row.unrelated.push(unrelated);
            row.git.push(gitLines);
            expect(unrelated, `unrelated lines after renaming ${id}`).toBeLessThanOrEqual(1);
            expect(gitLines, `git diff after renaming ${id}`).toBeLessThanOrEqual(idealLines + 1);
            git(fixture.repo, 'commit', '-q', '-am', `rename ${id}`);
            previous = now;
          }
          // Zero information loss: the model is the original's apart from the two names.
          const renamed = (key) => /^attr\u0000#[^\u0000]+\u0000\{\}name$/.test(key)
            && [taskA, taskB].some((id) => key.startsWith(`attr\u0000#${id}\u0000`));
          expect(factChanges(original, previous, renamed)).toEqual([]);
          expect(outside(previous)).toEqual(outside(original));
          expect(detectStyle(load(previous))).toEqual(style);
          expect(foreignLineEnds(previous, original)).toBe(0);

          // A 40 px move, then a vertical and a diagonal one (bpmn-js re-routes connections then): no DI
          // reordering, at most 16 changed lines, only layout values change.
          for (const [dx, dy] of [[40, 0], [0, 30], [25, 20]]) {
            const count = writes(cli).length;
            await moveBy(page, taskA, dx, dy);
            if (dx !== 40) {
              // bpmn-js may refuse a move (e.g. across a lane): nothing changes, nothing is written.
              const moved = await expect.poll(() => writes(cli).length, { timeout: 3000 }).toBeGreaterThan(count).then(() => true, () => false);
              if (!moved) {
                expect(await readFile(fixture.file, 'utf8')).toBe(previous);
                row.moves = [...(row.moves ?? []), 'refused'];
                continue;
              }
            }
            const now = await saved(page, cli, fixture.file, count);
            await dump(name, autocrlf, `${step++}-move`, now);
            const lines = await changedLines(fixture.dir, previous, now);
            expectMinimalWrites(cli, `move ${dx},${dy}`);
            const sameIds = [...idOrder(now)].sort().join() === [...idOrder(previous)].sort().join();
            if (dx !== 40 && (lines === 0 || !sameIds)) {
              // No change after all, or bpmn-js dropped the task onto a connection and split it (a
              // structural edit, not a move): minimal and lossless is all that is asserted (above).
              row.moves = [...(row.moves ?? []), lines === 0 ? 'no change' : `split ${lines}`];
              git(fixture.repo, 'commit', '-q', '-am', `move ${dx},${dy}`, '--allow-empty');
              previous = now;
              continue;
            }
            if (dx === 40) {
              row.move = lines;
              expect(lines, 'lines changed by the 40 px move').toBeLessThanOrEqual(16);
            } else {
              row.moves = [...(row.moves ?? []), lines];
              // bpmn-js re-routes connections: at most a removed and an added line per value it changed.
              expect(lines, `lines changed by the move ${dx},${dy}`).toBeLessThanOrEqual(2 * factChanges(previous, now).length);
            }
            expect(lines).toBeGreaterThan(0);
            expectMinimalWrites(cli, `move ${dx},${dy}`);
            expect(idOrder(now)).toEqual(idOrder(previous));
            // Only layout values: shape / label bounds and waypoints (bpmn-js also re-measures the
            // labels of connected elements).
            const layout = (key) => /^attr\u0000[^\u0000]*\{http:\/\/www\.omg\.org\/spec\/DD\/20100524\/DC\}Bounds\[0\]\u0000\{\}(x|y|width|height)$/.test(key)
              || /\{http:\/\/www\.omg\.org\/spec\/DD\/20100524\/DI\}waypoint\[\d+\]/.test(key);
            expect(factChanges(previous, now, layout)).toEqual([]);
            expect(outside(now)).toEqual(outside(original));
            git(fixture.repo, 'commit', '-q', '-am', 'move');
            previous = now;
          }

          if (autocrlf === 'false') {
            // Structural edits: written by the minimal writer too, new elements in the file's style.
            row.structural = [];
            for (const [what, edit] of STRUCTURAL) {
              const count = writes(cli).length;
              await page.evaluate(edit, { a: taskA, b: taskB });
              const now = await saved(page, cli, fixture.file, count);
              await dump(name, autocrlf, `${step++}-${what.replaceAll(' ', '-')}`, now);
              row.structural.push(await changedLines(fixture.dir, previous, now));
              expectMinimalWrites(cli, what);
              expect(outside(now), what).toEqual(outside(original));
              expect(foreignLineEnds(now, original), what).toBe(0);
              if (what === 'append a task') {
                // The new task and its shape: the file's prefixes, indentation and quotes.
                const doc = load(now);
                const added = await page.evaluate(() => window.__q4Appended);
                const task = doc.ids.get(added);
                const ref = doc.ids.get(taskA);
                const shapeOf = (id) => [...doc.ids.values()].find((el) => el.local === 'BPMNShape'
                  && el.attrs.some((a) => a.local === 'bpmnElement' && a.value === id));
                expect(task.prefix).toBe(ref.prefix);
                expect(shapeOf(added).prefix).toBe(shapeOf(taskA).prefix);
                const indentOf = (el) => /[ \t]*$/.exec(now.slice(0, el.start))[0];
                expect(indentOf(task)).toBe(indentOf(ref));
                expect(indentOf(shapeOf(added))).toBe(indentOf(shapeOf(taskA)));
                for (const a of [...task.allAttrs, ...shapeOf(added).allAttrs]) expect(a.quote).toBe(style.quote);
              }
              previous = now;
            }
          }
          expect(errors).toEqual([]);
          row.writes = writes(cli).length;
          row.fallbacks = writes(cli).filter((w) => w.mode !== 'minimal').length;
          expectMinimalWrites(cli);
          expect(cli.stderr()).not.toMatch(/bpmn-edit: (note|warning):/);
          report.push(row);
        } finally {
          await dump(name, autocrlf, 'cli-stderr', cli.stderr());
          await context.close();
          await cli.stop();
          await fixture.cleanup();
        }
      });
    }
  });
}

// Information inside the elements a gesture changes as a whole: replacing an element's type with the
// wrench, dragging it into a new sub-process, renaming inside a collapsed sub-process of an older file.
// All through the UI; every write must be minimal and nothing of the file may be lost.
test.describe('what is inside edited elements is kept (UI gestures)', () => {
  /** Comments, PIs, CDATA flags, the XML declaration and the DOCTYPE of a text, by path. */
  const keptFacts = (xml) => [...facts(load(xml))].filter(([key]) => /^(comment|pi|cdata|decl|doctype)\u0000/.test(key)).sort();

  async function open(browser, name, prepare = (xml) => xml) {
    const fixture = await setupRepo(name, 'false');
    const original = prepare(await readFile(fixture.file, 'utf8'));
    await writeFile(fixture.file, original);
    git(fixture.repo, 'commit', '-q', '-am', 'prepared', '--allow-empty');
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const cli = await startCli(fixture.file, { cwd: fixture.repo, env: { BPMN_EDIT_DEBUG_WRITES: '1' } });
    await page.goto(cli.url);
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await expect(page.locator('.djs-element.djs-shape').first()).toBeVisible();
    return {
      fixture, original, page, cli, errors,
      async close() {
        await context.close();
        await cli.stop();
        await fixture.cleanup();
      },
    };
  }

  const shapeOf = (page, id) => page.locator(`.djs-element.djs-shape[data-element-id="${id}"]`);

  async function replaceWith(page, id, entry) {
    await shapeOf(page, id).click();
    await page.locator('.djs-context-pad .entry[data-action="replace"]').click();
    await page.locator(`.djs-popup [data-id="${entry}"]`).click();
  }
  const replaceWithUserTask = (page, id) => replaceWith(page, id, 'replace-with-user-task');

  /** Creates an expanded sub-process from the palette in empty space; resolves to its id. */
  async function createSubProcess(page) {
    const before = await page.evaluate(() => window.bpmnModeler.get('elementRegistry').filter((e) => e.type === 'bpmn:SubProcess').map((e) => e.id));
    const canvas = await page.locator('#canvas').boundingBox();
    const to = { x: canvas.x + canvas.width * 0.55, y: canvas.y + canvas.height - 180 };
    await page.locator('.djs-palette .entry[data-action="create.subprocess-expanded"]').click();
    await page.mouse.move(to.x - 50, to.y - 50, { steps: 10 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.click(to.x, to.y);
    let id;
    await expect.poll(async () => {
      const now = await page.evaluate(() => window.bpmnModeler.get('elementRegistry').filter((e) => e.type === 'bpmn:SubProcess').map((e) => e.id));
      id = now.find((x) => !before.includes(x));
      return id !== undefined;
    }).toBe(true);
    await page.keyboard.press('Escape');
    return id;
  }

  async function dragInto(page, id, target) {
    const from = await shapeOf(page, id).boundingBox();
    const to = await shapeOf(page, target).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 30, from.y + from.height / 2 + 30, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
  }

  /** Checks shared by every gesture: minimal writes, no note or warning, nothing of the file lost. */
  async function expectKept(t, now) {
    expectMinimalWrites(t.cli);
    expect(t.cli.stderr()).not.toMatch(/bpmn-edit: (note|warning):/);
    expect(keptFacts(now)).toEqual(keptFacts(t.original));
    expect(outside(now)).toEqual(outside(t.original));
    expect(t.errors).toEqual([]);
  }

  test('doctype: replacing a task with the wrench keeps the entity reference in it', async ({ browser }) => {
    const t = await open(browser, 'doctype.bpmn');
    try {
      await replaceWithUserTask(t.page, 'Task_ShipOrder');
      const now = await saved(t.page, t.cli, t.fixture.file, 0);
      expect(load(now).ids.get('Task_ShipOrder').local).toBe('userTask');
      expect(now).toContain('<bpmn:documentation>Shipped by &company; logistics</bpmn:documentation>');
      expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(10);
      await expectKept(t, now);
    } finally {
      await t.close();
    }
  });

  test('doctype: dragging a task into a new sub-process keeps the entity reference in it', async ({ browser }) => {
    const t = await open(browser, 'doctype.bpmn');
    try {
      const sub = await createSubProcess(t.page);
      await saved(t.page, t.cli, t.fixture.file, 0);
      const count = writes(t.cli).length;
      await dragInto(t.page, 'Task_ShipOrder', sub);
      const now = await saved(t.page, t.cli, t.fixture.file, count);
      expect(load(now).ids.get('Task_ShipOrder').parent.path).toBe(`#${sub}`);
      expect(now).toContain('<bpmn:documentation>Shipped by &company; logistics</bpmn:documentation>');
      await expectKept(t, now);
    } finally {
      await t.close();
    }
  });

  test('comments-nonascii: replacing a task keeps its comment, PI, CDATA and acme: extensions', async ({ browser }) => {
    const t = await open(browser, 'comments-nonascii.bpmn');
    try {
      await replaceWithUserTask(t.page, 'Task_CheckStock');
      const now = await saved(t.page, t.cli, t.fixture.file, 0);
      const task = load(now).ids.get('Task_CheckStock');
      expect(task.local).toBe('userTask');
      expect(task.attrs.find((a) => a.local === 'sla')?.value).toBe('PT2H');
      expect(now).toContain('<acme:retryPolicy retries="3" backoff="PT5S">');
      expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(10);
      await expectKept(t, now);
    } finally {
      await t.close();
    }
  });

  test('comments-nonascii: dragging a task into a new sub-process takes its comment, PI, CDATA and extensions along', async ({ browser }) => {
    const t = await open(browser, 'comments-nonascii.bpmn');
    try {
      const sub = await createSubProcess(t.page);
      await saved(t.page, t.cli, t.fixture.file, 0);
      const count = writes(t.cli).length;
      await dragInto(t.page, 'Task_CheckStock', sub);
      const now = await saved(t.page, t.cli, t.fixture.file, count);
      expect(load(now).ids.get('Task_CheckStock').parent.path).toBe(`#${sub}`);
      expect(now).toContain('acme:sla="PT2H"');
      expect(now).toContain('<acme:note>Façade call – keep idempotent</acme:note>');
      await expectKept(t, now);
    } finally {
      await t.close();
    }
  });

  /** Geometry of elements and their labels as the editor shows them. */
  const geometry = (page, ids) => page.evaluate((list) => list.map((id) => {
    const e = window.bpmnModeler.get('elementRegistry').get(id);
    return { id, x: e.x, y: e.y, labelX: e.label?.x ?? null, labelY: e.label?.y ?? null };
  }), ids);

  test('bpmnio-demo-export: rename and move inside a collapsed sub-process (bpmn-js 7 file) stay minimal and look the same after reopening', async ({ browser }) => {
    const t = await open(browser, 'bpmnio-demo-export.bpmn', (xml) => xml
      .replace(/(<bpmn:process [^>]*>)/, '$1\n    <!-- reviewed by ops -->')
      .replace(/(<bpmndi:BPMNPlane [^>]*>)/, '$1\n      <?layout locked="true"?>'));
    let reopened = null;
    try {
      await t.page.locator('[data-container-id="Collapsed_event_sub_process"] .bjs-drilldown').click();
      await shapeOf(t.page, 'Event_0rdw479').dblclick();
      await expect(t.page.locator('.djs-direct-editing-parent')).toBeVisible();
      await t.page.keyboard.type('Inner start');
      await t.page.keyboard.press('Enter');
      let now = await saved(t.page, t.cli, t.fixture.file, 0);
      expect(now).toContain('<bpmn:startEvent id="Event_0rdw479" name="Inner start" />');
      expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(5); // the name and the new label
      // Move the labelled event (its label moves with it).
      const count = writes(t.cli).length;
      const box = await shapeOf(t.page, 'Event_0rdw479').boundingBox();
      await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await t.page.mouse.down();
      await t.page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 5 });
      await t.page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 5 });
      await t.page.mouse.up();
      now = await saved(t.page, t.cli, t.fixture.file, count);
      await expectKept(t, now);
      const shown = await geometry(t.page, ['Event_0rdw479']);
      expect(shown[0].labelY).not.toBeNull();
      // Reopen the file from disk (a new bpmn-edit, a new window): element and label where they were shown.
      await t.cli.stop();
      reopened = await startCli(t.fixture.file, { cwd: t.fixture.repo });
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await context.newPage();
      await page.goto(reopened.url);
      await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
      await page.locator('[data-container-id="Collapsed_event_sub_process"] .bjs-drilldown').click();
      await expect(shapeOf(page, 'Event_0rdw479')).toBeVisible();
      const again = await geometry(page, ['Event_0rdw479']);
      // bpmn-js (>= 9) puts the top-left element of such a sub-process' diagram at (180, 160) on every
      // import, so only positions relative to each other are stable: the label next to its event.
      expect(Math.abs((again[0].labelX - again[0].x) - (shown[0].labelX - shown[0].x)), 'label x').toBeLessThanOrEqual(1);
      expect(Math.abs((again[0].labelY - again[0].y) - (shown[0].labelY - shown[0].y)), 'label y').toBeLessThanOrEqual(1);
      // The label sits under its event, as bpmn-js places event labels.
      expect(again[0].labelY - again[0].y).toBeGreaterThan(0);
      expect(again[0].labelY - again[0].y).toBeLessThan(80);
      expect(await readFile(t.fixture.file, 'utf8')).toBe(now); // opening never writes
      await context.close();
    } finally {
      await reopened?.stop();
      await t.close();
    }
  });

  test('comments-nonascii: delete then undo writes the task back with its comment, PI and CDATA', async ({ browser }) => {
    const t = await open(browser, 'comments-nonascii.bpmn');
    try {
      await shapeOf(t.page, 'Task_CheckStock').click();
      await t.page.keyboard.press('Delete');
      let now = await saved(t.page, t.cli, t.fixture.file, 0);
      expect(load(now).ids.has('Task_CheckStock')).toBe(false);
      const count = writes(t.cli).length;
      await t.page.mouse.click(1500, 80); // the canvas, away from shapes
      await t.page.keyboard.press('ControlOrMeta+z');
      now = await saved(t.page, t.cli, t.fixture.file, count);
      await expectKept(t, now);
      // Back where it was, as it was (bpmn-js re-measures the gateway's label: at most that).
      expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(2);
    } finally {
      await t.close();
    }
  });

  test('comments-nonascii: replace then undo keeps the PI in the extensions and the task in place', async ({ browser }) => {
    const t = await open(browser, 'comments-nonascii.bpmn');
    try {
      await replaceWithUserTask(t.page, 'Task_CheckStock');
      await saved(t.page, t.cli, t.fixture.file, 0);
      const count = writes(t.cli).length;
      await t.page.mouse.click(1500, 80);
      await t.page.keyboard.press('ControlOrMeta+z');
      const now = await saved(t.page, t.cli, t.fixture.file, count);
      expect(load(now).ids.get('Task_CheckStock').local).toBe('task');
      await expectKept(t, now);
      expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(2);
    } finally {
      await t.close();
    }
  });

  for (const [file, id] of [['comments-nonascii.bpmn', 'Task_CheckStock'], ['camunda8-modeler.bpmn', 'Activity_1kpg3ok']]) {
    test(`${file}: wrench, delete, undo, undo comes back to the file as it was`, async ({ browser }) => {
      const t = await open(browser, file);
      try {
        const undo = async () => {
          await t.page.mouse.click(1500, 80); // the canvas, away from shapes
          await t.page.keyboard.press('ControlOrMeta+z');
        };
        await replaceWith(t.page, id, 'replace-with-service-task');
        const afterWrench = await saved(t.page, t.cli, t.fixture.file, 0);
        let count = writes(t.cli).length;
        await t.page.mouse.click(1500, 80); // deselect, then select it again: its context pad opens
        await shapeOf(t.page, id).click();
        await expect(t.page.locator('.djs-context-pad.open')).toBeVisible();
        await t.page.locator('.djs-context-pad.open .entry[data-action="delete"]').click();
        await saved(t.page, t.cli, t.fixture.file, count);
        count = writes(t.cli).length;
        await undo();
        const afterUndo = await saved(t.page, t.cli, t.fixture.file, count);
        // The service task is back with its own text (and the extensions kept on the type change).
        expect(load(afterUndo).ids.get(id).local).toBe('serviceTask');
        expect(await changedLines(t.fixture.dir, afterWrench, afterUndo)).toBeLessThanOrEqual(2);
        count = writes(t.cli).length;
        await undo();
        const now = await saved(t.page, t.cli, t.fixture.file, count);
        expect(load(now).ids.get(id).local).toBe(load(t.original).ids.get(id).local);
        await expectKept(t, now);
        // Apart from a label bpmn-js re-measures, the same model; bpmn-js may re-add a reference to the
        // restored flow at the end of a gateway's <incoming> list (its model's order): compared as a set.
        const refs = (key) => /\}(incoming|outgoing)\[\d+\]\u0000$/.test(key);
        expect(factChanges(t.original, now, (key) => refs(key) || /\{http:\/\/www\.omg\.org\/spec\/DD\/20100524\/DC\}Bounds\[0\]\u0000\{\}(x|width)$/.test(key))).toEqual([]);
        const refSets = (xml) => [...facts(load(xml))].filter(([key]) => refs(key)).map(([key, v]) => `${key.split('\u0000')[1].replace(/\[\d+\]$/, '')} ${v}`).sort();
        expect(refSets(now)).toEqual(refSets(t.original));
        expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(2); // a re-measured label, or a reference re-ordered by bpmn-js
      } finally {
        await t.close();
      }
    });
  }

  test('signavio-export: dragging the start event down is minimal (bpmn-js re-routes its flow)', async ({ browser }) => {
    const t = await open(browser, 'signavio-export.bpmn');
    try {
      await moveBy(t.page, 'sid-C069430A-FCD2-404F-B0F8-3A4D85BBB31F', 0, 20);
      const now = await saved(t.page, t.cli, t.fixture.file, 0);
      await expectKept(t, now);
      expect(await changedLines(t.fixture.dir, t.original, now)).toBeLessThanOrEqual(16);
    } finally {
      await t.close();
    }
  });

  for (const [file, id, other] of [['comments-nonascii.bpmn', 'Task_CheckStock', 'Task_CancelOrder'], ['camunda7-modeler.bpmn', 'Activity_09yexpb', 'Activity_1navjv9']]) {
    test(`${file}: wrench, connect a second flow, delete, undo keeps the element's own text`, async ({ browser }) => {
      const t = await open(browser, file);
      try {
        const pad = async (elementId, action) => {
          await t.page.mouse.click(1500, 80);
          await shapeOf(t.page, elementId).click();
          await expect(t.page.locator('.djs-context-pad.open')).toBeVisible();
          await t.page.locator(`.djs-context-pad.open .entry[data-action="${action}"]`).click();
        };
        let count = 0;
        await replaceWith(t.page, id, 'replace-with-service-task');
        await saved(t.page, t.cli, t.fixture.file, count);
        count = writes(t.cli).length;
        await pad(id, 'connect');
        const target = await shapeOf(t.page, other).boundingBox();
        await t.page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
        await t.page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
        const connected = await saved(t.page, t.cli, t.fixture.file, count);
        expect(load(connected).ids.get(id).children.filter((c) => c.kind === 'element' && c.local === 'outgoing').length).toBeGreaterThanOrEqual(2);
        count = writes(t.cli).length;
        await pad(id, 'delete');
        await saved(t.page, t.cli, t.fixture.file, count);
        count = writes(t.cli).length;
        await t.page.mouse.click(1500, 80);
        await t.page.keyboard.press('ControlOrMeta+z');
        const now = await saved(t.page, t.cli, t.fixture.file, count);
        expectMinimalWrites(t.cli);
        expect(t.cli.stderr()).not.toMatch(/bpmn-edit: (note|warning):/);
        expect(keptFacts(now)).toEqual(keptFacts(connected));
        // The same model as before the delete (bpmn-js may re-order the references to its flows).
        const refs = (key) => /\}(incoming|outgoing)\[\d+\]\u0000$/.test(key);
        expect(factChanges(connected, now, refs)).toEqual([]);
        expect(await changedLines(t.fixture.dir, connected, now)).toBeLessThanOrEqual(2);
      } finally {
        await t.close();
      }
    });
  }

  // Verifier Q4-impl final round, D1: delete + undo fell back to 'format' and dropped the element's
  // comment, PI, CDATA and kept extensions without a note: a task appended to it lost its only
  // references with the delete and got two back ("overlapping changes"), or the restored edges were
  // each other's remembered neighbour and none was written (camunda7-loan-approval: check failed).
  for (const [file, id, wrench, connect] of [
    ['comments-nonascii.bpmn', 'Task_CheckStock', false, 'to'],
    ['comments-nonascii.bpmn', 'Task_CheckStock', true, 'back'],
    ['camunda7-loan-approval.bpmn', 'UserTask_1', true, null],
    ['camunda7-loan-approval.bpmn', 'UserTask_1', false, null],
  ]) {
    test(`${file}: append${wrench ? ', wrench' : ''}${connect ? `, connect ${connect}` : ''}, delete, undo: minimal, the element's own text back`, async ({ browser }) => {
      const t = await open(browser, file);
      try {
        const pad = async (elementId, action) => {
          await t.page.mouse.click(1500, 80);
          await shapeOf(t.page, elementId).click();
          await expect(t.page.locator('.djs-context-pad.open')).toBeVisible();
          await t.page.locator(`.djs-context-pad.open .entry[data-action="${action}"]`).click();
        };
        const ids = () => t.page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll().map((e) => e.id));
        const before = await ids();
        let count = 0;
        await pad(id, 'append.append-task');
        await t.page.keyboard.press('Escape');
        await saved(t.page, t.cli, t.fixture.file, count);
        const appended = (await ids()).find((x) => !before.includes(x) && x.startsWith('Activity_') && !x.endsWith('_label'));
        expect(appended).toBeTruthy();
        if (wrench) {
          count = writes(t.cli).length;
          await t.page.mouse.click(1500, 80);
          await replaceWith(t.page, id, 'replace-with-service-task');
          await saved(t.page, t.cli, t.fixture.file, count);
        }
        if (connect) {
          count = writes(t.cli).length;
          const [from, to] = connect === 'to' ? [id, appended] : [appended, id];
          await pad(from, 'connect');
          const target = await shapeOf(t.page, to).boundingBox();
          await t.page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
          await t.page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
          await saved(t.page, t.cli, t.fixture.file, count);
        }
        const beforeDelete = await readFile(t.fixture.file, 'utf8');
        count = writes(t.cli).length;
        await pad(id, 'delete');
        await saved(t.page, t.cli, t.fixture.file, count);
        count = writes(t.cli).length;
        await t.page.mouse.click(1500, 80);
        await t.page.keyboard.press('ControlOrMeta+z');
        const now = await saved(t.page, t.cli, t.fixture.file, count);
        expectMinimalWrites(t.cli);
        expect(t.cli.stderr()).not.toMatch(/bpmn-edit: (note|warning):/);
        expect(keptFacts(now)).toEqual(keptFacts(t.original));
        // The model before the delete, extensions included; bpmn-js may re-order references to the
        // flows and drops sourceElement / targetElement of the edges it restores (known limits).
        const allowed = (key) => /\}(incoming|outgoing)\[\d+\]\u0000$/.test(key) || /\u0000\{\}(sourceElement|targetElement)$/.test(key);
        expect(factChanges(beforeDelete, now, allowed)).toEqual([]);
        expect(await changedLines(t.fixture.dir, beforeDelete, now)).toBeLessThanOrEqual(6);
      } finally {
        await t.close();
      }
    });
  }

  // Verifier Q4-impl final round, D2: expanding a collapsed sub-process (the wrench, or undo of the
  // collapse) fell back to 'format' ("moved together with its parent", 75-970 lines, kept extensions of
  // a wrenched task in it dropped): its shapes move out of the diagram bpmn-js made for it.
  test('comments-nonascii: a wrenched task in a new sub-process, collapse, expand, undo, undo: minimal, nothing lost', async ({ browser }) => {
    test.slow();
    const t = await open(browser, 'comments-nonascii.bpmn');
    try {
      const undo = async () => {
        await t.page.mouse.click(1500, 80);
        await t.page.keyboard.press('ControlOrMeta+z');
      };
      await replaceWith(t.page, 'Task_CheckStock', 'replace-with-service-task');
      const wrenched = await saved(t.page, t.cli, t.fixture.file, 0);
      let count = writes(t.cli).length;
      await t.page.mouse.click(1500, 80);
      const sub = await createSubProcess(t.page);
      await saved(t.page, t.cli, t.fixture.file, count);
      count = writes(t.cli).length;
      await dragInto(t.page, 'Task_CheckStock', sub);
      const inside = await saved(t.page, t.cli, t.fixture.file, count);
      expect(load(inside).ids.get('Task_CheckStock').parent.path).toBe(`#${sub}`);
      const texts = [];
      for (const step of ['replace-with-collapsed-subprocess', 'replace-with-expanded-subprocess', 'undo', 'undo']) {
        count = writes(t.cli).length;
        if (step === 'undo') await undo();
        else {
          // The sub-process by its border (its middle may be the task in it).
          await t.page.mouse.click(1500, 80);
          await shapeOf(t.page, sub).click({ position: { x: 4, y: 4 } });
          await t.page.locator('.djs-context-pad.open .entry[data-action="replace"]').click();
          await t.page.locator(`.djs-popup [data-id="${step}"]`).click();
        }
        texts.push(await saved(t.page, t.cli, t.fixture.file, count));
      }
      const [collapsed, expanded, undone, undone2] = texts;
      expect(load(collapsed).ids.has(sub)).toBe(true);
      expect(undone).toBe(collapsed); // undo of the expand: collapsed as before
      for (const now of texts) {
        expect(keptFacts(now)).toEqual(keptFacts(t.original));
        // The task keeps the extensions bpmn-js dropped on the wrench.
        expect(now).toContain('acme:sla="PT2H"');
        expect(now).toContain('<acme:note>Façade call – keep idempotent</acme:note>');
      }
      expectMinimalWrites(t.cli);
      expect(t.cli.stderr()).not.toMatch(/bpmn-edit: (note|warning):/);
      // Expanded again: the sub-process' size and its shapes' places (bpmn-js lays them out anew).
      expect(await changedLines(t.fixture.dir, collapsed, expanded)).toBeLessThanOrEqual(30);
      // Back to before the collapse, up to where the task's shape is in the plane.
      expect(await changedLines(t.fixture.dir, inside, undone2)).toBeLessThanOrEqual(6);
      expect(factChanges(wrenched, undone2, () => false).every((c) => !/acme|comment|pi |cdata/.test(c))).toBe(true);
    } finally {
      await t.close();
    }
  });
});
