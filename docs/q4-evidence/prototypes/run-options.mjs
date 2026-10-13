// Applies the option prototypes to the saves captured in docs/q4-evidence/<fixture>/ and writes
// docs/q4-evidence/options/<fixture>/<option>-save{1,2,3}.bpmn (+ .diff) and docs/q4-evidence/options.json.
import { BpmnModdle } from '../../../node_modules/bpmn-moddle/dist/index.js';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { measureSave } from '../../../scripts/q4-churn-analyse.mjs';
import { idealRename, numstat, unifiedDiff } from '../../../scripts/q4-xml.mjs';
import { accept, editMismatches, minimalDiffOrFallback, modelDifferences, preserveHeaderAndStyle, xmllintFormat } from './writers.mjs';

const EVIDENCE = new URL('../', import.meta.url).pathname;
const OUT = join(EVIDENCE, 'options');
rmSync(OUT, { recursive: true, force: true });

const OPTIONS = {
  'a-accept': { writer: accept },
  'b-preserve-header-style': { writer: preserveHeaderAndStyle },
  'c-minimal-diff': { writer: minimalDiffOrFallback },
  // (c') the same, but the server computes the first base itself with bpmn-moddle in Node (no
  // baseline message from the browser); bpmn-js import changes then land in the first save.
  'c2-minimal-diff-node-base': { writer: minimalDiffOrFallback, base: (f) => f.nodeBase },
  // (d1) normalise once: the first bpmn-js serialisation is committed on its own ("normalise
  // formatting"); measured from that commit on. Writer = accept.
  'd1-normalise-once': { writer: accept, start: (f) => f.baseline },
  // (d2) xmllint --format as the repository's canonical style, applied to every save.
  'd2-xmllint-both-sides': { writer: (disk, base, out) => xmllintFormat(out), start: (f) => xmllintFormat(f.original) },
};

const summary = [];
for (const name of readdirSync(EVIDENCE).filter((d) => existsSync(join(EVIDENCE, d, 'run.json'))).sort()) {
  const dir = join(EVIDENCE, name);
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  if (!run.ok) continue;
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  const f = {
    original: read('0-original.bpmn'), baseline: read('0b-bpmnjs-baseline.bpmn'),
    save1: read('1-save1.bpmn'), save2: read('2-save2.bpmn'), save3: read('3-save3-move.bpmn'),
  };
  const row = { fixture: run.fixture, options: {} };
  f.nodeBase = (await new BpmnModdle().toXML((await new BpmnModdle().fromXML(f.original)).rootElement, { format: true })).xml;
  for (const [opt, { writer, start, base: base0 }] of Object.entries(OPTIONS)) {
    const outDir = join(OUT, name);
    mkdirSync(outDir, { recursive: true });
    const stats = [{}, {}, {}];
    const disk0 = start ? start(f) : f.original;
    const c1 = writer(disk0, base0 ? base0(f) : f.baseline, f.save1, stats[0]);
    const c2 = writer(c1, f.save1, f.save2, stats[1]);
    const c3 = writer(c2, f.save2, f.save3, stats[2]);
    const ideal1 = idealRename(disk0, run.taskA, run.name1);
    const ideal2 = idealRename(c1, run.taskB, run.name2);
    const m1 = measureSave(disk0, ideal1, c1);
    const m2 = measureSave(c1, ideal2, c2);
    // Unintended changes vs the ORIGINAL file (not vs the normalised start of d1/d2): information loss.
    const lossVsOriginal = measureSave(f.original, idealRename(f.original, run.taskA, run.name1), c1).informationLoss;
    const files = [[c1, disk0, 'save1'], [c2, c1, 'save2'], [c3, c2, 'save3']];
    for (const [text, prev, label] of files) {
      writeFileSync(join(outDir, `${opt}-${label}.diff`), unifiedDiff(prev, text, 'before', 'after'));
    }
    row.options[opt] = {
      save1: {
        totalLines: m1.totalLines, editLines: m1.editLines, churnLines: m1.churnLines,
        sideEffectBpmnLabel: m1.semanticByCategory['edit side effect: BPMNLabel element added'] ?? 0,
        semanticByCategory: m1.semanticByCategory,
      },
      save2: { totalLines: m2.totalLines, editLines: m2.editLines, churnLines: m2.churnLines },
      save3MoveTotalLines: numstat(c2, c3).total,
      informationLossVsOriginal: lossVsOriginal.map((l) => l.category),
      // 3-way check: changes disk -> written file == changes bpmn-js made (base -> out). Must be 0.
      editMismatches: [[disk0, f.baseline, f.save1, c1], [c1, f.save1, f.save2, c2], [c2, f.save2, f.save3, c3]]
        .map(([d, b, o, c]) => editMismatches(d, b, o, c).length),
      // Model-level differences between the written file and bpmn-js' own output (content the
      // writer kept that bpmn-js dropped or rewrote on import, e.g. comments, DI migration).
      differencesFromBpmnJsOutput: [c1, c2, c3].map((c, k) => modelDifferences(c, [f.save1, f.save2, f.save3][k]).length),
      fallbacks: stats.map((s) => s.fallback ?? null),
    };
  }
  summary.push(row);
  console.log(name.padEnd(24), Object.entries(row.options).map(([k, v]) => `${k.split('-')[0]}:${v.save1.churnLines}/${v.save2.churnLines}/${v.save3MoveTotalLines}${v.informationLossVsOriginal.length ? ` L${v.informationLossVsOriginal.length}` : ''}${v.fallbacks.some(Boolean) ? ' FB' : ''}${v.editMismatches.some(Boolean) ? ` MM${v.editMismatches}` : ''}`).join('  '));
}
writeFileSync(join(EVIDENCE, 'options.json'), JSON.stringify({
  note: 'churnLines = lines changed vs the ideal one-attribute edit; save3MoveTotalLines = whole diff of a 40 px move; '
    + 'editMismatches = 3-way check, changes disk->written must equal changes bpmn-js made base->out (must be 0); '
    + 'informationLossVsOriginal = categories of lost information compared with the original file.',
  results: summary,
}, null, 2) + '\n');
