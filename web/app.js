// Editor shell: loads the host's file and renders it with the vendored bpmn-js modeler (global `BpmnJS`).

const fileNameEl = document.getElementById('file-name');
const errorEl = document.getElementById('error');

const modeler = new window.BpmnJS({ container: '#canvas' });
// Exposed for tests and debugging.
window.bpmnModeler = modeler;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

async function loadFile() {
  const res = await fetch('/api/file', { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed to load file (HTTP ${res.status})`);
  return body;
}

async function main() {
  let file;
  try {
    file = await loadFile();
  } catch (err) {
    showError(`Could not load the diagram: ${err.message}`);
    return;
  }

  fileNameEl.textContent = file.name;
  fileNameEl.title = file.path;
  document.title = `${file.name} — local-bpmn`;

  try {
    const { warnings } = await modeler.importXML(file.xml);
    if (warnings.length) console.warn('local-bpmn: diagram imported with warnings', warnings);
    modeler.get('canvas').zoom('fit-viewport', 'auto');
  } catch (err) {
    showError(`Could not render ${file.name}: ${err.message}`);
  }
}

main();
