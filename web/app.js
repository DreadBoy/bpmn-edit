// Editor shell: renders the host's file with the vendored bpmn-js modeler (global `BpmnJS`) and keeps
// it in sync with the host over a WebSocket (see src/server.js for the protocol).
//
// Sync model: every window sends its whole document after an edit, together with the version it is
// based on. The host is the single point of serialisation: it accepts an update only if it is based
// on the current version (a change made on disk in between is the one exception, see Session), and
// answers 'conflict' otherwise. This window keeps the edits the host has not accepted yet as id-based
// ops (see OP_CAPTURE). When another window's document arrives first, it is shown and those ops are
// re-applied on top of it ("rebase"), then the result is sent again right away. Updates can no longer
// overwrite each other at the host. For the edits that have ops (label, move, create, append,
// connect, delete) concurrent edits of different elements are kept; an op that cannot be re-applied
// (its element was deleted, someone else changed the same label or position first, or re-applying it
// would change other elements than the original edit did) is dropped on its own, with a visible
// notice. Other edits are dropped, with a notice, only if they race someone else's edit. A delete
// that removes an element someone else changed concurrently is reported to them ('overrides').
//
// Only one update is in flight at a time. A document from someone else that arrives while the user
// is in the middle of an edit (label editor open, drag, popup menu) is held back until it is done.

/** Edits are sent this long after the last change (coalesces bursts such as keyboard nudges). */
const SEND_DELAY_MS = 300;

/** How long the "Reloaded from disk" notice stays visible. */
const RELOADED_NOTICE_MS = 3000;

/** How long a notice about edits that could not be merged stays visible. */
const TOAST_MS = 8000;

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
const toastEl = document.getElementById('toast');

const modeler = new window.BpmnJS({ container: '#canvas' });
const canvas = modeler.get('canvas');
const commandStack = modeler.get('commandStack');
const directEditing = modeler.get('directEditing');
const dragging = modeler.get('dragging');
const elementRegistry = modeler.get('elementRegistry');
const popupMenu = modeler.get('popupMenu', false);
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
let version = null;       // version of the document this window's edits are based on
let importing = false;
let rendered = false;
let dirty = false;        // edits made since the last send (or import)
let sendTimer = null;     // pending debounced send
let sendHeld = false;     // a send came due but has to wait (update in flight, or a rebase is due)
let sending = false;      // serialising the document for a send
let inflight = null;      // { edits } of the update sent and not yet answered by 'ack' / 'conflict'
let mustRebase = false;   // the host refused our update: re-apply our edits on the newer document
let unsent = false;       // edits made while disconnected
let flushRequested = false; // the host is shutting down and waits for 'flushed'
let lastError = null;     // { code, message } from the server, cleared by the next ack
let fileStatus = { state: 'ok' }; // state of the file on disk, pushed by the host ('file-status')
let reloadedTimer = null; // "Reloaded from disk" notice is showing while set
let toastTimer = null;
let deferredUpdate = null; // newest remote-update held back while this window had local edits
let localEdits = [];      // this window's edits since the last send or import (see recordCommand)
let redoEdits = [];       // edits taken back by undo (unsent), for redo
let replaying = null;     // while re-applying an op: { flowId, spliced } (see applyOpChecked)
let droppedOnFlow = null; // id of the flow the running root command inserted a shape into, if any
let deleteSeen = null;    // seenOf() the elements the running root delete command removes
let pendingOverrides = []; // others' concurrent changes our next update removes (see applyOp 'delete')
let unsavedEdits = [];    // [{ version, edits }] accepted by the host but not on disk yet ('saved')
let lostEdits = [];       // accepted edits a change on disk replaced before they were saved: re-applied
                          // on top of it, before the other unsent edits (see 'remote-update')
const recentChanges = new Map(); // element id -> when an update of ours that changed it was accepted
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

function hasPendingSend() {
  return Boolean(dirty || sendTimer || sendHeld || sending || inflight);
}

function renderStatus() {
  let state;
  if (!connected) state = everConnected ? 'disconnected' : 'connecting';
  else if (lastError) state = 'error';
  else if (hasPendingSend() || mustRebase) state = 'saving';
  else state = 'saved';

  statusEl.dataset.state = state;
  statusEl.textContent = STATUS_TEXT[state];
  if (state === 'error') statusEl.title = lastError.message;
  else if (state === 'disconnected' && (unsent || hasPendingSend())) {
    statusEl.title = 'Connection to local-bpmn lost; recent changes were not saved';
  } else statusEl.removeAttribute('title');
}

