#!/usr/bin/env node
// Generates a large, deterministic BPMN diagram for measurements and tests: `rows` chains of
// `cols` flow nodes (start event, tasks, exclusive gateways, intermediate events, end event) laid
// out in a grid, each chain connected left to right by sequence flows, all with DI.
//
//   node scripts/gen-large-bpmn.js [--rows 16] [--cols 10] [out.bpmn]   (stdout without a path)
//
// The defaults give 160 flow nodes + 144 sequence flows = 304 elements. Element ids are stable:
// node `N_<row>_<col>` (tasks `Task_<row>_<col>`), flow `Flow_<row>_<col>` (from column col to col + 1).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COL_WIDTH = 150;
const ROW_HEIGHT = 130;
const LEFT = 160;
const TOP = 80;

const SIZES = {
  task: [100, 80],
  exclusiveGateway: [50, 50],
  startEvent: [36, 36],
  endEvent: [36, 36],
  intermediateThrowEvent: [36, 36],
};

/** Kind of the node in column `col` of a row with `cols` columns. */
function kindAt(col, cols) {
  if (col === 0) return 'startEvent';
  if (col === cols - 1) return 'endEvent';
  if (col % 4 === 3) return 'exclusiveGateway';
  if (col % 6 === 5) return 'intermediateThrowEvent';
  return 'task';
}

function nodeId(kind, row, col) {
  const prefix = { task: 'Task', exclusiveGateway: 'Gateway', startEvent: 'Start', endEvent: 'End', intermediateThrowEvent: 'Event' }[kind];
  return `${prefix}_${row}_${col}`;
}

function nodeName(kind, row, col) {
  const word = { task: 'Task', exclusiveGateway: 'Decide', startEvent: 'Start', endEvent: 'Done', intermediateThrowEvent: 'Signal' }[kind];
  return `${word} ${row}.${col}`;
}

/** Returns the BPMN XML of the generated diagram. */
export function generateLargeBpmn({ rows = 16, cols = 10 } = {}) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 2) {
    throw new RangeError('rows must be >= 1 and cols >= 2');
  }
  const nodes = [];
  const flows = [];
  for (let row = 0; row < rows; row++) {
    const centerY = TOP + row * ROW_HEIGHT + 40;
    for (let col = 0; col < cols; col++) {
      const kind = kindAt(col, cols);
      const [width, height] = SIZES[kind];
      const centerX = LEFT + col * COL_WIDTH + 50;
      nodes.push({
        kind, row, col, id: nodeId(kind, row, col), name: nodeName(kind, row, col),
        x: centerX - width / 2, y: centerY - height / 2, width, height,
      });
    }
    for (let col = 0; col < cols - 1; col++) {
      const source = nodes[nodes.length - cols + col];
      const target = nodes[nodes.length - cols + col + 1];
      flows.push({
        id: `Flow_${row}_${col}`,
        source,
        target,
        waypoints: [[source.x + source.width, centerY], [target.x, centerY]],
      });
    }
  }

  const incoming = new Map(flows.map((f) => [f.target.id, f.id]));
  const outgoing = new Map(flows.map((f) => [f.source.id, f.id]));
  const semantic = nodes.map((n) => {
    const refs = [
      incoming.has(n.id) ? `      <bpmn:incoming>${incoming.get(n.id)}</bpmn:incoming>` : null,
      outgoing.has(n.id) ? `      <bpmn:outgoing>${outgoing.get(n.id)}</bpmn:outgoing>` : null,
    ].filter(Boolean).join('\n');
    return `    <bpmn:${n.kind} id="${n.id}" name="${n.name}">\n${refs}\n    </bpmn:${n.kind}>`;
  });
  const semanticFlows = flows.map((f) => `    <bpmn:sequenceFlow id="${f.id}" sourceRef="${f.source.id}" targetRef="${f.target.id}" />`);

  const shapes = nodes.map((n) => {
    const marker = n.kind === 'exclusiveGateway' ? ' isMarkerVisible="true"' : '';
    const label = n.kind === 'task' ? '' : `
        <bpmndi:BPMNLabel>
          <dc:Bounds x="${n.x - 12}" y="${n.y + n.height + 5}" width="${n.width + 24}" height="14" />
        </bpmndi:BPMNLabel>`;
    return `      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${marker}>
        <dc:Bounds x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" />${label}
      </bpmndi:BPMNShape>`;
  });
  const edges = flows.map((f) => `      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">
${f.waypoints.map(([x, y]) => `        <di:waypoint x="${x}" y="${y}" />`).join('\n')}
      </bpmndi:BPMNEdge>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_Large" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_Large" name="Large process" isExecutable="false">
${[...semantic, ...semanticFlows].join('\n')}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_Large">
    <bpmndi:BPMNPlane id="BPMNPlane_Large" bpmnElement="Process_Large">
${[...shapes, ...edges].join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rows' || args[i] === '--cols') options[args[i].slice(2)] = Number(args[++i]);
    else out = args[i];
  }
  const xml = generateLargeBpmn(options);
  if (out) writeFileSync(out, xml);
  else process.stdout.write(xml);
}
