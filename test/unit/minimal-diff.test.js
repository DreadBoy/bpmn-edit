import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createFileStore } from '../../src/file.js';
import {
  checkForms, checkMinimal, checkModel, detectStyle, escapeAttr, facts, load, minimalDiff, parse, preserveFormat,
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
    // And without a base ('unbased'), kept extensions bpmn-js does not have are reported too.
    const unbased = renderForDisk({ disk: W1, base: null, out: U1.replace('name="Beta"', 'name="Beta 2"') });
    assert.equal(unbased.mode, 'unbased', unbased.reason);
    assert.ok(unbased.lost.includes('attribute acme:sla in A'), unbased.lost.join(' | '));
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

  it('expands character references, keeps entity references as written (like bpmn-js) and normalises line ends', () => {
    const doc = parse('<?xml version="1.0"?>\r\n<!DOCTYPE a [ <!ENTITY co "ACME &#38; Co"> ]>\r\n<a t="x&#10;y\r\nz">&co; &#x1F600;\r\n<![CDATA[<raw>]]></a>');
    assert.equal(doc.root.attrs[0].value, 'x\ny z');
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
