// Q4 experiment: writes the constructed fixtures of test/fixtures/q4/ (formatting variants of one small
// order process). Downloaded fixtures are not touched; see test/fixtures/q4/SOURCES.md.
//
//   node scripts/q4-make-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'q4');

const NS = [
  ['xmlns:bpmn', 'http://www.omg.org/spec/BPMN/20100524/MODEL'],
  ['xmlns:bpmndi', 'http://www.omg.org/spec/BPMN/20100524/DI'],
  ['xmlns:dc', 'http://www.omg.org/spec/DD/20100524/DC'],
  ['xmlns:di', 'http://www.omg.org/spec/DD/20100524/DI'],
];

const el = (name, attrs = [], ...children) => ({ name, attrs, children });
const text = (value) => ({ text: value });
const comment = (value) => ({ comment: value });
const raw = (value) => ({ raw: value }); // emitted verbatim (CDATA, PIs inside elements)

/** The order process used by all constructed fixtures. `extra` adds content for the comment fixture. */
function orderModel({ names = {}, extra = false } = {}) {
  const n = (id, fallback) => names[id] ?? fallback;
  const flowNode = (tag, id, name, incoming, outgoing, ...more) => el(`bpmn:${tag}`, [['id', id], ['name', name]],
    ...more,
    ...incoming.map((f) => el('bpmn:incoming', [], text(f))),
    ...outgoing.map((f) => el('bpmn:outgoing', [], text(f))));
  const flow = (id, src, tgt, name) => el('bpmn:sequenceFlow',
    [['id', id], ...(name ? [['name', name]] : []), ['sourceRef', src], ['targetRef', tgt]]);
  const shape = (id, [x, y, w, h], label, attrs = []) => el('bpmndi:BPMNShape', [['id', `${id}_di`], ['bpmnElement', id], ...attrs],
    el('dc:Bounds', [['x', x], ['y', y], ['width', w], ['height', h]]),
    ...(label ? [el('bpmndi:BPMNLabel', [], el('dc:Bounds', [['x', label[0]], ['y', label[1]], ['width', label[2]], ['height', label[3]]]))] : []));
  const edge = (id, points, label) => el('bpmndi:BPMNEdge', [['id', `${id}_di`], ['bpmnElement', id]],
    ...points.map(([x, y]) => el('di:waypoint', [['x', x], ['y', y]])),
    ...(label ? [el('bpmndi:BPMNLabel', [], el('dc:Bounds', [['x', label[0]], ['y', label[1]], ['width', label[2]], ['height', label[3]]]))] : []));

  const checkStockExtras = extra ? [
    comment(' Stock is checked against the warehouse system (Lager) '),
    el('bpmn:documentation', [], raw('<![CDATA[Checks <stock> & reserves items; see "Lagerbestand" policy.]]>')),
    el('bpmn:extensionElements', [],
      el('acme:retryPolicy', [['retries', '3'], ['backoff', 'PT5S']],
        el('acme:note', [], text('Façade call – keep idempotent'))),
      raw('<?acme-lint ignore="missing-implementation"?>')),
  ] : [];

  return el('bpmn:definitions', [...NS,
    ...(extra ? [['xmlns:acme', 'https://example.com/schema/acme/1.0']] : []),
    ['id', 'Definitions_Order'], ['targetNamespace', 'http://bpmn.io/schema/bpmn'],
    ...(extra ? [['acme:owner', 'Team Šumi & Co']] : [])],
  el('bpmn:process', [['id', 'Process_Order'], ['name', n('Process_Order', 'Order process')], ['isExecutable', 'false']],
    ...(extra ? [comment(' Happy path first, then the cancellation branch ')] : []),
    flowNode('startEvent', 'StartEvent_OrderReceived', n('StartEvent_OrderReceived', 'Order received'), [], ['Flow_ToCheckStock']),
    el('bpmn:task', [['id', 'Task_CheckStock'], ['name', n('Task_CheckStock', 'Check stock')], ...(extra ? [['acme:sla', 'PT2H']] : [])],
      ...checkStockExtras,
      el('bpmn:incoming', [], text('Flow_ToCheckStock')),
      el('bpmn:outgoing', [], text('Flow_ToGateway'))),
    flowNode('exclusiveGateway', 'Gateway_InStock', n('Gateway_InStock', 'In stock?'), ['Flow_ToGateway'], ['Flow_Yes', 'Flow_No']),
    flowNode('task', 'Task_ShipOrder', n('Task_ShipOrder', 'Ship order'), ['Flow_Yes'], ['Flow_ToShipped']),
    flowNode('task', 'Task_CancelOrder', n('Task_CancelOrder', 'Cancel order'), ['Flow_No'], ['Flow_ToCancelled']),
    flowNode('endEvent', 'EndEvent_OrderShipped', n('EndEvent_OrderShipped', 'Order shipped'), ['Flow_ToShipped'], []),
    flowNode('endEvent', 'EndEvent_OrderCancelled', n('EndEvent_OrderCancelled', 'Order cancelled'), ['Flow_ToCancelled'], []),
    flow('Flow_ToCheckStock', 'StartEvent_OrderReceived', 'Task_CheckStock'),
    flow('Flow_ToGateway', 'Task_CheckStock', 'Gateway_InStock'),
    flow('Flow_Yes', 'Gateway_InStock', 'Task_ShipOrder', n('Flow_Yes', 'yes')),
    flow('Flow_No', 'Gateway_InStock', 'Task_CancelOrder', n('Flow_No', 'no')),
    flow('Flow_ToShipped', 'Task_ShipOrder', 'EndEvent_OrderShipped'),
    flow('Flow_ToCancelled', 'Task_CancelOrder', 'EndEvent_OrderCancelled')),
  el('bpmndi:BPMNDiagram', [['id', 'BPMNDiagram_Order']],
    el('bpmndi:BPMNPlane', [['id', 'BPMNPlane_Order'], ['bpmnElement', 'Process_Order']],
      shape('StartEvent_OrderReceived', [152, 182, 36, 36], [133, 225, 74, 14]),
      shape('Task_CheckStock', [240, 160, 100, 80]),
      shape('Gateway_InStock', [395, 175, 50, 50], [456, 193, 47, 14], [['isMarkerVisible', 'true']]),
      shape('Task_ShipOrder', [500, 60, 100, 80]),
      shape('Task_CancelOrder', [500, 260, 100, 80]),
      shape('EndEvent_OrderShipped', [662, 82, 36, 36], [645, 125, 70, 14]),
      shape('EndEvent_OrderCancelled', [662, 282, 36, 36], [641, 325, 79, 14]),
      edge('Flow_ToCheckStock', [[188, 200], [240, 200]]),
      edge('Flow_ToGateway', [[340, 200], [395, 200]]),
      edge('Flow_Yes', [[420, 175], [420, 100], [500, 100]], [426, 135, 18, 14]),
      edge('Flow_No', [[420, 225], [420, 300], [500, 300]], [428, 260, 15, 14]),
      edge('Flow_ToShipped', [[600, 100], [662, 100]]),
      edge('Flow_ToCancelled', [[600, 300], [662, 300]]))));
}

