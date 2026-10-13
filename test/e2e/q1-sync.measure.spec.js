// Q1 measurements: full-XML sync with 2 and 3 windows on the small fixture and a large generated
// diagram. Not part of the regular suite (see playwright.config.js); run with
//
//   LOCAL_BPMN_MEASURE=1 LOCAL_BPMN_MEASURE_OUT=/some/dir npx playwright test q1-sync.measure
//
// Every edit is made with the real mouse/keyboard; state is only read via page.evaluate. Results are
// printed and, with LOCAL_BPMN_MEASURE_OUT, written as JSON (one file per configuration).
import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateLargeBpmn } from '../../scripts/gen-large-bpmn.js';
import { collectPageErrors, copyFixture, startCli } from './helpers/cli.js';
import { emptyCanvasPoint, shape, status } from './helpers/editor.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TRIALS = Number(process.env.LOCAL_BPMN_MEASURE_TRIALS || 1);

test.use({ actionTimeout: 10_000 });

const DIAGRAMS = {
  small: {
    ready: 'Task_CheckStock',
    // Elements that can be moved / renamed independently.
    elements: ['Task_CheckStock', 'Task_ShipOrder', 'Task_CancelOrder', 'Gateway_InStock', 'EndEvent_OrderShipped', 'EndEvent_OrderCancelled'],
    dragPx: 40,
  },
  large: {
    ready: 'Task_0_1',
    // Rows 0 and 15 are left out: dragged up/down they can slide under the toolbar.
    elements: Array.from({ length: 14 }, (_, i) => [1, 2, 4, 6, 8].map((col) => `Task_${i + 1}_${col}`)).flat(),
    dragPx: 25,
  },
};

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

