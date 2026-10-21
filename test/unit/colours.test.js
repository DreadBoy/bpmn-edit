// V2-6: colours (bpmn-js-color-picker → modeling.setColor) through the minimal-diff writer.
// bpmn-js serialises with bpmn-moddle; these tests use the same bpmn-moddle (the version bpmn-js
// depends on) in Node to produce bpmn-js' base and output, and set colours the way bpmn-js'
// SetColorHandler does: on a shape `background-color`, `border-color` and the legacy `fill`, `stroke`;
// on a connection `border-color` and `stroke`; on a label (BPMNLabel) `color`. The colour picker passes
// lower-case hex values (bpmn-js normalises through a canvas) and undefined for "Default".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BpmnModdle } from 'bpmn-moddle';
import { load, renderForDisk } from '../../src/minimal-diff.js';

const FIXTURES = new URL('../fixtures/colours/', import.meta.url).pathname;
const BIOC = 'http://bpmn.io/schema/bpmn/biocolor/1.0';
const COLOR = 'http://www.omg.org/spec/BPMN/non-normative/color/1.0';
const BLUE = { fill: '#bbdefb', stroke: '#0d4372' };
const GREEN = { fill: '#c8e6c9', stroke: '#205022' };
const DEFAULT = { fill: undefined, stroke: undefined };

/** Lines added + deleted between two texts (line-based LCS). */
function changedLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const t = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return x.length + y.length - 2 * t[0][0];
}

/** Count of `needle` in `text`. */
const count = (text, needle) => text.split(needle).length - 1;

/**
 * An editing session like the browser's: the file on disk, bpmn-js' model of it and the base the
 * writer gets. `edit(fn)` changes the model, serialises it like bpmn-js and writes it like the store
 * (base after a write = the XML it was written from).
 */
async function open(name) {
  const moddle = new BpmnModdle();
  const disk = readFileSync(FIXTURES + name, 'utf8');
  const { rootElement: defs } = await moddle.fromXML(disk);
  const serialise = async () => (await moddle.toXML(defs, { format: true })).xml;
  const memory = new Map();
  const session = {
    original: disk,
    disk,
    base: await serialise(),
    modes: [],
    di(id) {
      const di = defs.diagrams.flatMap((d) => d.plane.planeElement).find((e) => e.bpmnElement.id === id);
      assert.ok(di, `no DI for ${id}`);
      return di;
    },
    element(id) {
      return session.di(id).bpmnElement;
    },
    async edit(fn) {
      fn(session);
      const out = await serialise();
      const result = renderForDisk({ disk: session.disk, base: session.base, out, memory });
      session.modes.push(result.mode);
      assert.equal(result.mode, 'minimal', `write mode ${result.mode}: ${result.reason ?? ''}`);
      assert.equal(result.lost, undefined, `lost: ${result.lost}`);
      session.disk = result.text;
      session.base = out;
      return result.text;
    },
    /** bpmn-js' modeling.setColor(elements, colors). */
    setColor(ids, { fill, stroke }) {
      for (const id of ids) {
        const di = session.di(id);
        const props = di.$type === 'bpmndi:BPMNEdge'
          ? { 'border-color': stroke, stroke }
          : { 'background-color': fill, 'border-color': stroke, stroke, fill };
        for (const [key, value] of Object.entries(props)) di.set(key, value);
      }
    },
    /** bpmn-js' modeling.setColor on an external label: its BPMNLabel's color:color. */
    setLabelColor(id, { stroke }) {
      session.di(id).label.set('color', stroke);
    },
  };
  return session;
}

/** Prefixes the root of `text` binds to `uri`. */
function rootPrefixes(text, uri) {
  return Object.entries(load(text).root.nsDecls).filter(([, u]) => u === uri).map(([p]) => p);
}