const NOTICES = {
  missing: { text: 'File deleted on disk', title: 'Your next edit will recreate it' },
  invalid: { text: 'File on disk is not valid BPMN; showing the last good version' },
  reloaded: { text: 'Reloaded from disk' },
  deferred: {
    text: 'Disk changed; reloads after your edit',
    title: 'Your edit is then re-applied on top of the change made on disk',
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
  // Only worth telling while the user is busy: otherwise it is shown within milliseconds.
  else if (deferredUpdate && interactionActive()) kind = 'deferred';
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

/**
 * Short-lived notice about edits of this window that were not applied (see rebaseLocalEdits).
 * `kind`: 'conflict' (someone else changed the same thing first) or 'dropped' (anything else).
 */
function showToast(kind, text, details = []) {
  clearTimeout(toastTimer);
  toastEl.dataset.kind = kind;
  toastEl.textContent = text;
  if (details.length) toastEl.title = details.join('\n');
  else toastEl.removeAttribute('title');
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastTimer = null;
    toastEl.hidden = true;
  }, TOAST_MS);
}

function isOpen() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

function sendMessage(message) {
  if (!isOpen()) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/**
 * Serialises the diagram and sends it as an update based on `version`. The edits it contains wait
 * in `inflight` until the host answers ('ack' or 'conflict'); at most one update is in flight.
 */
function sendNow() {
  clearTimeout(sendTimer);
  sendTimer = null;
  sendHeld = false;
  if (inflight || sending) {
    sendHeld = true; // sent when the host has answered the update in flight
    renderStatus();
    return;
  }
  const edits = localEdits;
  localEdits = [];
  redoEdits = [];
  dirty = false;
  sending = true;
  renderStatus();
  const baseVersion = version;
  const overrides = pendingOverrides;
  pendingOverrides = [];
  modeler.saveXML({ format: true }).then(({ xml }) => {
    const message = { type: 'update', xml, baseVersion };
    if (overrides.length) message.overrides = overrides;
    if (sendMessage(message)) {
      inflight = { edits };
    } else {
      unsent = true;
      localEdits = [...edits, ...localEdits];
      dirty = true;
    }
  }, (err) => {
    lastError = { code: 'serialize-failed', message: `Could not serialise the diagram: ${err.message}` };
  }).finally(() => {
    sending = false;
    renderStatus();
    settleLocalActivity();
  });
}

function scheduleSend() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(onSendDue, SEND_DELAY_MS);
  renderStatus();
}

/**
 * The debounced send is due. It waits while an update is in flight, and while another window's
 * document is held back (sending now would only be refused): the edits are then re-applied on top
 * of that document first (settleLocalActivity).
 */
function onSendDue() {
  sendTimer = null;
  if (inflight || sending || mustRebase || deferredUpdate) {
    sendHeld = true;
    renderStatus();
    settleLocalActivity();
    return;
  }
  sendNow();
}

/** The host is shutting down: commit an open label edit, send pending edits, then confirm. */
function flushForShutdown() {
  if (directEditing.isActive()) directEditing.complete();
  flushRequested = true;
  if (sendTimer) sendNow();
  settleLocalActivity();
  checkFlushed();
}