function escapeAttr(value, quote) {
  let out = String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return quote === '"' ? out.replaceAll('"', '&quot;') : out.replaceAll("'", '&apos;');
}
const escapeText = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Serialises a tree. Options: indent unit, attrsOnLines (one attribute per line, aligned under the
 * first), quote, selfClose (' />' or '/>'), eol, finalNewline, prolog (text before the root element).
 */
function serialize(root, { indent = '  ', attrsOnLines = false, quote = '"', selfClose = ' />', eol = '\n',
  finalNewline = true, prolog = '<?xml version="1.0" encoding="UTF-8"?>\n', quoteFor = () => quote } = {}) {
  const lines = [];
  const walk = (node, depth) => {
    const pad = indent.repeat(depth);
    if (node.comment !== undefined) return void lines.push(`${pad}<!--${node.comment}-->`);
    if (node.raw !== undefined) return void lines.push(`${pad}${node.raw}`);
    const attrText = node.attrs.map(([k, v]) => {
      const q = quoteFor(k, quote);
      return `${k}=${q}${escapeAttr(v, q)}${q}`;
    });
    let open = `${pad}<${node.name}`;
    if (attrText.length) {
      if (attrsOnLines && attrText.length > 1) {
        const hang = attrsOnLines === 'hang' ? `${pad}${indent}` : ' '.repeat(open.length + 1);
        open += ` ${attrText[0]}${attrText.slice(1).map((a) => `${eol === '\n' ? '\n' : '\n'}${hang}${a}`).join('')}`;
      } else open += ` ${attrText.join(' ')}`;
    }
    const kids = node.children;
    if (!kids.length) return void lines.push(`${open}${selfClose}`);
    if (kids.length === 1 && kids[0].text !== undefined) {
      return void lines.push(`${open}>${escapeText(kids[0].text)}</${node.name}>`);
    }
    lines.push(`${open}>`);
    for (const kid of kids) walk(kid, depth + 1);
    lines.push(`${pad}</${node.name}>`);
  };
  walk(root, 0);
  const body = (prolog + lines.join('\n')).split('\n').join(eol);
  return body + (finalNewline ? eol : '');
}

