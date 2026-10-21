import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BpmnModdle } from 'bpmn-moddle'; // installed with bpmn-js (dev dependency)
import WebSocket from 'ws';
import { createFileStore } from '../../src/file.js';
import {
  checkForms, checkMinimal, checkModel, checkOrder, detectStyle, escapeAttr, facts, idOf, load, lostExtensions, minimalDiff, parse, preserveFormat,
  renderForDisk, XmlError,
} from '../../src/minimal-diff.js';
import { createServer } from '../../src/server.js';
import { Session } from '../../src/session.js';

const EVIDENCE = new URL('../../docs/q4-evidence/', import.meta.url).pathname;
const MODEL = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const DI = 'http://www.omg.org/spec/BPMN/20100524/DI';
const DC = 'http://www.omg.org/spec/DD/20100524/DC';
const DDI = 'http://www.omg.org/spec/DD/20100524/DI';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lines added + deleted between two texts (line-based LCS, byte exact like git with autocrlf off). */
function changedLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const t = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return x.length + y.length - 2 * t[0][0];
}

/**
 * Children of BPMN elements out of the BPMN 2.0 XSD's order (the sequence of every type, from
 * src/bpmn-schema-order.js, see checkOrder), and second extensionElements. Returns descriptions (empty:
 * in order).
 */
const NOWHERE = load('<none/>');
const schemaOrderProblems = (xml) => checkOrder(NOWHERE, NOWHERE, load(xml));

const XSD = new URL('../../node_modules/bpmn-moddle/resources/bpmn/xsd/BPMN20.xsd', import.meta.url).pathname;
const HAS_XMLLINT = spawnSync('xmllint', ['--version']).status === 0 && existsSync(XSD);
/**
 * Second, independent opinion on the order: what xmllint finds wrong with `xml` against the BPMN 2.0 XSD
 * that it does not find in `original` (messages without line numbers). [] when xmllint is not installed.
 */