describe('colours: the vendored colour picker', () => {
  const VENDOR = new URL('../../web/vendor/bpmn-js-color-picker/', import.meta.url).pathname;

  it('is the installed version, a small bundle that only defines the plugin module (no second bpmn-js)', () => {
    const installed = JSON.parse(readFileSync(new URL('../../node_modules/bpmn-js-color-picker/package.json', import.meta.url), 'utf8')).version;
    assert.equal(readFileSync(VENDOR + 'VERSION', 'utf8'), `${installed}\n`);
    const bundle = readFileSync(VENDOR + 'color-picker.min.js', 'utf8');
    assert.ok(bundle.length < 10_000, `${bundle.length} bytes`);
    assert.ok(bundle.includes('window.BpmnColorPickerModule='));
    assert.ok(bundle.includes('colorContextPadProvider') && bundle.includes('colorPopupProvider'));
    // Modules a second copy of diagram-js / bpmn-js would define.
    for (const service of ['eventBus', 'elementRegistry', 'commandStack', 'bpmnRenderer']) {
      assert.ok(!bundle.includes(`${service}:[`), service);
    }
    const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('vendor/bpmn-js/bpmn-modeler.production.min.js') < html.indexOf('vendor/bpmn-js-color-picker/color-picker.min.js'));
    assert.ok(html.includes('<link rel="stylesheet" href="vendor/bpmn-js-color-picker/color-picker.css">'));
  });
});