/** Answers a flush request once nothing is pending any more. */
function checkFlushed() {
  if (!flushRequested || hasPendingSend() || mustRebase) return;
  flushRequested = false;
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
  resetLocalEdits(); // importing cleared the command stack
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

/** True while the user is in the middle of an edit (typing a label, dragging, a popup menu open). */
function interactionActive() {
  return directEditing.isActive() || Boolean(dragging.context()) || Boolean(popupMenu?.isOpen());
}

/** True while this window has edits the host has not accepted yet, or the user is in the middle of one. */
function hasLocalChanges() {
  return hasPendingSend() || mustRebase || interactionActive();
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
  notifyOverrides(message.overrides);
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
  if (version !== null && message.version <= version) return; // already superseded
  if (hasLocalChanges()) {
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
 * or conflict received, debounced send due). Handles a held-back remote update in the message order.
 */
function settleLocalActivity() {
  enqueue(settleNow);
}

/**
 * Once the user is done (no label editor, drag or popup menu) and no update is on its way to the
 * host, a held-back remote update is:
 * - dropped if a local edit was accepted by the host after it (higher version; only possible for a
 *   change made on disk the editor could not display, see Session);
 * - shown, with this window's unsent edits re-applied on top, if there are any or the host refused
 *   our update (a change made on disk is treated like another window's edit: Q2);
 * - otherwise simply shown.
 * Then anything still unsent goes out.
 */
async function settleNow() {
  if (deferredUpdate && !interactionActive() && !sending && !inflight) {
    const message = deferredUpdate;
    const unsentEdits = Boolean(dirty || localEdits.length || lostEdits.length);
    deferredUpdate = null;
    if (version !== null && message.version <= version) {
      console.warn(`local-bpmn: an edit from this window replaced ${describeOrigin(message.origin)}`);
    } else if (unsentEdits || mustRebase) {
      await rebaseLocalEdits(message);
    } else {
      await showRemoteDocument(message);
    }
  }
  if (sendHeld && !inflight && !sending && !mustRebase && !deferredUpdate) {
    sendNow();
  }
  renderNotice();
  renderStatus();
  checkFlushed();
}

// --- Re-applying unsent local edits on top of another window's document -------------------------
//
// Each user action is one root command on the bpmn-js command stack (nested commands are side
// effects of it). Right after a root command has run, it is recorded as an "edit": id-based ops
// that repeat the action with `modeling` on another version of the document, plus what each op
// expects to find (e.g. the label before the edit), so a change someone else made to the same thing
// is detected instead of overwritten. Commands without an op capture, and undo/redo of edits that
// were already sent, are recorded as unsupported edits: they are sent as usual, but if the host
// refuses the update they cannot be re-applied and are dropped (with a notice) rather than letting
// this window's whole document replace other people's changes.

/** Thrown when an op cannot be recorded. */
class CaptureError extends Error {}

/** Plain copy of a point or bounds (commands keep references to live objects). */
function plainBounds({ x, y, width, height }) {
  return width === undefined ? { x, y } : { x, y, width, height };
}

/** The text of an element's label, as bpmn-js edits it. */
function labelOf(element) {
  const bo = element.businessObject;
  if (!bo) return null;
  if (bo.$instanceOf('bpmn:TextAnnotation')) return bo.text ?? null;
  if (bo.$instanceOf('bpmn:Group')) return bo.categoryValueRef?.value ?? null;
  return bo.name ?? null;
}

/** How to call an element in a notice: its name, else its id. */
function nameOf(element) {
  const target = element.labelTarget || element;
  return labelOf(target) || target.id;
}

/** Op for a connection created by a command (kept with its id and type, re-laid out on re-apply). */
function connectionOp(connection) {
  return {
    kind: 'connect',
    id: connection.id,
    type: connection.businessObject.$type,
    sourceId: connection.source.id,
    targetId: connection.target.id,
    name: nameOf(connection.source),
    sourceName: nameOf(connection.source),
    targetName: nameOf(connection.target),
  };
}

/** Ops that re-create `element` (a shape, or a connection) as it is right after its creation. */
function createdElementOps(element) {
  if (element.labelTarget) return []; // external labels are re-created with their element
  if (element.waypoints) return [connectionOp(element)];
  const bo = element.businessObject;
  if (bo.$instanceOf('bpmn:Participant') || bo.$instanceOf('bpmn:Lane')) {
    throw new CaptureError(`creating a ${bo.$type} is not supported`);
  }
  const eventDefinitions = bo.eventDefinitions || [];
  if (eventDefinitions.length > 1) throw new CaptureError('multiple event definitions are not supported');
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
    parentName: nameOf(parent),
    attach: Boolean(element.host),
  }];
}

/** Op for moving `shapes` by `delta`; records where each shape was before (to detect conflicts). */
function moveOp(shapes, delta, target, attach) {
  return {
    kind: 'move',
    from: shapes.map((shape) => ({ id: shape.id, x: shape.x - delta.x, y: shape.y - delta.y, name: nameOf(shape) })),
    delta: plainBounds(delta),
    targetId: target?.id ?? null,
    targetName: target ? nameOf(target) : undefined,
    attach,
  };
}

/** Root command -> function(context) returning the ops that repeat it. Anything else: unsupported. */
const OP_CAPTURE = {
  'element.updateLabel': ({ element, newLabel, oldLabel, newBounds }) => [{
    kind: 'label',
    id: element.id,
    text: newLabel ?? null,
    oldText: oldLabel ?? null,
    bounds: newBounds ? plainBounds(newBounds) : undefined,
    name: oldLabel || nameOf(element),
  }],
  'elements.move': ({ shapes, delta, newParent, newHost, hints = {} }) => [
    moveOp(shapes, delta, hints.attach === true ? newHost : newParent, hints.attach),
  ],
  'shape.move': ({ shape, delta, newParent }) => [moveOp([shape], delta, newParent)],
  'elements.create': ({ elements }) => elements.flatMap(createdElementOps),
  'shape.create': ({ shape }) => createdElementOps(shape),
  'shape.append': ({ source, shape }) => {
    const connection = [...shape.incoming, ...shape.outgoing]
      .find((c) => c.source === source || c.target === source);
    return [...createdElementOps(shape), ...(connection ? [connectionOp(connection)] : [])];
  },
  'connection.create': ({ connection }) => [connectionOp(connection)],
  'elements.delete': ({ elements }) => [deleteOp(elements)],
  'shape.delete': ({ shape }) => [deleteOp([shape])],
  'connection.delete': ({ connection }) => [deleteOp([connection])],
};

/**
 * Op for deleting `elements`, with what each looked like when it was deleted: if someone else
 * changed it meanwhile, the delete still wins, but they are told (see 'overrides' in the protocol).
 */
