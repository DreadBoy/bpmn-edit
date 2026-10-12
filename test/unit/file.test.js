import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { looksLikeBpmn, readBpmnFile } from '../../src/file.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url);

describe('readBpmnFile', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'local-bpmn-unit-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('returns the XML of a valid BPMN file', async () => {
    const xml = await readBpmnFile(FIXTURE.pathname);
    assert.equal(xml, await readFile(FIXTURE, 'utf8'));
  });

  it('rejects a missing file', async () => {
    const missing = join(dir, 'nope.bpmn');
    await assert.rejects(readBpmnFile(missing), { message: `File not found: ${missing}` });
  });

  it('rejects a directory', async () => {
    const sub = join(dir, 'folder.bpmn');
    await mkdir(sub);
    await assert.rejects(readBpmnFile(sub), { message: `Not a file: ${sub}` });
  });

  it('rejects a non-BPMN file', async () => {
    const txt = join(dir, 'notes.txt');
    await writeFile(txt, 'just some text\n');
    await assert.rejects(readBpmnFile(txt), {
      message: `Not a BPMN file (no bpmn:definitions element): ${txt}`,
    });
  });
});

describe('looksLikeBpmn', () => {
  const ns = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
  it('accepts prefixed and default-namespace definitions', () => {
    assert.ok(looksLikeBpmn(`<bpmn:definitions xmlns:bpmn="${ns}"></bpmn:definitions>`));
    assert.ok(looksLikeBpmn(`<semantic:definitions id="x" xmlns:semantic='${ns}'/>`));
    assert.ok(looksLikeBpmn(`<?xml version="1.0"?>\n<definitions\n  xmlns="${ns}">\n</definitions>`));
  });
  it('rejects other namespaces and documents', () => {
    assert.ok(!looksLikeBpmn('<definitions xmlns="http://example.com/other"/>'));
    assert.ok(!looksLikeBpmn(`<bpmn:definitions xmlns:other="${ns}"/>`));
    assert.ok(!looksLikeBpmn('<html><body>hi</body></html>'));
    assert.ok(!looksLikeBpmn(''));
  });
});
