# Q4: formatting churn in the first `git diff`

**Question.** When a user opens a `.bpmn` file written by another tool and makes one small edit in bpmn-edit, how
many diff lines have nothing to do with the edit? Is any information lost? What should we do about it?

**Short answer.** It depends on where the file came from. A file already written by the current bpmn-js (e.g. after one save) shows 0–1
unrelated lines. Files from Camunda Modeler, demo.bpmn.io, Signavio, Bizagi or hand-formatted files show **39 to 898
unrelated lines** for a one-word rename. Files with comments, processing instructions or a DOCTYPE **lose
information without warning**. After the first save, later saves are clean: at most 1 unrelated line. A prototype
of a minimal-diff writer (option c) brings every corpus file down to **0–1 unrelated lines with zero information
loss**. We recommend it. See [Recommendation](#recommendation) for the threshold the implementation must meet.

Every number below comes from files in `docs/q4-evidence/` (paths are given in each section).

## Setup

| Item | Version |
| --- | --- |
| macOS | Darwin 25.6.0, arm64 |
| Node | v22.22.2 |
| Chrome | 155.0.8059.40, real Chrome via Playwright `channel: 'chrome'`, headless, viewport 1600×1000 |
| Playwright | 1.64.0 |
| bpmn-js | 18.31.0 (vendored bundle `web/vendor/bpmn-js`); bpmn-moddle 10.3.1 / moddle-xml 12.3.1 in `node_modules` |
| git | 2.54.0 (Apple Git-157), run with `core.autocrlf=false` |

Source: `docs/q4-evidence/environment.json`.

The app saves with `modeler.saveXML({ format: true })` (`web/app.js`). The CLI writes exactly that string to disk
(`src/session.js` → `src/file.js`). Opening a file does not write it; the harness checks this for every fixture.

### What the harness does (`scripts/q4-churn-measure.mjs`)

For each fixture in `test/fixtures/q4/`:

1. Copy the fixture into a fresh git repo and commit it.
2. Start the real CLI (`node bin/bpmn-edit.js <file> --no-open --port <random>`) and open its URL in real Chrome.
   Check that the file on disk is unchanged after opening. Save bpmn-js's serialisation of the unedited diagram
   (`0b-bpmnjs-baseline.bpmn`, read-only; used as the merge base by the writer prototypes).
3. **Save 1:** double-click task A, select all, type `Q4 first rename`, press Enter. Wait until the file on disk
   contains the new name and has not changed for 1 s. Record `git diff`, `--stat`, `--numstat`, `-w` and
   `--word-diff=plain`, then commit.
4. **Save 2:** the same for task B with the new name `Q4 zweite Änderung`. The diff is against save 1. `camunda7-loan-approval` has only one task, so there task B is task A renamed again.
5. **Save 3:** drag task A 40 px to the right. This layout edit is used to judge the writer options.

`scripts/q4-churn-analyse.mjs` computes the numbers (Node only). It also checks that its recomputed totals match
the git `--numstat` recorded in the real repos.

Definitions (per save):

- **total**: lines added plus lines deleted in `git diff` from the previous file to the saved file.
- **edit**: lines changed by the *ideal* edit, which is the previous file with only the `name="…"` value of the
  renamed task replaced in place (`idealRename` in `scripts/q4-xml.mjs`). This is always 2.
- **churn**: lines changed between the ideal file and the saved file. In other words, everything unrelated to the
  edit. `churn -w` is the same with `git diff -w`.
- **semantic categories**: an XML-level comparison of the ideal file and the saved file. Elements are keyed by id,
  or by the nearest id'd ancestor plus element name and index. Attributes and namespaces are compared by namespace
  URI, and entity references are expanded. See `semanticChanges` / `formattingChanges` in `scripts/q4-xml.mjs`.

### Reproduce

```sh
npm install
node scripts/q4-make-fixtures.mjs                 # optional: regenerate the constructed fixtures
Q4_WORK=$TMPDIR/bpmn-edit-q4 node scripts/q4-churn-measure.mjs   # ~2 min; real CLI + real Chrome
node scripts/q4-churn-analyse.mjs                 # -> docs/q4-evidence/results.json, analyse.log
node docs/q4-evidence/prototypes/run-options.mjs  # options (a)-(d) -> options.json, options/, options-run.log
node docs/q4-evidence/prototypes/stress.mjs       # structural edits for option (c) -> options-stress.json/.log
```

The capture was run twice, before and after the baseline step was added. Both runs gave identical numbers for
every fixture.

## Corpus

Full sources and licences are in `test/fixtures/q4/SOURCES.md`.

| Fixture | Lines | What it represents | Source / licence |
| --- | ---: | --- | --- |
| `camunda7-modeler` | 168 | Camunda Modeler 4.11.1, C7 (`camunda:`, `modeler:` attrs) | camunda-consulting/camunda-7-code-examples, Apache-2.0 |
| `camunda7-loan-approval` | 50 | Camunda Modeler 4.7.0, C7, `bpmn2:` prefix, no final newline | camunda/camunda-bpm-examples, Apache-2.0 |
| `camunda8-modeler` | 268 | Camunda Modeler 5.1.0, C8 (`zeebe:`, `modeler:`, `bioc:`/`color:`) | camunda/camunda-modeler, MIT |
| `bpmnio-demo-export` | 878 | demo.bpmn.io export (bpmn-js 7.3.0), collapsed sub-processes | process-analytics/bpmn-visualization-examples, Apache-2.0 |
| `signavio-export` | 216 | SAP Signavio 19.9.0 (default ns, `signavio:` ext, 3-space indent, `69.0` numbers) | bpmn-miwg test suite, CC BY 3.0 |
| `bizagi-export` | 437 | Bizagi Modeler 2.8.0.8 (ns declared per element, `bizagi:` ext) | bpmn-miwg test suite, CC BY 3.0 |
| `hand-4space` | 202 | 4-space indent, one attribute per line, `/>` | constructed by us |
| `hand-tabs` | 202 | tab indent, one attribute per line, single quotes | constructed by us |
| `crlf` | 106 | bpmn.io layout, CRLF | constructed by us |
| `no-trailing-newline` | 106 | bpmn.io layout, no final newline | constructed by us |
| `comments-nonascii` | 119 | comments, PIs, CDATA, unknown `acme:` namespace, non-ASCII text, `&quot;`/`&amp;` | constructed by us |
| `doctype` | 110 | `standalone="no"`, DOCTYPE with internal entity used in a text | constructed by us |

## Results: what the editor writes today

Sources: `docs/q4-evidence/results.json` and `analyse.log`. Raw diffs are in
`docs/q4-evidence/<fixture>/{first,second,third}.diff` (also `.stat`, `.numstat`, `.w.diff`, `.word.diff`). The
saved files are `0-original.bpmn`, `1-save1.bpmn`, `2-save2.bpmn` and `3-save3-move.bpmn`.

### Line counts

| Fixture | Save 1 total (+/−) | Edit | **Save 1 churn** | churn −w | Save 2 total | **Save 2 churn** | Move (save 3) total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| bizagi-export | 156 (+78/−78) | 2 | **154** | 152 | 2 | **0** | 52 |
| bpmnio-demo-export | 900 (+462/−438) | 2 | **898** | 898 | 3 | **1** | 12 |
| camunda7-loan-approval | 41 (+21/−20) | 2 | **39** | 37 | 2 | **0** | 6 |
| camunda7-modeler | 127 (+64/−63) | 2 | **127** | 127 | 3 | **1** | 12 |
| camunda8-modeler | 145 (+73/−72) | 2 | **143** | 143 | 3 | **1** | 20 |
| comments-nonascii | 16 (+5/−11) | 2 | **14** | 14 | 3 | **1** | 14 |
| crlf | 213 (+107/−106) | 2 | **213** | 1 | 3 | **1** | 12 |
| doctype | 10 (+4/−6) | 2 | **8** | 8 | 3 | **1** | 12 |
| hand-4space | 305 (+105/−200) | 2 | **305** | 209 | 3 | **1** | 12 |
| hand-tabs | 305 (+105/−200) | 2 | **305** | 211 | 3 | **1** | 12 |
| no-trailing-newline | 5 (+3/−2) | 2 | **3** | 1 | 3 | **1** | 12 |
| signavio-export | 431 (+216/−215) | 2 | **431** | 137 | 2 | **0** | 18 |

Notes:

- In some rows churn equals total. That happens when the renamed line is itself inside a reformatted region, so
  even the edit line differs from the ideal edit.
- **Second save:** 0 or 1 unrelated lines everywhere. The 1 line is always the empty `<bpmndi:BPMNLabel />`
  described below. The churn is a one-off normalisation, not a recurring cost.
- **Move:** dragging a task makes bpmn-js move that shape's `BPMNShape` to the end of the plane (DI ordering).
  The shape's lines are therefore deleted in one place and added in another, on every move. Example:
  `hand-4space/third.diff`.

### Churn categories (save 1)

Counts are affected items, not lines (`results.json` → `first.formatting` / `first.semanticByCategory`).

| Fixture | Formatting-level | Model-level / side effects |
| --- | --- | --- |
| bizagi-export | 73 element-local `xmlns="…"` declarations moved before the other attributes (e.g. `<Bounds x=… xmlns="…"/>` → `<Bounds xmlns="…" x=…/>`); XML declaration `<?xml version="1.0"?>` → with `encoding="UTF-8"`; final newline added; root start tag (xmlns order) | 14 numbers respelled (`209.33334350585937` → `…938`); `isMarkerVisible="true"` added to 2 gateways |
| bpmnio-demo-export | **95 DI elements reordered** (shapes before edges, bpmn-js DI ordering) | bpmn-js import migration: 7 `BPMNDiagram`s added for collapsed sub-processes, 4 coordinates moved into them; empty `BPMNLabel` |
| camunda7-loan-approval | 3 DI elements reordered; final newline added; root tag (namespace declarations reordered) | empty `BPMNLabel` |
| camunda7-modeler | 14 DI elements reordered; 4 elements with attributes reordered; root tag (xmlns order) | empty `BPMNLabel` |
| camunda8-modeler | 17 DI elements reordered; 1 `<x></x>` → `<x />`; root tag (xmlns order) | empty `BPMNLabel` |
| comments-nonascii | 2 attribute values re-escaped (`&quot;` → `&#34;`, `&amp;` → `&#38;`); root tag | **3 comments, 2 PIs dropped**; CDATA → escaped text; empty `BPMNLabel` |
| crlf | all line endings CRLF → LF (whole file) | empty `BPMNLabel` |
| doctype | XML declaration loses `standalone="no"`; 1 text re-escaped | **DOCTYPE dropped; `&company;` turned into the literal text `&amp;company;`**; empty `BPMNLabel` |
| hand-4space | indent 4 → 2 spaces; 56 multi-line start tags joined; 33 `/>` → ` />` | empty `BPMNLabel` |
| hand-tabs | indent tab → 2 spaces; 56 multi-line start tags joined; 149 attributes `'` → `"` | empty `BPMNLabel` |
| no-trailing-newline | final newline added | empty `BPMNLabel` |
| signavio-export | indent 3 → 2 spaces; header split from the XML declaration line; 40 elements with attributes reordered; 68 `/>` → ` />` | 13 default-valued attributes dropped (`completionQuantity="1"`, `startQuantity="1"`, `isForCompensation="false"`, `typeLanguage`); 82 numbers respelled (`30.0` → `30`) |

Not observed: `exporter` / `exporterVersion` changes (the app does not set them), namespace prefix changes
(`bpmn2:`, default namespaces and `omgdc:` are kept), and dropped unknown extensions (`camunda:`, `zeebe:`,
`modeler:`, `signavio:`, `bizagi:` and `acme:` elements and attributes all survive).

**Edit side effect.** When a task without a `BPMNLabel` is renamed, bpmn-js adds an empty
`<bpmndi:BPMNLabel />` to its shape. This is 1 extra line on every save that renames such a task (all fixtures
except Signavio and Bizagi, whose shapes already have labels). It happens in every option below, because it is
part of the bpmn-js model.

### Information loss (save 1)

Source: `results.json` → `first.informationLoss`. Spot-check in `comments-nonascii/first.diff` and
`doctype/first.diff`.

| What | Result |
| --- | --- |
| XML comments (before the root and inside elements) | **lost** (3 of 3) |
| Processing instructions (before the root and inside `extensionElements`) | **lost** (2 of 2) |
| DOCTYPE | **lost**. Its internal entity was not expanded (bpmn-moddle warning `unparsable content ]>`, shown only in the browser console). The saved file contains the literal text `&company;` instead of "ACME d.o.o.". This is a silent change of content. |
| CDATA | converted to escaped text (same value; the whitespace around the section is trimmed) |
| Unknown-namespace elements and attributes (camunda, zeebe, modeler, signavio, bizagi, acme) | kept (0 lost) |
| Namespace prefixes, local namespace declarations (Bizagi), unused declarations (Signavio `i18n`) | kept |
| Default-valued BPMN attributes | dropped (Signavio: 13; same meaning, but the text changes) |
| Numbers | respelled (`30.0` → `30`; `…937` → `…938`, the shortest round-trip form of the same double) |
| Import warnings | `bpmnio-demo-export`: `unknown attribute <implementation>` (the value is still kept); `doctype`: `unparsable content ]>` |

## Options

Each option was prototyped in scratch, not in project code. The snapshots are in `docs/q4-evidence/prototypes/`.
Each option is a function `write(disk, base, out)`:

- `disk` is the text on disk.
- `base` is bpmn-js's serialisation of that state: the baseline after import, or the previous save.
- `out` is the new bpmn-js output.

Each option was applied to the captured outputs from the harness run (save 1 → 2 → 3, chained). Results are in
`docs/q4-evidence/options.json`, `options-run.log` and per-fixture diffs in
`options/<fixture>/<option>-save{1,2,3}.diff`.

| Option | What it does |
| --- | --- |
| **a** accept | Write bpmn-js output as-is (today). |
| **b** preserve header + style | Keep the original prolog (XML declaration, comments, PIs and DOCTYPE before the root). Keep the original root start tag if it declares the same attributes and namespaces. Keep the indent unit (whitespace-only text re-indented), line endings and final newline (or its absence). |
| **c** minimal-diff writer | 3-way merge. Compute model changes `base → out` per element path (id, or nearest id'd ancestor + name + index): changed, added and removed attributes; added, removed or replaced elements; text; new namespace declarations. Patch them into `disk` by offset. Everything else stays byte-for-byte, including order, formatting, comments and unknown content. New elements are copied from bpmn-js output and re-indented to the file's style. Each write is **verified**: the model changes `disk → written` must equal `base → out`. Otherwise it falls back to (b). The base is the browser's `saveXML` right after import. |
| **c′** (c) with server-side base | Like (c), but the first base is computed on the server with bpmn-moddle in Node, so no baseline message from the browser is needed. Changes bpmn-js makes on import (DI migration, `isMarkerVisible`) then land in the first save. |
| **d1** normalise once | Accept bpmn-js output, but commit the first normalisation separately ("normalise formatting"), so that edit diffs are clean afterwards. Numbers are measured from that commit. |
| **d2** canonical formatter | `xmllint --format` applied to the repository file and to every save. |

Not available: bpmn-js / bpmn-moddle have no serialiser options beyond `format` and `preamble`. Nothing preserves
comments, attribute order, indent or line endings.

### Results per fixture

Each cell shows **save 1 churn / save 2 churn / move total lines**. `(loss n)` is the number of lost information
items compared with the original file. `FB` means the prototype fell back to (b) at least once.

| Fixture | a | b | **c** | c′ | d1 | d2 |
| --- | --- | --- | --- | --- | --- | --- |
| bizagi-export | 154 / 0 / 52 | 148 / 0 / 52 | **0 / 0 / 16** | 4 / 0 / 16 | 0 / 0 / 52 | 24 / 0 / 52 |
| bpmnio-demo-export | 898 / 1 / 12 | 898 / 1 / 12 | **1 / 1 / 6** | 36 / 1 / 6 | 1 / 1 / 12 | 898 / 1 / 12 |
| camunda7-loan-approval | 39 / 0 / 6 | 35 / 0 / 6 | **1 / 0 / 6** | 1 / 0 / 6 | 1 / 0 / 6 | 37 / 0 / 6 |
| camunda7-modeler | 127 / 1 / 12 | 125 / 1 / 12 | **1 / 1 / 6** | 1 / 1 / 6 | 1 / 1 / 12 | 127 / 1 / 12 |
| camunda8-modeler | 143 / 1 / 20 | 141 / 1 / 20 | **1 / 1 / 14** | 1 / 1 / 14 | 1 / 1 / 20 | 141 / 1 / 20 |
| comments-nonascii | 14 / 1 / 14 (loss 5) | 10 / 1 / 14 (loss 3) | **1 / 1 / 8** | 1 / 1 / 8 | 1 / 1 / 14 (loss 5) | 8 / 1 / 14 (loss 5) |
| crlf | 213 / 1 / 12 | 1 / 1 / 12 | **1 / 1 / 6** | 1 / 1 / 6 | 1 / 1 / 12 | 1 / 1 / 12 |
| doctype | 8 / 1 / 12 (loss 2) | 3 / 1 / 12 (loss 1) | **1 / 1 / 6** | 1 / 1 / 6 | 1 / 1 / 12 (loss 2) | 8 / 1 / 12 (loss 2) |
| hand-4space | 305 / 1 / 12 | 202 / 1 / 12 | **1 / 1 / 6** | 1 / 1 / 6 | 1 / 1 / 12 | 1 / 1 / 12 |
| hand-tabs | 305 / 1 / 12 | 204 / 1 / 12 | **1 / 1 / 6** | 1 / 1 / 6 | 1 / 1 / 12 | 1 / 1 / 12 |
| no-trailing-newline | 3 / 1 / 12 | 1 / 1 / 12 | **1 / 1 / 6** | 1 / 1 / 6 | 1 / 1 / 12 | 1 / 1 / 12 |
| signavio-export | 431 / 0 / 18 | 188 / 0 / 18 | **0 / 0 / 10** | 0 / 0 / 10 | 0 / 0 / 18 | 136 / 0 / 18 |
| **max save-1 churn** | 898 | 898 | **1** | 36 | 1 | 898 |
| **sum of move lines** | 194 | 194 | **96** | 96 | 194 | 194 |
| **lost items (all files)** | 7 | 4 | **0** | 0 | 7 | 7 |

The only unrelated line left in (c) is bpmn-js's empty `<bpmndi:BPMNLabel />`. Option (c) needed no fallback on
the corpus, and its 3-way check reported 0 mismatches on every save (`editMismatches` in `options.json`).

Example: `options/hand-tabs/c-minimal-diff-save1.diff` is exactly 1 changed name line plus 1 added
`BPMNLabel` line, in the file's own tab and single-quote style. The move diff (`…-save3.diff`) changes only the
`x` of the shape and of 2 waypoints.

**Stress test for (c).** Source: `options-stress.json`, `options-stress.log` and per-step diffs in
`options-stress/<fixture>/`. On every fixture these structural edits were made in sequence through the bpmn-js
modeling API in real Chrome: append a task, set a colour (new `bioc:`/`color:` namespaces), add a text
annotation with an association, replace a task by a user task (same id, other element), and delete a task.

- 60 steps, **0 fallbacks, 0 verification mismatches**.
- Lines written by (c): 1106 in total. bpmn-js's own steady-state diffs for the same steps: 1151.
- (c) writes more lines than bpmn-js only where the file puts every attribute on its own line (hand-formatted
  files: colour 10 vs 4 lines, replace 19 vs 14, delete 52 vs 41). Those extra lines are in the file's own style.
- Earlier prototype iterations failed this check in three ways: a namespace declared on a nested element, an
  element replaced by another type with the same id, and default attributes inside deleted or replaced elements.
  In each case the verification turned the failure into a safe fallback, and each was then fixed. This is the
  safety net the real implementation needs.

### Effort and risk

| Option | Unrelated lines (rename) | Info loss | Size (prototype → product) | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| a | 3 – 898 first save, 0 – 1 later | comments, PIs, DOCTYPE/entities | 0 | 0 | Users see huge first diffs and lose comments silently; also DI reordering on every move. |
| b | 1 – 898 (big gains only for CRLF / no-newline / header-only files) | inner comments and PIs, entities | ~50 LOC | 0.5 day | Low. Does not fix DI ordering, attribute order or number spelling. |
| **c** | **0 – 1** | **none** | writer ~185 LOC + tokenizer/facts ~250 LOC (`scripts/q4-xml.mjs`) → ~450–600 LOC with tests | **2 – 3 days**, including a `baseline` message from the browser after import and an E2E test over the corpus | Medium: a hand-written XML tokenizer and path matching. It is contained by the 3-way verification and the fallback to (b) on every write, so a bug costs churn, not data. |
| c′ | 0 – 36 (first save writes bpmn-js import migrations) | none | as (c) + bpmn-moddle as a runtime dependency of the CLI | 2 – 3 days | Same as (c). No protocol change. |
| d1 | 0 – 1 after a separate normalisation commit | as (a), in the normalisation commit | small (UI hint or a CLI flag) | 0.5 – 1 day | The user still has to accept a huge diff and the information loss once. |
| d2 | 1 – 898 | as (a) | small + xmllint dependency | 0.5 day | Does not reorder DI or attributes. It only helps files that are already xmllint-formatted. |

## Recommendation

**Implement option (c), the minimal-diff 3-way writer, on the host (server side), with (b) as its fallback.**

- **Base.** The browser sends bpmn-js's `saveXML` right after each import (initial load, and every reload after
  an external change) as a `baseline` for that version. For later writes, the base is the previous `update` XML,
  which the session already holds.
- **Fallback.** If there is no baseline, use bpmn-moddle in Node (c′), or write (b) output.
- **Verification.** Always run it. If it fails, write (b) output and print one warning line on the CLI.
- **Empty labels (optional).** The writer may skip adding empty `<bpmndi:BPMNLabel />` elements, which carry no
  information. With that, a rename becomes a pure 1-line change.

Record the decision in `docs/decisions.md` (not done here, by instruction).

**Acceptance threshold for the implementation.** Test it with an E2E spec over every file in `test/fixtures/q4/`
that uses the same UI steps as `scripts/q4-churn-measure.mjs`:

1. **Rename.** A one-label rename yields **at most 1 changed line unrelated to the edit** on the first save and on
   every later save. The only tolerated line is bpmn-js's empty `<bpmndi:BPMNLabel />` (0 if the writer suppresses
   it). Lines are counted by `churnLines` in `scripts/q4-churn-analyse.mjs`.