function deleteOp(elements) {
  const seen = deleteSeen ?? seenOf(elements); // taken before the command ran (see the listener below)
  return { kind: 'delete', ids: elements.map((element) => element.id), seen };
}

/**
 * For each element: what it looks like now, how to call it and (shapes) the connections attached
 * to it (see deleteOp).
 */
function seenOf(elements) {
  return Object.fromEntries(elements.map((element) => [element.id, {
    key: identityKey(element),
    name: nameOf(element),
    attached: element.waypoints ? undefined : [...element.incoming, ...element.outgoing].map((c) => c.id),
  }]));
}

/** Elements a delete command is about to remove. */
const DELETE_TARGETS = {
  'elements.delete': ({ elements }) => elements,
  'shape.delete': ({ shape }) => [shape],
  'connection.delete': ({ connection }) => [connection],
};

/** What a user would call a change of an element: position/size, ends of a connection, name. */
function identityKey(element) {
  const name = labelOf(element.labelTarget || element) ?? '';
  if (element.waypoints) return `c|${element.source?.id}|${element.target?.id}|${name}`;
  return `s|${element.x},${element.y},${element.width},${element.height}|${name}`;
}

function resetLocalEdits() {
  localEdits = [];
  redoEdits = [];
  droppedOnFlow = null;
  deleteSeen = null;
}

/**
 * The id of the root command running now, or null while a nested command runs. diagram-js 15
 * (vendored with bpmn-js 18) keeps the running commands, outermost first, in this private field;
 * execute() and the internal execution each push the command, so while only the root runs, every
 * entry is the root's action. Undefined if the field is missing (then edits are unsupported).
 */
function rootCommandId() {
  const actions = commandStack._currentExecution?.actions;
  if (!actions) return undefined;
  return actions.length && actions.every((action) => action === actions[0]) ? actions[0].id : null;
}

/** Records a finished root command as an edit (see OP_CAPTURE). */
function recordCommand({ command, context }) {
  if (importing) return;
  const id = rootCommandId();
  if (id === null) return; // nested: part of the root command's edit
  redoEdits = [];
  const splicedFlowId = droppedOnFlow;
  droppedOnFlow = null;
  const capturedSeen = deleteSeen;
  deleteSeen = null;
  const capture = OP_CAPTURE[command];
  if (id === undefined || !capture) {
    localEdits.push({ id, unsupported: describeCommand(command) });
    return;
  }
  try {
    // Everything the command changed, nested commands and behaviours included: re-applying it may
    // change these (and connections attached to them), nothing else (see applyOpChecked).
    const touched = [...new Set((commandStack._currentExecution?.dirty ?? []).map((element) => element.id))];
    deleteSeen = capturedSeen;
    let ops;
    try {
      ops = capture(context);
    } finally {
      deleteSeen = null;
    }
    // Dropped onto a flow: re-applied only if bpmn-js picks the same flow again (see applyOpChecked).
    if (splicedFlowId) for (const op of ops) if (op.kind === 'move' || op.kind === 'create') op.flowId = splicedFlowId;
    localEdits.push({ id, ops, touched });
  } catch (err) {
    if (!(err instanceof CaptureError)) console.error(err);
    localEdits.push({ id, unsupported: describeCommand(command) });
  }
}

