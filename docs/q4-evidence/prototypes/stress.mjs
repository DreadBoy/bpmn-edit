// Stress test for the minimal-diff writer prototype with structural edits made through the bpmn-js
// modeling API (append, delete, replace type, colour, annotation, move into another position),
// one after another, on every corpus file. Records bpmn-js output after each step, chains the
// writer, and checks the 3-way verification.
import { chromium } from '../../../node_modules/@playwright/test/index.mjs';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCli } from '../../../test/e2e/helpers/cli.js';
import { minimalDiff, Fallback, editMismatches, preserveHeaderAndStyle } from './writers.mjs';
import { numstat, unifiedDiff } from '../../../scripts/q4-xml.mjs';

const WT = new URL('../../../', import.meta.url).pathname;
const FIX = join(WT, 'test/fixtures/q4');
const OUT = join(WT, 'docs/q4-evidence/options-stress');
const WORK = join(process.env.TMPDIR || '/tmp', 'local-bpmn-q4-stress');
const TARGETS = JSON.parse(readFileSync(join(WT, 'docs/q4-evidence/runs.json'), 'utf8'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const STEPS = {
  append: ({ a }) => {
    const m = window.bpmnModeler; const reg = m.get('elementRegistry');
    const src = reg.get(a);
    m.get('modeling').appendShape(src, { type: 'bpmn:Task' }, { x: src.x + src.width / 2 + 60, y: src.y + src.height + 120 });
  },
  color: ({ a }) => {
    const m = window.bpmnModeler;
    m.get('modeling').setColor([m.get('elementRegistry').get(a)], { fill: '#bbdefb', stroke: '#0d4372' });
  },
  annotate: ({ a }) => {
    const m = window.bpmnModeler; const reg = m.get('elementRegistry');
    const src = reg.get(a);
    const ann = m.get('elementFactory').createShape({ type: 'bpmn:TextAnnotation' });
    m.get('modeling').createShape(ann, { x: src.x + 50, y: src.y - 80 }, src.parent);
    m.get('modeling').updateProperties(ann, { text: 'Note – Änderung' });
    m.get('modeling').connect(src, ann);
  },
  replace: ({ b }) => {
    const m = window.bpmnModeler;
    m.get('bpmnReplace').replaceElement(m.get('elementRegistry').get(b), { type: 'bpmn:UserTask' });
  },
  delete: ({ a }) => {
    const m = window.bpmnModeler;
    m.get('modeling').removeElements([m.get('elementRegistry').get(a)]);
  },
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const summary = [];
try {
  for (const name of readdirSync(FIX).filter((f) => f.endsWith('.bpmn')).sort()) {
    const run = TARGETS.find((r) => r.fixture === name);
    const dir = join(WORK, name.replace(/\.bpmn$/, ''));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    copyFileSync(join(FIX, name), file);
    const cli = await startCli(file, { cwd: dir });
    const page = await browser.newPage();
    const row = { fixture: name, steps: [] };
    try {
      await page.goto(cli.url);
      await page.locator('.djs-element.djs-shape').first().waitFor({ timeout: 15000 });
      const save = () => page.evaluate(async () => (await window.bpmnModeler.saveXML({ format: true })).xml);
      let base = await save();
      let disk = readFileSync(join(FIX, name), 'utf8');
      const outDir = join(OUT, name.replace(/\.bpmn$/, ''));
      mkdirSync(outDir, { recursive: true });
      for (const [step, fn] of Object.entries(STEPS)) {
        let error = null;
        try {
          await page.evaluate(fn, { a: run.taskA, b: run.taskB === run.taskA ? run.taskA : run.taskB });
        } catch (err) { error = err.message.split('\n')[0]; }
        const out = await save();
        let candidate; let fallback = null;
        try {
          candidate = minimalDiff(disk, base, out);
        } catch (err) {
          if (!(err instanceof Fallback)) throw err;
          fallback = err.message;
          candidate = preserveHeaderAndStyle(disk, base, out);
        }
        const mism = editMismatches(disk, base, out, candidate).length;
        const entry = {
          step, error, fallback, editMismatches: mism,
          minimalDiffLines: numstat(disk, candidate).total,
          bpmnJsDiffLines: numstat(base, out).total,
        };
        row.steps.push(entry);
        writeFileSync(join(outDir, `${step}.diff`), unifiedDiff(disk, candidate, 'before', 'after'));
        disk = candidate;
        base = out;
      }
    } finally {
      await page.close();
      await cli.stop();
    }
    summary.push(row);
    console.log(name.padEnd(28), row.steps.map((s) => `${s.step}:${s.minimalDiffLines}/${s.bpmnJsDiffLines}${s.fallback ? ' FB' : ''}${s.editMismatches ? ` MM${s.editMismatches}` : ''}${s.error ? ' ERR' : ''}`).join('  '));
  }
} finally {
  await browser.close();
}
writeFileSync(join(WT, 'docs/q4-evidence/options-stress.json'), JSON.stringify({
  note: 'Structural edits through the bpmn-js modeling API, applied in sequence. minimalDiffLines = diff lines written by '
    + 'the minimal-diff prototype; bpmnJsDiffLines = diff lines between consecutive bpmn-js serialisations (steady state, '
    + 'i.e. after the one-off normalisation); fallback = the prototype gave up and option (b) output was written; '
    + 'editMismatches must be 0.',
  results: summary,
}, null, 2) + '\n');
