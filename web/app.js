// Editor shell: renders the host's file with the vendored bpmn-js modeler (global `BpmnJS`) and keeps
// it in sync with the host over a WebSocket (see src/server.js for the protocol).

/** Edits are sent this long after the last change (coalesces drags, typing, etc.). */
const SEND_DELAY_MS = 300;

/** How long the "Reloaded from disk" notice stays visible. */
const RELOADED_NOTICE_MS = 3000;

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
const noticeEl = document.getElementById('notice');

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
let fileStatus = { state: 'ok' }; // state of the file on disk, pushed by the host ('file-status')
let reloadedTimer = null; // "Reloaded from disk" notice is showing while set
let deferredUpdate = null; // latest remote-update held back while this window had local edits
let queue = Promise.resolve(); // incoming messages and deferred work, strictly in order

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function hideError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

/** Runs `task` after everything queued before it (messages are handled one at a time). */
function enqueue(task) {
  queue = queue.then(task).catch((err) => {
    showError(`Unexpected error: ${err.message}`);
  });
  return queue;
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

const NOTICES = {
  missing: { text: 'File deleted on disk', title: 'Your next edit will recreate it' },
  invalid: { text: 'File on disk is not valid BPMN; showing the last good version' },
  reloaded: { text: 'Reloaded from disk' },
  deferred: {
    text: 'Disk changed; reloads after your edit',
    title: 'If your edit is saved first, it replaces the change made on disk',
  },
};

/** Shows the persistent file-status notice, else the transient "reloaded" one, else nothing. */
function renderNotice() {
  let kind = null;
  if (fileStatus.state === 'missing' || fileStatus.state === 'invalid') kind = fileStatus.state;
  else if (deferredUpdate) kind = 'deferred';
  else if (reloadedTimer) kind = 'reloaded';
  if (!kind) {
    noticeEl.hidden = true;
    noticeEl.textContent = '';
    delete noticeEl.dataset.kind;
    noticeEl.removeAttribute('title');
    return;
  }
  const notice = NOTICES[kind];
  noticeEl.dataset.kind = kind;
  noticeEl.textContent = notice.text;
  const title = kind === 'invalid' ? fileStatus.message : notice.title;
  if (title) noticeEl.title = title;
  else noticeEl.removeAttribute('title');
  noticeEl.hidden = false;
}

function showReloadedNotice() {
  clearTimeout(reloadedTimer);
  reloadedTimer = setTimeout(() => {
    reloadedTimer = null;
    renderNotice();
  }, RELOADED_NOTICE_MS);
  renderNotice();
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
      settleLocalActivity();
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
  hideError(); // a diagram is showing (again): earlier render errors are over
  if (!rendered) {
    modeler.get('canvas').zoom('fit-viewport', 'auto');
    rendered = true;
  }
}

/**
 * True while this client has edits the host has not acknowledged yet, or the user is in the middle
 * of one (typing a label, dragging).
 */
function hasLocalChanges() {
  return Boolean(sendTimer || sending || unacked || modeler.get('directEditing').isActive()
    || modeler.get('dragging').context());
}

/**
 * Shows a document replaced by someone else (e.g. the file changed on disk) without disturbing the
 * user: keeps zoom/scroll and the selection. While this window has local edits in progress the
 * update is held back (see settleLocalActivity).
 */
async function applyRemoteUpdate(message) {
  if (!rendered) {
    // Nothing showing yet (the first document could not be rendered): just try this one.
    try {
      await importDiagram(message.xml);
      version = message.version;
    } catch (err) {
      showError(`Could not render the changed document: ${err.message}`);
      reportImportFailure(message, err);
    }
    return;
  }
  if (hasLocalChanges()) {
    if (!deferredUpdate) {
      console.warn(`local-bpmn: the document changed (${message.origin}) while this window has edits in progress; `
        + 'it will be shown once they are done unless they are saved first');
    }
    if (!deferredUpdate || message.version > deferredUpdate.version) deferredUpdate = message;
    renderNotice();
    return;
  }
  const canvas = modeler.get('canvas');
  const selection = modeler.get('selection');
  const elementRegistry = modeler.get('elementRegistry');
  const { x, y, width, height } = canvas.viewbox();
  const selectedIds = selection.get().map((element) => element.id);
  const { xml: previousXml } = await modeler.saveXML({ format: true });

  try {
    await importDiagram(message.xml);
  } catch (err) {
    // Never leave the editor blank or broken: go back to what was shown before.
    console.warn('local-bpmn: could not show the changed document', err);
    try {
      await importDiagram(previousXml);
    } catch {
      // Nothing better to show; the error notice below explains.
    }
    canvas.viewbox({ x, y, width, height });
    // From disk, the host answers the report with an 'invalid' file status (shown as a notice);
    // anything else has no such indicator, so show the error.
    if (message.origin === 'disk') reportImportFailure(message, err);
    else showError(`Could not show the changed document: ${err.message}`);
    return;
  }
  canvas.viewbox({ x, y, width, height });
  const stillThere = selectedIds.map((id) => elementRegistry.get(id)).filter(Boolean);
  if (stillThere.length) selection.select(stillThere);
  version = message.version;
  if (message.origin === 'disk') showReloadedNotice();
}

/** Tells the host that a document from disk could not be shown, so it can report the file as invalid. */
function reportImportFailure(message, err) {
  if (message.origin === 'disk') sendMessage({ type: 'import-failed', version: message.version, message: err.message });
}

/**
 * Called whenever local activity may have ended (label editor closed, send finished, ack received).
 * A held-back remote update is shown now, unless a local edit was accepted by the host after it
 * (higher version): then the local edit won and the held-back update is dropped.
 */
function settleLocalActivity() {
  if (!deferredUpdate) return;
  enqueue(async () => {
    if (!deferredUpdate || hasLocalChanges()) return;
    const message = deferredUpdate;
    deferredUpdate = null;
    if (version === null || message.version > version) await applyRemoteUpdate(message);
    else console.warn('local-bpmn: an edit from this window replaced a change made on disk');
    renderNotice();
  });
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
        reportImportFailure({ origin: 'disk', version: message.version }, err); // the host checks the origin
      }
      break;
    case 'ack':
      unacked = Math.max(0, unacked - 1);
      version = message.version;
      lastError = null;
      settleLocalActivity();
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
    case 'remote-update':
      await applyRemoteUpdate(message);
      break;
    case 'file-status':
      fileStatus = { state: message.state, message: message.message };
      if (fileStatus.state !== 'ok') {
        clearTimeout(reloadedTimer); // superseded by the persistent notice
        reloadedTimer = null;
      }
      renderNotice();
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
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    enqueue(() => handleMessage(message)); // in order: init imports asynchronously
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

// Closing the label editor or ending a drag (committed or cancelled) may release a held-back
// remote update.
modeler.on('directEditing.deactivate', () => settleLocalActivity());
modeler.on('drag.cleanup', () => settleLocalActivity());

renderStatus();
connect();