/** Human wording of a command for notices ('shape.resize' -> 'resize'). */
function describeCommand(command) {
  return command.replace(/^(elements?|shape|connection|canvas)\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Undo of an edit not sent yet takes it back; undo of an edit already sent cannot be expressed as
 * ops and is recorded as an unsupported 'undo' edit referring to it (see normalizeEdits).
 */
function recordUndo() {
  const undone = commandStack._stack?.[commandStack._stackIdx + 1]?.id;
  const last = localEdits[localEdits.length - 1];
  if (undone !== undefined && last && last.id === undone) redoEdits.push(localEdits.pop());
  else localEdits.push({ id: undone, unsupported: 'undo', undo: true });
}

function recordRedo() {
  const redone = commandStack._stack?.[commandStack._stackIdx]?.id;
  const next = redoEdits[redoEdits.length - 1];
  if (redone !== undefined && next && next.id === redone) localEdits.push(redoEdits.pop());
  else localEdits.push({ id: redone, unsupported: 'redo', redo: true });
}

/**
 * Edits to re-apply, in order: an unsupported undo of an edit that is itself in the list cancels
 * it (and a later redo restores it), so an undone edit is never re-applied.
 */
function normalizeEdits(edits) {
  const result = [];
  const undone = new Map();
  for (const edit of edits) {
    if (edit.undo && edit.id !== undefined) {
      const index = result.findLastIndex((e) => e.id === edit.id && !e.unsupported);
      if (index >= 0) {
        undone.set(edit.id, result.splice(index, 1)[0]);
        continue;
      }
    }
    if (edit.redo && undone.has(edit.id)) {
      result.push(undone.get(edit.id));
      undone.delete(edit.id);
      continue;
    }
    result.push(edit);
  }
  return result;
}

/**
 * Re-applies one op with `modeling` on the document now showing. Returns { problems, kept }:
 * problems = [{ reason: 'deleted' | 'changed' | 'failed', name }] (empty if it applied completely);
 * kept = the part of the op that applied (the op itself, or narrowed), or null. Kept ops stay the
 * original objects, so what they expect to find (oldText, from, seen, flowId) still refers to the
 * document the user edited, however often they are re-applied.
 */
function applyOp(op) {
  const modeling = modeler.get('modeling');
  const bpmnFactory = modeler.get('bpmnFactory');
  const elementFactory = modeler.get('elementFactory');
  const get = (id) => elementRegistry.get(id);
  const none = (problems = []) => ({ problems, kept: null });
  switch (op.kind) {
    case 'label': {
      const element = get(op.id);
      if (!element) return none([{ reason: 'deleted', name: op.name }]);
      const current = labelOf(element.labelTarget || element);
      if ((current ?? '') === (op.text ?? '')) return none();
      if ((current ?? '') !== (op.oldText ?? '')) return none([{ reason: 'changed', name: op.name }]);
      modeling.updateLabel(element, op.text, op.bounds);
      return { problems: [], kept: op };
    }
    case 'move': {
      const problems = [];
      const shapes = [];
      const from = [];
      for (const entry of op.from) {
        const shape = get(entry.id);
        if (!shape) problems.push({ reason: 'deleted', name: entry.name });
        // Already where this move puts it (e.g. the document already contains this edit): nothing to do.
        else if (Math.abs(shape.x - entry.x - op.delta.x) <= 0.5 && Math.abs(shape.y - entry.y - op.delta.y) <= 0.5) continue;
        else if (Math.abs(shape.x - entry.x) > 0.5 || Math.abs(shape.y - entry.y) > 0.5) problems.push({ reason: 'changed', name: entry.name });
        else {
          shapes.push(shape);
          from.push(entry);
        }
      }
      const target = op.targetId ? get(op.targetId) : undefined;
      // The container or host it was moved into is gone: name that, not the moved shape.
      if (op.targetId && !target) return none([{ reason: 'deleted', name: op.targetName || op.targetId }]);
      if (!shapes.length) return none(problems);
      modeling.moveElements(shapes, op.delta, target, op.attach === undefined ? {} : { attach: op.attach });
      return { problems, kept: from.length === op.from.length ? op : { ...op, from } };
    }
    case 'create': {
      if (get(op.id)) return none(); // already there
      const parent = get(op.parentId);
      if (!parent) return none([{ reason: 'deleted', name: op.parentName || op.parentId }]); // where it was created
      // Created on a flow: bpmn-js only splices when the flow is given as the parent.
      const flow = op.flowId ? get(op.flowId) : null;
      const businessObject = bpmnFactory.create(op.type, op.name === undefined ? { id: op.id } : { id: op.id, name: op.name });
      const shape = elementFactory.createShape({
        type: op.type, businessObject, eventDefinitionType: op.eventDefinitionType, isExpanded: op.isExpanded,
      });
      modeling.createShape(shape, op.bounds, flow || parent, op.attach ? { attach: true } : {});
      return { problems: [], kept: op };
    }
    case 'connect': {
      if (get(op.id)) return none();
      const source = get(op.sourceId);
      const target = get(op.targetId);
      // Name the end that is gone (the source if both are).
      if (!source || !target) return none([{ reason: 'deleted', name: source ? op.targetName : op.sourceName }]);
      const businessObject = bpmnFactory.create(op.type, { id: op.id });
      if (!modeling.connect(source, target, { type: op.type, businessObject })) return none([{ reason: 'failed', name: op.name }]);
      return { problems: [], kept: op };
    }
    case 'delete': {
      // Already gone (deleted elsewhere too) is fine: the result is the same.
      const elements = op.ids.map((id) => get(id)).filter(Boolean);
      if (!elements.length) return none();
      for (const element of elements) {
        const seen = op.seen?.[element.id];
        if (!seen) continue;
        if (seen.key !== identityKey(element)) pendingOverrides.push({ id: element.id, name: seen.name });
        // Connections to or from it that someone else added meanwhile go with it.
        for (const connection of element.waypoints || !seen.attached ? [] : [...element.incoming, ...element.outgoing]) {
          if (!seen.attached.includes(connection.id)) pendingOverrides.push({ id: connection.id, name: seen.name, kind: 'connection' });
        }
      }
      modeling.removeElements(elements);
      return { problems: [], kept: op };
    }
    default:
      return none([{ reason: 'failed', name: op.kind }]);
  }
}

/**
 * State of every element, split into what is structural (existence, parent/host or connection ends,
 * name) and what is only geometry (bounds, waypoints).
 */
function stateSnapshot() {
  const state = new Map();
  for (const e of elementRegistry.getAll()) {
    const name = e.businessObject?.name ?? '';
    if (e.waypoints) {
      state.set(e.id, { struct: `c|${e.source?.id}|${e.target?.id}|${name}`, geom: e.waypoints.map((p) => `${p.x},${p.y}`).join(' '), minor: true });
    } else if (e.labelTarget) {
      state.set(e.id, { struct: `l|${e.labelTarget.id}|${name}`, geom: `${e.x},${e.y},${e.width},${e.height}`, minor: true });
    } else {
      state.set(e.id, { struct: `s|${e.parent?.id}|${e.host?.id ?? ''}|${name}`, geom: `${e.x},${e.y},${e.width},${e.height}`, minor: false });
    }
  }
  return state;
}

/**
 * applyOp, guarded: bpmn-js behaviours run again when an op is re-applied, against a document with
 * other people's changes (e.g. a shape moved onto someone else's new flow would be spliced into
 * it). The op may change the elements its original command changed (`touched`) and connections
 * attached to them. Anywhere else it may only re-lay out connections and move external labels
 * (geometry); any other change (an element created, removed, reconnected, re-parented, renamed, or
 * another shape moved) means the op is undone and reported as failed. Dropping onto a flow only
 * happens again into the flow of the original drop (see the listener below).
 */
function applyOpChecked(op, touched) {
  if (!touched) return applyOp(op);
  const allowed = new Set(touched);
  const allowAttached = (element) => {
    for (const connection of [...(element?.incoming ?? []), ...(element?.outgoing ?? [])]) allowed.add(connection.id);
  };
  for (const id of touched) allowAttached(elementRegistry.get(id));
  const before = stateSnapshot();
  const stackIdx = commandStack._stackIdx;
  replaying = { flowId: op.flowId ?? null, spliced: false };
  let result;
  let spliced;
  try {
    result = applyOp(op);
  } finally {
    ({ spliced } = replaying);
    replaying = null;
  }
  if (commandStack._stackIdx === stackIdx) return result; // nothing executed
  const after = stateSnapshot();
  // A re-applied drop onto a flow creates the second half of the split flow under a new id.
  if (spliced) for (const id of touched) allowAttached(elementRegistry.get(id));
  const foreign = [...new Set([...before.keys(), ...after.keys()])].filter((id) => {
    if (allowed.has(id)) return false;
    const was = before.get(id);
    const is = after.get(id);
    if (!was || !is || was.struct !== is.struct) return true;
    return was.geom !== is.geom && !is.minor;
  });
  const missedSplice = Boolean(op.flowId) && !spliced;
  if (!foreign.length && !missedSplice) return result;
  console.warn(`local-bpmn: re-applying an edit (${op.kind}) ${missedSplice ? 'could not drop it onto the same flow'
    : `would also have changed ${foreign.join(', ')}`}; it was undone`);
  commandStack.undo();
  return { problems: [...result.problems, { reason: 'failed', name: op.name || op.from?.[0]?.name || op.kind }], kept: null };
}

/**
 * Re-applies `edits` on the document now showing (the one in `message`). The commands this runs are
 * recorded as edits again (recordCommand), but those are replaced by the original edits, narrowed
 * to what applied: an edit re-applied several times (each time the host refuses the update) keeps
 * its original ops and context. An op that throws unexpectedly may leave the command stack
 * half-done, so the document is then imported again and the edits re-applied without that op.
 * Resolves to the problems (see applyOp).
 */
async function replayEdits(edits, message) {
  const skip = new Set();
  for (;;) {
    pendingOverrides = [];
    const problems = [];
    let failedAt = null;
    let index = 0;
    for (const edit of edits) {
      if (edit.unsupported) {
        problems.push({ reason: 'unsupported', name: edit.unsupported });
        continue;
      }
      const mark = localEdits.length;
      const kept = [];
      for (const op of edit.ops) {
        const key = index++;
        if (skip.has(key)) {
          problems.push({ reason: 'failed', name: op.name || op.kind });
          continue;
        }
        try {
          const result = applyOpChecked(op, edit.touched);
          problems.push(...result.problems);
          if (result.kept) kept.push(result.kept);
        } catch (err) {
          console.error('local-bpmn: could not re-apply an edit', op, err);
          failedAt = key;
          break;
        }
      }
      if (failedAt !== null) break;
      const recorded = localEdits.splice(mark);
      if (kept.length) localEdits.push({ ...edit, ops: kept, id: recorded.at(-1)?.id ?? edit.id });
    }
    if (failedAt === null) return problems;
    skip.add(failedAt);
    commandStack._currentExecution = { actions: [], dirty: [], trigger: null }; // abandon the broken command
    const view = canvas.viewbox();
    await importDiagram(message.xml);
    canvas.viewbox(view);
  }
}

/** Tells the user which of their edits were not applied (`fromDisk`: on top of a change made on disk). */
function reportProblems(problems, fromDisk = false) {
  if (!problems.length) return;
  const sentences = problems.map(({ reason, name }) => (fromDisk ? {
    changed: `Your change to “${name}” was not applied: it was changed on disk at the same time (the file's version was kept)`,
    deleted: `Your change to “${name}” was not applied: it was deleted on disk`,
    unsupported: `Your edit (${name}) could not be merged with a change made on disk and was not applied`,
    failed: `Your change to “${name}” could not be applied on top of a change made on disk`,
  } : {
    changed: `Your change to “${name}” was not applied: someone else changed it first`,
    deleted: `Your change to “${name}” was not applied: someone else deleted it`,
    unsupported: `Your edit (${name}) could not be merged with someone else's and was not applied`,
    failed: `Your change to “${name}” could not be applied on top of someone else's edit`,
  })[reason]);
  const unique = [...new Set(sentences)];
  for (const sentence of unique) console.warn(`local-bpmn: ${sentence}`);
  const kind = problems.some((p) => p.reason === 'changed') ? 'conflict' : 'dropped';
  showToast(kind, unique.length > 1 ? `${unique[0]} (+${unique.length - 1} more)` : unique[0], unique);
}

/**
 * Shows another window's document (`message`) and re-applies this window's edits the host has not
 * accepted on top of it; the result is sent right away. Edits that cannot be re-applied are
 * dropped one by one, with a notice; the others are kept.
 */
async function rebaseLocalEdits(message) {
  clearTimeout(sendTimer);
  sendTimer = null;
  const edits = normalizeEdits([...lostEdits, ...localEdits]);
  lostEdits = [];
  localEdits = [];
  mustRebase = false;
  if (!(await showRemoteDocument(message))) {
    // The other document cannot be displayed here (should not happen: it was displayed where it
    // was made). Keep this window's document and replace that one explicitly, with an error shown.
    localEdits = edits;
    advanceVersion(message.version);
    dirty = true;
    sendNow();
    return;
  }
  dirty = false;
  const problems = await replayEdits(edits, message);
  if (message.origin === 'disk') reportDiskMerge(edits, problems);
  else reportProblems(problems);
  if (dirty) sendNow();
  else sendHeld = false;
}

/**
 * After re-applying this window's edits on top of a change made on disk (Q2): says what happened.
 * Edits that could not be applied are reported as such; a delete that removed an element changed on
 * disk says so too (the file's change to it is gone); otherwise the merge is confirmed.
 */
function reportDiskMerge(edits, problems) {
  if (problems.length) {
    reportProblems(problems, true);
    return;
  }
  if (pendingOverrides.length) {
    const sentences = pendingOverrides.map(({ name, id, kind }) => (kind === 'connection'
      ? `Your delete of “${name || id}” also removed a connection added on disk`
      : `Your delete of “${name || id}” removed a change made to it on disk`));
    for (const sentence of sentences) console.warn(`local-bpmn: ${sentence}`);
    showToast('conflict', sentences.length > 1 ? `${sentences[0]} (+${sentences.length - 1} more)` : sentences[0], sentences);
    return;
  }
  // dirty: something was re-applied (an edit the change on disk already contained needs no notice).
  if (edits.length && dirty) showToast('merged', 'The file was changed on disk; your edits were applied on top of that change');
}

/** Fetches the host's current document (used if a newer one is needed but was not received). */
async function fetchLatest() {
  const response = await fetch('/api/file', { cache: 'no-store' });
  const { xml, version: latest } = await response.json();
  return { type: 'remote-update', xml, version: latest, origin: 'host' };
}

/** How long an accepted change of ours counts as recent (for notices about concurrent deletes). */
const RECENT_CHANGE_MS = 30_000;

/** Remembers the elements our accepted update changed. */
function rememberChanges(edits) {
  const now = Date.now();
  for (const [id, time] of recentChanges) if (now - time > RECENT_CHANGE_MS) recentChanges.delete(id);
  for (const edit of edits) {
    for (const op of edit.ops ?? []) {
      if (op.kind === 'delete') continue;
      for (const id of op.from ? op.from.map((f) => f.id) : [op.id]) recentChanges.set(id.replace(/_label$/, ''), now);
    }
  }
}

/**
 * Another window deleted elements that someone changed concurrently ('overrides'): if that was us,
 * our change is gone, so say so.
 */
function notifyOverrides(overrides) {
  if (!Array.isArray(overrides)) return;
  const now = Date.now();
  const ours = overrides.filter(({ id }) => now - (recentChanges.get(id) ?? -Infinity) <= RECENT_CHANGE_MS);
  if (!ours.length) return;
  const sentences = ours.map(({ name, id, kind }) => (kind === 'connection'
    ? `Your connection to “${name || id}” was removed: someone else deleted it at the same time`
    : `Your change to “${name || id}” was undone: someone else deleted it at the same time`));
  for (const sentence of sentences) console.warn(`local-bpmn: ${sentence}`);
  for (const { id } of ours) recentChanges.delete(id);
  showToast('conflict', sentences.length > 1 ? `${sentences[0]} (+${sentences.length - 1} more)` : sentences[0], sentences);
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
      // A (new) connection starts from the host's current document: edits waiting for a disk write
      // under an earlier connection's versions no longer apply (Q2).
      unsavedEdits = [];
      lostEdits = [];
      try {
        await importDiagram(message.xml);
        version = message.version;
      } catch (err) {
        showError(`Could not render ${message.name || 'the diagram'}: ${err.message}`);
        reportImportFailure({ origin: 'disk', version: message.version }, err); // the host checks the origin
      }
      break;
    case 'ack':
      rememberChanges(inflight?.edits ?? []);
      // Kept until the host has written them, in case a change on disk replaces them first (Q2).
      if (inflight?.edits?.length) unsavedEdits.push({ version: message.version, edits: inflight.edits });
      inflight = null;
      advanceVersion(message.version);
      lastError = null;
      settleLocalActivity();
      break;
    case 'conflict': {
      // The host has a newer document (sent to us as 'remote-update' before this): re-apply the
      // refused edits, and whatever was edited since, on top of it.
      localEdits = [...(inflight?.edits ?? []), ...localEdits];
      inflight = null;
      mustRebase = true;
      if (!deferredUpdate || deferredUpdate.version < message.version) {
        try {
          deferredUpdate = await fetchLatest();
        } catch (err) {
          lastError = { code: 'conflict', message: `Could not load the newer document: ${err.message}` };
        }
      }
      settleLocalActivity();
      break;
    }
    case 'error':
      // 'write-failed' is pushed by the host on its own; other errors answer our update.
      if (message.code !== 'write-failed') inflight = null;
      lastError = { code: message.code, message: message.message };
      console.warn(`local-bpmn: ${message.code}: ${message.message}`);
      settleLocalActivity();
      break;
    case 'flush':
      flushForShutdown();
      break;
    case 'saved':
      unsavedEdits = unsavedEdits.filter((entry) => entry.version > message.version);
      break;
    case 'remote-update':
      if (message.origin === 'disk' && Number.isInteger(message.discardedAfter)) {
        // The file changed on disk before our accepted edits were written: they are not in this
        // document. Re-apply them on top of it (Q2), like edits the host refused.
        const lost = unsavedEdits.filter((entry) => entry.version > message.discardedAfter);
        unsavedEdits = [];
        if (lost.length) {
          lostEdits.push(...lost.flatMap((entry) => entry.edits));
          mustRebase = true;
        }
      }
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
  if (event.trigger === 'undo') recordUndo();
  else if (event.trigger === 'redo') recordRedo();
  dirty = true;
  scheduleSend();
});
modeler.on('commandStack.postExecuted', recordCommand);

// A delete removes external labels before it is recorded: note what the elements looked like (name
// included) while they are still complete.
modeler.on('commandStack.preExecute', ({ command, context }) => {
  if (importing || !DELETE_TARGETS[command] || !rootCommandId()) return;
  deleteSeen = seenOf(DELETE_TARGETS[command](context));
});

// bpmn-js inserts a shape that is dropped (moved or created) onto a sequence flow into that flow.
// The user's own drop records the flow (see recordCommand); while re-applying edits, it only happens
// again into that same flow, so a re-applied move never splices into another flow (possibly someone
// else's new one) by accident.
modeler.on(['commandStack.elements.move.postExecuted', 'commandStack.shape.create.postExecuted'], 1500, ({ context }) => {
  if (!context.targetFlow) return;
  if (!replaying) droppedOnFlow = context.targetFlow.id;
  else if (replaying.flowId === context.targetFlow.id) replaying.spliced = true;
  else delete context.targetFlow;
});

// Closing the label editor, ending a drag (committed or cancelled) or closing a popup menu may
// release a held-back remote update.
modeler.on('directEditing.deactivate', () => settleLocalActivity());
modeler.on('drag.cleanup', () => settleLocalActivity());
modeler.on('popupMenu.close', () => settleLocalActivity());

// Leaving or hiding the page: send a pending edit now rather than after the debounce.
window.addEventListener('pagehide', () => {
  if (directEditing.isActive()) directEditing.complete();
  if (sendTimer) sendNow();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && sendTimer) sendNow();
});

renderStatus();
connect();