2. **No information loss.** Compared with the original file, nothing is lost: comments, processing
   instructions, DOCTYPE (including entity references), CDATA, unknown-namespace elements and attributes,
   namespace prefixes and declarations, default-valued attributes, and the spelling of numbers outside edited
   elements. Checked by `informationLoss` being empty (comments, PIs, DOCTYPE/entities, unknown elements and attributes) together with criterion 1, which catches dropped defaults, re-spelled numbers, CDATA conversion and namespace changes.
3. **Formatting.** Line endings, indent unit, attribute quotes and order, the XML declaration and the
   presence or absence of a final newline are unchanged outside edited elements.
4. **Move.** A 40 px move of one task changes no line outside that shape's `Bounds`/label and its connected
   edges' waypoints. There is no DI reordering: `elementsReordered` is 0, and the total is at or below the (c)
   column above (≤ 16 lines on this corpus).
5. **Safety.** Every write passes the 3-way check (0 mismatches). Structural edits (append, colour, annotation,
   replace, delete) on the corpus produce 0 fallbacks.

## Limitations

- The corpus has 12 files: 6 real exports and 6 constructed. Other tools may produce shapes the tokenizer has not
  seen, for example entity references defined in an external DTD, or `xml:space`. The verification and fallback
  are what make that acceptable.
- Renames and moves went through the UI. The structural stress edits used the bpmn-js modeling API in the real
  editor page, not UI gestures.
- The app's plain bpmn-js has no `camunda`/`zeebe` moddle extensions, so those are kept as unknown attributes and
  elements. If such extensions are added later, re-run the corpus.
- The prototype snapshots under `docs/q4-evidence/prototypes/` are evidence, not product code.
