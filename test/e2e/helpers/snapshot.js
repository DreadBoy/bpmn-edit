// Snapshots of a diagram (every shape and connection with name and geometry), from a window or from the
// XML on disk, to check that windows and the file agree.

/** Every shape and connection of a window's diagram (labels and the root left out), sorted by id. */
export function windowSnapshot(page) {
  return page.evaluate(() => window.bpmnModeler.get('elementRegistry').getAll()
    .filter((e) => e.parent && !e.labelTarget)
    .map((e) => ({
      id: e.id,
      name: e.businessObject.name ?? null,
      geometry: e.waypoints ? e.waypoints.map(({ x, y }) => [x, y]) : [e.x, e.y, e.width, e.height],
    }))
    .sort((p, q) => p.id.localeCompare(q.id)));
}

/** The same as windowSnapshot, read from the BPMN XML on disk. */
export function diskSnapshot(xml) {
  const names = new Map();
  for (const [, attrs] of xml.matchAll(/<bpmn:\w+ ([^>]*?)\/?>/g)) {
    const id = /(?:^|\s)id="([^"]*)"/.exec(attrs)?.[1];
    const name = /(?:^|\s)name="([^"]*)"/.exec(attrs)?.[1];
    if (id) names.set(id, name === undefined ? null : name.replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
  }
  const elements = [];
  const shapeRe = /<bpmndi:BPMNShape [^>]*bpmnElement="([^"]+)"[^>]*>\s*<dc:Bounds x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g;
  for (const [, id, x, y, width, height] of xml.matchAll(shapeRe)) {
    elements.push({ id, name: names.get(id) ?? null, geometry: [x, y, width, height].map(Number) });
  }
  for (const [, id, body] of xml.matchAll(/<bpmndi:BPMNEdge [^>]*bpmnElement="([^"]+)"[^>]*>([\s\S]*?)<\/bpmndi:BPMNEdge>/g)) {
    const geometry = [...body.matchAll(/<di:waypoint x="([^"]+)" y="([^"]+)"/g)].map(([, x, y]) => [Number(x), Number(y)]);
    elements.push({ id, name: names.get(id) ?? null, geometry });
  }
  return elements.sort((p, q) => p.id.localeCompare(q.id));
}
