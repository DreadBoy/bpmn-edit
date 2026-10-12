// Editor shell: renders the host's file with the vendored bpmn-js modeler (global `BpmnJS`) and keeps
// it in sync with the host over a WebSocket (see src/server.js for the protocol).

/** Edits are sent this long after the last change (coalesces drags, typing, etc.). */
const SEND_DELAY_MS = 300;

const STATUS_TEXT = {
  connecting: 'Connecting…',
  saved: 'Saved',
  saving: 'Saving…',
  disconnected: 'Disconnected',
  error: 'Not saved',
};

const fileNameEl = document.getElementById('file-name');
const statusEl = document.getElementById('save-status');
const errorEl = document.getElementById('error');

const modeler = new window.BpmnJS({ container: '#canvas' });
// Exposed for tests and debugging.
window.bpmnModeler = modeler;

let socket = null;
let connected = false;
let everConnected = false;
let version = null;       // version of the document this client last received or had acknowledged
let importing = false;
let rendered = false;
let sendTimer = null;     // pending debounced send
let sendChain = Promise.resolve(); // serialises saveXML + send so updates go out in edit order
let sending = 0;          // sends in progress (serialising the XML)
let unacked = 0;          // updates sent but not yet acknowledged
let unsent = false;       // edits made while disconnected
let lastError = null;     // { code, message } from the server, cleared by the next ack

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function renderStatus() {
  let state;
  if (!connected) state = everConnected ? 'disconnected' : 'connecting';
  else if (lastError) state = 'error';
  else if (sendTimer || sending || unacked) state = 'saving';
  else state = 'saved';

  statusEl.dataset.state = state;
  statusEl.textContent = STATUS_TEXT[state];
  if (state === 'error') statusEl.title = lastError.message;
  else if (state === 'disconnected' && (unsent || sendTimer || unacked)) {
    statusEl.title = 'Connection to local-bpmn lost; recent changes were not saved';
  } else statusEl.removeAttribute('title');
}

function isOpen() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

function sendMessage(message) {
  if (!isOpen()) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/** Serialises the diagram and sends it as an update (queued behind earlier sends). */
function sendNow() {
  clearTimeout(sendTimer);
  sendTimer = null;
  sending += 1;
  renderStatus();
  sendChain = sendChain.then(async () => {
    try {
      const { xml } = await modeler.saveXML({ format: true });
      if (sendMessage({ type: 'update', xml, baseVersion: version })) unacked += 1;
      else unsent = true;
    } catch (err) {
      lastError = { code: 'serialize-failed', message: `Could not serialise the diagram: ${err.message}` };
    } finally {
      sending -= 1;
      renderStatus();
    }
  });
  return sendChain;
}

function scheduleSend() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(sendNow, SEND_DELAY_MS);
  renderStatus();
}

/** The host is shutting down: commit an open label edit, send pending edits, then confirm. */
async function flushForShutdown() {
  const directEditing = modeler.get('directEditing');
  if (directEditing.isActive()) directEditing.complete();
  if (sendTimer) await sendNow();
  else await sendChain;
  sendMessage({ type: 'flushed' });
}

async function importDiagram(xml) {
  importing = true;
  try {
    const { warnings } = await modeler.importXML(xml);
    if (warnings.length) console.warn('local-bpmn: diagram imported with warnings', warnings);
  } finally {
    importing = false;
  }
  if (!rendered) {
    modeler.get('canvas').zoom('fit-viewport', 'auto');
    rendered = true;
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case 'init':
      if (message.name) {
        fileNameEl.textContent = message.name;
        fileNameEl.title = message.path || message.name;
        document.title = `${message.name} — local-bpmn`;
      }
      try {
        await importDiagram(message.xml);
        version = message.version;
      } catch (err) {
        showError(`Could not render ${message.name || 'the diagram'}: ${err.message}`);
      }
      break;
    case 'ack':
      unacked = Math.max(0, unacked - 1);
      version = message.version;
      lastError = null;
      break;
    case 'error':
      // 'write-failed' is pushed by the host on its own; other errors answer one of our updates.
      if (message.code !== 'write-failed') unacked = Math.max(0, unacked - 1);
      lastError = { code: message.code, message: message.message };
      console.warn(`local-bpmn: ${message.code}: ${message.message}`);
      break;
    case 'flush':
      await flushForShutdown();
      break;
    default:
      break; // unknown types are ignored so newer hosts can add messages
  }
  renderStatus();
}

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    connected = true;
    everConnected = true;
    renderStatus();
  });
  let queue = Promise.resolve(); // handle messages strictly in order (init imports asynchronously)
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    queue = queue.then(() => handleMessage(message)).catch((err) => {
      showError(`Unexpected error: ${err.message}`);
    });
  });
  socket.addEventListener('close', () => {
    const wasConnected = connected;
    connected = false;
    renderStatus();
    if (!wasConnected && !rendered) showError('Could not connect to the local-bpmn server.');
  });
}

modeler.on('commandStack.changed', (event) => {
  if (importing || event.trigger === 'clear') return;
  scheduleSend();
});

renderStatus();
connect();
