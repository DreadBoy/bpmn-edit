// Q4 experiment, step 2 of 2: computes the numbers in docs/q4-evidence/results.json from the files
// captured by q4-churn-measure.mjs. Pure Node, no browser.
//
// Definitions (per save):
//   total        lines changed in `git diff` (added + deleted) between the previous and the saved file
//   edit         lines changed by the ideal edit: the previous file with only the renamed task's
//                name="..." value replaced in place (scripts/q4-xml.mjs idealRename)
//   churn        lines changed between that ideal file and the saved file (= everything unrelated
//                to the edit); churnIgnoringWhitespace is the same with `git diff -w`
//   semantic     unintended differences at the XML level (facts compare, see q4-xml.mjs), by category
//   formatting   formatting-level differences (counts of affected items)
//
//   node scripts/q4-churn-analyse.mjs
import { BpmnModdle } from 'bpmn-moddle';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formattingChanges, idealRename, numstat, semanticChanges } from './q4-xml.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const EVIDENCE = join(ROOT, 'docs', 'q4-evidence');

function summarise(changes) {
  const byCategory = {};
  for (const c of changes) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  return byCategory;
}

/** Measures one save: `prev` -> `actual`, where `ideal` is `prev` with only the intended edit. */
export function measureSave(prev, ideal, actual) {
  const total = numstat(prev, actual);
  const edit = numstat(prev, ideal);
  const churn = numstat(ideal, actual);
  const semantic = semanticChanges(ideal, actual);
  return {
    totalLines: total.total,
    totalAdded: total.added,
    totalDeleted: total.deleted,
    totalLinesIgnoringWhitespace: numstat(prev, actual, { ignoreSpace: true }).total,
    editLines: edit.total,
    churnLines: churn.total,
    churnLinesIgnoringWhitespace: numstat(ideal, actual, { ignoreSpace: true }).total,
    semanticByCategory: summarise(semantic),
    informationLoss: semantic.filter((c) => c.loss),
    formatting: formattingChanges(ideal, actual),
    semantic,
  };
}

async function importWarnings(xml) {
  const { warnings } = await new BpmnModdle().fromXML(xml);
  return warnings.map((w) => w.message.split('\n')[0]);
}

async function main() {
  const env = JSON.parse(readFileSync(join(EVIDENCE, 'environment.json'), 'utf8'));
  const fixtures = readdirSync(EVIDENCE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(EVIDENCE, d.name, 'run.json'))).map((d) => d.name).sort();
  const results = [];
  for (const name of fixtures) {
    const dir = join(EVIDENCE, name);
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    if (!run.ok) { results.push({ fixture: run.fixture, ok: false, error: run.error }); continue; }
    const read = (f) => readFileSync(join(dir, f), 'utf8');
    const original = read('0-original.bpmn');
    const save1 = read('1-save1.bpmn');
    const save2 = read('2-save2.bpmn');
    const save3 = read('3-save3-move.bpmn');
    const ideal1 = idealRename(original, run.taskA, run.name1);
    const ideal2 = idealRename(save1, run.taskB, run.name2);
    writeFileSync(join(dir, 'ideal1.bpmn'), ideal1);
    writeFileSync(join(dir, 'ideal2.bpmn'), ideal2);
    const first = measureSave(original, ideal1, save1);
    const second = measureSave(save1, ideal2, save2);
    const third = {
      totalLines: numstat(save2, save3).total,
      formatting: formattingChanges(save2, save3),
      changedFacts: semanticChanges(save2, save3).map((c) => c.key),
    };
    // Cross-check against the recorded git numstat of the real repo.
    const recorded = (f) => read(f).trim().split('\t').slice(0, 2).map(Number).reduce((a, b) => a + b, 0);
    if (recorded('first.numstat') !== first.totalLines || recorded('second.numstat') !== second.totalLines) {
      throw new Error(`${name}: recomputed totals differ from recorded git numstat`);
    }
    results.push({
      fixture: run.fixture,
      ok: true,
      taskA: run.taskA,
      taskB: run.taskB,
      originalLines: original.split('\n').length - (original.endsWith('\n') ? 1 : 0),
      importWarnings: await importWarnings(original),
      first,
      second,
      third,
    });
    console.log(`${name.padEnd(24)} save1 total ${String(first.totalLines).padStart(4)} edit ${first.editLines} churn ${String(first.churnLines).padStart(4)} (-w ${String(first.churnLinesIgnoringWhitespace).padStart(4)}) loss ${first.informationLoss.length} | save2 total ${second.totalLines} churn ${second.churnLines} | move ${third.totalLines}`);
  }
  writeFileSync(join(EVIDENCE, 'results.json'), JSON.stringify({ environment: env, definitions: {
    totalLines: 'added+deleted lines of git diff previous -> saved file',
    editLines: 'added+deleted lines of the ideal edit (only name="..." of the renamed task replaced in place)',
    churnLines: 'added+deleted lines between the ideal edit and the saved file (unrelated to the edit)',
    churnLinesIgnoringWhitespace: 'the same with git diff -w',
  }, results }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