describe('colours: an uncoloured file', () => {
  it('colours a task, a gateway and a flow in place and declares bioc: and color: once on the root', async () => {
    const s = await open('plain.bpmn');
    const text = await s.edit(() => s.setColor(['Task_Review', 'Gateway_Ok', 'Flow_Yes'], BLUE));
    assert.deepEqual(rootPrefixes(text, BIOC), ['bioc']);
    assert.deepEqual(rootPrefixes(text, COLOR), ['color']);
    assert.equal(count(text, `xmlns:bioc="${BIOC}"`), 1);
    assert.equal(count(text, `xmlns:color="${COLOR}"`), 1);
    assert.ok(text.includes('<bpmndi:BPMNShape id="Task_Review_di" bpmnElement="Task_Review" bioc:stroke="#0d4372" bioc:fill="#bbdefb" color:background-color="#bbdefb" color:border-color="#0d4372">'));
    assert.ok(text.includes('<bpmndi:BPMNShape id="Gateway_Ok_di" bpmnElement="Gateway_Ok" isMarkerVisible="true" bioc:stroke="#0d4372" bioc:fill="#bbdefb" color:background-color="#bbdefb" color:border-color="#0d4372">'));
    assert.ok(text.includes('<bpmndi:BPMNEdge id="Flow_Yes_di" bpmnElement="Flow_Yes" bioc:stroke="#0d4372" color:border-color="#0d4372">'));
    // The root line (declarations) and the three DI start tags: 4 lines changed, 8 in a diff.
    assert.equal(changedLines(s.original, text), 8);
  });

  it('colours every kind of element (lane, pool, data object, sub-process and its task, events, flows) in one edit', async () => {
    const s = await open('plain.bpmn');
    const all = ['Participant_Team', 'Lane_Author', 'Lane_Editor', 'StartEvent_Draft', 'Task_Review', 'Gateway_Ok', 'EndEvent_Done',
      'SubProcess_Fix', 'Task_Fix', 'DataObjectReference_Notes', 'Flow_ToReview', 'Flow_ToGateway', 'Flow_Yes', 'Flow_No', 'Flow_Back'];
    const text = await s.edit(() => s.setColor(all, GREEN));
    assert.equal(changedLines(s.original, text), 2 * (all.length + 1));
    assert.equal(count(text, 'bioc:stroke="#205022"'), all.length);
    assert.equal(count(text, 'bioc:fill="#c8e6c9"'), all.length - 5);
  });

  it('"Default" removes the attributes and the declarations it added: the file is as before', async () => {
    const s = await open('plain.bpmn');
    await s.edit(() => s.setColor(['Task_Review', 'Gateway_Ok', 'Flow_Yes'], BLUE));
    const back = await s.edit(() => s.setColor(['Task_Review', 'Gateway_Ok', 'Flow_Yes'], DEFAULT));
    assert.equal(back, s.original);
  });

  it('keeps the declarations while any colour is left', async () => {
    const s = await open('plain.bpmn');
    await s.edit(() => s.setColor(['Task_Review', 'Flow_Yes'], BLUE));
    const text = await s.edit(() => s.setColor(['Task_Review'], DEFAULT));
    assert.equal(count(text, `xmlns:bioc="${BIOC}"`), 1);
    assert.equal(count(text, `xmlns:color="${COLOR}"`), 1);
    assert.ok(!text.includes('bioc:fill'));
    assert.equal(changedLines(s.original, text), 4);
    const none = await s.edit(() => s.setColor(['Flow_Yes'], DEFAULT));
    assert.equal(none, s.original);
  });

  it('recolouring changes the values in place; undo-like steps back give the earlier texts', async () => {
    const s = await open('plain.bpmn');
    const blue = await s.edit(() => s.setColor(['Task_Review'], BLUE));
    const green = await s.edit(() => s.setColor(['Task_Review'], GREEN));
    assert.equal(changedLines(blue, green), 2);
    assert.equal(await s.edit(() => s.setColor(['Task_Review'], BLUE)), blue); // undo of the recolour
    assert.equal(await s.edit(() => s.setColor(['Task_Review'], DEFAULT)), s.original); // undo of the colour
    assert.equal(await s.edit(() => s.setColor(['Task_Review'], BLUE)), blue); // redo
  });

  it('colours an external label (color:color on its BPMNLabel) and takes it off again', async () => {
    const s = await open('plain.bpmn');
    const text = await s.edit(() => s.setLabelColor('Gateway_Ok', BLUE));
    assert.ok(text.includes('<bpmndi:BPMNLabel color:color="#0d4372">'));
    assert.deepEqual(rootPrefixes(text, COLOR), ['color']);
    assert.deepEqual(rootPrefixes(text, BIOC), []);
    assert.equal(changedLines(s.original, text), 4);
    assert.equal(await s.edit(() => s.setLabelColor('Gateway_Ok', DEFAULT)), s.original);
  });

  it('declares the namespaces in the file\'s layout (one attribute per line)', async () => {
    const moddleFile = 'plain.bpmn';
    const s = await open(moddleFile);
    // Same diagram with the root's attributes one per line, like test/fixtures/order.bpmn.
    s.disk = s.disk.replace(/<bpmn:definitions [^>]*>/, (tag) => tag.replace(/" /g, '"\n                  '));
    s.original = s.disk;
    const text = await s.edit(() => s.setColor(['Task_Review'], BLUE));
    assert.ok(text.includes(`modeler:executionPlatformVersion="8.8.0"\n                  xmlns:bioc="${BIOC}"\n                  xmlns:color="${COLOR}">`));
    assert.equal(await s.edit(() => s.setColor(['Task_Review'], DEFAULT)), s.original);
  });
});

describe('colours: files coloured by Camunda Modeler / bpmn.io', () => {
  for (const name of ['camunda-coloured.bpmn', 'bioc-only.bpmn', 'color-only.bpmn', 'other-prefixes.bpmn']) {
    it(`${name}: an unrelated edit keeps every colour byte for byte`, async () => {
      const s = await open(name);
      const text = await s.edit(() => { s.element('Task_Fix').name = 'Fix it now'; });
      assert.equal(changedLines(s.original, text), 2);
      assert.equal(text, s.original.replace('name="Fix it" />', 'name="Fix it now" />'));
    });

    it(`${name}: "Default" on one element removes only its attributes`, async () => {
      const s = await open(name);
      const before = s.original.split('\n').find((line) => line.includes('id="Task_Review_di"'));
      const text = await s.edit(() => s.setColor(['Task_Review'], DEFAULT));
      assert.equal(changedLines(s.original, text), 2);
      assert.ok(text.includes('<bpmndi:BPMNShape id="Task_Review_di" bpmnElement="Task_Review">'), before);
    });
  }

  it('camunda-coloured.bpmn: removing every colour removes the declarations too (bpmn-js drops them)', async () => {
    const s = await open('camunda-coloured.bpmn');
    const text = await s.edit(() => {
      s.setColor(['Task_Review', 'Gateway_Ok', 'Lane_Editor', 'DataObjectReference_Notes', 'Flow_Yes'], DEFAULT);
      s.setLabelColor('Gateway_Ok', DEFAULT);
    });
    assert.equal(text, readFileSync(FIXTURES + 'plain.bpmn', 'utf8'));
  });

  it('camunda-coloured.bpmn: a label colour (color:color on BPMNLabel) is changed in place', async () => {
    const s = await open('camunda-coloured.bpmn');
    const text = await s.edit(() => s.setLabelColor('Gateway_Ok', GREEN));
    assert.equal(changedLines(s.original, text), 2);
    assert.ok(text.includes('<bpmndi:BPMNLabel color:color="#205022">'));
  });

  it('bioc-only.bpmn: a new colour reuses bioc: and adds only color:', async () => {
    const s = await open('bioc-only.bpmn');
    const text = await s.edit(() => s.setColor(['Task_Fix'], GREEN));
    assert.deepEqual(rootPrefixes(text, BIOC), ['bioc']);
    assert.deepEqual(rootPrefixes(text, COLOR), ['color']);
    // The older shapes keep their bioc-only colours; the new one has both.
    assert.ok(text.includes('bpmnElement="Task_Review" bioc:stroke="#0d4372" bioc:fill="#bbdefb">'));
    assert.ok(text.includes('bpmnElement="Task_Fix" bioc:stroke="#205022" bioc:fill="#c8e6c9" color:background-color="#c8e6c9" color:border-color="#205022">'));
    assert.equal(changedLines(s.original, text), 4);
  });

  it('color-only.bpmn: a new colour reuses color: and adds only bioc:', async () => {
    const s = await open('color-only.bpmn');
    const text = await s.edit(() => s.setColor(['Task_Fix'], GREEN));
    assert.deepEqual(rootPrefixes(text, BIOC), ['bioc']);
    assert.deepEqual(rootPrefixes(text, COLOR), ['color']);
    assert.equal(changedLines(s.original, text), 4);
  });

  it('other-prefixes.bpmn: colours are written with the file\'s own prefixes, nothing declared', async () => {
    const s = await open('other-prefixes.bpmn');
    const text = await s.edit(() => s.setColor(['Task_Fix', 'Flow_No'], GREEN));
    assert.deepEqual(rootPrefixes(text, BIOC), ['bc']);
    assert.deepEqual(rootPrefixes(text, COLOR), ['omgc']);
    assert.ok(!text.includes('xmlns:bioc') && !text.includes('xmlns:color'));
    assert.ok(text.includes('bpmnElement="Task_Fix" bc:stroke="#205022" bc:fill="#c8e6c9" omgc:background-color="#c8e6c9" omgc:border-color="#205022">'));
    assert.ok(text.includes('bpmnElement="Flow_No" bc:stroke="#205022" omgc:border-color="#205022">'));
    assert.equal(changedLines(s.original, text), 4);
  });

  it('a colour namespace the file declares but does not use is kept (bpmn-js never had it)', async () => {
    const s = await open('plain.bpmn');
    s.disk = s.disk.replace(' xmlns:di=', ` xmlns:bioc="${BIOC}" xmlns:di=`);
    s.original = s.disk;
    const text = await s.edit(() => { s.element('Task_Fix').name = 'Fix it now'; });
    assert.equal(count(text, `xmlns:bioc="${BIOC}"`), 1);
    assert.equal(changedLines(s.original, text), 2);
  });
});