for (const diagram of ['small', 'large']) {
  for (const n of [2, 3]) {
    test(`measure ${diagram} diagram with ${n} windows`, async ({ browser }) => {
      test.setTimeout(900_000);
      const spec = DIAGRAMS[diagram];
      const fixture = await copyFixture('order.bpmn');
      if (diagram === 'large') await writeFile(fixture.file, generateLargeBpmn());
      const fileBytes = (await readFile(fixture.file)).length;
      const cli = await startCli(fixture.file, { cwd: fixture.dir });
      const windows = [];
      const result = { diagram, windows: n, fileBytes };
      try {
        for (let i = 0; i < n; i++) windows.push(await openWindow(browser, cli.url, spec.ready));
        const disk = () => readFile(fixture.file, 'utf8');
        const pristine = await disk();
        // Puts the original diagram back (as a change on disk, shown in every window): after many
        // random moves, flows end up on top of the shapes the next trial clicks.
        const reset = async () => {
          await writeFile(fixture.file, pristine);
          for (const w of windows) {
            await expect.poll(() => w.page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll().length), { timeout: 5000 })
              .toBeGreaterThan(5);
          }
          await settle();
          await expect.poll(async () => (await position(windows[0].page, spec.elements[0]))?.y, { timeout: 5000 })
            .toBe(diskPosition(pristine, spec.elements[0]).y);
          direction.clear();
        };
        const settle = () => settleAll(windows);

        // --- Latency and payload: one window moves an element, the others watch for it. ---------
        const latencies = [];
        const sentBytes = [];
        const receivedBytes = [];
        let noOpDrags = 0;
        let notSeen = 0;
        let elementIndex = 0;
        const direction = new Map();
        const nextElement = () => spec.elements[elementIndex++ % spec.elements.length];
        const dyFor = (id) => {
          const d = direction.get(id) ?? 1;
          direction.set(id, -d);
          return d * spec.dragPx;
        };
        for (let t = 0; t < 20 * TRIALS; t++) {
          const sender = windows[t % n];
          const receivers = windows.filter((w) => w !== sender);
          const id = nextElement();
          await Promise.all(receivers.map((w) => armWatch(w.page, id)));
          for (const w of windows) w.frames.length = 0;
          await armRelease(sender.page);
          const before = await position(sender.page, id);
          await dragBy(sender.page, id, dyFor(id));
          const releasedAt = await sender.page.evaluate(() => window.__releasedAt);
          if (samePosition(before, await position(sender.page, id))) {
            noOpDrags += 1; // the drag did not move the element (nothing to sync)
            await settle();
            continue;
          }
          for (const w of receivers) {
            try {
              await expect.poll(() => w.page.evaluate(() => window.__seenAt), { timeout: 5000 }).not.toBeNull();
              latencies.push((await w.page.evaluate(() => window.__seenAt)) - releasedAt);
            } catch {
              notSeen += 1;
            }
          }
          await settle();
          sentBytes.push(...sender.frames.filter((f) => f.dir === 'sent' && f.type === 'update').map((f) => f.bytes));
          for (const w of receivers) {
            receivedBytes.push(...w.frames.filter((f) => f.dir === 'received' && f.type === 'remote-update').map((f) => f.bytes));
          }
        }
        Object.assign(result, {
          latencyMs: { n: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100) },
          sentBytesPerEdit: percentile(sentBytes, 50),
          receivedBytesPerEdit: percentile(receivedBytes, 50),
          updatesSentPerEdit: sentBytes.length / (20 * TRIALS - noOpDrags),
          noOpDrags,
          notSeen,
        });

        // --- Lost edits: every window edits a different element, released together or within 500 ms.
        const lost = { simultaneousMoves: [0, 0], staggeredMoves: [0, 0], labelAndMoves: [0, 0], disagreements: 0, falseNotices: 0 };
        for (const mode of ['simultaneousMoves', 'staggeredMoves', 'labelAndMoves']) {
          for (let t = 0; t < 10 * TRIALS; t++) {
            const ids = windows.map(() => nextElement());
            const expected = {};
            const releases = [];
            for (let i = 0; i < n; i++) {
              const { page } = windows[i];
              if (mode === 'labelAndMoves' && i === 0) {
                const text = `L${t}-${Math.random().toString(36).slice(2, 6)}`;
                await shape(page, ids[i]).dblclick();
                await expect(page.locator('.djs-direct-editing-parent')).toBeVisible();
                await page.keyboard.press('ControlOrMeta+a');
                await page.keyboard.type(text);
                expected[ids[i]] = { name: text };
                const p = await emptyCanvasPoint(page);
                releases.push(() => page.mouse.click(p.x, p.y));
              } else {
                await dragHold(page, ids[i], dyFor(ids[i]));
                releases.push(() => page.mouse.up());
              }
            }
            const offsets = windows.map((_, i) => (mode === 'staggeredMoves' && i > 0 ? Math.round(Math.random() * 500) : 0));
            await Promise.all(releases.map((release, i) => delay(offsets[i]).then(release)));
            for (let i = 0; i < n; i++) {
              if (!expected[ids[i]]) expected[ids[i]] = await position(windows[i].page, ids[i]);
            }
            await settle();
            const { lostEdits, disagree } = await check(windows, await disk(), expected);
            // Different elements: any notice about a dropped or conflicting edit is a false one.
            for (const { page } of windows) {
              if (await page.locator('#toast:not([hidden])').count()) {
                lost.falseNotices += 1;
                await page.evaluate(() => { document.getElementById('toast').hidden = true; });
              }
            }
            lost[mode][0] += lostEdits;
            lost[mode][1] += n;
            lost.disagreements += disagree ? 1 : 0;
          }
        }
        result.lostEdits = lost;

        // --- Rapid back-and-forth: alternating edits about 100 ms apart in two windows. ----------
        const rapid = [0, 0];
        for (let t = 0; t < 5 * TRIALS; t++) {
          const expected = {};
          for (let k = 0; k < 6; k++) {
            const w = windows[k % 2];
            const id = nextElement();
            await dragBy(w.page, id, dyFor(id));
            expected[id] = await position(w.page, id);
            await delay(100);
          }
          await settle();
          const { lostEdits } = await check(windows, await disk(), expected);
          rapid[0] += lostEdits;
          rapid[1] += 6;
        }
        result.rapidLost = rapid;

        // --- Delete vs edit: B renames X while A moves Y and then deletes X. --------------------
        const deleteVsEdit = { resurrected: 0, otherEditLost: 0, trials: 0, noticeShown: 0 };
        for (let t = 0; t < 3 * TRIALS; t++) {
          await reset();
          const [a, b] = windows;
          const x = nextElement();
          const y = nextElement();
          await shape(b.page, x).dblclick();
          await expect(b.page.locator('.djs-direct-editing-parent')).toBeVisible();
          await b.page.keyboard.press('ControlOrMeta+a');
          await b.page.keyboard.type(`Renamed ${t}`);
          await dragBy(a.page, y, dyFor(y));
          const yPos = await position(a.page, y);
          await shape(a.page, x).click();
          await a.page.keyboard.press('Delete');
          await expect(shape(a.page, x)).toHaveCount(0);
          await delay(800);
          const p = await emptyCanvasPoint(b.page);
          await b.page.mouse.click(p.x, p.y);
          await settle();
          const xml = await disk();
          deleteVsEdit.trials += 1;
          if (xml.includes(`id="${x}"`)) deleteVsEdit.resurrected += 1;
          if (!samePosition(diskPosition(xml, y), yPos)) deleteVsEdit.otherEditLost += 1;
          if (await b.page.locator('#toast').isVisible().catch(() => false)) deleteVsEdit.noticeShown += 1;
        }
        result.deleteVsEdit = deleteVsEdit;

        // --- Receiver UX: viewport, selection, in-progress drag and label edit. -----------------
        const ux = { viewportJumps: 0, selectionLost: 0, dragInterrupted: 0, labelInterrupted: 0, trials: 0 };
        for (let t = 0; t < 3 * TRIALS; t++) {
          await reset();
          const [a, b] = windows;
          ux.trials += 1;
          // Viewport + selection.
          const sel = nextElement();
          await shape(b.page, sel).click();
          const box = await b.page.locator('#canvas').boundingBox();
          await b.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await b.page.mouse.wheel(0, 60);
          await delay(100);
          const view = await viewbox(b.page);
          let id = nextElement();
          await armWatch(b.page, id);
          await dragBy(a.page, id, dyFor(id));
          await expect.poll(() => b.page.evaluate(() => window.__seenAt), { timeout: 5000 }).not.toBeNull().catch(() => {
            ux.notSeen = (ux.notSeen ?? 0) + 1;
          });
          await settle();
          const after = await viewbox(b.page);
          if (['x', 'y', 'width', 'height'].some((k) => Math.abs(after[k] - view[k]) > 1)) ux.viewportJumps += 1;
          const selected = await b.page.evaluate(() => window.bpmnModeler.get('selection').get().map((e) => e.id));
          if (!selected.includes(sel)) ux.selectionLost += 1;

          // Drag in progress in B while A edits.
          const dragged = nextElement();
          const dy = dyFor(dragged);
          await dragHold(b.page, dragged, dy);
          id = nextElement();
          await dragBy(a.page, id, dyFor(id));
          await delay(900);
          const stillDragging = await b.page.evaluate(() => Boolean(window.bpmnModeler.get('dragging').context()));
          await b.page.mouse.up();
          const draggedPos = await position(b.page, dragged);
          await settle();
          if (!stillDragging || !samePosition(diskPosition(await disk(), dragged), draggedPos)) ux.dragInterrupted += 1;

          // Label editor open in B while A edits.
          const labelled = nextElement();
          await shape(b.page, labelled).dblclick();
          await b.page.keyboard.press('ControlOrMeta+a');
          await b.page.keyboard.type(`Typing ${t}`);
          id = nextElement();
          await dragBy(a.page, id, dyFor(id));
          await delay(900);
          const editorOpen = await b.page.locator('.djs-direct-editing-parent').isVisible();
          const editorText = editorOpen ? await b.page.locator('.djs-direct-editing-parent').innerText() : '';
          const p = await emptyCanvasPoint(b.page);
          await b.page.mouse.click(p.x, p.y);
          await settle();
          if (!editorOpen || editorText !== `Typing ${t}` || diskName(await disk(), labelled) !== `Typing ${t}`) ux.labelInterrupted += 1;
        }
        result.ux = ux;
        result.pageErrors = windows.flatMap((w) => w.errors);
        result.stuckDeferred = stuck.count;
        stuck.count = 0;
      } finally {
        for (const w of windows) await w.context.close();
        await cli.stop();
        await fixture.cleanup();
      }
      console.log(JSON.stringify(result));
      if (process.env.LOCAL_BPMN_MEASURE_OUT) {
        await mkdir(process.env.LOCAL_BPMN_MEASURE_OUT, { recursive: true });
        await writeFile(join(process.env.LOCAL_BPMN_MEASURE_OUT, `${diagram}-${n}.json`), JSON.stringify(result, null, 2));
      }
    });
  }
}

