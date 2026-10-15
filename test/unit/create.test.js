import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { BLANK_DIAGRAM } from '../../src/blank.js';
import { askYesNo, CreateError, ensureFile, hasBpmnExtension } from '../../src/create.js';
import { hasBalancedTags, isCompleteBpmn, looksLikeBpmn, readBpmnFile } from '../../src/file.js';
import { renderForDisk } from '../../src/minimal-diff.js';

// What bpmn-js 18 saves after the blank diagram's start event is named "Order received" and a task is
// connected to it (captured in Chrome from the editor).
const EDITED = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Order received">
      <bpmn:outgoing>Flow_1xwj20h</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Activity_0f3nekh">
      <bpmn:incoming>Flow_1xwj20h</bpmn:incoming>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow_1xwj20h" sourceRef="StartEvent_1" targetRef="Activity_0f3nekh" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="102" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="134" y="145" width="73" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Activity_0f3nekh_di" bpmnElement="Activity_0f3nekh">
        <dc:Bounds x="250" y="80" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1xwj20h_di" bpmnElement="Flow_1xwj20h">
        <di:waypoint x="188" y="120" />
        <di:waypoint x="250" y="120" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

describe('BLANK_DIAGRAM', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-unit-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('is BPMN with one start event in a non-executable process, drawn on the diagram', () => {
    assert.ok(looksLikeBpmn(BLANK_DIAGRAM));
    assert.ok(isCompleteBpmn(BLANK_DIAGRAM));
    assert.ok(hasBalancedTags(BLANK_DIAGRAM));
    assert.match(BLANK_DIAGRAM, /<bpmn:process id="Process_1" isExecutable="false">\s*<bpmn:startEvent id="StartEvent_1" \/>\s*<\/bpmn:process>/);
    assert.match(BLANK_DIAGRAM, /<bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">/);
    assert.match(BLANK_DIAGRAM, /<bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">\s*<dc:Bounds [^>]+\/>/);
    assert.ok(BLANK_DIAGRAM.endsWith('</bpmn:definitions>\n'));
  });

  it('passes the startup check', async () => {
    const file = join(dir, 'blank.bpmn');
    await writeFile(file, BLANK_DIAGRAM);
    assert.equal(await readBpmnFile(file), BLANK_DIAGRAM);
  });

  it('is saved by the minimal-diff writer (no fallback), keeping its final newline', () => {
    // The editor's own serialisation of the blank diagram is the template without the final newline.
    for (const base of [BLANK_DIAGRAM.trimEnd(), null]) {
      const result = renderForDisk({ disk: BLANK_DIAGRAM, base, out: EDITED, memory: new Map() });
      assert.equal(result.mode, base === null ? 'unbased' : 'minimal');
      assert.equal(result.lost, undefined);
      assert.equal(result.text, `${EDITED}\n`);
    }
  });
});

describe('hasBpmnExtension', () => {
  it('accepts .bpmn in any letter case and rejects other names', () => {
    for (const ok of ['a.bpmn', 'dir/Order.BPMN', 'x.Bpmn', 'a.b.bpmn']) assert.equal(hasBpmnExtension(ok), true, ok);
    for (const bad of ['a.xml', 'a.bpmn2', 'a.bpmn.txt', 'bpmn', '.bpmn', 'dir/.bpmn', 'a.bpm']) assert.equal(hasBpmnExtension(bad), false, bad);
  });
});

describe('ensureFile', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'bpmn-edit-unit-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  const never = () => assert.fail('must not ask');

  it('leaves an existing file alone (with and without create), whatever its name', async () => {
    const file = join(dir, 'existing.txt');
    await writeFile(file, 'not even BPMN');
    for (const create of [false, true]) {
      assert.deepEqual(await ensureFile({ path: file, create, interactive: true, ask: never }), { created: false });
      assert.equal(await readFile(file, 'utf8'), 'not even BPMN');
    }
  });

  it('not interactive: refuses with the --create hint and writes nothing', async () => {
    const file = join(dir, 'quiet.bpmn');
    await assert.rejects(ensureFile({ path: file, interactive: false, ask: never }), (err) => {
      assert.ok(err instanceof CreateError);
      assert.equal(err.message, `File not found: ${file} (pass --create to create it)`);
      return true;
    });
    assert.ok(!(await readdir(dir)).includes('quiet.bpmn'));
  });

  it('create: writes the blank diagram without asking', async () => {
    const file = join(dir, 'made.bpmn');
    assert.deepEqual(await ensureFile({ path: file, create: true, ask: never }), { created: true });
    assert.equal(await readFile(file, 'utf8'), BLANK_DIAGRAM);
  });

  it('interactive: asks with the path, creates on yes, refuses on no', async () => {
    const yes = join(dir, 'yes.bpmn');
    const questions = [];
    assert.deepEqual(await ensureFile({
      path: yes, interactive: true, ask: async (q) => { questions.push(q); return true; },
    }), { created: true });
    assert.deepEqual(questions, [`${yes} does not exist. Create it? [y/N] `]);
    assert.equal(await readFile(yes, 'utf8'), BLANK_DIAGRAM);

    const no = join(dir, 'no.bpmn');
    await assert.rejects(ensureFile({ path: no, interactive: true, ask: async () => false }), {
      name: 'Error', message: `${no} was not created`,
    });
    assert.ok(!(await readdir(dir)).includes('no.bpmn'));
  });

  it('refuses a name not ending in .bpmn before asking, even with create', async () => {
    for (const name of ['new.xml', 'new.bpmn2', 'new']) {
      const file = join(dir, name);
      for (const create of [false, true]) {
        await assert.rejects(ensureFile({ path: file, create, interactive: true, ask: never }), {
          message: `cannot create ${file}: the name must end in .bpmn`,
        });
      }
      assert.ok(!(await readdir(dir)).includes(name));
    }
    assert.deepEqual(await ensureFile({ path: join(dir, 'upper.BPMN'), create: true }), { created: true });
  });

  it('never creates folders', async () => {
    const file = join(dir, 'missing', 'deeper', 'new.bpmn');
    await assert.rejects(ensureFile({ path: file, create: true }), {
      message: `cannot create ${file}: folder ${join(dir, 'missing', 'deeper')} does not exist (bpmn-edit does not create folders)`,
    });
    const blocker = join(dir, 'plain-file');
    await writeFile(blocker, 'x');
    await assert.rejects(ensureFile({ path: join(blocker, 'new.bpmn'), create: true, interactive: true, ask: never }), {
      message: `cannot create ${join(blocker, 'new.bpmn')}: ${blocker} is not a folder`,
    });
    assert.ok(!(await readdir(dir)).includes('missing'));
  });

  it('never overwrites a file that appears while the question is open', async () => {
    const file = join(dir, 'race.bpmn');
    const result = await ensureFile({
      path: file,
      interactive: true,
      ask: async () => {
        await writeFile(file, 'written meanwhile');
        return true;
      },
    });
    assert.deepEqual(result, { created: false });
    assert.equal(await readFile(file, 'utf8'), 'written meanwhile');
  });

  it('says so when the folder disappears while the question is open', async () => {
    const sub = join(dir, 'vanishing');
    await mkdir(sub);
    const file = join(sub, 'new.bpmn');
    await assert.rejects(ensureFile({
      path: file, interactive: true, ask: async () => { await rm(sub, { recursive: true }); return true; },
    }), { message: `cannot create ${file}: folder ${sub} does not exist (bpmn-edit does not create folders)` });
  });
});

describe('askYesNo', () => {
  async function answer(typed, { end = false } = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (d) => { shown += d; });
    const result = askYesNo('Create it? [y/N] ', { input, output });
    if (typed !== null) input.write(typed);
    if (end) input.end();
    return { result: await result, shown };
  }

  it('is yes only for y/yes in any case', async () => {
    for (const typed of ['y\n', 'Y\n', 'yes\n', 'YES\n', ' yes \n']) assert.equal((await answer(typed)).result, true, typed);
    for (const typed of ['n\n', '\n', 'no\n', 'maybe\n', 'yess\n', 'ja\n']) assert.equal((await answer(typed)).result, false, typed);
  });

  it('shows the question and is no at end of input', async () => {
    const { result, shown } = await answer(null, { end: true });
    assert.equal(result, false);
    assert.ok(shown.startsWith('Create it? [y/N] '));
  });
});
