import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hasBalancedTags, isCompleteBpmn, looksLikeBpmn, readBpmnFile } from '../../src/file.js';

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
    // Only the root element counts, not a definitions tag mentioned in a comment or nested deeper.
    assert.ok(!looksLikeBpmn(`<!-- <bpmn:definitions xmlns:bpmn="${ns}"> --><html/>`));
    assert.ok(!looksLikeBpmn(`<root><bpmn:definitions xmlns:bpmn="${ns}"/></root>`));
    assert.ok(!looksLikeBpmn(`text <bpmn:definitions xmlns:bpmn="${ns}"/>`));
  });
});

describe('isCompleteBpmn', () => {
  const ns = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
  it('accepts documents that end with the closing definitions tag', async () => {
    assert.ok(isCompleteBpmn(await readFile(FIXTURE, 'utf8')));
    assert.ok(isCompleteBpmn(`<bpmn:definitions xmlns:bpmn="${ns}"></bpmn:definitions>\n\n`));
    assert.ok(isCompleteBpmn(`<definitions xmlns="${ns}">\n</definitions >`));
    assert.ok(isCompleteBpmn(`<a.b:definitions xmlns:a.b="${ns}"></a.b:definitions>`));
  });
  it('rejects truncated documents and non-BPMN', async () => {
    const xml = await readFile(FIXTURE, 'utf8');
    assert.ok(!isCompleteBpmn(xml.slice(0, Math.floor(xml.length * 0.6))));
    assert.ok(!isCompleteBpmn(xml.trimEnd().slice(0, -1)));
    assert.ok(!isCompleteBpmn(`<bpmn:definitions xmlns:bpmn="${ns}"></definitions>`));
    assert.ok(!isCompleteBpmn(`<definitions xmlns="http://example.com/other"></definitions>`));
    assert.ok(!isCompleteBpmn(''));
    assert.ok(!isCompleteBpmn(null));
  });
  it('rejects documents broken in the middle that still end with the closing tag', async () => {
    const xml = await readFile(FIXTURE, 'utf8');
    assert.ok(!isCompleteBpmn(xml.replace('name="Ship order">', 'name="Ship <order> broken')));
    assert.ok(!isCompleteBpmn(xml.replace('name="Check stock"', 'name="Check stock')));
    assert.ok(!isCompleteBpmn(xml.replace('</bpmn:task>', '')));
    assert.ok(!isCompleteBpmn(xml.replace('<bpmn:process ', 'junk < <bpmn:process ')));
    assert.ok(!isCompleteBpmn(xml.replace('<bpmn:process ', '<1x/><bpmn:process ')));
  });
  it('accepts comments and processing instructions around the root element', async () => {
    const xml = await readFile(FIXTURE, 'utf8');
    const ok = {
      trailingComment: `${xml}<!-- generated -->`,
      trailingPI: `${xml}<?checksum abc?>\n`,
      leadingCommentWithDefs: xml.replace('<bpmn:definitions', '<!-- old root was <definitions xmlns="x"> -->\n<bpmn:definitions'),
      leadingCommentBpmn2Defs: xml.replace('<bpmn:definitions', '<!-- <bpmn2:definitions> -->\n<bpmn:definitions'),
      doctypeSubset: xml.replace('<bpmn:definitions', '<!DOCTYPE bpmn:definitions [ <!ENTITY co "Co"> ]>\n<bpmn:definitions'),
      bom: `\ufeff${xml}`,
    };
    for (const [name, variant] of Object.entries(ok)) {
      assert.ok(looksLikeBpmn(variant), `looksLikeBpmn ${name}`);
      assert.ok(isCompleteBpmn(variant), `isCompleteBpmn ${name}`);
    }
    assert.ok(!isCompleteBpmn(`${xml}trailing text`));
    assert.ok(!isCompleteBpmn(`${xml}<extra/>`));
    assert.ok(!isCompleteBpmn(`${xml}<!-- unterminated`));
  });
});

describe('hasBalancedTags', () => {
  it('accepts well-formed markup with comments, CDATA, processing instructions and a DOCTYPE', () => {
    assert.ok(hasBalancedTags('<?xml version="1.0"?><!DOCTYPE a><a><!-- <b> --><![CDATA[<x>]]><?pi <z>?><c x="1>2" y=\'"\'/>text > more</a>'));
    assert.ok(hasBalancedTags('<!DOCTYPE a [<!ENTITY e "v">]><a>&e;</a>'));
    assert.ok(hasBalancedTags('<p:a><p:b></p:b ></p:a>'));
  });
  it('rejects unclosed, mismatched and malformed markup', () => {
    for (const bad of ['<a>', '<a></b>', '<a><b></a></b>', '<a x="1></a>', '<a x="<"/>', '<a', '<a><!-- </a>', '< a/>', '<-a/>']) {
      assert.ok(!hasBalancedTags(bad), bad);
    }
  });
});