async function openWindow(browser, url, readyId) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const win = { page, context, errors: collectPageErrors(page), frames: [] };
  page.on('websocket', (ws) => {
    const record = (dir) => ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      let type = '(unparsable)';
      try { ({ type } = JSON.parse(text)); } catch { /* keep */ }
      win.frames.push({ dir, type, bytes: Buffer.byteLength(text) });
    };
    ws.on('framesent', record('sent'));
    ws.on('framereceived', record('received'));
  });
  await page.goto(url);
  await expect(shape(page, readyId)).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-state', 'saved');
  return win;
}

const stuck = { count: 0 };

/** Waits until every window is saved, has nothing held back, and stays so. */
async function settleAll(windows) {
  for (let round = 0; round < 2; round++) {
    for (const { page } of windows) {
      await expect(status(page)).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
      await expect(page.locator('#notice[data-kind="deferred"]')).toHaveCount(0, { timeout: 10_000 }).catch(() => {
        stuck.count += 1; // a held-back update that is never shown (counted, the run goes on)
      });
    }
    await delay(700);
  }
}

/** Records when `id` is drawn somewhere else than now (window.__seenAt, epoch ms with fractions). */
function armWatch(page, id) {
  return page.evaluate((elementId) => {
    const find = () => document.querySelector(`#canvas .djs-element[data-element-id="${elementId}"]`);
    const initial = find()?.getAttribute('transform');
    window.__seenAt = null;
    const observer = new MutationObserver(() => {
      const transform = find()?.getAttribute('transform');
      if (transform && transform !== initial) {
        window.__seenAt = performance.timeOrigin + performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.getElementById('canvas'), { subtree: true, childList: true, attributes: true, attributeFilter: ['transform'] });
  }, id);
}

/** Records the time of the next pointer release (window.__releasedAt). */
function armRelease(page) {
  return page.evaluate(() => {
    window.__releasedAt = null;
    window.addEventListener('pointerup', () => { window.__releasedAt = performance.timeOrigin + performance.now(); }, { capture: true, once: true });
  });
}

async function dragHold(page, id, dy) {
  const box = await shape(page, id).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x, from.y + dy, { steps: 4 });
}

async function dragBy(page, id, dy) {
  await dragHold(page, id, dy);
  await page.mouse.up();
}

function position(page, id) {
  return page.evaluate((elementId) => {
    const e = window.bpmnModeler.get('elementRegistry').get(elementId);
    return e ? { x: e.x, y: e.y } : null;
  }, id);
}

function viewbox(page) {
  return page.evaluate(() => {
    const { x, y, width, height } = window.bpmnModeler.get('canvas').viewbox();
    return { x, y, width, height };
  });
}

function samePosition(p, q) {
  return Boolean(p && q && p.x === q.x && p.y === q.y);
}

function diskPosition(xml, id) {
  const match = new RegExp(`bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="([\\d.-]+)" y="([\\d.-]+)"`).exec(xml);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

function diskName(xml, id) {
  const match = new RegExp(`id="${id}" name="([^"]*)"`).exec(xml);
  return match ? match[1] : null;
}

/** Counts edits missing on disk, and whether any window differs from disk for the edited elements. */
async function check(windows, xml, expected) {
  let lostEdits = 0;
  let disagree = false;
  for (const [id, want] of Object.entries(expected)) {
    const ok = want.name !== undefined ? diskName(xml, id) === want.name : samePosition(diskPosition(xml, id), want);
    if (!ok) lostEdits += 1;
    for (const { page } of windows) {
      const state = await page.evaluate((elementId) => {
        const e = window.bpmnModeler.get('elementRegistry').get(elementId);
        return e ? { x: e.x, y: e.y, name: e.businessObject.name } : null;
      }, id);
      const diskState = { ...diskPosition(xml, id), name: diskName(xml, id) };
      if (!state || state.x !== diskState.x || state.y !== diskState.y || (state.name ?? null) !== diskState.name) disagree = true;
    }
  }
  return { lostEdits, disagree };
}