const files = {
  // 4-space indent, attributes on separate lines aligned under the first, '/>' without a space.
  'hand-4space.bpmn': serialize(orderModel(), { indent: '    ', attrsOnLines: true, selfClose: '/>' }),
  // Tab indent, attributes on separate (hanging-indented) lines, single quotes on attributes.
  'hand-tabs.bpmn': serialize(orderModel(), { indent: '\t', attrsOnLines: 'hang', quote: "'" }),
  // bpmn.io-like layout (2 spaces, one line per tag) but Windows line endings.
  'crlf.bpmn': serialize(orderModel(), { eol: '\r\n' }),
  // bpmn.io-like layout without a newline at the end of the file.
  'no-trailing-newline.bpmn': serialize(orderModel(), { finalNewline: false }),
  // Comments (before the root, inside the process and inside a task), a processing instruction before
  // the root and one inside extensionElements, CDATA, an unknown extension namespace (element +
  // attributes), non-ASCII text, and escaped characters in attribute values.
  'comments-nonascii.bpmn': serialize(orderModel({
    extra: true,
    names: {
      Process_Order: 'Naročilo – Bestellung',
      StartEvent_OrderReceived: 'Naročilo prejeto',
      Task_CheckStock: 'Preveri zalogo (Lager prüfen)',
      Task_ShipOrder: 'Odpošlji naročilo 📦',
      Task_CancelOrder: 'Prekliči "naročilo" & obvesti',
      Gateway_InStock: 'Na zalogi? 在库?',
    },
  }), {
    prolog: '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!-- Order process. Owner: Team Šumi. Do not rename ids: referenced by the worker code. -->\n'
      + '<?acme-tool version="2.1" generated="2026-10-01"?>\n',
  }),
  // A DOCTYPE with an internal subset declaring an entity that is used in a documentation text.
  'doctype.bpmn': serialize(orderModel(), {
    prolog: '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
      + '<!DOCTYPE bpmn:definitions [\n  <!ENTITY company "ACME d.o.o.">\n]>\n',
  }).replace('<bpmn:task id="Task_ShipOrder" name="Ship order">',
    '<bpmn:task id="Task_ShipOrder" name="Ship order">\n      <bpmn:documentation>Shipped by &company; logistics</bpmn:documentation>'),
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(OUT, name), content, 'utf8');
  console.log(`wrote ${name} (${Buffer.byteLength(content)} bytes)`);
}