async function newXsdErrors(xml, original) {
  if (!HAS_XMLLINT) return [];
  const dir = await mkdtemp(join(tmpdir(), 'bpmn-xsd-'));
  try {
    const errors = async (text) => {
      await writeFile(join(dir, 'f.bpmn'), text);
      const r = spawnSync('xmllint', ['--noout', '--nonet', '--schema', XSD, join(dir, 'f.bpmn')], { encoding: 'utf8' });
      return r.stderr.split('\n').filter((l) => l && !/validates$|fails to validate$/.test(l)).map((l) => l.replace(/^[^:]*:\d+: /, ''));
    };
    const before = new Set(await errors(original));
    return (await errors(xml)).filter((l) => !before.has(l));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Line (1-based) on which element `id` starts. */
const lineOf = (xml, id) => xml.slice(0, load(xml).ids.get(id).start).split('\n').length;

/** `xml` with only the name of element `id` replaced (the ideal edit of a rename). */
function idealRename(xml, id, name) {
  const doc = load(xml);
  const attr = doc.ids.get(id).attrs.find((a) => a.local === 'name');
  return xml.slice(0, attr.valueStart) + escapeAttr(name, attr.quote) + xml.slice(attr.valueEnd);
}

// ---- A small document written in two styles: the file's own, and bpmn-js'.
//
// Nodes: [name, attrs, children] or [name, attrs, 'text']; attrs values may be [onDisk, inBpmnJs]
// (null: absent there); ['#comment', text] and ['#pi', text] only appear on disk.
const FILE_STYLE = { eol: '\r\n', unit: '\t', quote: "'", selfClose: '/>', decl: "<?xml version='1.0' encoding='UTF-8'?>", disk: true, finalNewline: false };
const BPMNJS_STYLE = { eol: '\n', unit: '  ', quote: '"', selfClose: ' />', decl: '<?xml version="1.0" encoding="UTF-8"?>', disk: false, finalNewline: true };

function build(prolog, root, style) {
  const value = (v) => (Array.isArray(v) ? v[style.disk ? 0 : 1] : v);
  const render = (node, depth) => {
    const indent = style.unit.repeat(depth);
    const [name, attrs = {}, content = []] = node;
    if (name === '#comment') return style.disk ? `${indent}<!--${attrs}-->` : null;
    if (name === '#pi') return style.disk ? `${indent}<?${attrs}?>` : null;
    const attrText = Object.entries(attrs).map(([k, v]) => [k, value(v)]).filter(([, v]) => v !== null)
      .map(([k, v]) => ` ${k}=${style.quote}${escapeAttr(v, style.quote)}${style.quote}`).join('');
    const text = Array.isArray(content) && content.length === 2 && content.every((c) => typeof c === 'string')
      ? content[style.disk ? 0 : 1] : content;
    if (typeof text === 'string') return `${indent}<${name}${attrText}>${text}</${name}>`;
    const kids = content.map((c) => render(c, depth + 1)).filter((c) => c !== null);
    if (!kids.length) return `${indent}<${name}${attrText}${style.selfClose}`;
    return [`${indent}<${name}${attrText}>`, ...kids, `${indent}</${name}>`].join(style.eol);
  };
  const lines = [style.decl, ...(style.disk ? prolog : []), render(root, 0)];
  return lines.join(style.eol) + (style.finalNewline ? style.eol : '');
}

const NS = { 'xmlns:bpmn2': MODEL, 'xmlns:bpmndi': DI, 'xmlns:dc': DC, 'xmlns:di': DDI };
const shapeNode = (id, x, y) => ['bpmndi:BPMNShape', { id: `${id}_di`, bpmnElement: id }, [
  ['dc:Bounds', { x, y, width: '100', height: '80' }],
]];
function model({ tasks = null, flows = null, shapes = null, edges = null, rootAttrs = {}, processExtra = [] } = {}) {
  return ['bpmn2:definitions', { ...NS, ...rootAttrs, id: 'Defs', targetNamespace: 'http://example.com' }, [
    ['bpmn2:process', { id: 'P', isExecutable: 'false' }, [
      ['#comment', ' the happy path '],
      ...(tasks ?? [
        ['bpmn2:task', { id: 'A', name: 'Alpha', completionQuantity: ['1', null] }, [['bpmn2:outgoing', {}, 'F1']]],
        ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1'], ['#pi', 'lint ignore']]],
      ]),
      ...(flows ?? [['bpmn2:sequenceFlow', { id: 'F1', sourceRef: 'A', targetRef: 'B' }]]),
      ...processExtra,
    ]],
    ['bpmndi:BPMNDiagram', { id: 'D1' }, [
      ['bpmndi:BPMNPlane', { id: 'PL', bpmnElement: 'P' }, [
        ...(shapes ?? [shapeNode('A', ['100.0', '100'], '100'), shapeNode('B', '300', '100')]),
        ...(edges ?? [['bpmndi:BPMNEdge', { id: 'F1_di', bpmnElement: 'F1' }, [
          ['di:waypoint', { x: '200', y: '140' }], ['di:waypoint', { x: '300', y: '140' }],
        ]]]),
      ]],
    ]],
  ]];
}
const PROLOG = ['<!-- Owner: process team -->', '<?acme-tool v="1"?>'];
const disk = (m, prolog = PROLOG) => build(prolog, m, FILE_STYLE);
const bpmnjs = (m) => build(PROLOG, m, BPMNJS_STYLE);

describe('minimal-diff writer: the Q4 corpus (captured bpmn-js saves)', async () => {
  const runs = JSON.parse(await readFile(join(EVIDENCE, 'runs.json'), 'utf8'));
  for (const run of runs) {
    it(`${run.fixture}: renames and a move change only what was edited`, async () => {
      const dir = join(EVIDENCE, run.fixture.replace(/\.bpmn$/, ''));
      const read = (f) => readFile(join(dir, f), 'utf8');
      const [original, baseline, save1, save2, save3] = await Promise.all(
        ['0-original.bpmn', '0b-bpmnjs-baseline.bpmn', '1-save1.bpmn', '2-save2.bpmn', '3-save3-move.bpmn'].map(read),
      );
      const w1 = renderForDisk({ disk: original, base: baseline, out: save1 });
      const w2 = renderForDisk({ disk: w1.text, base: save1, out: save2 });
      const w3 = renderForDisk({ disk: w2.text, base: save2, out: save3 });
      assert.deepEqual([w1.mode, w2.mode, w3.mode], ['minimal', 'minimal', 'minimal']);
      assert.equal(changedLines(idealRename(original, run.taskA, run.name1), w1.text), 0);
      assert.equal(changedLines(idealRename(w1.text, run.taskB, run.name2), w2.text), 0);
      const move = changedLines(w2.text, w3.text);
      assert.ok(move > 0 && move <= 16, `move changed ${move} lines`);
      // Everything outside the root element (declaration, comments, PIs, DOCTYPE, final newline) is kept.
      const outside = (xml) => { const { root } = parse(xml); return [xml.slice(0, root.start), xml.slice(root.end)]; };
      assert.deepEqual(outside(w3.text), outside(original));
      assert.deepEqual(detectStyle(load(w3.text)), detectStyle(load(original)));
    });
  }

  it('keeps comments, PIs, CDATA, the DOCTYPE and entity references (comments-nonascii, doctype)', async () => {
    for (const name of ['comments-nonascii', 'doctype']) {
      const read = (f) => readFile(join(EVIDENCE, name, f), 'utf8');
      const [original, baseline, save1] = await Promise.all(['0-original.bpmn', '0b-bpmnjs-baseline.bpmn', '1-save1.bpmn'].map(read));
      const { text, mode } = renderForDisk({ disk: original, base: baseline, out: save1 });
      assert.equal(mode, 'minimal');
      const kept = (xml) => [...facts(load(xml))].filter(([key]) => /^(comment|pi|cdata|decl|doctype)\u0000/.test(key));
      assert.deepEqual(kept(text), kept(original));
      if (name === 'doctype') assert.match(text, /Shipped by &company; logistics/);
      if (name === 'comments-nonascii') assert.match(text, /<!\[CDATA\[Checks <stock> & reserves items/);
    }
  });
});

describe('minimal-diff writer: edits in the file\'s style', () => {
  const D = disk(model());
  const B = bpmnjs(model());

  it('a rename changes one line and keeps everything else byte for byte', () => {
    const U = bpmnjs(model({ tasks: [
      ['bpmn2:task', { id: 'A', name: 'Alpha & "Omega"' }, [['bpmn2:outgoing', {}, 'F1']]],
      ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
    ] }));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.equal(text, D.replace("name='Alpha'", "name='Alpha &amp; \"Omega\"'"));
  });

  it('a name with a tab, line feed or carriage return is written with character references (bpmn-js writes some literally)', () => {
    // Verifier Q4-impl round 8, D2: bpmn-js writes a tab and a carriage return in an attribute literally
    // (and reads them back so); written so, any XML reader (and the writer's) normalises them to spaces.
    for (const [name, written] of [['tab\there', 'tab&#9;here'], ['a\nb\r\nc', 'a&#10;b&#13;&#10;c'], ['cr\ronly', 'cr&#13;only']]) {
      const U = bpmnjs(model()).replace('name="Alpha"', `name="${name.replaceAll('\n', '&#10;')}"`);
      const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
      assert.equal(mode, 'minimal');
      assert.equal(text, D.replace("name='Alpha'", `name='${written}'`));
      assert.equal(load(text).ids.get('A').attrs.find((a) => a.local === 'name').value, name);
    }
  });

  it('writes added elements with the file\'s indent, line ends, quotes, prefixes and self-closing style', () => {
    const U = bpmnjs(model({
      tasks: [
        ['bpmn2:task', { id: 'A', name: 'Alpha' }, [['bpmn2:outgoing', {}, 'F1'], ['bpmn2:outgoing', {}, 'F2']]],
        ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
        ['bpmn2:task', { id: 'C', name: 'Gamma' }, [['bpmn2:incoming', {}, 'F2']]],
      ],
      flows: [['bpmn2:sequenceFlow', { id: 'F1', sourceRef: 'A', targetRef: 'B' }], ['bpmn2:sequenceFlow', { id: 'F2', sourceRef: 'A', targetRef: 'C' }]],
      shapes: [shapeNode('A', '100', '100'), shapeNode('B', '300', '100'), shapeNode('C', '300', '300')],
    }));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(!/(^|[^\r])\n/.test(text), 'only CRLF line ends');
    assert.ok(text.includes("\t\t\t<bpmn2:outgoing>F2</bpmn2:outgoing>\r\n\t\t</bpmn2:task>"));
    assert.ok(text.includes("\t\t<bpmn2:task id='C' name='Gamma'>\r\n\t\t\t<bpmn2:incoming>F2</bpmn2:incoming>\r\n\t\t</bpmn2:task>"));
    assert.ok(text.includes("\t\t<bpmn2:sequenceFlow id='F2' sourceRef='A' targetRef='C'/>"));
    assert.ok(text.includes("\t\t\t\t<dc:Bounds x='300' y='300' width='100' height='80'/>"));
    assert.ok(text.includes("x='100.0'"), 'unchanged numbers keep their spelling');
    assert.ok(text.includes("completionQuantity='1'"), 'attributes bpmn-js drops are kept');
    assert.ok(text.startsWith(build(PROLOG, model(), FILE_STYLE).slice(0, 80)));
    assert.ok(!text.endsWith('\n'), 'still no final newline');
    assert.equal(changedLines(D, text), 8); // 1 outgoing, task C (3), flow F2 (1), shape C (3)
  });

  it('removes deleted elements with their lines, keeping comments and PIs elsewhere', () => {
    const U = bpmnjs(model({
      tasks: [['bpmn2:task', { id: 'A', name: 'Alpha' }]],
      flows: [],
      shapes: [shapeNode('A', '100', '100')],
      edges: [],
    }));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(!text.includes("id='B'") && !text.includes("id='F1'") && !text.includes('F1_di'));
    assert.ok(text.includes('<!-- the happy path -->') && text.includes('<!-- Owner: process team -->'));
    assert.ok(text.includes("<bpmn2:task id='A' name='Alpha' completionQuantity='1'>\r\n\t\t</bpmn2:task>"));
  });

  it('moves an element (with its own text, PI included) into a new sub-process and declares a new namespace where needed', () => {
    const U = bpmnjs(model({
      rootAttrs: { 'xmlns:bioc': 'http://bpmn.io/schema/bpmn/biocolor/1.0' },
      tasks: [
        ['bpmn2:task', { id: 'A', name: 'Alpha' }, [['bpmn2:outgoing', {}, 'F1']]],
        ['bpmn2:subProcess', { id: 'S' }, [['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]]]],
      ],
      shapes: [
        ['bpmndi:BPMNShape', { id: 'A_di', bpmnElement: 'A', 'bioc:fill': '#ff0000' }, [['dc:Bounds', { x: '100', y: '100', width: '100', height: '80' }]]],
        shapeNode('B', '300', '100'), shapeNode('S', '250', '50'),
      ],
    }));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes("\t\t<bpmn2:subProcess id='S'>\r\n\t\t\t<bpmn2:task id='B' name='Beta'>\r\n\t\t\t\t<bpmn2:incoming>F1</bpmn2:incoming>\r\n\t\t\t\t<?lint ignore?>\r\n\t\t\t</bpmn2:task>\r\n\t\t</bpmn2:subProcess>"));
    assert.ok(text.includes("xmlns:bioc='http://bpmn.io/schema/bpmn/biocolor/1.0'"));
    assert.ok(text.includes("<bpmndi:BPMNShape id='A_di' bpmnElement='A' bioc:fill='#ff0000'>"));
  });

  it('replaces an element by another type in place (its own text, PI included)', () => {
    const U = bpmnjs(model({ tasks: [
      ['bpmn2:task', { id: 'A', name: 'Alpha' }, [['bpmn2:outgoing', {}, 'F1']]],
      ['bpmn2:userTask', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
    ] }));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes("\t\t<bpmn2:userTask id='B' name='Beta'>\r\n\t\t\t<bpmn2:incoming>F1</bpmn2:incoming>\r\n\t\t\t<?lint ignore?>\r\n\t\t</bpmn2:userTask>\r\n\t\t<bpmn2:sequenceFlow"));
  });

  it('uses the file\'s own prefix (or default namespace) for a namespace bpmn-js writes with another', () => {
    // On disk the BPMN model namespace is the default one; bpmn-js output uses "bpmn2:".
    const D2 = D.replaceAll('bpmn2:', '').replace("xmlns:bpmn2='", "xmlns='");
    const U = bpmnjs(model({
      tasks: [
        ['bpmn2:task', { id: 'A', name: 'Alpha' }, [['bpmn2:outgoing', {}, 'F1']]],
        ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
        ['bpmn2:task', { id: 'C', name: 'Gamma' }],
      ],
      shapes: [shapeNode('A', '100', '100'), shapeNode('B', '300', '100'), shapeNode('C', '500', '100')],
    }));
    const { text, mode } = renderForDisk({ disk: D2, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes("\t\t<task id='C' name='Gamma'/>"));
    // And a prefix the file binds to the namespace under another name.
    const D3 = D.replaceAll('dc:', 'omgdc:').replace("xmlns:dc='", "xmlns:omgdc='");
    const { text: t3, mode: m3 } = renderForDisk({ disk: D3, base: B, out: U });
    assert.equal(m3, 'minimal');
    assert.ok(t3.includes("<omgdc:Bounds x='500' y='100' width='100' height='80'/>"));
    assert.ok(!t3.includes('xmlns:dc'));
  });

  it('follows one-attribute-per-line layouts (aligned and hanging)', () => {
    const aligned = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<bpmn:definitions xmlns:bpmn="${MODEL}"`,
      `                  id="Defs">`,
      '    <bpmn:process id="P"',
      '                  isExecutable="false">',
      '        <bpmn:task id="A"',
      '                   name="Alpha"/>',
      '    </bpmn:process>',
      '</bpmn:definitions>',
      '',
    ].join('\n');
    const base = `<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions xmlns:bpmn="${MODEL}" id="Defs">\n  <bpmn:process id="P" isExecutable="false">\n    <bpmn:task id="A" name="Alpha" />\n  </bpmn:process>\n</bpmn:definitions>\n`;
    const out = base.replace('<bpmn:task id="A" name="Alpha" />', '<bpmn:task id="A" name="Alpha" />\n    <bpmn:task id="B" name="Beta" />');
    const { text, mode } = renderForDisk({ disk: aligned, base, out });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes('                   name="Alpha"/>\n        <bpmn:task id="B"\n                   name="Beta"/>\n'));
    const hanging = aligned.replace(/\n {16,}/g, '\n\t\t').replace(/ {4}/g, '\t');
    const { text: t2, mode: m2 } = renderForDisk({ disk: hanging, base, out });
    assert.equal(m2, 'minimal');
    assert.equal(detectStyle(load(hanging)).layout.mode, 'hanging');
    assert.ok(t2.includes('\t\t<bpmn:task id="B"\n'));
  });

  it('writes new elements as they come, CDATA and comments included', () => {
    const U = bpmnjs(model({ processExtra: [['bpmn2:task', { id: 'C' }, [['bpmn2:documentation', {}, '<![CDATA[a < b]]>']]]] }));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes("\t\t<bpmn2:task id='C'>\r\n\t\t\t<bpmn2:documentation><![CDATA[a < b]]></bpmn2:documentation>\r\n\t\t</bpmn2:task>"));
  });

  it('writes nothing new when bpmn-js only re-serialised the same model', () => {
    const { text, mode } = renderForDisk({ disk: D, base: B, out: B });
    assert.equal(mode, 'minimal');
    assert.equal(text, D);
  });
});

describe('minimal-diff writer: fallbacks', () => {
  const D = disk(model());
  const B = bpmnjs(model());
  const U = bpmnjs(model({ tasks: [
    ['bpmn2:task', { id: 'A', name: 'Renamed' }, [['bpmn2:outgoing', {}, 'F1']]],
    ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
  ] }));

  it('without a base, the disk text itself is the base (\'unbased\', still checked)', () => {
    const { text, mode, reason } = renderForDisk({ disk: D, base: null, out: U });
    assert.equal(mode, 'unbased');
    assert.equal(reason, 'no base');
    assert.ok(text.includes("name='Renamed'") && text.includes('<!-- the happy path -->'));
    // bpmn-js' normalisations are written too: the default attribute goes, 100.0 stays (same number).
    assert.ok(!text.includes('completionQuantity') && text.includes("x='100.0'"));
  });

  it('falls back to the file\'s style (\'format\'), carrying comments and PIs over and naming what it loses', () => {
    // The text of A's <outgoing> changes, and on disk it has a comment next to it: not patched in place.
    const disk2 = D.replace('<bpmn2:outgoing>F1</bpmn2:outgoing>', '<bpmn2:outgoing>F1<!-- why --></bpmn2:outgoing>');
    const out = B.replace('<bpmn2:outgoing>F1</bpmn2:outgoing>', '<bpmn2:outgoing>F9</bpmn2:outgoing>');
    const { text, mode, reason, lost } = renderForDisk({ disk: disk2, base: B, out });
    assert.equal(mode, 'format');
    assert.match(reason, /text next to a comment/);
    assert.deepEqual(checkModel(load(text), load(out)), []);
    assert.ok(text.startsWith(`<?xml version='1.0' encoding='UTF-8'?>\r\n<!-- Owner: process team -->\r\n<?acme-tool v="1"?>\r\n`));
    assert.ok(text.includes("\t\t<!-- the happy path -->\r\n\t\t<bpmn2:task id='A' name='Alpha'>\r\n"), 'comment kept before its element');
    assert.ok(text.includes("\t\t\t<bpmn2:incoming>F1</bpmn2:incoming>\r\n\t\t\t<?lint ignore?>\r\n"), 'PI kept after its element');
    assert.ok(!text.endsWith('\n'));
    assert.deepEqual(lost, ['comment "why"']);
  });

  it('writes bpmn-js\' output as it is (\'raw\') when the file cannot be read, naming what is lost', () => {
    const broken = D.replace("<bpmn2:task id='B'", "<bpmn2:task foo:x='1' id='B'");
    const { text, mode, reason, lost } = renderForDisk({ disk: broken, base: B, out: U });
    assert.equal(mode, 'raw');
    assert.match(reason, /unbound prefix foo/);
    assert.equal(text, U);
    assert.deepEqual(lost, ['comment "Owner: process team"', 'processing instruction <?acme-tool v="1"?>', 'comment "the happy path"', 'processing instruction <?lint ignore?>']);
  });

  it('keeps references to entities, also from an external DTD', () => {
    const external = D.replace('<!-- Owner: process team -->', '<!DOCTYPE bpmn2:definitions SYSTEM "x.dtd">')
      .replace("name='Beta'", "name='Beta &ext;'");
    const base = B.replace('name="Beta"', 'name="Beta &amp;ext;"');
    const out = U.replace('name="Beta"', 'name="Beta &amp;ext; 2"');
    const { text, mode } = renderForDisk({ disk: external, base, out });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes("name='Renamed'") && text.includes("name='Beta &ext; 2'"));
  });

  it('writes the XML as it is when nothing is on disk (\'new\')', () => {
    assert.deepEqual(renderForDisk({ disk: null, base: null, out: U }), { text: U, mode: 'new' });
  });

  it('never throws, whatever it is given', () => {
    assert.equal(renderForDisk({ disk: D, base: B, out: '<not xml' }).mode, 'raw');
    const notBpmn = renderForDisk({ disk: '<x/>', base: B, out: U });
    assert.equal(notBpmn.mode, 'format'); // nothing of the file to keep but its (empty) style
    assert.deepEqual(checkModel(load(notBpmn.text), load(U)), []);
  });

  it('the checks catch a result that changed something else', () => {
    const written = minimalDiff(D, B, U);
    assert.deepEqual(checkMinimal(load(D), load(B), load(U), load(written)), []);
    const tampered = written.replace("name='Beta'", "name='Bet'");
    assert.ok(checkMinimal(load(D), load(B), load(U), load(tampered)).some((k) => k.includes('#B')));
    assert.deepEqual(checkForms(D, B, U, tampered), ['element B']);
    const lostComment = written.replace('<!-- the happy path -->', '');
    assert.ok(checkMinimal(load(D), load(B), load(U), load(lostComment)).some((k) => k.startsWith('comment')));
    const notApplied = D;
    assert.ok(checkMinimal(load(D), load(B), load(U), load(notApplied)).some((k) => k.includes('#A')));
  });

  it('preserveFormat keeps prolog, epilog, indent, quotes and line ends', () => {
    const { text, lost } = preserveFormat(D, U);
    assert.deepEqual(lost, []);
    assert.deepEqual(checkModel(load(text), load(U)), []);
    assert.deepEqual(detectStyle(load(text)), detectStyle(load(D)));
  });
});

describe('minimal-diff writer: what is inside replaced and moved elements', () => {
  const ACME = 'https://example.com/acme';
  const DOCTYPE = '<!DOCTYPE bpmn2:definitions [<!ENTITY company "ACME d.o.o.">]>';
  const prolog = [DOCTYPE, '<!-- Owner: process team -->'];
  // Task A with an unknown attribute, a comment, a CDATA documentation, an entity, extensions and a PI.
  const taskA = (type, { extensions = true, sla = true } = {}) => [type, { id: 'A', name: 'Alpha', ...(sla ? { 'acme:sla': 'PT2H' } : {}) }, [
    ['#comment', ' checked by the warehouse '],
    ['bpmn2:documentation', {}, ['<![CDATA[Checks <stock> & more]]>', 'Checks &lt;stock&gt; &amp; more']],
    ...(extensions ? [['bpmn2:extensionElements', {}, [['acme:retry', { n: '3' }], ['#pi', 'acme-lint off']]]] : []),
    ['bpmn2:outgoing', {}, 'F1'],
  ]];
  const taskB = (type) => [type, { id: 'B', name: 'Beta' }, [
    ['bpmn2:documentation', {}, ['Shipped by &company; logistics', 'Shipped by &amp;company; logistics']],
    ['bpmn2:incoming', {}, 'F1'],
  ]];
  const m = (tasks, extra = {}) => model({ rootAttrs: { 'xmlns:acme': ACME }, tasks, ...extra });
  const D = disk(m([taskA('bpmn2:task'), taskB('bpmn2:task')]), prolog);
  const B = bpmnjs(m([taskA('bpmn2:task'), taskB('bpmn2:task')]));

  it('a type change keeps comments, PIs, CDATA and the extensions bpmn-js drops', () => {
    // bpmn-js' replace drops unknown attributes and extension elements of the old element.
    const U = bpmnjs(m([taskA('bpmn2:userTask', { extensions: false, sla: false }), taskB('bpmn2:task')]));
    const { text, mode, reason } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal', reason);
    const expected = disk(m([taskA('bpmn2:userTask'), taskB('bpmn2:task')]), prolog);
    assert.equal(text, expected);
    assert.equal(changedLines(D, text), 4); // the start and end tag
  });

  it('a replace that keeps the tag keeps the extensions bpmn-js drops, also of the DI shape it re-creates', () => {
    // Verifier Q4-impl round 7, D-A. bpmn-js' replace (e.g. another event definition: the same tag) drops
    // unknown attributes, extension elements, and re-creates the DI shape with a new id, without its DI
    // extension and its label's id and style.
    const shapes = (diId, old) => [['bpmndi:BPMNShape', { id: diId, bpmnElement: 'A' }, [
      ...(old ? [['di:extension', {}]] : []),
      ['dc:Bounds', { x: ['100.0', '100'], y: '100', width: '100', height: '80' }],
      ['bpmndi:BPMNLabel', old ? { id: 'A_label', labelStyle: 'S1', 'acme:hint': 'x' } : {}, [
        ...(old ? [['di:extension', {}]] : []), ['dc:Bounds', { x: '90', y: '190', width: old ? '0' : '55', height: '14' }]]],
    ]], shapeNode('B', '300', '100')];
    const before = m([taskA('bpmn2:task'), taskB('bpmn2:task')], { shapes: shapes('A_di', true) });
    const D1 = disk(before, prolog);
    const B1 = bpmnjs(before);
    const U1 = bpmnjs(m([taskA('bpmn2:task', { extensions: false, sla: false }), taskB('bpmn2:task')], { shapes: shapes('Event_1x_di', false) }));
    const memory = new Map();
    const W1 = renderForDisk({ disk: D1, base: B1, out: U1, memory });
    assert.equal(W1.mode, 'minimal', W1.reason);
    assert.equal(W1.lost, undefined, W1.lost?.join(' | '));
    // The new DI id and what bpmn-js changed in the label; everything else as it was.
    assert.equal(W1.text, D1.replace("id='A_di'", "id='Event_1x_di'").replace("width='0'", "width='55'"));
    // The next save has the label without an id in its base and output: it is still the label on disk.
    const U2 = U1.replace('<dc:Bounds x="90" y="190" width="55"', '<dc:Bounds x="95" y="190" width="55"');
    const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2, memory });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.equal(W2.text, W1.text.replace("x='90'", "x='95'"));
    // Undo of both: back to the original text.
    const W3 = renderForDisk({ disk: W2.text, base: U2, out: U1, memory });
    const W4 = renderForDisk({ disk: W3.text, base: U1, out: B1, memory });
    assert.deepEqual([W3.mode, W4.mode], ['minimal', 'minimal'], W4.reason);
    assert.equal(W4.text, D1);
  });

  it('a replace whose re-created DI shape has no label reports what the old label carried (its style, extensions)', () => {
    // Verifier Q4-impl round 8: Bizagi / Signavio tasks have a label with a style; bpmn-js re-creates the
    // shape of a task it replaces without one (a task's label is inside it), so the label goes. Not silently.
    const shapes = (diId, label) => [['bpmndi:BPMNShape', { id: diId, bpmnElement: 'A' }, [
      ['dc:Bounds', { x: '100', y: '100', width: '100', height: '80' }],
      ...(label ? [label] : []),
    ]], shapeNode('B', '300', '100')];
    const run = (label) => {
      const before = m([taskA('bpmn2:task'), taskB('bpmn2:task')], { shapes: shapes('A_di', label) });
      const after = m([taskA('bpmn2:userTask', { extensions: false, sla: false }), taskB('bpmn2:task')], { shapes: shapes('UserTask_1_di', null) });
      return renderForDisk({ disk: disk(before, prolog), base: bpmnjs(before), out: bpmnjs(after) });
    };
    const bounds = ['dc:Bounds', { x: '90', y: '190', width: '0', height: '0' }];
    const styled = run(['bpmndi:BPMNLabel', { id: 'A_label', labelStyle: 'S1', 'acme:hint': 'x' }, [['di:extension', {}, [['acme:pos', {}]]], bounds]]);
    assert.equal(styled.mode, 'minimal', styled.reason);
    assert.deepEqual(styled.lost, ['label style S1 of A_di', 'attribute acme:hint in the label of A_di', 'element acme:pos in the label of A_di']);
    // A label with nothing but its bounds (and an empty DI extension): nothing to report.
    const plain = run(['bpmndi:BPMNLabel', { id: 'A_label' }, [['di:extension', {}], bounds]]);
    assert.equal(plain.mode, 'minimal', plain.reason);
    assert.equal(plain.lost, undefined);
  });

  it('a minimal write that would drop extensions of an element bpmn-js still has reports them (safety net)', () => {
    // An extension the writer would not keep (here: bpmn-js changed the element's only child, which holds
    // it, so the child is rewritten): reported in 'lost', never silent. An extension in an element bpmn-js
    // removed goes without a note.
    const ev = (def) => ['bpmn2:startEvent', { id: 'E' }, [def]];
    const before = m([ev(['bpmn2:timerEventDefinition', { 'acme:calendar': 'work' }, [['bpmn2:timeDuration', {}, 'PT1H']]]), taskB('bpmn2:task')]);
    const after = m([ev(['bpmn2:messageEventDefinition', {}]), taskB('bpmn2:task')]);
    const W = renderForDisk({ disk: disk(before, prolog), base: bpmnjs(before), out: bpmnjs(after) });
    assert.equal(W.mode, 'minimal', W.reason);
    assert.equal(W.lost, undefined); // the timer definition (and its attribute) is what bpmn-js removed
    // The same attribute on the event itself, which bpmn-js keeps: kept.
    const before2 = m([['bpmn2:startEvent', { id: 'E', 'acme:calendar': 'work' }, [['bpmn2:timerEventDefinition', {}]]], taskB('bpmn2:task')]);
    const after2 = m([['bpmn2:startEvent', { id: 'E' }, [['bpmn2:messageEventDefinition', {}]]], taskB('bpmn2:task')]);
    const W2 = renderForDisk({ disk: disk(before2, prolog), base: bpmnjs(before2), out: bpmnjs(after2) });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.ok(W2.text.includes("<bpmn2:startEvent id='E' acme:calendar='work'>"), W2.text);
    // The net itself: a written text without the event's extension attribute is reported.
    assert.deepEqual(lostExtensions(load(disk(before2, prolog)), load(disk(after2, prolog)), load(bpmnjs(after2))), ['attribute acme:calendar in E']);
  });

  it('a new reference of a sub-process goes in front of its flow elements, whatever their order on disk', () => {
    // Verifier Q4-impl round 7, D-B: on disk the start event is first (an undo put it back there), in
    // bpmn-js' output last; the new <outgoing> went next to the task, after the start event.
    const sub = (kids) => ['bpmn2:subProcess', { id: 'S' }, kids];
    const se = ['bpmn2:startEvent', { id: 'SE' }];
    const t = ['bpmn2:task', { id: 'T' }];
    const D2 = disk(m([sub([se, t]), taskB('bpmn2:task')]), prolog);
    const B2 = bpmnjs(m([sub([t, se]), taskB('bpmn2:task')]));
    const U2 = bpmnjs(m([sub([['bpmn2:outgoing', {}, 'F9'], t, se]), taskB('bpmn2:task')]));
    const W = renderForDisk({ disk: D2, base: B2, out: U2 });
    assert.equal(W.mode, 'minimal', W.reason);
    assert.deepEqual(schemaOrderProblems(W.text), []);
    assert.deepEqual(load(W.text).ids.get('S').children.filter((c) => c.kind === 'element').map((c) => c.local), ['outgoing', 'startEvent', 'task']);
  });

  it('extensions kept on a type change go when the element is deleted later', () => {
    const U1 = bpmnjs(m([taskA('bpmn2:userTask', { extensions: false, sla: false }), taskB('bpmn2:task')]));
    const W1 = renderForDisk({ disk: D, base: B, out: U1 });
    assert.equal(W1.mode, 'minimal');
    const U2 = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2 });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.ok(!W2.text.includes("id='A'") && !W2.text.includes('acme:retry') && !W2.text.includes('acme-lint'));
    assert.ok(W2.text.includes('Shipped by &company; logistics') && W2.text.includes('<!-- Owner: process team -->'));
  });

  it('delete then undo: the element comes back with its old text, where it was', () => {
    const memory = new Map();
    const U1 = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const W1 = renderForDisk({ disk: D, base: B, out: U1, memory });
    assert.equal(W1.mode, 'minimal');
    assert.ok(memory.has('A') && memory.has('A_di') && memory.has('F1'));
    // bpmn-js re-adds the elements at the end of their parents.
    const U2 = bpmnjs(m([taskB('bpmn2:task'), taskA('bpmn2:task')], { shapes: [shapeNode('B', '300', '100'), shapeNode('A', '100', '100')] }));
    const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2, memory });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.equal(W2.text, D.replace("x='100.0'", "x='100.0'"));
    // Without the memory (or with another model) it is written from bpmn-js' output.
    const plain = renderForDisk({ disk: W1.text, base: U1, out: U2 });
    assert.equal(plain.mode, 'minimal');
    assert.ok(!plain.text.includes('checked by the warehouse'));
  });

  describe('select-all delete and undo of a large diagram (the memory bound)', () => {
    // Verifier Q4-impl round 9: the memory held 200 ids, so an undo after cutting more wrote the
    // first ones from bpmn-js' output: their comments, PIs and CDATA gone, as `minimal`, with no note.
    const extras = Array.from({ length: 300 }, (_, i) => ['bpmn2:task', { id: `T${i}`, name: `extra ${i}` }]);
    const all = (tasks, shapes) => m(tasks, { shapes, ...(tasks.length ? {} : { flows: [], edges: [] }) });
    const shapes = [shapeNode('A', ['100.0', '100'], '100'), shapeNode('B', '300', '100'), ...extras.map((_, i) => shapeNode(`T${i}`, `${i * 10}`, '400'))];
    const Dbig = disk(all([taskA('bpmn2:task'), taskB('bpmn2:task'), ...extras], shapes), prolog);
    const Bbig = bpmnjs(all([taskA('bpmn2:task', { extensions: false, sla: false }), taskB('bpmn2:task'), ...extras], shapes));
    const Ubig = bpmnjs(all([], []));
    const kept = (text) => [...facts(load(text))].filter(([k]) => /^(comment|pi|cdata)\u0000/.test(k) || k.includes(ACME)).map(([k, v]) => `${k}=${v}`);

    it('comes back byte-exact (but for the process\' free comment), every write minimal', () => {
      const memory = new Map();
      const W1 = renderForDisk({ disk: Dbig, base: Bbig, out: Ubig, memory });
      assert.equal(W1.mode, 'minimal', W1.reason);
      assert.ok(memory.size > 600);
      const W2 = renderForDisk({ disk: W1.text, base: Ubig, out: Bbig, memory });
      assert.equal(W2.mode, 'minimal', W2.reason);
      assert.equal(W2.lost, undefined, W2.lost?.join(' | '));
      assert.deepEqual(kept(W2.text).sort(), kept(Dbig).sort());
      // A comment between elements that are all cut stays in its parent; they come back before it.
      const free = '\t\t<!-- the happy path -->\r\n';
      assert.ok(W2.text.includes(free));
      assert.equal(W2.text.replace(free, ''), Dbig.replace(free, ''));
    });

    it('thousands of elements come back too (a long chain of neighbours)', () => {
      const many = Array.from({ length: 3000 }, (_, i) => ['bpmn2:task', { id: `T${i}`, name: `extra ${i}` }]);
      const many3 = (a) => all([a, taskB('bpmn2:task'), ...many], [shapeNode('A', ['100.0', '100'], '100'), shapeNode('B', '300', '100')]);
      const D3 = disk(many3(taskA('bpmn2:task')), prolog);
      const B3 = bpmnjs(many3(taskA('bpmn2:task', { extensions: false, sla: false })));
      const memory = new Map();
      const W1 = renderForDisk({ disk: D3, base: B3, out: Ubig, memory });
      const W2 = renderForDisk({ disk: W1.text, base: Ubig, out: B3, memory });
      assert.deepEqual([W1.mode, W2.mode], ['minimal', 'minimal'], W2.reason);
      assert.equal(W2.lost, undefined, W2.lost?.join(' | '));
      assert.deepEqual(kept(W2.text).sort(), kept(D3).sort());
    });

    it('an element whose text the memory evicted is reported with what it lost, never silently', () => {
      // A budget smaller than any text: everything evicted; A's tombstone names its comment, PI, CDATA, extension.
      const memory = new Map();
      const W1 = renderForDisk({ disk: Dbig, base: Bbig, out: Ubig, memory, limits: { budget: 1 } });
      assert.equal(W1.mode, 'minimal', W1.reason);
      assert.equal(memory.size, 0);
      const W2 = renderForDisk({ disk: W1.text, base: Ubig, out: Bbig, memory, limits: { budget: 1 } });
      assert.equal(W2.mode, 'minimal', W2.reason);
      assert.ok(!W2.text.includes('checked by the warehouse'));
      const lost = W2.lost?.join(' | ') ?? '';
      for (const what of ['comment "checked by the warehouse"', 'processing instruction <?acme-lint off?>', 'a CDATA section in A/', 'element acme:retry', 'attribute acme:sla']) {
        assert.ok(lost.includes(what), `${what} not in: ${lost}`);
      }
      assert.ok(!/T\d|extra/.test(lost), lost); // the extra tasks had nothing to lose
    });

    it('with the tombstones evicted too, a note says what may be lost', () => {
      const memory = new Map();
      const limits = { budget: 1, tombs: 0 };
      const W1 = renderForDisk({ disk: Dbig, base: Bbig, out: Ubig, memory, limits });
      const W2 = renderForDisk({ disk: W1.text, base: Ubig, out: Bbig, memory, limits });
      assert.equal(W2.mode, 'minimal', W2.reason);
      assert.equal(W2.lost?.length, 1, W2.lost?.join(' | '));
      assert.match(W2.lost[0], /^any comments, PIs, CDATA or unknown-namespace content of \d+ element\(s\) brought back after more removals/);
    });
  });

  it('the check refuses text written back from memory that is not the remembered one', () => {
    const memory = new Map();
    const U1 = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const W1 = renderForDisk({ disk: D, base: B, out: U1, memory });
    const U2 = bpmnjs(m([taskB('bpmn2:task'), taskA('bpmn2:task')], { shapes: [shapeNode('B', '300', '100'), shapeNode('A', '100', '100')] }));
    const restored = ['A', 'F1', 'A_di', 'F1_di'].map((id) => ({ id, text: memory.get(id).at(-1).text, scope: memory.get(id).at(-1).scope }));
    const tampered = D.replace('<!-- checked by the warehouse -->', '<!-- something else -->');
    assert.ok(checkMinimal(load(W1.text), load(U1), load(U2), load(tampered), restored).some((k) => k.startsWith('comment #A')));
    assert.deepEqual(checkMinimal(load(W1.text), load(U1), load(U2), load(D), restored), []);
  });

  it('type change then undo: the kept extensions are the ones bpmn-js brings back', () => {
    const U1 = bpmnjs(m([taskA('bpmn2:userTask', { extensions: false, sla: false }), taskB('bpmn2:task')]));
    const W1 = renderForDisk({ disk: D, base: B, out: U1 });
    const W2 = renderForDisk({ disk: W1.text, base: U1, out: B });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.equal(W2.text, D);
  });

  it('type change, delete, undo, undo: minimal all the way, back to the original text', () => {
    const memory = new Map();
    const U1 = bpmnjs(m([taskA('bpmn2:serviceTask', { extensions: false, sla: false }), taskB('bpmn2:task')]));
    const W1 = renderForDisk({ disk: D, base: B, out: U1, memory });
    const U2 = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2, memory });
    // Undo of the delete: bpmn-js' model of the task at delete time (without the kept extensions).
    const W3 = renderForDisk({ disk: W2.text, base: U2, out: U1, memory });
    assert.deepEqual([W1.mode, W2.mode, W3.mode], ['minimal', 'minimal', 'minimal'], W3.reason);
    assert.equal(W3.text, W1.text);
    const W4 = renderForDisk({ disk: W3.text, base: U1, out: B, memory });
    assert.equal(W4.mode, 'minimal', W4.reason);
    assert.equal(W4.text, D);
  });

  // Verifier Q4-impl round 6: after a type change, references written back (undo) or added (a new flow)
  // went in front of the kept extensionElements: schema-invalid BPMN, reported as minimal lost=0.
  for (const doc of [true, false]) {
    const taskX = (type, { ext = true, out = 'F1' } = {}) => [type, { id: 'A', name: 'Alpha', ...(ext ? { 'acme:sla': 'PT2H' } : {}) }, [
      ...(doc ? [['bpmn2:documentation', {}, 'Checks the stock']] : []),
      ...(ext ? [['bpmn2:extensionElements', {}, [['acme:retry', { n: '3' }], ['#pi', 'acme-lint off']]]] : []),
      ...(out ? [['bpmn2:outgoing', {}, out]] : []),
    ]];
    const taskY = (incoming) => ['bpmn2:task', { id: 'B', name: 'Beta' }, incoming ? [['bpmn2:incoming', {}, incoming]] : []];
    const flow = (id) => ['bpmn2:sequenceFlow', { id, sourceRef: 'A', targetRef: 'B' }];
    const edge = (id) => ['bpmndi:BPMNEdge', { id: `${id}_di`, bpmnElement: id }, [['di:waypoint', { x: '200', y: '140' }], ['di:waypoint', { x: '300', y: '140' }]]];
    const D0 = disk(m([taskX('bpmn2:task'), taskY('F1')]), prolog);
    const B0 = bpmnjs(m([taskX('bpmn2:task'), taskY('F1')]));
    const U1 = bpmnjs(m([taskX('bpmn2:serviceTask', { ext: false }), taskY('F1')]));
    const U2 = bpmnjs(m([taskX('bpmn2:serviceTask', { ext: false, out: null }), taskY(null)], { flows: [], edges: [] }));
    const label = doc ? 'with documentation' : 'without documentation';

    it(`type change, delete the flow, undo: the reference goes after the kept extensions (${label})`, () => {
      const memory = new Map();
      const W1 = renderForDisk({ disk: D0, base: B0, out: U1, memory });
      const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2, memory });
      const W3 = renderForDisk({ disk: W2.text, base: U2, out: U1, memory });
      for (const w of [W1, W2, W3]) assert.equal(w.mode, 'minimal', w.reason);
      for (const w of [W1, W2, W3]) assert.deepEqual(schemaOrderProblems(w.text), []);
      assert.equal(W3.text, W1.text);
    });

    it(`type change, delete the flow, a new flow: its reference goes after the kept extensions (${label})`, () => {
      const W1 = renderForDisk({ disk: D0, base: B0, out: U1 });
      const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2 });
      const U3 = bpmnjs(m([taskX('bpmn2:serviceTask', { ext: false, out: 'F2' }), taskY('F2')], { flows: [flow('F2')], edges: [edge('F2')] }));
      const W3 = renderForDisk({ disk: W2.text, base: U2, out: U3 });
      assert.equal(W3.mode, 'minimal', W3.reason);
      assert.deepEqual(schemaOrderProblems(W3.text), []);
      assert.equal(W3.text, disk(m([taskX('bpmn2:serviceTask', { out: 'F2' }), taskY('F2')], { flows: [flow('F2')], edges: [edge('F2')] }), prolog));
    });
  }

  it('a new documentation goes in front of the kept extensions', () => {
    const taskX = (type, { ext = true, doc = false } = {}) => [type, { id: 'A', name: 'Alpha' }, [
      ...(doc ? [['bpmn2:documentation', {}, 'New']] : []),
      ...(ext ? [['bpmn2:extensionElements', {}, [['acme:retry', { n: '3' }]]]] : []),
      ['bpmn2:outgoing', {}, 'F1'],
    ]];
    const D0 = disk(m([taskX('bpmn2:task'), taskB('bpmn2:task')]), prolog);
    const U1 = bpmnjs(m([taskX('bpmn2:serviceTask', { ext: false }), taskB('bpmn2:task')]));
    const W1 = renderForDisk({ disk: D0, base: bpmnjs(m([taskX('bpmn2:task'), taskB('bpmn2:task')])), out: U1 });
    const U2 = bpmnjs(m([taskX('bpmn2:serviceTask', { ext: false, doc: true }), taskB('bpmn2:task')]));
    const W2 = renderForDisk({ disk: W1.text, base: U1, out: U2 });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.deepEqual(schemaOrderProblems(W2.text), []);
    assert.equal(W2.text, disk(m([taskX('bpmn2:serviceTask', { doc: true }), taskB('bpmn2:task')]), prolog));
  });

  it('the check refuses children out of the schema order', () => {
    const U1 = bpmnjs(m([taskA('bpmn2:serviceTask', { extensions: false, sla: false }), taskB('bpmn2:task')]));
    const W1 = renderForDisk({ disk: D, base: B, out: U1 }).text;
    // The same text with the kept extensionElements moved after <outgoing>.
    const ext = /[ \t]*<bpmn2:extensionElements>[\s\S]*?<\/bpmn2:extensionElements>\r\n/.exec(W1)[0];
    const out = /[ \t]*<bpmn2:outgoing>F1<\/bpmn2:outgoing>\r\n/.exec(W1)[0];
    const wrong = W1.replace(ext, '').replace(out, out + ext);
    assert.deepEqual(checkOrder(load(D), load(U1), load(W1)), []);
    assert.deepEqual(checkOrder(load(D), load(U1), load(wrong)), ['#A: bpmn2:extensionElements after bpmn2:outgoing']);
    // A file that is out of order already is not held against the write.
    assert.deepEqual(checkOrder(load(wrong), load(U1), load(wrong)), []);
  });

  it('a fallback names every kept extension, comment, PI and CDATA it drops', () => {
    // The file has extensions bpmn-js' model lacks (kept on a type change); a change next to a comment
    // forces the 'format' fallback, written from bpmn-js' output.
    const U1 = bpmnjs(m([taskA('bpmn2:serviceTask', { extensions: false, sla: false }), taskB('bpmn2:task')]));
    const W1 = renderForDisk({ disk: D, base: B, out: U1 }).text;
    const disk2 = W1.replace('<bpmn2:incoming>F1</bpmn2:incoming>', '<bpmn2:incoming>F1<!-- why --></bpmn2:incoming>');
    const out = U1.replace('<bpmn2:incoming>F1</bpmn2:incoming>', '<bpmn2:incoming>F9</bpmn2:incoming>');
    const { mode, lost, reason } = renderForDisk({ disk: disk2, base: U1, out });
    assert.equal(mode, 'format', reason);
    assert.ok(lost.includes('comment "why"'), lost.join(' | '));
    assert.ok(lost.includes('attribute acme:sla in A'), lost.join(' | '));
    assert.ok(lost.some((l) => l.startsWith('element acme:retry')), lost.join(' | '));
    assert.ok(lost.some((l) => l.startsWith('processing instruction <?acme-lint off?>')), lost.join(' | '));
    // Without a base ('unbased'), extensions bpmn-js does not have are kept as well (bpmn-js never drops
    // extensions of an element it still has, except on replace); what is lost is reported.
    const unbased = renderForDisk({ disk: W1, base: null, out: U1.replace('name="Beta"', 'name="Beta 2"') });
    assert.equal(unbased.mode, 'unbased', unbased.reason);
    assert.ok(!(unbased.lost ?? []).some((l) => /acme/.test(l)), unbased.lost?.join(' | '));
    assert.ok(unbased.text.includes("acme:sla='PT2H'") && unbased.text.includes('acme:retry'));
    // In 'format', kept extensions bpmn-js does not have are reported.
    const unbasedFormat = renderForDisk({ disk: disk2, base: null, out });
    assert.equal(unbasedFormat.mode, 'format', unbasedFormat.reason);
    assert.ok(unbasedFormat.lost.includes('attribute acme:sla in A'), unbasedFormat.lost.join(' | '));
  });

  it('an id that comes back with another model and goes again does not hide its first text (cut, paste, undo, undo)', () => {
    const memory = new Map();
    const gone = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const pasted = bpmnjs(m([taskB('bpmn2:task'), ['bpmn2:task', { id: 'A', name: 'Pasted' }]],
      { flows: [], shapes: [shapeNode('B', '300', '100'), shapeNode('A', '-200', '-200')], edges: [] }));
    const W1 = renderForDisk({ disk: D, base: B, out: gone, memory });
    const W2 = renderForDisk({ disk: W1.text, base: gone, out: pasted, memory });
    const W3 = renderForDisk({ disk: W2.text, base: pasted, out: gone, memory });
    const W4 = renderForDisk({ disk: W3.text, base: gone, out: B, memory });
    assert.deepEqual([W1, W2, W3, W4].map((w) => w.mode), ['minimal', 'minimal', 'minimal', 'minimal']);
    assert.equal(W4.text, D);
  });

  it('delete then undo when bpmn-js brings the element back changed (its flow references re-ordered): old text, patched', () => {
    const memory = new Map();
    const two = (order) => ['bpmn2:task', { id: 'A', name: 'Alpha', 'acme:sla': 'PT2H' }, [
      ['#comment', ' checked by the warehouse '],
      ['bpmn2:documentation', {}, ['<![CDATA[Checks <stock> & more]]>', 'Checks &lt;stock&gt; &amp; more']],
      ['bpmn2:extensionElements', {}, [['acme:retry', { n: '3' }], ['#pi', 'acme-lint off']]],
      ...order.map((f) => ['bpmn2:outgoing', {}, f]),
    ]];
    const flows = [['bpmn2:sequenceFlow', { id: 'F1', sourceRef: 'A', targetRef: 'B' }], ['bpmn2:sequenceFlow', { id: 'F2', sourceRef: 'A', targetRef: 'B' }]];
    const withTwo = (order) => m([two(order), taskB('bpmn2:task')], { flows });
    const disk2 = disk(withTwo(['F1', 'F2']), prolog);
    const base2 = bpmnjs(withTwo(['F1', 'F2']));
    const gone = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const W1 = renderForDisk({ disk: disk2, base: base2, out: gone, memory });
    assert.equal(W1.mode, 'minimal');
    const back = bpmnjs(withTwo(['F2', 'F1'])); // bpmn-js re-adds the references in another order
    const W2 = renderForDisk({ disk: W1.text, base: gone, out: back, memory });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.equal(W2.lost, undefined);
    for (const kept of ['<!-- checked by the warehouse -->', '<?acme-lint off?>', '<![CDATA[Checks <stock> & more]]>', "acme:sla='PT2H'", "<acme:retry n='3'/>"]) {
      assert.ok(W2.text.includes(kept), kept);
    }
    assert.ok(W2.text.indexOf('<bpmn2:outgoing>F2</bpmn2:outgoing>') < W2.text.indexOf('<bpmn2:outgoing>F1</bpmn2:outgoing>'));
    assert.ok(changedLines(disk2, W2.text) <= 2, String(changedLines(disk2, W2.text)));
  });

  it('a remembered element that cannot be used is reported as lost, not dropped silently', () => {
    const memory = new Map([['A', [{
      text: "<bpmn2:task id='A'><!-- only here --></bpmn2:task>", form: 'other', indent: '\t\t', scope: { bpmn2: MODEL },
      after: null, before: null,
    }]]]);
    const out = bpmnjs(m([taskA('bpmn2:task'), taskB('bpmn2:task')]));
    const base = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const diskNoA = renderForDisk({ disk: D, base: B, out: base }).text;
    const { mode, lost } = renderForDisk({ disk: diskNoA, base, out, memory });
    assert.equal(mode, 'minimal');
    assert.deepEqual(lost, ['comment "only here"']);
  });

  it('a type change keeps an entity reference in the element', () => {
    const U = bpmnjs(m([taskA('bpmn2:task'), taskB('bpmn2:userTask')]));
    const { text, mode } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal');
    assert.ok(text.includes("<bpmn2:userTask id='B' name='Beta'>\r\n\t\t\t<bpmn2:documentation>Shipped by &company; logistics</bpmn2:documentation>"));
  });

  it('a move into a sub-process takes the element\'s own text along (comments, PIs, CDATA, entities)', () => {
    const sub = (children) => ['bpmn2:subProcess', { id: 'S' }, children];
    const withSub = disk(m([taskA('bpmn2:task'), taskB('bpmn2:task'), sub([])]), prolog);
    const base = bpmnjs(m([taskA('bpmn2:task'), taskB('bpmn2:task'), sub([])]));
    const out = bpmnjs(m([taskB('bpmn2:task'), sub([taskA('bpmn2:task', {})])]));
    const { text, mode, reason } = renderForDisk({ disk: withSub, base, out });
    assert.equal(mode, 'minimal', reason);
    const moved = disk(m([taskB('bpmn2:task'), sub([taskA('bpmn2:task')])]), prolog);
    assert.equal(text, moved.replace("<bpmn2:subProcess id='S'/>", "<bpmn2:subProcess id='S'></bpmn2:subProcess>"));
    // And with the entity: B into the sub-process.
    const out2 = bpmnjs(m([taskA('bpmn2:task'), sub([taskB('bpmn2:task')])]));
    const r2 = renderForDisk({ disk: withSub, base, out: out2 });
    assert.equal(r2.mode, 'minimal', r2.reason);
    assert.ok(r2.text.includes("\t\t\t<bpmn2:task id='B' name='Beta'>\r\n\t\t\t\t<bpmn2:documentation>Shipped by &company; logistics</bpmn2:documentation>"));
  });

  it('the check refuses a result that turns an entity into text or drops a comment of a moved element', () => {
    const out = bpmnjs(m([taskA('bpmn2:task'), taskB('bpmn2:userTask')]));
    const good = minimalDiff(D, B, out);
    const lostEntity = good.replace('Shipped by &company; logistics', 'Shipped by &amp;company; logistics');
    assert.ok(checkMinimal(load(D), load(B), load(out), load(lostEntity)).some((k) => k.startsWith('text #B')));
    const lostComment = good.replace('<!-- checked by the warehouse -->', '');
    assert.ok(checkMinimal(load(D), load(B), load(out), load(lostComment)).some((k) => k.startsWith('comment #A')));
    const lostExtension = good.replace("<acme:retry n='3'/>", '');
    assert.ok(checkMinimal(load(D), load(B), load(out), load(lostExtension)).length > 0);
  });

  it('two new children of an element that has none on disk: minimal, in bpmn-js\' order', () => {
    // Verifier Q4-impl final round, D1: undo of a delete gave a task that had lost all its references
    // two `<incoming>` back; both were written over the same (empty) content: "overlapping changes".
    const taskC = (refs) => ['bpmn2:task', { id: 'C' }, refs.map((f) => ['bpmn2:incoming', {}, f])];
    const shapes = [shapeNode('A', '100', '100'), shapeNode('B', '300', '100'), shapeNode('C', '500', '100')];
    const before = m([taskA('bpmn2:task'), taskB('bpmn2:task'), taskC([])], { shapes });
    const after = m([taskA('bpmn2:task'), taskB('bpmn2:task'), taskC(['F7', 'F8'])], { shapes });
    for (const empty of ["<bpmn2:task id='C'/>", "<bpmn2:task id='C'>\r\n\t\t</bpmn2:task>"]) {
      const onDisk = disk(before, prolog).replace("<bpmn2:task id='C'/>", empty);
      const { text, mode, reason } = renderForDisk({ disk: onDisk, base: bpmnjs(before), out: bpmnjs(after) });
      assert.equal(mode, 'minimal', reason);
      assert.equal(text, disk(after, prolog));
    }
  });

  // A plane whose first children are the edges of A (a camunda7-loan-approval layout): deleting A cuts
  // two neighbours that each remember the other as theirs.
  const flows2 = [['bpmn2:sequenceFlow', { id: 'F1', sourceRef: 'A', targetRef: 'B' }], ['bpmn2:sequenceFlow', { id: 'F2', sourceRef: 'A', targetRef: 'B' }]];
  const edge = (id) => ['bpmndi:BPMNEdge', { id: `${id}_di`, bpmnElement: id, sourceElement: 'A_di' }, [
    ['di:waypoint', { x: '200', y: '140' }], ['di:waypoint', { x: '300', y: '140' }],
  ]];
  const taskA2 = (order, opts) => {
    const [type, attrs, kids] = taskA('bpmn2:task', opts);
    return [type, attrs, [...kids.filter(([n]) => n !== 'bpmn2:outgoing'), ...order.map((f) => ['bpmn2:outgoing', {}, f])]];
  };
  const taskB2 = ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1'], ['bpmn2:incoming', {}, 'F2']]];
  const planeFirst = (order) => m([taskA2(order), taskB2], {
    flows: flows2, shapes: [], edges: [edge('F1'), edge('F2'), shapeNode('A', '100', '100'), shapeNode('B', '300', '100')],
  });
  // Without A, no edge is left: bpmn-js no longer declares the `di:` namespace.
  const goneA = bpmnjs(m([['bpmn2:task', { id: 'B', name: 'Beta' }]], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }))
    .replace(` xmlns:di="${DDI}"`, '');

  it('delete then undo of an element whose cut neighbours remember each other: all of them back, in place', () => {
    const memory = new Map();
    const onDisk = disk(planeFirst(['F1', 'F2']), prolog);
    const W1 = renderForDisk({ disk: onDisk, base: bpmnjs(planeFirst(['F1', 'F2'])), out: goneA, memory });
    assert.equal(W1.mode, 'minimal', W1.reason);
    // bpmn-js brings it all back as it was: the old text exactly.
    const same = renderForDisk({ disk: W1.text, base: goneA, out: bpmnjs(planeFirst(['F1', 'F2'])), memory: new Map(memory) });
    assert.equal(same.mode, 'minimal', same.reason);
    assert.equal(same.text, onDisk);
    // bpmn-js brings them back changed (references re-ordered, the edges without `sourceElement`):
    // their remembered texts, patched; nothing lost, the edges first in the plane in their order.
    const changed = bpmnjs(planeFirst(['F2', 'F1'])).replaceAll(' sourceElement="A_di"', '');
    const W2 = renderForDisk({ disk: W1.text, base: goneA, out: changed, memory });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.equal(W2.lost, undefined);
    for (const kept of ['<!-- checked by the warehouse -->', '<?acme-lint off?>', '<![CDATA[Checks <stock> & more]]>', "acme:sla='PT2H'", "<acme:retry n='3'/>"]) {
      assert.ok(W2.text.includes(kept), kept);
    }
    assert.ok(W2.text.indexOf("id='F1_di'") < W2.text.indexOf("id='F2_di'") && W2.text.indexOf("id='F2_di'") < W2.text.indexOf("id='A_di'"));
    assert.equal(changedLines(onDisk, W2.text), 6, W2.text); // the two references swapped, two sourceElement
  });

  it('a fallback names what the remembered text of an element brought back would have kept', () => {
    // Verifier Q4-impl final round, D1: 'format' wrote such an element from bpmn-js' output and counted
    // only what the file on disk had, so its comment, PI, CDATA and extensions went without a word.
    const memory = new Map();
    const gone = bpmnjs(m([taskB('bpmn2:task')], { flows: [], shapes: [shapeNode('B', '300', '100')], edges: [] }));
    const W1 = renderForDisk({ disk: D, base: B, out: gone, memory });
    assert.equal(W1.mode, 'minimal');
    // A change next to a comment elsewhere forces 'format' on the undo (of a delete after a type change
    // and back: bpmn-js' model of A lacks the extensions only the file has).
    const disk2 = W1.text.replace('<bpmn2:incoming>F1</bpmn2:incoming>', '<bpmn2:incoming>F1<!-- why --></bpmn2:incoming>');
    const out = bpmnjs(m([taskA('bpmn2:task', { extensions: false, sla: false }), taskB('bpmn2:task')])).replace('<bpmn2:incoming>F1</bpmn2:incoming>', '<bpmn2:incoming>F9</bpmn2:incoming>');
    const { mode, lost, reason } = renderForDisk({ disk: disk2, base: gone, out, memory });
    assert.equal(mode, 'format', reason);
    for (const what of ['comment "why"', 'comment "checked by the warehouse"', 'processing instruction <?acme-lint off?>',
      'a CDATA section in A/documentation[0]', 'attribute acme:sla in A', 'element acme:retry in A/extensionElements[0]']) {
      assert.ok(lost.includes(what), `${what}: ${lost.join(' | ')}`);
    }
  });

  // A collapsed sub-process with its content in a diagram of its own (bpmn-js >= 9).
  const shapeA = (x, y) => ['bpmndi:BPMNShape', { id: 'A_di', bpmnElement: 'A' }, [
    ['#comment', ' placed by hand '], ['dc:Bounds', { x, y, width: '100', height: '80' }],
  ]];
  const withSub = (expanded) => ['bpmn2:definitions', { ...NS, id: 'Defs', targetNamespace: 'http://example.com' }, [
    ['bpmn2:process', { id: 'P', isExecutable: 'false' }, [
      ['bpmn2:subProcess', { id: 'S' }, [['#comment', ' the inner part '], ['bpmn2:task', { id: 'A', name: 'Alpha' }]]],
      ['bpmn2:task', { id: 'B', name: 'Beta' }],
    ]],
    ['bpmndi:BPMNDiagram', { id: 'D1' }, [
      ['bpmndi:BPMNPlane', { id: 'PL', bpmnElement: 'P' }, [
        ['bpmndi:BPMNShape', { id: 'S_di', bpmnElement: 'S', isExpanded: String(expanded) }, [
          ['dc:Bounds', expanded ? { x: '100', y: '100', width: '350', height: '200' } : { x: '200', y: '160', width: '100', height: '80' }],
        ]],
        ...(expanded ? [shapeA('250', '160')] : []),
        shapeNode('B', '600', '100'),
      ]],
    ]],
    ...(expanded ? [] : [['bpmndi:BPMNDiagram', { id: 'D2' }, [['bpmndi:BPMNPlane', { id: 'PL2', bpmnElement: 'S' }, [shapeA('180', '160')]]]]]),
  ]];

  it('expanding a collapsed sub-process: its shapes move out of the diagram bpmn-js removes, with their text', () => {
    // Verifier Q4-impl final round, D2: "moved together with its parent" fell back to 'format'.
    const memory = new Map();
    const collapsed = disk(withSub(false), PROLOG);
    const W1 = renderForDisk({ disk: collapsed, base: bpmnjs(withSub(false)), out: bpmnjs(withSub(true)), memory });
    assert.equal(W1.mode, 'minimal', W1.reason);
    assert.equal(W1.text, disk(withSub(true), PROLOG));
    // Undo (collapse again): the diagram is new again, the shape goes into it with its text.
    const W2 = renderForDisk({ disk: W1.text, base: bpmnjs(withSub(true)), out: bpmnjs(withSub(false)), memory });
    assert.equal(W2.mode, 'minimal', W2.reason);
    assert.equal(W2.text, collapsed);
    const W3 = renderForDisk({ disk: W2.text, base: bpmnjs(withSub(false)), out: bpmnjs(withSub(true)), memory });
    assert.equal(W3.mode, 'minimal', W3.reason);
    assert.equal(W3.text, W1.text);
  });
});

describe('minimal-diff writer: gestures captured in the browser (test/fixtures/q4-captures)', async () => {
  const CAPTURES = new URL('../fixtures/q4-captures/', import.meta.url).pathname;
  // What bpmn-js drops and the file keeps: comments, PIs, CDATA, declaration, DOCTYPE, extensions.
  const kept = (xml) => [...facts(load(xml))].filter(([key, value]) => {
    const [type, , detail] = key.split('\u0000');
    if (/^(comment|pi|cdata|decl|doctype)$/.test(type)) return true;
    const uri = type === 'el' ? /^\{([^}]*)\}/.exec(value)?.[1] : type === 'attr' ? /^\{([^}]*)\}/.exec(detail)?.[1] : '';
    return Boolean(uri) && !/omg\.org|bpmn\.io|w3\.org/.test(uri);
  }).sort(([a], [b]) => (a < b ? -1 : 1));
  const replay = async (name) => {
    const capture = JSON.parse(await readFile(join(CAPTURES, `${name}.json`), 'utf8'));
    const original = await readFile(new URL(`../fixtures/q4/${capture.fixture}`, import.meta.url).pathname, 'utf8');
    const memory = new Map();
    const texts = [original];
    const writes = [];
    let base = capture.baseline;
    for (const { op, out } of capture.steps) {
      const w = renderForDisk({ disk: texts[texts.length - 1], base, out, memory });
      writes.push({ op, ...w });
      texts.push(w.text);
      base = out;
    }
    return { texts, writes };
  };
  const allMinimal = (writes) => {
    for (const w of writes) {
      assert.equal(w.mode, 'minimal', `${w.op}: ${w.reason}`);
      assert.equal(w.lost, undefined, `${w.op}: ${w.lost}`);
    }
  };

  // Verifier Q4-impl final round, D1: delete + undo fell back to 'format' ("overlapping changes", or the
  // check refusing restored edges that were never written) and lost the element's comment, PI, CDATA
  // and kept extensions without a word. [capture, steps before the delete, changed lines allowed]
  for (const [name, beforeDelete, allowed] of [
    ['cn-connect2', 2, 6], ['cn-connectback', 2, 6], ['cn-wrench-connect2', 3, 6], ['c7-plain', 1, 6], ['c7-wrench', 2, 6],
  ]) {
    it(`${name}: delete + undo brings the element back with its own text (minimal, nothing lost)`, async () => {
      const { texts, writes } = await replay(name);
      allMinimal(writes);
      const reference = texts[beforeDelete];
      assert.deepEqual(kept(texts[texts.length - 1]), kept(reference));
      // bpmn-js re-orders a reference on undo, and drops the edges' sourceElement / targetElement.
      assert.ok(changedLines(reference, texts[texts.length - 1]) <= allowed, String(changedLines(reference, texts[texts.length - 1])));
    });
  }

  // Verifier Q4-impl final round, D2: expanding a collapsed sub-process (wrench, or undo of the collapse)
  // fell back to 'format' (75-970 changed lines) and dropped kept extensions of a wrenched task in it.
  it('cn-sub-long: collapse, expand, undo, undo, redo, redo of a new sub-process: minimal, small diffs', async () => {
    const { texts, writes } = await replay('cn-sub-long');
    allMinimal(writes);
    for (const t of texts) assert.deepEqual(kept(t), kept(texts[0]));
    // After 'into' (index 2) and after undo, undo (index 6): the same, up to where the task's shape is.
    assert.ok(changedLines(texts[2], texts[6]) <= 6, String(changedLines(texts[2], texts[6])));
    assert.equal(texts[5], texts[3]); // undo of the expand: collapsed as before
    assert.equal(texts[8], texts[4]); // redo, redo: expanded as before
    for (const [k, limit] of [[3, 30], [4, 20]]) assert.ok(changedLines(texts[k - 1], texts[k]) <= limit, `${k}: ${changedLines(texts[k - 1], texts[k])}`);
  });

  // Verifier Q4-impl round 6: after a wrench, references written back (undo) or added (a new flow, a move
  // back out of a sub-process) went in front of the kept extensionElements: schema-invalid, minimal lost=0.
  it('c8-wrench-flows: wrench, delete both flows, connect again: the new reference after the kept extensions', async () => {
    const { texts, writes } = await replay('c8-wrench-flows');
    allMinimal(writes);
    for (const t of texts) assert.deepEqual(schemaOrderProblems(t), []);
    assert.deepEqual(kept(texts[texts.length - 1]), kept(texts[0]));
  });

  it('cn-wrench-flows-undo: wrench, delete both flows, undo, undo: back to the text after the wrench', async () => {
    const { texts, writes } = await replay('cn-wrench-flows-undo');
    allMinimal(writes);
    for (const t of texts) assert.deepEqual(schemaOrderProblems(t), []);
    assert.deepEqual(kept(texts[texts.length - 1]), kept(texts[0]));
    assert.ok(changedLines(texts[1], texts[5]) <= 2, String(changedLines(texts[1], texts[5])));
  });

  it('cn-wrench-sub-undo, cn-sub-ship-undo: undo of a move into a sub-process puts the task back where it was', async () => {
    // [capture, task, index of the text before the move, changed lines allowed]: bpmn-js re-adds the
    // gateway's reference to the flow it brings back last, and re-measures the gateway's label.
    for (const [name, id, before, allowed] of [['cn-wrench-sub-undo', 'Task_CheckStock', 2, 0], ['cn-sub-ship-undo', 'Task_ShipOrder', 1, 4]]) {
      const { texts, writes } = await replay(name);
      allMinimal(writes);
      for (const t of texts) assert.deepEqual(schemaOrderProblems(t), [], name);
      assert.deepEqual(kept(texts[texts.length - 1]), kept(texts[0]), name);
      assert.equal(lineOf(texts[texts.length - 1], id), lineOf(texts[before], id), name);
      const changed = changedLines(texts[before], texts[texts.length - 1]);
      assert.ok(changed <= allowed, `${name}: ${changed}`);
    }
  });

  // Verifier Q4-impl round 7, D-A: a wrench that keeps the element's tag (another event definition) was
  // written like any edit: the extensions bpmn-js drops on replace (unknown attributes, extensionElements,
  // the re-created DI shape's DI extension and its label's id and style) went, 'minimal' without a note.
  // [capture, element, text that must stay, lines an undo may differ from the original (bpmn-js keeps the
  // label it re-measured, and writes the numbers it changed back its way: 30.0 -> 30)]
  const BZ_START = '_6b5db6a9-037a-49ad-9201-09201e2aaa97';
  const SG_START = 'sid-C069430A-FCD2-404F-B0F8-3A4D85BBB31F';
  /** Per DI shape (by bpmnElement): its DI extensions, label ids and label styles. */
  const diExtras = (xml) => {
    const doc = load(xml);
    const shapes = [...doc.ids.values()].filter((e) => e.uri === DI && e.local === 'BPMNShape');
    return shapes.map((s) => {
      const all = [];
      const visit = (e) => {
        for (const c of e.children.filter((x) => x.kind === 'element')) {
          if (c.uri === DDI && c.local === 'extension') all.push(`${e.local}:extension`);
          if (c.local === 'BPMNLabel') all.push(`label id=${c.attrs.find((a) => a.local === 'id')?.value} style=${c.attrs.find((a) => a.local === 'labelStyle')?.value}`);
          visit(c);
        }
      };
      visit(s);
      return `${s.attrs.find((a) => a.local === 'bpmnElement').value}: ${all.join(', ')}`;
    }).sort();
  };
  for (const [name, id, needles, undoLines] of [
    ['c7m-start-msg', 'StartEvent_1', ['<bpmn:startEvent id="StartEvent_1" camunda:asyncBefore="true" camunda:exclusive="false">'], 0],
    ['bz-start-timer', BZ_START, ['<bizagi:BizagiProperty name="bgColor" value="White" />',
      '<BPMNLabel id="DiagramElement_05d5265d-2b92-499c-a022-e339533d6089" labelStyle="Style_35e829d8-1dc4-443b-8f15-7bfc8038eab5">'], 2],
    ['sg-start-timer', SG_START, ['<signavio:signavioMetaData metaKey="bgcolor" metaValue="#ffffff"/>',
      '<bpmndi:BPMNLabel labelStyle="sid-dc3ba873-47b5-4027-8306-93aeab017ac3">'], 6],
  ]) {
    it(`${name}: a wrench that keeps the tag keeps the extensions bpmn-js drops; undo, redo`, async () => {
      const { texts, writes } = await replay(name);
      allMinimal(writes);
      const [original, wrenched, undone, redone] = texts;
      assert.notEqual(wrenched, original);
      assert.equal(load(wrenched).ids.get(id).local, 'startEvent');
      for (const needle of needles) assert.ok(wrenched.includes(needle), needle);
      for (const t of texts) {
        assert.deepEqual(kept(t), kept(original));
        assert.deepEqual(diExtras(t), diExtras(original));
        assert.deepEqual(schemaOrderProblems(t), []);
      }
      assert.ok(changedLines(original, undone) <= undoLines, String(changedLines(original, undone)));
      assert.equal(redone, wrenched);
    });
  }

  it('bz-task-service: a wrench that changes the tag keeps the DI extension of the shape bpmn-js re-creates; undo', async () => {
    const { texts, writes } = await replay('bz-task-service');
    // The shape keeps its DI extension; bpmn-js re-creates it without a label (a task's label is inside
    // it): the old label goes like one whose name is cleared (and comes back with the undo). Its style
    // goes with it, which is said (verifier Q4-impl round 8; its DI extension is empty, nothing to name).
    assert.deepEqual(writes.map((w) => [w.mode, w.lost]), [
      ['minimal', ['label style Style_6b41969d-9f3b-4d41-be89-6b5b6a905a1d of DiagramElement_57dad906-f70a-4843-ab50-5cf02eabb1e5']],
      ['minimal', undefined],
    ]);
    const [original, wrenched, undone] = texts;
    const id = '_5a972b87-735d-454a-b31c-f52fb3afc5c7';
    assert.equal(load(wrenched).ids.get(id).local, 'serviceTask');
    assert.deepEqual(kept(wrenched), kept(original));
    assert.deepEqual(diExtras(wrenched).filter((s) => !s.startsWith(id)), diExtras(original).filter((s) => !s.startsWith(id)));
    assert.equal(diExtras(wrenched).find((s) => s.startsWith(id)), `${id}: BPMNShape:extension`);
    assert.equal(undone, original);
  });

  // Verifier Q4-impl round 7, D-B: the first <outgoing> of a sub-process went next to its nearest sibling
  // in bpmn-js' output, a flow element that is elsewhere on disk (a start event moved back into it by an
  // undo goes back to its old place, bpmn-js appends it): after a flow element, 'format' fallback.
  it('cn-sub-start-out, cn-sub-start-wrench: a new reference of a sub-process goes in front of its flow elements', async () => {
    for (const name of ['cn-sub-start-out', 'cn-sub-start-wrench']) {
      const { texts, writes } = await replay(name);
      allMinimal(writes);
      for (const t of texts) assert.deepEqual(schemaOrderProblems(t), [], name);
      assert.deepEqual(kept(texts[texts.length - 1]), kept(texts[0]), name);
      assert.ok(changedLines(texts[texts.length - 2], texts[texts.length - 1]) <= 13, name); // reference, task, flow, shape, edge
    }
  });

  it('cn-sub-wrench, cn-sub-del: a wrenched task in the sub-process keeps its kept extensions through collapse, expand, delete, undo', async () => {
    for (const [name, reference] of [['cn-sub-wrench', 1], ['cn-sub-del', 1]]) {
      const { texts, writes } = await replay(name);
      allMinimal(writes);
      assert.deepEqual(kept(texts[texts.length - 1]), kept(texts[reference]), name);
      assert.deepEqual(kept(texts[reference]), kept(texts[0]), name);
    }
  });

  // Verifier Q4-impl round 8, D1: an element an undo brings back goes back to its old place on disk,
  // bpmn-js appends it; a new artifact went next to it (its nearest sibling in bpmn-js' output), i.e.
  // among the flow elements (a group in Bizagi's collaboration: before a participant). Schema-invalid,
  // written as minimal without a note: the order check only knew the head of the sequences.
  // [capture, the new element's type, the elements the schema puts before it in its parent, lines the undo may
  // differ from the original (labels bpmn-js re-measures, references it re-adds last)]
  for (const [name, type, before, undoLines] of [
    ['cn-flow-undo-annotate', 'textAnnotation', /^(startEvent|task|exclusiveGateway|endEvent|sequenceFlow)$/, 0],
    ['cn-task-undo-group', 'group', /^(startEvent|task|exclusiveGateway|endEvent|sequenceFlow)$/, 2],
    ['bz-all-undo-group', 'group', /^(participant|messageFlow)$/, 16],
  ]) {
    it(`${name}: delete, undo, then a new ${type}: after every ${before.source.replace(/[\^$()]/g, '')} (schema order)`, async () => {
      const { texts, writes } = await replay(name);
      allMinimal(writes);
      const [original, , undone, added] = texts;
      // The undo puts everything back where it was (up to labels bpmn-js re-measures and references it re-orders).
      assert.deepEqual(kept(undone), kept(original));
      assert.ok(changedLines(original, undone) <= undoLines, String(changedLines(original, undone)));
      for (const t of texts) assert.deepEqual(schemaOrderProblems(t), [], name);
      assert.deepEqual(await newXsdErrors(added, original), []);
      const el = [...load(added).ids.values()].find((e) => e.local === type && !load(original).ids.has(idOf(e)));
      const siblings = el.parent.children.filter((c) => c.kind === 'element').map((c) => c.local);
      assert.equal(siblings.slice(siblings.indexOf(type)).findIndex((l) => before.test(l)), -1, siblings.join(' '));
      assert.ok(changedLines(undone, added) <= 14, String(changedLines(undone, added)));
    });
  }

  // Verifier Q4-impl round 8, D3: deleting everything in a bpmn-js 7 file with collapsed sub-processes
  // fell back to 'format' (the diagrams bpmn-js makes for them exist only in its view; "cannot find it
  // on disk"). The undo (bpmn-js ≥ 9 brings those diagrams back, so the file gets them) stays minimal.
  it('bd-all-undo: deleting everything with collapsed sub-processes of an older file is minimal, nothing lost', async () => {
    const { texts, writes } = await replay('bd-all-undo');
    allMinimal(writes);
    assert.deepEqual(load(texts[1]).root.children.filter((c) => c.kind === 'element').map((c) => c.local), ['globalTask', 'process', 'BPMNDiagram']);
    for (const t of texts) assert.deepEqual(kept(t), kept(texts[0]));
    for (const t of texts) assert.deepEqual(schemaOrderProblems(t), []);
  });
});

describe('minimal-diff writer: the schema order of children', () => {
  it('the order table is generated from the BPMN 2.0 XSD (scripts/gen-bpmn-schema-order.mjs)', async () => {
    const { generate } = await import('../../scripts/gen-bpmn-schema-order.mjs');
    const committed = await readFile(new URL('../../src/bpmn-schema-order.js', import.meta.url), 'utf8');
    assert.equal(committed, generate(), 'run node scripts/gen-bpmn-schema-order.mjs');
    const { ELEMENTS, SEQUENCES } = await import('../../src/bpmn-schema-order.js');
    const seq = (el) => SEQUENCES[ELEMENTS[el]];
    const inOrder = (list, ...names) => names.every((n, k) => k === 0 || list.indexOf(names[k - 1]) < list.indexOf(n));
    assert.ok(inOrder(seq('bpmn:process'), 'bpmn:documentation', 'bpmn:extensionElements', 'bpmn:ioSpecification', 'bpmn:auditing',
      'bpmn:monitoring', 'bpmn:property', 'bpmn:laneSet', 'bpmn:flowElement', 'bpmn:artifact', 'bpmn:resourceRole',
      'bpmn:correlationSubscription', 'bpmn:supports'));
    assert.ok(inOrder(seq('bpmn:subProcess'), 'bpmn:incoming', 'bpmn:outgoing', 'bpmn:loopCharacteristics', 'bpmn:laneSet', 'bpmn:flowElement', 'bpmn:artifact'));
    assert.ok(inOrder(seq('bpmn:collaboration'), 'bpmn:participant', 'bpmn:messageFlow', 'bpmn:artifact', 'bpmn:conversationNode',
      'bpmn:conversationAssociation', 'bpmn:participantAssociation', 'bpmn:messageFlowAssociation', 'bpmn:correlationKey'));
    assert.deepEqual(seq('bpmn:definitions'), ['bpmn:import', 'bpmn:extension', 'bpmn:rootElement', 'bpmndi:BPMNDiagram', 'bpmn:relationship']);
    assert.deepEqual(seq('bpmndi:BPMNShape'), ['di:extension', 'dc:Bounds', 'bpmndi:BPMNLabel']);
  });

  it('the check refuses children out of order anywhere in a sequence (process, collaboration, definitions, DI)', () => {
    const doc = (body) => `<definitions xmlns="${MODEL}" xmlns:bpmndi="${DI}" xmlns:dc="${DC}" xmlns:di="${DDI}" id="Defs">${body}</definitions>`;
    const ok = doc('<collaboration id="C"><participant id="Pa" processRef="P"/><group id="G"/></collaboration>'
      + '<process id="P"><laneSet id="LS"/><task id="T"/><sequenceFlow id="F" sourceRef="T" targetRef="T"/><textAnnotation id="TA"/></process>'
      + '<bpmndi:BPMNDiagram id="D"><bpmndi:BPMNPlane id="PL"><bpmndi:BPMNShape id="S" bpmnElement="T"><dc:Bounds x="0" y="0" width="1" height="1"/>'
      + '<bpmndi:BPMNLabel labelStyle="LS1"/></bpmndi:BPMNShape></bpmndi:BPMNPlane></bpmndi:BPMNDiagram>');
    assert.deepEqual(schemaOrderProblems(ok), []);
    const swap = (text, a, b) => text.replace(a, '\u0000').replace(b, a).replace('\u0000', b);
    for (const [a, b, problem] of [
      ['<sequenceFlow id="F" sourceRef="T" targetRef="T"/>', '<textAnnotation id="TA"/>', '#P: sequenceFlow after textAnnotation'],
      ['<laneSet id="LS"/>', '<task id="T"/>', '#P: laneSet after task'],
      ['<participant id="Pa" processRef="P"/>', '<group id="G"/>', '#C: participant after group'],
      ['<dc:Bounds x="0" y="0" width="1" height="1"/>', '<bpmndi:BPMNLabel labelStyle="LS1"/>', '#S: dc:Bounds after bpmndi:BPMNLabel'],
    ]) {
      assert.deepEqual(schemaOrderProblems(swap(ok, a, b)), [problem]);
    }
    // The process after the diagram: rootElement after BPMNDiagram.
    const moved = ok.replace(/<process[\s\S]*<\/process>/, '').replace('</definitions>', `${/<process[\s\S]*<\/process>/.exec(ok)[0]}</definitions>`);
    assert.deepEqual(schemaOrderProblems(moved), ['#Defs: process after bpmndi:BPMNDiagram']);
  });

  it('a new artifact goes after every flow element on disk, also when bpmn-js has its flows in another order', () => {
    // On disk F1 is between the tasks (an undo put it back there); bpmn-js appends it, and the new
    // annotation comes after it in bpmn-js' output.
    const tasks = [
      ['bpmn2:task', { id: 'A', name: 'Alpha' }, [['bpmn2:outgoing', {}, 'F1']]],
      ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
    ];
    const flow = ['bpmn2:sequenceFlow', { id: 'F1', sourceRef: 'A', targetRef: 'B' }];
    const note = ['bpmn2:textAnnotation', { id: 'N' }, [['bpmn2:text', {}, 'Note']]];
    const onDisk = disk(model({ tasks: [tasks[0], flow, tasks[1]], flows: [] }));
    const base = bpmnjs(model({ tasks, flows: [flow] }));
    const out = bpmnjs(model({ tasks, flows: [flow, note] }));
    const W = renderForDisk({ disk: onDisk, base, out });
    assert.equal(W.mode, 'minimal', W.reason);
    assert.equal(W.text, disk(model({ tasks: [tasks[0], flow, tasks[1]], flows: [note] })));
    assert.deepEqual(schemaOrderProblems(W.text), []);
  });
});

describe('minimal-diff writer: global elements edited in the properties panel (V2-5)', () => {
  // The properties panel adds bpmn:signal / message / error / escalation to the definitions' root
  // elements (bpmn-js appends them after the processes) and sets signalRef & co. on the event
  // definition. bpmn-js' output is made here the way bpmn-js makes it: bpmn-moddle's toXML.
  const moddle = new BpmnModdle();
  const serialise = async (definitions) => (await moddle.toXML(definitions, { format: true })).xml;
  const read = async (xml) => (await moddle.fromXML(xml)).rootElement;
  const BODY = (roots) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="${MODEL}" xmlns:bpmndi="${DI}" xmlns:dc="${DC}" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
${roots}
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="PL" bpmnElement="P">
      <bpmndi:BPMNShape id="End_di" bpmnElement="End">
        <dc:Bounds x="100" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Throw_di" bpmnElement="Throw">
        <dc:Bounds x="200" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
  const PROCESS = (endDef = '<bpmn:signalEventDefinition id="SED_End" />', throwDef = '<bpmn:signalEventDefinition id="SED_Throw" />') => `  <bpmn:process id="P" isExecutable="false">
    <bpmn:intermediateThrowEvent id="Throw" name="Notify">
      ${throwDef}
    </bpmn:intermediateThrowEvent>
    <bpmn:endEvent id="End" name="Shipped">
      ${endDef}
    </bpmn:endEvent>
  </bpmn:process>`;

  /** Writes bpmn-js' output after `edit(definitions, byId)` for `onDisk`; checks it is minimal, lossless and in schema order. */
  async function write(onDisk, edit) {
    const base = await serialise(await read(onDisk));
    const definitions = await read(onDisk);
    const byId = (id) => {
      const stack = [definitions];
      while (stack.length) {
        const el = stack.pop();
        if (el.id === id) return el;
        for (const value of Object.values(el)) {
          if (Array.isArray(value)) stack.push(...value.filter((v) => v?.$type));
          else if (value?.$type && value !== el.$parent) stack.push(value);
        }
      }
      throw new Error(`no ${id}`);
    };
    edit(definitions, byId);
    const out = await serialise(definitions);
    const W = renderForDisk({ disk: onDisk, base, out });
    assert.equal(W.mode, 'minimal', W.reason);
    assert.equal(W.lost, undefined);
    assert.deepEqual(schemaOrderProblems(W.text), []);
    assert.deepEqual(await newXsdErrors(W.text, onDisk), []);
    return W.text;
  }

  const addRoot = (definitions, type, attrs) => {
    const root = moddle.create(type, attrs);
    root.$parent = definitions;
    definitions.rootElements.push(root);
    return root;
  };

  it('a new signal: one line after the process, signalRef on the event definition', async () => {
    const onDisk = BODY(PROCESS());
    const text = await write(onDisk, (definitions, byId) => {
      byId('SED_End').signalRef = addRoot(definitions, 'bpmn:Signal', { id: 'Signal_1', name: 'OrderShipped' });
    });
    assert.equal(text, onDisk
      .replace('<bpmn:signalEventDefinition id="SED_End" />', '<bpmn:signalEventDefinition id="SED_End" signalRef="Signal_1" />')
      .replace('  </bpmn:process>\n', '  </bpmn:process>\n  <bpmn:signal id="Signal_1" name="OrderShipped" />\n'));
    assert.equal(changedLines(onDisk, text), 3);
  });

  it('signals placed before the process on disk (as some tools write them): a new one, a rename and a second reference', async () => {
    const onDisk = BODY(`  <bpmn:signal id="Signal_A" name="Alpha" />\n${PROCESS('<bpmn:signalEventDefinition id="SED_End" signalRef="Signal_A" />')}`);
    let text = await write(onDisk, (definitions, byId) => {
      byId('SED_Throw').signalRef = addRoot(definitions, 'bpmn:Signal', { id: 'Signal_B', name: 'Beta' });
    });
    assert.match(text, /signalRef="Signal_B"/);
    assert.equal(changedLines(onDisk, text), 3);
    assert.ok(text.indexOf('<bpmn:signal id="Signal_B"') < text.indexOf('<bpmndi:BPMNDiagram'));

    text = await write(onDisk, (definitions, byId) => { byId('Signal_A').name = 'Alpha renamed'; });
    assert.equal(text, onDisk.replace('name="Alpha"', 'name="Alpha renamed"'));

    text = await write(onDisk, (definitions, byId) => { byId('SED_Throw').signalRef = byId('Signal_A'); });
    assert.equal(text, onDisk.replace('<bpmn:signalEventDefinition id="SED_Throw" />', '<bpmn:signalEventDefinition id="SED_Throw" signalRef="Signal_A" />'));

    // Removing the reference ("<none>") leaves the signal.
    text = await write(onDisk, (definitions, byId) => { byId('SED_End').signalRef = undefined; });
    assert.equal(text, onDisk.replace(' signalRef="Signal_A"', ''));
  });

  it('message, error and escalation definitions with their global elements', async () => {
    const onDisk = BODY(PROCESS('<bpmn:messageEventDefinition id="MED_End" />', '<bpmn:escalationEventDefinition id="EED_Throw" />'));
    const text = await write(onDisk, (definitions, byId) => {
      byId('MED_End').messageRef = addRoot(definitions, 'bpmn:Message', { id: 'Message_1', name: 'Shipped' });
      byId('EED_Throw').escalationRef = addRoot(definitions, 'bpmn:Escalation', { id: 'Escalation_1', name: 'Late', escalationCode: 'E1' });
      addRoot(definitions, 'bpmn:Error', { id: 'Error_1', name: 'Boom', errorCode: '500' });
    });
    assert.match(text, /<bpmn:messageEventDefinition id="MED_End" messageRef="Message_1" \/>/);
    assert.match(text, /<bpmn:escalationEventDefinition id="EED_Throw" escalationRef="Escalation_1" \/>/);
    assert.match(text, /<\/bpmn:process>\n {2}<bpmn:message id="Message_1" name="Shipped" \/>\n {2}<bpmn:escalation id="Escalation_1" name="Late" escalationCode="E1" \/>\n {2}<bpmn:error id="Error_1" name="Boom" errorCode="500" \/>\n {2}<bpmndi:BPMNDiagram/);
    assert.equal(changedLines(onDisk, text), 7);
  });

  it('a collaboration first: the new signal still goes after the process, before the diagram', async () => {
    const onDisk = BODY(`  <bpmn:collaboration id="C">\n    <bpmn:participant id="Pa" processRef="P" />\n  </bpmn:collaboration>\n${PROCESS()}`);
    const text = await write(onDisk, (definitions, byId) => {
      byId('SED_End').signalRef = addRoot(definitions, 'bpmn:Signal', { id: 'Signal_1', name: 'OrderShipped' });
    });
    assert.ok(text.indexOf('</bpmn:process>') < text.indexOf('<bpmn:signal id="Signal_1"'));
    assert.ok(text.indexOf('<bpmn:signal id="Signal_1"') < text.indexOf('<bpmndi:BPMNDiagram'));
    assert.equal(changedLines(onDisk, text), 3);
  });

  it('documentation added to an event', async () => {
    const onDisk = BODY(PROCESS());
    const text = await write(onDisk, (definitions, byId) => {
      byId('End').documentation = [moddle.create('bpmn:Documentation', { text: 'Tell the customer.' })];
    });
    assert.match(text, /<bpmn:endEvent id="End" name="Shipped">\n {6}<bpmn:documentation>Tell the customer\.<\/bpmn:documentation>\n {6}<bpmn:signalEventDefinition/);
    assert.equal(changedLines(onDisk, text), 1);
  });
});

describe('minimal-diff writer: waypoints', () => {
  it('bpmn-js inserting waypoints before one that stays: minimal, the kept one in the file\'s spelling', () => {
    const doc = (points) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${MODEL}" xmlns:bpmndi="${DI}" xmlns:omgdi="${DDI}" id="Defs">
   <process id="P"><sequenceFlow id="F" sourceRef="A" targetRef="B"/></process>
   <bpmndi:BPMNDiagram id="D1">
      <bpmndi:BPMNPlane id="PL" bpmnElement="P">
         <bpmndi:BPMNEdge bpmnElement="F" id="F_gui">
${points.map(([x, y]) => `            <omgdi:waypoint x="${x}" y="${y}"/>`).join('\n')}
         </bpmndi:BPMNEdge>
      </bpmndi:BPMNPlane>
   </bpmndi:BPMNDiagram>
</definitions>
`;
    const disk2 = doc([['325.0', '310'], ['419.0', '310']]);
    const base = doc([['325', '310'], ['419', '310']]);
    const out = doc([['360', '330'], ['390', '330'], ['390', '310'], ['419', '310']]);
    const { text, mode, reason } = renderForDisk({ disk: disk2, base, out });
    assert.equal(mode, 'minimal', reason);
    assert.ok(text.includes('<omgdi:waypoint x="419.0" y="310"/>'));
    assert.equal(changedLines(disk2, text), 4);
  });
});

describe('minimal-diff writer: DI that bpmn-js moved on import (collapsed sub-processes of older files)', () => {
  // On disk the event's shape is in the main diagram; bpmn-js >= 9 shows it in a diagram of its own,
  // with other coordinates (offset -125, -1202).
  const shape = (x, y, label = '') => `<bpmndi:BPMNShape id="E_di" bpmnElement="E"><dc:Bounds x="${x}" y="${y}" width="36" height="36" />${label}</bpmndi:BPMNShape>`;
  const doc = (process, plane, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="${MODEL}" xmlns:bpmndi="${DI}" xmlns:dc="${DC}" id="Defs">
  <!-- reviewed by ops -->
  <bpmn:process id="P">
    <bpmn:subProcess id="S">
      ${process}
    </bpmn:subProcess>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="PL" bpmnElement="P">
      <?layout locked="true"?>
      <bpmndi:BPMNShape id="S_di" bpmnElement="S" isExpanded="false"><dc:Bounds x="200" y="1300" width="100" height="80" /></bpmndi:BPMNShape>
      ${plane}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>${extra}
</bpmn:definitions>
`;
  const D = doc('<bpmn:startEvent id="E" />', shape('305', '1362'));
  const migrated = (event, s) => doc(event, '', `
  <bpmndi:BPMNDiagram id="D2">
    <bpmndi:BPMNPlane bpmnElement="S">
      ${s}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`);
  const B = migrated('<bpmn:startEvent id="E" />', shape('180', '160'));

  it('a rename that adds a label writes it moved back by the offset, comments and PIs untouched', () => {
    const U = migrated('<bpmn:startEvent id="E" name="Start" />', shape('180', '160', '<bpmndi:BPMNLabel><dc:Bounds x="162" y="203" width="72" height="14" /></bpmndi:BPMNLabel>'));
    const { text, mode, reason } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal', reason);
    assert.ok(text.includes('<bpmn:startEvent id="E" name="Start" />'));
    assert.match(text, /<bpmndi:BPMNLabel>\s*<dc:Bounds x="287" y="1405" width="72" height="14" \/>\s*<\/bpmndi:BPMNLabel><\/bpmndi:BPMNShape>/);
    assert.ok(text.includes('<!-- reviewed by ops -->') && text.includes('<?layout locked="true"?>'));
    assert.ok(!text.includes('D2'));
  });

  it('a move inside the sub-process is written moved back by the offset', () => {
    const U = migrated('<bpmn:startEvent id="E" />', shape('220', '160'));
    const { text, mode, reason } = renderForDisk({ disk: D, base: B, out: U });
    assert.equal(mode, 'minimal', reason);
    assert.equal(text, D.replace('x="305"', 'x="345"'));
  });
});

describe('minimal-diff reader', () => {
  it('rejects what it does not understand', () => {
    for (const bad of [
      '<a><b></a>', '<a x="1" x="2"/>', '<p:a/>', '<a>&</a>', '<a>&#xZZ;</a>', '<a x=1/>', '<a/><b/>', 'text<a/>',
      '<a><!-- open</a>', '<a', '<a x="<"/>',
    ]) assert.throws(() => parse(bad), XmlError, bad);
    assert.throws(() => load(`<a xmlns="${MODEL}"><b id="x"/><c id="x"/></a>`), /duplicate id/);
  });

  it('expands character references, keeps entity references as written (like bpmn-js), normalises line ends in text', () => {
    const doc = parse('<?xml version="1.0"?>\r\n<!DOCTYPE a [ <!ENTITY co "ACME &#38; Co"> ]>\r\n<a t="x&#10;y\r\nz\tw">&co; &#x1F600;\r\n<![CDATA[<raw>]]></a>');
    // Attribute values as bpmn-js reads them: white space as written (no attribute-value normalisation).
    assert.equal(doc.root.attrs[0].value, 'x\ny\r\nz\tw');
    assert.equal(doc.root.children[0].value, '\u0001co; 😀\n');
    assert.deepEqual([...doc.entities.names], ['co']);
    assert.equal(doc.root.children[1].value, '<raw>');
  });
});

describe('createFileStore with the minimal-diff writer', () => {
  let dir;
  let file;
  let logs;
  const log = (m) => logs.push(m);
  const D = disk(model());
  const B = bpmnjs(model());
  const U = bpmnjs(model({ tasks: [
    ['bpmn2:task', { id: 'A', name: 'Renamed' }, [['bpmn2:outgoing', {}, 'F1']]],
    ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
  ] }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-q4-store-'));
    file = join(dir, 'p.bpmn');
    await writeFile(file, D);
    logs = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes only the edit once it has the base; \'saved\' reports the editor\'s XML', async () => {
    const store = createFileStore(file, { debounceMs: 10, log, render: renderForDisk, debugWrites: true });
    await store.read();
    assert.equal(store.setBaseline(D, B), true);
    const saved = [];
    store.on('saved', ({ xml }) => saved.push(xml));
    store.write(U);
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), D.replace("name='Alpha'", "name='Renamed'"));
    assert.equal(store.diskXml, D.replace("name='Alpha'", "name='Renamed'"));
    assert.deepEqual(saved, [U]);
    assert.equal(store.writerStats.minimal, 1);
    assert.match(logs.join(''), /debug: write mode=minimal ms=\d+\n/);
    // The next write uses the XML just written from as its base.
    const U2 = U.replace('name="Beta"', 'name="Beta 2"');
    store.write(U2);
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), D.replace("name='Alpha'", "name='Renamed'").replace("name='Beta'", "name='Beta 2'"));
    assert.equal(store.writerStats.minimal, 2);
    assert.ok(!logs.join('').includes('note:') && !logs.join('').includes('warning:'));
  });

  it('ignores a base for other text, and drops it when the file changes on disk', async () => {
    const store = createFileStore(file, { debounceMs: 10, settleMs: 30, log, render: renderForDisk });
    await store.read();
    assert.equal(store.setBaseline(D.replace('Alpha', 'Other'), B), false);
    await store.watch();
    try {
      assert.equal(store.setBaseline(D, B), true);
      const changed = D.replace("name='Beta'", "name='Beta on disk'");
      const seen = new Promise((resolve) => store.once('external-change', resolve));
      await writeFile(file, changed);
      await seen;
      store.write(U);
      await store.flush();
      assert.equal(store.writerStats.unbased, 1); // the base was for the old text
      assert.match(logs.join(''), /note: saved p\.bpmn without the editor's reading of the file on disk \(the editor had not told bpmn-edit yet how it reads the file\)/);
    } finally {
      await store.unwatch();
    }
  });

  it('names what a fallback could not keep, on every save that loses it', async () => {
    const disk2 = D.replace('<bpmn2:outgoing>F1</bpmn2:outgoing>', '<bpmn2:outgoing>F1<!-- why --></bpmn2:outgoing>');
    await writeFile(file, disk2);
    const store = createFileStore(file, { debounceMs: 10, log, render: renderForDisk });
    await store.read();
    store.setBaseline(disk2, B);
    const lostEvents = [];
    store.on('rendered', ({ mode, lost }) => lostEvents.push([mode, lost]));
    store.write(B.replace('<bpmn2:outgoing>F1</bpmn2:outgoing>', '<bpmn2:outgoing>F9</bpmn2:outgoing>'));
    await store.flush();
    assert.deepEqual(lostEvents, [['format', ['comment "why"']]]);
    assert.match(logs.join(''), /note: could not change only the edited parts of p\.bpmn \(#A\/outgoing\[0\]: text next to a comment\)/);
    assert.match(logs.join(''), /warning: this save of p\.bpmn could not keep this from the file: comment "why"\n/);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes('<!-- the happy path -->') && text.includes('<?lint ignore?>'));
  });

  it('without `render` writes the XML as it is', async () => {
    const store = createFileStore(file, { debounceMs: 10, log });
    await store.read();
    store.write(U);
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), U);
  });
});

describe('Session.diskTextOf', () => {
  it('remembers the versions read from disk, not the edits', () => {
    const D = disk(model());
    const session = new Session({ xml: D });
    assert.equal(session.diskTextOf(1), D);
    const edited = D.replace('Alpha', 'Edited');
    const v = session.applyUpdate(edited, 1);
    assert.equal(session.diskTextOf(v), undefined);
    const fromDisk = D.replace('Beta', 'Disk');
    const w = session.replaceFromDisk(fromDisk);
    assert.equal(session.diskTextOf(w), fromDisk);
  });
});

describe("server: 'baseline' messages", () => {
  let dir;
  let file;
  let server;
  let store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-q4-ws-'));
    file = join(dir, 'p.bpmn');
    await writeFile(file, disk(model()));
    store = createFileStore(file, { debounceMs: 10, log: () => {}, render: renderForDisk });
    server = createServer({ filePath: file, session: new Session({ xml: await store.read(), store }), port: 0 });
    await server.listen();
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const inbox = [];
    ws.on('message', (data) => inbox.push(JSON.parse(data.toString())));
    const next = async (type) => {
      for (let i = 0; i < 200; i++) {
        const k = inbox.findIndex((m) => m.type === type);
        if (k >= 0) return inbox.splice(k, 1)[0];
        await delay(10);
      }
      throw new Error(`no ${type}`);
    };
    return { ws, next, opened: new Promise((resolve) => ws.once('open', resolve)) };
  }

  it("a client's baseline for the version on disk is the writer's base", async () => {
    const c = connect();
    await c.opened;
    const init = await c.next('init');
    c.ws.send(JSON.stringify({ type: 'baseline', version: init.version, xml: bpmnjs(model()) }));
    const U = bpmnjs(model({ tasks: [
      ['bpmn2:task', { id: 'A', name: 'Renamed' }, [['bpmn2:outgoing', {}, 'F1']]],
      ['bpmn2:task', { id: 'B', name: 'Beta' }, [['bpmn2:incoming', {}, 'F1']]],
    ] }));
    c.ws.send(JSON.stringify({ type: 'update', xml: U, baseVersion: init.version }));
    await c.next('ack');
    await c.next('saved');
    assert.equal(await readFile(file, 'utf8'), disk(model()).replace("name='Alpha'", "name='Renamed'"));
    assert.equal(store.writerStats.minimal, 1);
    c.ws.send(JSON.stringify({ type: 'baseline', version: 'x' }));
    assert.equal((await c.next('error')).code, 'bad-message');
    c.ws.close();
  });

  it('a baseline for a version that is not on disk is ignored', async () => {
    const c = connect();
    await c.opened;
    const init = await c.next('init');
    c.ws.send(JSON.stringify({ type: 'baseline', version: init.version + 5, xml: bpmnjs(model()) }));
    const U = bpmnjs(model()).replace('name="Alpha"', 'name="Renamed"');
    c.ws.send(JSON.stringify({ type: 'update', xml: U, baseVersion: init.version }));
    await c.next('saved');
    assert.equal(store.writerStats.unbased, 1);
    c.ws.close();
  });
});

// Keep the corpus list in step with the fixtures directory.
it('the captured corpus covers every Q4 fixture', async () => {
  const fixtures = (await readdir(new URL('../fixtures/q4/', import.meta.url).pathname)).filter((n) => n.endsWith('.bpmn')).sort();
  const runs = JSON.parse(await readFile(join(EVIDENCE, 'runs.json'), 'utf8')).map((r) => r.fixture).sort();
  assert.deepEqual(runs, fixtures);
});
