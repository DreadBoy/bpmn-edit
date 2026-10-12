// Editor shell: renders the host's file with the vendored bpmn-js modeler (global `BpmnJS`) and keeps
// it in sync with the host over a WebSocket (see src/server.js for the protocol).
//
// Every window sends its whole document after an edit; the host keeps the last one it receives and
// passes it on to the other windows. A document from someone else that arrives while this window has
// an edit in progress (label editor open, drag, edit not sent yet) is held back; when the edit is done
// it is shown and this window's unsent edits are re-applied on top of it (see rebaseLocalEdits), so
// both edits survive.

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
const canvas = modeler.get('canvas');
const commandStack = modeler.get('commandStack');
const directEditing = modeler.get('directEditing');
const dragging = modeler.get('dragging');
const elementRegistry = modeler.get('elementRegistry');
const selection = modeler.get('selection');

let clientId = null;      // assigned by the host in 'init'

// Exposed for tests and debugging.
window.bpmnModeler = modeler;
window.localBpmn = Object.freeze({
  /** This window's id in the session (from the host), or null before 'init'. */
  get clientId() { return clientId; },
});

let socket = null;
let connected = false;
let everConnected = false;
let version = null;       // version of the document this client last received or had acknowledged
let importing = false;
let rendered = false;
let sendTimer = null;     // pending debounced send
let sendHeld = false;     // the debounced send came due while another window's edit was held back
let sendChain = Promise.resolve(); // serialises saveXML + send so updates go out in edit order
let sending = 0;          // sends in progress (serialising the XML)
let unacked = 0;          // updates sent but not yet acknowledged
let unsent = false;       // edits made while disconnected
let lastError = null;     // { code, message } from the server, cleared by the next ack
let fileStatus = { state: 'ok' }; // state of the file on disk, pushed by the host ('file-status')
let reloadedTimer = null; // "Reloaded from disk" notice is showing while set
let deferredUpdate = null; // latest remote-update held back while this window had local edits
let localOps = [];        // this window's edits since the last send or import, as ops (see OP_CAPTURE)
let localOpsBroken = null; // why localOps cannot reproduce those edits (e.g. undo), or null
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
  else if (sendTimer || sendHeld || sending || unacked) state = 'saving';
  else state = 'saved';

  statusEl.dataset.state = state;
  statusEl.textContent = STATUS_TEXT[state];
  if (state === 'error') statusEl.title = lastError.message;
  else if (state === 'disconnected' && (unsent || sendTimer || sendHeld || unacked)) {
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
  // Same kind (a held-back update), different wording when it comes from another window.
  deferredRemote: {
    text: 'Someone else edited; shown after your edit',
    title: 'Both edits are kept',
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
  const notice = kind === 'deferred' && deferredUpdate.origin !== 'disk' ? NOTICES.deferredRemote : NOTICES[kind];
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
  sendHeld = false;
  sending += 1;
  renderStatus();
  sendChain = sendChain.then(async () => {
    try {
      resetLocalOps(); // everything up to here goes out with this XML
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
  sendTimer = setTimeout(onSendDue, SEND_DELAY_MS);
  renderStatus();
}

/**
 * The debounced send is due. If another window's edit is held back, sending this window's document
 * now would overwrite it: hold the send until the edits are merged (settleLocalActivity).
 */
function onSendDue() {
  sendTimer = null;
  if (deferredUpdate && deferredUpdate.origin !== 'disk') {
    sendHeld = true;
    renderStatus();
    settleLocalActivity();
    return;
  }
  sendNow();
}

/** The host is shutting down: commit an open label edit, send pending edits, then confirm. */
async function flushForShutdown() {
  if (directEditing.isActive()) directEditing.complete();
  await settleNow();
  if (sendTimer || sendHeld) await sendNow();
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
  resetLocalOps(); // importing cleared the command stack
  hideError(); // a diagram is showing (again): earlier render errors are over
  if (!rendered) {
    canvas.zoom('fit-viewport', 'auto');
    rendered = true;
  }
}

/** Raises the known version; an ack or update never moves it backwards. */
function advanceVersion(newVersion) {
  version = version === null ? newVersion : Math.max(version, newVersion);
}

/** True while the user is in the middle of an edit (typing a label, dragging). */
function interactionActive() {
  return directEditing.isActive() || Boolean(dragging.context());
}

/**
 * True while this client has edits the host has not acknowledged yet, or the user is in the middle
 * of one.
 */
function hasLocalChanges() {
  return Boolean(sendTimer || sendHeld || sending || unacked || interactionActive());
}

/** Who made a change, for log messages. */
function describeOrigin(origin) {
  return origin === 'disk' ? 'a change made on disk' : `an edit from another window (${origin})`;
}

/**
 * Shows a document replaced by someone else (the file changed on disk, or another window's edit)
 * without disturbing the user: keeps zoom/scroll and the selection. While this window has local
 * edits in progress the update is held back (see settleLocalActivity).
 */
async function applyRemoteUpdate(message) {
  if (!rendered) {
    // Nothing showing yet (the first document could not be rendered): just try this one.
    try {
      await importDiagram(message.xml);
      advanceVersion(message.version);
    } catch (err) {
      showError(`Could not render the changed document: ${err.message}`);
      reportImportFailure(message, err);
    }
    return;
  }
  if (hasLocalChanges()) {
    if (!deferredUpdate) {
      console.warn(`local-bpmn: ${describeOrigin(message.origin)} arrived while this window has edits in progress; `
        + 'it will be shown once they are done');
    }
    if (!deferredUpdate || message.version > deferredUpdate.version) deferredUpdate = message;
    renderNotice();
    settleLocalActivity(); // e.g. only the debounced send is pending: merge right away
    return;
  }
  await showRemoteDocument(message);
}

/**
 * Imports a document from someone else, keeping zoom/scroll and the selection. On failure the
 * previous document is shown again. Resolves to whether the new document is showing.
 */
async function showRemoteDocument(message) {
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
    return false;
  }
  canvas.viewbox({ x, y, width, height });
  const stillThere = selectedIds.map((id) => elementRegistry.get(id)).filter(Boolean);
  if (stillThere.length) selection.select(stillThere);
  advanceVersion(message.version);
  if (message.origin === 'disk') showReloadedNotice();
  return true;
}

/** Tells the host that a document from disk could not be shown, so it can report the file as invalid. */
function reportImportFailure(message, err) {
  if (message.origin === 'disk') sendMessage({ type: 'import-failed', version: message.version, message: err.message });
}

/**
 * Called whenever local activity may have ended (label editor closed, drag over, send finished, ack
 * received, debounced send due). Handles a held-back remote update in the message order.
 */
function settleLocalActivity() {
  if (!deferredUpdate) return;
  enqueue(settleNow);
}

/**
 * Once the user is done (no label editor, no drag) and nothing is on its way to the host, a
 * held-back remote update is:
 * - dropped if a local edit was accepted by the host after it (higher version): last write wins;
 * - shown, with this window's unsent edits re-applied on top, if there are any (another window's
 *   edit) — for a change on disk the unsent edit is sent first instead and wins (as before);
 * - otherwise simply shown.
 */
async function settleNow() {
  if (!deferredUpdate || interactionActive() || sending || unacked) return;
  const message = deferredUpdate;
  const unsentEdits = Boolean(sendTimer || sendHeld);
  if (unsentEdits && message.origin === 'disk') return; // sent when due, then dropped (see above)
  deferredUpdate = null;
  if (version !== null && message.version <= version) {
    console.warn(`local-bpmn: an edit from this window replaced ${describeOrigin(message.origin)}`);
    if (sendHeld) sendNow();
  } else if (unsentEdits) {
    await rebaseLocalEdits(message);
  } else {
    await showRemoteDocument(message);
  }
  renderNotice();
}

// --- Re-applying unsent local edits on top of another window's document -------------------------
//
// Each user action is one root command on the bpmn-js command stack (nested commands are side
// effects of it). Right after a root command has run, it is recorded as id-based ops: enough to
// repeat the action with `modeling` on another version of the document. The list is reset whenever
// the document is sent or imported, so it always describes the edits the host has not seen.

/** Thrown when an op cannot be recorded or re-applied; the caller falls back to last write wins. */
class RebaseError extends Error {}

/** Plain copy of a point or bounds (commands keep references to live objects). */
function plainBounds({ x, y, width, height }) {
  return width === undefined ? { x, y } : { x, y, width, height };
}

/** Op for a connection created by a command (kept with its id and type, re-laid out on re-apply). */
function connectionOp(connection) {
  return {
    kind: 'connect',
    id: connection.id,
    type: connection.businessObject.$type,
    sourceId: connection.source.id,
    targetId: connection.target.id,
  };
}

/** Ops that re-create `element` (a shape, or a connection) as it is right after its creation. */
function createdElementOps(element) {
  if (element.labelTarget) return []; // external labels are re-created with their element
  if (element.waypoints) return [connectionOp(element)];
  const bo = element.businessObject;
  if (bo.$instanceOf('bpmn:Participant') || bo.$instanceOf('bpmn:Lane')) {
    throw new RebaseError(`creating a ${bo.$type} is not supported`);
  }
  const eventDefinitions = bo.eventDefinitions || [];
  if (eventDefinitions.length > 1) throw new RebaseError('multiple event definitions are not supported');
  const parent = element.host || element.parent;
  return [{
    kind: 'create',
    id: element.id,
    type: bo.$type,
    name: bo.name,
    eventDefinitionType: eventDefinitions[0]?.$type,
    isExpanded: element.di?.isExpanded || undefined,
    bounds: plainBounds(element),
    parentId: parent.id,
    attach: Boolean(element.host),
  }];
}

/** Root command -> function(context) returning the ops that repeat it. Anything else: unsupported. */
const OP_CAPTURE = {
  'element.updateLabel': ({ element, newLabel, newBounds }) => [{
    kind: 'label', id: element.id, text: newLabel ?? null, bounds: newBounds ? plainBounds(newBounds) : undefined,
  }],
  'elements.move': ({ shapes, delta, newParent, newHost, hints = {} }) => [{
    kind: 'move',
    ids: shapes.map((shape) => shape.id),
    delta: plainBounds(delta),
    targetId: (hints.attach === true ? newHost : newParent)?.id ?? null,
    attach: hints.attach,
  }],
  'shape.move': ({ shape, delta, newParent }) => [{
    kind: 'move', ids: [shape.id], delta: plainBounds(delta), targetId: newParent?.id ?? null,
  }],
  'elements.create': ({ elements }) => elements.flatMap(createdElementOps),
  'shape.create': ({ shape }) => createdElementOps(shape),
  'shape.append': ({ source, shape }) => {
    const connection = [...shape.incoming, ...shape.outgoing]
      .find((c) => c.source === source || c.target === source);
    return [...createdElementOps(shape), ...(connection ? [connectionOp(connection)] : [])];
  },
  'connection.create': ({ connection }) => [connectionOp(connection)],
  'elements.delete': ({ elements }) => [{ kind: 'delete', ids: elements.map((element) => element.id) }],
  'shape.delete': ({ shape }) => [{ kind: 'delete', ids: [shape.id] }],
  'connection.delete': ({ connection }) => [{ kind: 'delete', ids: [connection.id] }],
};

function resetLocalOps() {
  localOps = [];
  localOpsBroken = null;
}

/** True while the outermost (root) command of a user action is running. */
function isRootCommand() {
  // diagram-js 15 (vendored with bpmn-js 18) keeps the running commands, outermost first, in this
  // private field; execute() and the internal execution each push the command, so while only the
  // root runs, every entry is the root's action. If the field is ever missing, nothing is recorded
  // and merging falls back to last write wins (see recordCommand).
  const actions = commandStack._currentExecution?.actions;
  return Boolean(actions?.length) && actions.every((action) => action === actions[0]);
}

/** Records a finished root command as ops (see OP_CAPTURE). */
function recordCommand({ command, context }) {
  if (importing || localOpsBroken) return;
  if (!isRootCommand()) {
    if (!commandStack._currentExecution?.actions) localOpsBroken = 'command stack internals changed';
    return;
  }
  const capture = OP_CAPTURE[command];
  if (!capture) {
    localOpsBroken = `unsupported command ${command}`;
    return;
  }
  try {
    localOps.push(...capture(context));
  } catch (err) {
    localOpsBroken = `${command}: ${err.message}`;
  }
}

/** Repeats `ops` with `modeling` on the document now showing; throws RebaseError if one cannot apply. */
function applyOps(ops) {
  const modeling = modeler.get('modeling');
  const bpmnFactory = modeler.get('bpmnFactory');
  const elementFactory = modeler.get('elementFactory');
  const get = (id) => {
    const element = elementRegistry.get(id);
    if (!element) throw new RebaseError(`element ${id} is gone`);
    return element;
  };
  const absent = (id) => {
    if (elementRegistry.get(id)) throw new RebaseError(`element ${id} exists already`);
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'label':
        modeling.updateLabel(get(op.id), op.text, op.bounds);
        break;
      case 'move':
        modeling.moveElements(op.ids.map(get), op.delta, op.targetId ? get(op.targetId) : undefined,
          op.attach === undefined ? {} : { attach: op.attach });
        break;
      case 'create': {
        absent(op.id);
        const businessObject = bpmnFactory.create(op.type, op.name === undefined ? { id: op.id } : { id: op.id, name: op.name });
        const shape = elementFactory.createShape({
          type: op.type, businessObject, eventDefinitionType: op.eventDefinitionType, isExpanded: op.isExpanded,
        });
        modeling.createShape(shape, op.bounds, get(op.parentId), op.attach ? { attach: true } : {});
        break;
      }
      case 'connect': {
        absent(op.id);
        const businessObject = bpmnFactory.create(op.type, { id: op.id });
        if (!modeling.connect(get(op.sourceId), get(op.targetId), { type: op.type, businessObject })) {
          throw new RebaseError(`could not connect ${op.sourceId} to ${op.targetId}`);
        }
        break;
      }
      case 'delete': {
        // Already gone (deleted elsewhere too) is fine: the result is the same.
        const elements = op.ids.map((id) => elementRegistry.get(id)).filter(Boolean);
        if (elements.length) modeling.removeElements(elements);
        break;
      }
      default:
        throw new RebaseError(`unknown op ${op.kind}`);
    }
  }
}

/**
 * Shows another window's document (`message`) and re-applies this window's unsent edits on top of
 * it; the re-applied commands are then sent as usual. If that is not possible (an unsupported
 * command, undo/redo, an element the other edit removed), this window's document is sent as it is
 * and replaces the other edit (last write wins), with a warning.
 */
async function rebaseLocalEdits(message) {
  clearTimeout(sendTimer);
  sendTimer = null;
  sendHeld = false;
  const lastWriteWins = (reason) => {
    console.warn(`local-bpmn: could not merge this window's edits with ${describeOrigin(message.origin)} `
      + `(${reason}); this window's version replaces it`);
    return sendNow();
  };
  if (localOpsBroken) return lastWriteWins(localOpsBroken);

  const ops = localOps;
  const { xml: localXml } = await modeler.saveXML({ format: true });
  if (!(await showRemoteDocument(message))) return lastWriteWins('the other document could not be shown');
  try {
    applyOps(ops); // the commands schedule the send of the merged document
  } catch (err) {
    if (!(err instanceof RebaseError)) console.error(err); // still recover below
    const view = canvas.viewbox();
    await importDiagram(localXml);
    canvas.viewbox(view);
    return lastWriteWins(err.message);
  }
  return undefined;
}

async function handleMessage(message) {
  switch (message.type) {
    case 'init':
      if (message.name) {
        fileNameEl.textContent = message.name;
        fileNameEl.title = message.path || message.name;
        document.title = `${message.name} — local-bpmn`;
      }
      clientId = message.clientId ?? null;
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
      advanceVersion(message.version);
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
  // Undo/redo is not recorded as ops: a merge with another window's edit falls back to last write wins.
  if (event.trigger === 'undo' || event.trigger === 'redo') localOpsBroken ??= event.trigger;
  scheduleSend();
});
modeler.on('commandStack.postExecuted', recordCommand);

// Closing the label editor or ending a drag (committed or cancelled) may release a held-back
// remote update.
modeler.on('directEditing.deactivate', () => settleLocalActivity());
modeler.on('drag.cleanup', () => settleLocalActivity());

renderStatus();
connect();
