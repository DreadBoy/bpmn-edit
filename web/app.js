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
// connect, delete, and plain attribute changes made in the properties panel, such as a name or a
// signal's name) concurrent edits of different elements are kept; an op that cannot be re-applied
// (its element was deleted, someone else changed the same label or position first, or re-applying it
// would change other elements than the original edit did) is dropped on its own, with a visible
// notice. Other edits are dropped, with a notice, only if they race someone else's edit. A delete
// that removes an element someone else changed concurrently is reported to them ('overrides').
//
// Only one update is in flight at a time. A document from someone else that arrives while the user
// is in the middle of an edit (label editor open, drag, popup menu) is held back until it is done.
// Text being typed in the properties panel does not hold it back: it is carried over into the new
// document instead (see web/properties.js).
//
// The same page serves the host (`/?host=<secret>`, printed by the CLI) and collaborators
// (`/s/<token>/`); every URL it uses is relative to the page, so it works under both. The host secret
// is moved out of the address bar at once (history.replaceState) into sessionStorage (this tab only,
// survives a reload); it is sent only to this server, on host-only calls and on the WebSocket
// handshake. With a valid secret the host's socket receives 'share' messages, which show the Share
// controls; without one (or as a collaborator) they never appear.
//
// Connection (S8; rules and numbers in web/connection-shared.js): a connection lost without a close
// code from the host (network, tunnel, host process killed) shows "Reconnecting…" and is retried
// with backoff. Edits made meanwhile are kept; on the new connection's 'init' the window re-syncs:
// if the host's document is the one this window's edits are based on (or already contains the
// update that was in flight), they are simply sent; otherwise the host's document is shown and the
// edits are re-applied op by op, exactly as for a 'conflict'. The window gives up and shows "Session
// ended" when the host closes with 4001 (sharing stopped) or 4002 (host shut down), when a probe of
// `api/file` says the link is gone (404, or Cloudflare 530 for a while), or after the retry limit.
// The page pings the host (heartbeat) to notice connections that die silently. A page whose host
// secret is from an earlier run of the CLI reconnects as a plain local editor (the host says so in
// 'init'); it can edit, not share.

import {
  CLOSE_SESSION_ENDED, CLOSE_SHARE_STOPPED, HEARTBEAT_MS, RECONNECT, probeVerdict, reconnectDelay, shouldGiveUp,
} from './connection-shared.js';
import { createPresence } from './presence.js';
import { createPropertiesPanel, propertiesPanelOptions } from './properties.js';

/** Edits are sent this long after the last change (coalesces bursts such as keyboard nudges). */
const SEND_DELAY_MS = 300;

/** How long the "Reloaded from disk" notice stays visible. */
const RELOADED_NOTICE_MS = 3000;

/** How long a notice about edits that could not be merged stays visible. */
const TOAST_MS = 8000;

const STATUS_TEXT = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  saved: 'Saved',
  saving: 'Saving…',
  disconnected: 'Disconnected',
  error: 'Not saved',
};

/**
 * Connection timing; tests may shorten it by defining `window.bpmnEditTestConnection` before the
 * page runs ({ heartbeatMs, delays, jitter, giveUpAttempts, giveUpMs, tunnelGoneMs }).
 */
const testConnection = window.bpmnEditTestConnection ?? {};
const reconnectPolicy = { ...RECONNECT, ...testConnection };
const heartbeatMs = testConnection.heartbeatMs ?? HEARTBEAT_MS;

const fileNameEl = document.getElementById('file-name');
const statusEl = document.getElementById('save-status');
const errorEl = document.getElementById('error');
const noticeEl = document.getElementById('notice');
const toastEl = document.getElementById('toast');
const shareEl = document.getElementById('share');
const shareStartEl = document.getElementById('share-start');
const shareProgressEl = document.getElementById('share-progress');
const shareProgressTextEl = document.getElementById('share-progress-text');
const shareActiveEl = document.getElementById('share-active');
const shareUrlEl = document.getElementById('share-url');
const shareCopyEl = document.getElementById('share-copy');
const shareStopEl = document.getElementById('share-stop');
const shareErrorEl = document.getElementById('share-error');
const shareErrorTextEl = document.getElementById('share-error-text');
const reconnectingEl = document.getElementById('reconnecting');
const overlayEl = document.getElementById('session-overlay');
const overlayTitleEl = document.getElementById('session-overlay-title');
const overlayTextEl = document.getElementById('session-overlay-text');
const overlayActionEl = document.getElementById('session-overlay-action');

/** Collaborator page (`/s/<token>/`): never has host powers. */
const isCollaborator = location.pathname.startsWith('/s/');
const HOST_SECRET_KEY = 'bpmn-edit:host-secret';
let hostSecret = takeHostSecret();

/** Forgets a host secret the host no longer accepts (it is from an earlier run of the CLI). */
function dropHostSecret() {
  hostSecret = null;
  try {
    sessionStorage.removeItem(HOST_SECRET_KEY);
  } catch {
    // storage blocked: nothing stored
  }
}

/**
 * Random id of this page, kept in memory only (a reload or another tab has a different one). Sent in
 * 'hello', so the host can replace this page's old entry in the users list when it reconnects.
 */
const pageKey = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Removes `?host=` from the address bar (so it is not bookmarked, shown or shared by accident) and
 * returns the host secret: from the URL, or from this tab's sessionStorage after a reload.
 */
function takeHostSecret() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('host');
  if (fromUrl !== null) {
    url.searchParams.delete('host');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  if (isCollaborator) return null;
  try {
    if (fromUrl) sessionStorage.setItem(HOST_SECRET_KEY, fromUrl);
    return fromUrl || sessionStorage.getItem(HOST_SECRET_KEY);
  } catch {
    return fromUrl || null; // storage blocked: works until the next reload
  }
}

// V2-6: the colour picker (context pad "Set color", web/vendor/bpmn-js-color-picker) is a module of this one
// Modeler, not a bundle of its own bpmn-js: its bundle holds only the plugin's providers.
const propertiesEl = document.getElementById('properties-panel');
const propertiesOptions = propertiesPanelOptions(propertiesEl);
const modeler = new window.BpmnJS({
  container: '#canvas',
  ...propertiesOptions,
  additionalModules: [
    ...(propertiesOptions.additionalModules ?? []),
    ...(window.BpmnColorPickerModule ? [window.BpmnColorPickerModule] : []),
  ],
});
const canvas = modeler.get('canvas');
const commandStack = modeler.get('commandStack');
const directEditing = modeler.get('directEditing');
const dragging = modeler.get('dragging');
const elementRegistry = modeler.get('elementRegistry');
const popupMenu = modeler.get('popupMenu', false);
const selection = modeler.get('selection');
const presence = createPresence({ modeler, send: sendMessage, toolbar: document.getElementById('toolbar'), key: pageKey });
const propertiesPanel = createPropertiesPanel({
  modeler, container: propertiesEl, toggle: document.getElementById('properties-toggle'),
});

let clientId = null;      // assigned by the host in 'init'

// Exposed for tests and debugging.
window.bpmnModeler = modeler;

// Files from bpmn-js before version 9 keep the DI of a collapsed sub-process in the main diagram. On
// import, bpmn-js (SubprocessCompatibility, priority 1500) moves it into a diagram of its own and shifts
// shapes and waypoints next to the origin, but not the shapes' label bounds: such labels show far away
// from their elements. Shift them by the same amount (Q4-impl, docs/decisions.md). The file keeps its
// own coordinates: bpmn-edit's writer moves bpmn-js' changes back by that shift (src/minimal-diff.js).
{
  const eventBus = modeler.get('eventBus');
  let before = null;
  const positionOf = (di) => (di.bounds ? { x: di.bounds.x, y: di.bounds.y } : di.waypoint?.[0] ? { x: di.waypoint[0].x, y: di.waypoint[0].y } : null);
  const planeElements = (definitions) => (definitions.diagrams ?? []).flatMap((diagram) => diagram.plane?.planeElement ?? []);
  eventBus.on('import.render.start', 1600, ({ definitions }) => {
    before = new Map();
    for (const di of planeElements(definitions)) {
      const at = positionOf(di);
      if (at && di.label?.bounds) before.set(di, at);
    }
  });
  eventBus.on('import.render.start', 1400, ({ definitions }) => {
    if (!before) return;
    for (const di of planeElements(definitions)) {
      const was = before.get(di);
      const now = was && positionOf(di);
      if (!now || (now.x === was.x && now.y === was.y)) continue;
      di.label.bounds.x += now.x - was.x;
      di.label.bounds.y += now.y - was.y;
    }
    before = null;
  });
}
window.bpmnEdit = Object.freeze({
  /** This window's id in the session (from the host), or null before 'init'. */
  get clientId() { return clientId; },
});

let socket = null;
let connected = false;
let synced = false;       // 'init' of the current connection handled: updates may be sent
let everSynced = false;   // an 'init' was handled on some connection
let reconnect = null;     // while reconnecting: { attempts, since, tunnelGoneSince, timer }
let ended = null;         // why the session is over ('share-stopped', 'ended', …), shown as an overlay
let heartbeatTimer = null;
let lastPingAt = null;    // when the last heartbeat ping was sent on this connection
let lastReceivedAt = 0;   // when the last message arrived
let fileIdentity = null;  // path (or name) of the file the first 'init' showed
let syncedXml = null;     // the host's document at `version`, as far as this window knows
let syncedBaseline = null; // bpmn-js' serialisation of syncedXml right after importing it (see importDiagram)
let version = null;       // version of the document this window's edits are based on
let importing = false;
let carriedView = null;   // during an import: selection and properties panel field to restore (see importDiagram)
let rendered = false;
let dirty = false;        // edits made since the last send (or import)
let sendTimer = null;     // pending debounced send
let sendHeld = false;     // a send came due but has to wait (update in flight, or a rebase is due)
let sending = false;      // serialising the document for a send
let inflight = null;      // { edits, xml, seq, reapplied } of the update sent, not yet answered ('ack' / 'conflict')
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
// Pending edits (edits this window made that are not known to be on disk), oldest first:
//   unsavedEdits  accepted by the host ('ack'), not confirmed written yet ('saved')
//   lostEdits     accepted edits a change on disk replaced before they were written (told by
//                 'remote-update' with discardedAfter, or by 'init' after a reconnect): not in the
//                 host's document any more, re-applied like unsent edits
//   inflight      sent, not answered yet
//   localEdits    not sent yet (plus `dirty`)
// The last three are re-applied, in this order, by one path: rebaseLocalEdits (after a 'conflict',
// a change on disk that discarded accepted edits, or a reconnect to a changed document).
let unsavedEdits = [];    // [{ version, edits }], see above
let lostEdits = [];       // edits, see above
let lostVersions = [];    // versions of the accepted updates lostEdits came from
let pendingReapplied = []; // such versions re-applied, to tell the host (with the next update, or 'reapplied')
let updateSeq = 0;        // number of the last update sent (with the page key: see 'init' accepted)
let hostInstance = null;  // id of the host session the versions in unsavedEdits belong to ('init')
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

/** Edits this window has that the host has not (known to have) accepted. */
function hasUnsavedWork() {
  return Boolean(hasPendingSend() || mustRebase || localEdits.length || lostEdits.length);
}

/** Also edits the host accepted but has not confirmed as written to disk yet ('saved'). */
function hasUnconfirmedWork() {
  return hasUnsavedWork() || unsavedEdits.length > 0;
}

function renderStatus() {
  let state;
  if (ended) state = 'disconnected';
  else if (!connected || !synced) state = everSynced ? 'reconnecting' : 'connecting';
  else if (lastError) state = 'error';
  else if (hasPendingSend() || mustRebase) state = 'saving';
  else state = 'saved';

  statusEl.dataset.state = state;
  statusEl.textContent = STATUS_TEXT[state];
  if (state === 'error') statusEl.title = lastError.message;
  else if (state === 'disconnected' && (unsent || hasUnconfirmedWork())) {
    statusEl.title = 'Connection to bpmn-edit lost; recent changes may not have been saved';
  } else if (state === 'reconnecting' && hasUnconfirmedWork()) {
    statusEl.title = 'Your changes are kept and saved once the connection is back';
  } else statusEl.removeAttribute('title');
  reconnectingEl.hidden = state !== 'reconnecting';
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
  if (!synced || !isOpen()) {
    // Not connected (or not re-synced yet): sent after the next 'init' (see resync).
    sendHeld = true;
    unsent = true;
    renderStatus();
    return;
  }
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
  const reapplied = pendingReapplied;
  pendingReapplied = [];
  modeler.saveXML({ format: true }).then(({ xml }) => {
    updateSeq += 1;
    const message = { type: 'update', xml, baseVersion, seq: updateSeq };
    if (overrides.length) message.overrides = overrides;
    if (reapplied.length) message.reapplied = reapplied;
    if (sendMessage(message)) {
      inflight = { edits, xml, seq: updateSeq, reapplied };
    } else {
      unsent = true;
      localEdits = [...edits, ...localEdits];
      pendingReapplied = [...reapplied, ...pendingReapplied];
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

/**
 * Imports `xml`. `baselineFor`: the host's version of `xml` if it may come from the file on disk
 * (not another window's edit): bpmn-js' serialisation of it right after the import is sent to the
 * host as the 'baseline' of that version, the base of its minimal-diff writer (Q4). It is taken
 * before anything else can change the diagram (saveXML serialises synchronously when called).
 */
async function importDiagram(xml, { baselineFor = null, origin = null } = {}) {
  // What the user is looking at: kept across a failed import (the previous document is then
  // imported again), restored once one succeeds (see the 'import.done' listener and below).
  carriedView ??= {
    selectedIds: selection.get().map((element) => element.id),
    // What the panel shows: the selected element, else the process (or collaboration).
    panelName: selection.get()[0] ? nameOf(selection.get()[0]) : (canvas.getRootElement() && nameOf(canvas.getRootElement())),
    field: propertiesPanel.takeFieldState(),
  };
  importing = true;
  let serialised;
  try {
    const { warnings } = await modeler.importXML(xml);
    if (Number.isInteger(baselineFor)) serialised = modeler.saveXML({ format: true });
    if (warnings.length) console.warn('bpmn-edit: diagram imported with warnings', warnings);
  } finally {
    importing = false;
  }
  const { field, panelName } = carriedView;
  carriedView = null;
  // Text the user was typing in the properties panel goes back into its field (and is committed to
  // this document), unless its element is gone or someone else changed that value meanwhile.
  propertiesPanel.restoreFieldState(field).then((problem) => {
    if (problem) reportProblems([{ reason: problem, name: panelName || 'the element' }], origin === 'disk');
  });
  resetLocalEdits(); // importing cleared the command stack
  hideError(); // a diagram is showing (again): earlier render errors are over
  syncedXml = xml;
  syncedBaseline = null;
  if (!rendered) {
    canvas.zoom('fit-viewport', 'auto');
    rendered = true;
  }
  if (serialised) {
    try {
      syncedBaseline = (await serialised).xml;
      sendMessage({ type: 'baseline', version: baselineFor, xml: syncedBaseline });
    } catch (err) {
      console.warn('bpmn-edit: could not serialise the imported diagram', err);
    }
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
      await importDiagram(message.xml, { baselineFor: fromHost(message) ? message.version : null });
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
  const { xml: previousXml } = await modeler.saveXML({ format: true });

  try {
    await importDiagram(message.xml, { baselineFor: fromHost(message) ? message.version : null, origin: message.origin });
  } catch (err) {
    // Never leave the editor blank or broken: go back to what was shown before.
    console.warn('bpmn-edit: could not show the changed document', err);
    try {
      await importDiagram(previousXml);
    } catch {
      // Nothing better to show; the error notice below explains.
    }
    syncedXml = null; // what is showing is this window's, not known to be the host's
    syncedBaseline = null;
    canvas.viewbox({ x, y, width, height });
    // From disk, the host answers the report with an 'invalid' file status (shown as a notice);
    // anything else has no such indicator, so show the error.
    if (message.origin === 'disk') reportImportFailure(message, err);
    else showError(`Could not show the changed document: ${err.message}`);
    return false;
  }
  canvas.viewbox({ x, y, width, height }); // the selection is restored by importDiagram
  advanceVersion(message.version);
  if (message.origin === 'disk') showReloadedNotice();
  return true;
}

/**
 * Whether a document may be the file on disk ('disk', or the host's current document: 'host'), not
 * another window's edit (whose base the host already knows).
 */
function fromHost(message) {
  return message.origin === 'disk' || message.origin === 'host' || message.origin === undefined;
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
      console.warn(`bpmn-edit: an edit from this window replaced ${describeOrigin(message.origin)}`);
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
  // Properties panel (and a few context menu toggles): plain values (a name, a code, a flag) of the
  // element, of one of its event definitions or of a global element such as a bpmn:Signal.
  'element.updateProperties': ({ element, properties, oldProperties }) => [
    attrsOp(element, { kind: 'element' }, properties, oldProperties),
  ],
  'element.updateModdleProperties': ({ element, moddleElement, properties, oldProperties }) => [
    attrsOp(element, moddleTarget(element, moddleElement), properties, oldProperties),
  ],
};

/** A value an 'attrs' op can set and compare: a string, number, boolean or nothing. */
function isPlainValue(value) {
  return value === undefined || value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Same attribute value (unset and null are the same). */
function sameValue(a, b) {
  return (a ?? null) === (b ?? null);
}

/**
 * Op for setting plain attributes on `target` (see moddleTarget), with their values before, so a
 * concurrent change of the same attribute is detected. IDs and references are not supported.
 */
function attrsOp(element, target, properties, oldProperties = {}) {
  const keys = Object.keys(properties);
  if (!keys.length || keys.some((key) => key === 'id' || key === 'di' || key === 'default'
    || !isPlainValue(properties[key]) || !isPlainValue(oldProperties[key]))) {
    throw new CaptureError('only plain attributes can be re-applied');
  }
  return {
    kind: 'attrs',
    id: element.id,
    target,
    props: { ...properties },
    old: Object.fromEntries(keys.map((key) => [key, oldProperties[key]])),
    // How the user knew it before the edit (a rename names the old name, like a label edit).
    name: oldProperties.name || (target.kind === 'root' ? target.name || target.id : nameOf(element)),
  };
}

/** Where a moddle element is, relative to `element`: its business object, an event definition or a root element. */
function moddleTarget(element, moddleElement) {
  const bo = element.businessObject;
  if (moddleElement === bo) return { kind: 'element' };
  const index = (bo.eventDefinitions ?? []).indexOf(moddleElement);
  if (index >= 0) return { kind: 'eventDefinition', index, type: moddleElement.$type };
  if (moddleElement.id && moddleElement.$parent?.$instanceOf?.('bpmn:Definitions')) {
    return { kind: 'root', id: moddleElement.id, type: moddleElement.$type, name: moddleElement.name };
  }
  throw new CaptureError(`changing a ${moddleElement.$type} is not supported`);
}

/** The moddle element an 'attrs' op changes in the document now showing, or null if it is gone. */
function attrsTargetOf(element, target) {
  switch (target.kind) {
    case 'element':
      return element?.businessObject ?? null;
    case 'eventDefinition': {
      const definition = element?.businessObject.eventDefinitions?.[target.index];
      return definition?.$type === target.type ? definition : null;
    }
    case 'root':
      return modeler.getDefinitions()?.rootElements?.find((root) => root.id === target.id && root.$type === target.type) ?? null;
    default:
      return null;
  }
}

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

/** Wording of commands that describeCommand() cannot derive from the name. */
const COMMAND_WORDS = {
  'element.updateProperties': 'properties panel change',
  'element.updateModdleProperties': 'properties panel change',
  'properties-panel.multi-command-executor': 'properties panel change',
};

/** Human wording of a command for notices ('shape.resize' -> 'resize'). */
function describeCommand(command) {
  if (COMMAND_WORDS[command]) return COMMAND_WORDS[command];
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
        const at = (x, y) => Math.abs(shape.x - x) <= 0.5 && Math.abs(shape.y - y) <= 0.5;
        if (!shape) problems.push({ reason: 'deleted', name: entry.name });
        // Already where this move puts it (the document already contains this edit: accepted before a
        // reconnect, or a change on disk made from a copy that has it): nothing to do.
        else if (at(entry.x + op.delta.x, entry.y + op.delta.y)) continue;
        else if (!at(entry.x, entry.y)) problems.push({ reason: 'changed', name: entry.name });
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
    case 'attrs': {
      const element = get(op.id);
      const target = attrsTargetOf(element, op.target);
      if (!target) return none([{ reason: 'deleted', name: op.name }]);
      const keys = Object.keys(op.props);
      if (keys.every((key) => sameValue(target.get(key), op.props[key]))) return none(); // already there
      if (keys.some((key) => !sameValue(target.get(key), op.old[key]) && !sameValue(target.get(key), op.props[key]))) {
        return none([{ reason: 'changed', name: op.name }]);
      }
      if (op.target.kind === 'element') modeling.updateProperties(element, op.props);
      // A global element (e.g. a signal) is kept even if the event it was edited from is gone.
      else modeling.updateModdleProperties(element ?? canvas.getRootElement(), target, op.props);
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
  console.warn(`bpmn-edit: re-applying an edit (${op.kind}) ${missedSplice ? 'could not drop it onto the same flow'
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
          console.error('bpmn-edit: could not re-apply an edit', op, err);
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
  for (const sentence of unique) console.warn(`bpmn-edit: ${sentence}`);
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
  // The host is told once these are re-applied (with the update below, or 'reapplied'), so it does
  // not keep them aside for a window that is gone (Q2).
  pendingReapplied.push(...lostVersions);
  lostVersions = [];
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
  // A save from an older copy (Q2): its own notice ('kept-aside') says what happened and where the
  // edits are; a "merged" notice here would be misleading.
  if (message.origin === 'disk' && !message.stale) reportDiskMerge(edits, problems);
  else if (message.origin !== 'disk') reportProblems(problems);
  if (dirty) sendNow();
  else {
    sendHeld = false;
    sendReapplied();
  }
}

/** Nothing to send after re-applying discarded edits (all already there, or not applicable): say so. */
function sendReapplied() {
  if (!pendingReapplied.length || inflight || sending) return; // goes with the update in flight's successor
  if (sendMessage({ type: 'reapplied', versions: pendingReapplied })) pendingReapplied = [];
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
    for (const sentence of sentences) console.warn(`bpmn-edit: ${sentence}`);
    showToast('conflict', sentences.length > 1 ? `${sentences[0]} (+${sentences.length - 1} more)` : sentences[0], sentences);
    return;
  }
  // dirty: something was re-applied (an edit the change on disk already contained needs no notice).
  if (edits.length && dirty) showToast('merged', 'The file was changed on disk; your edits were applied on top of that change');
}

/** Says that a save from an older copy replaced the latest saved edits, kept next to the file as `name`. */
function showStaleSaveNotice(name) {
  const text = `The file was saved on disk from an older copy, without the latest changes; they were saved next to it as ${name}`;
  console.warn(`bpmn-edit: ${text}`);
  showToast('conflict', text);
}

/** Fetches the host's current document (used if a newer one is needed but was not received). */
async function fetchLatest() {
  const response = await fetch('api/file', { cache: 'no-store' });
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
  for (const sentence of sentences) console.warn(`bpmn-edit: ${sentence}`);
  for (const { id } of ours) recentChanges.delete(id);
  showToast('conflict', sentences.length > 1 ? `${sentences[0]} (+${sentences.length - 1} more)` : sentences[0], sentences);
}

async function handleMessage(message) {
  switch (message.type) {
    case 'init': {
      const identity = message.path || message.name || null;
      if (fileIdentity !== null && identity !== fileIdentity) {
        // A different bpmn-edit now runs on this address (restarted on another file): never mix
        // this window's document into it.
        endSession('other-file', message.name);
        break;
      }
      fileIdentity = identity;
      if (message.name) {
        fileNameEl.textContent = message.name;
        fileNameEl.title = message.path || message.name;
        document.title = `${message.name} — bpmn-edit`;
      }
      clientId = message.clientId ?? null;
      checkRole(message.role, everSynced);
      synced = true;
      everSynced = true;
      clearReconnect();
      if (!rendered) {
        hostInstance = message.instance ?? null;
        try {
          await importDiagram(message.xml, { baselineFor: message.version });
          version = message.version;
        } catch (err) {
          showError(`Could not render ${message.name || 'the diagram'}: ${err.message}`);
          reportImportFailure({ origin: 'disk', version: message.version }, err); // the host checks the origin
        }
        break;
      }
      await resync(message);
      break;
    }
    case 'ack':
      rememberChanges(inflight?.edits ?? []);
      if (inflight) {
        syncedXml = inflight.xml;
        syncedBaseline = inflight.xml;
      }
      // Kept until the host has written them, in case a change on disk replaces them first (Q2).
      if (inflight?.edits?.length) unsavedEdits.push({ version: message.version, edits: inflight.edits });
      inflight = null;
      advanceVersion(message.version);
      lastError = null;
      sendReapplied();
      settleLocalActivity();
      break;
    case 'conflict': {
      // The host has a newer document (sent to us as 'remote-update' before this): re-apply the
      // refused edits, and whatever was edited since, on top of it.
      localEdits = [...(inflight?.edits ?? []), ...localEdits];
      pendingReapplied = [...(inflight?.reapplied ?? []), ...pendingReapplied];
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
      if (message.code !== 'write-failed') {
        pendingReapplied = [...(inflight?.reapplied ?? []), ...pendingReapplied];
        inflight = null;
      }
      lastError = { code: message.code, message: message.message };
      console.warn(`bpmn-edit: ${message.code}: ${message.message}`);
      settleLocalActivity();
      break;
    case 'flush':
      flushForShutdown();
      break;
    case 'saved':
      unsavedEdits = unsavedEdits.filter((entry) => entry.version > message.version);
      break;
    case 'kept-aside':
      // Another program saved the file from a copy older than the latest saved edits (Q2): the
      // file keeps that save (shown as "Reloaded from disk"); the edits are in a file next to it.
      if (message.reason === 'stale-save' && typeof message.name === 'string') showStaleSaveNotice(message.name);
      break;
    case 'remote-update':
      if (message.origin === 'disk' && Number.isInteger(message.discardedAfter)) {
        // The file changed on disk before our accepted edits were written: they are not in this
        // document. Re-apply them on top of it (Q2), like edits the host refused.
        const lost = unsavedEdits.filter((entry) => entry.version > message.discardedAfter);
        unsavedEdits = [];
        if (lost.length) {
          lostEdits.push(...lost.flatMap((entry) => entry.edits));
          lostVersions.push(...lost.map((entry) => entry.version));
          mustRebase = true;
        }
      }
      await applyRemoteUpdate(message);
      break;
    case 'welcome':
    case 'presence':
    case 'selection':
      presence.handleMessage(message);
      break;
    case 'file-status':
      fileStatus = { state: message.state, message: message.message };
      if (fileStatus.state !== 'ok') {
        clearTimeout(reloadedTimer); // superseded by the persistent notice
        reloadedTimer = null;
      }
      renderNotice();
      break;
    case 'share':
      shareEpoch += 1;
      renderShare(message);
      break;
    default:
      break; // unknown types are ignored so newer hosts can add messages
  }
  renderStatus();
}

// --- Share (host only) -----------------------------------------------------------------------------

let shareEpoch = 0; // number of 'share' messages received (a newer one beats an HTTP answer)
let copiedTimer = null;

/** Calls a host-only endpoint (relative to this page, with the host secret). */
async function shareRequest(method) {
  const response = await fetch('api/share', {
    method,
    cache: 'no-store',
    headers: { 'X-Bpmn-Edit-Host': hostSecret },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // fall through
  }
  if (body && typeof body.state === 'string') return body;
  throw new Error(body?.error || `HTTP ${response.status}`);
}

function showShareError(message) {
  shareErrorTextEl.textContent = message;
  shareErrorEl.hidden = false;
}

function hideShareError() {
  shareErrorEl.hidden = true;
  shareErrorTextEl.textContent = '';
}

/** Shows the sharing status: { state: 'idle' | 'starting' | 'active' | 'error', url?, progress?, error? }. */
function renderShare(status) {
  shareEl.hidden = false;
  shareEl.dataset.state = status.state;
  shareStartEl.hidden = status.state === 'starting' || status.state === 'active';
  shareStartEl.disabled = false;
  shareProgressEl.hidden = status.state !== 'starting';
  shareActiveEl.hidden = status.state !== 'active';
  shareStopEl.disabled = false;
  if (status.state === 'starting') shareProgressTextEl.textContent = status.progress || 'Starting tunnel…';
  if (status.state === 'active' && shareUrlEl.value !== status.url) {
    shareUrlEl.value = status.url;
    shareCopyEl.textContent = 'Copy';
    shareCopyEl.title = `Copy the public link: ${status.url}`; // the link box is hidden in narrow windows
  }
  if (status.state === 'error') showShareError(status.error?.message || 'Sharing failed.');
  else if (status.state !== 'idle') hideShareError();
}

/** Renders an HTTP answer unless a 'share' message newer than the request already did. */
async function shareAction(method, pending) {
  const epoch = shareEpoch;
  if (pending) renderShare(pending);
  try {
    const status = await shareRequest(method);
    if (shareEpoch === epoch) renderShare(status);
  } catch (err) {
    renderShare({ state: 'error', error: { message: `Sharing failed: ${err.message}` } });
  }
}

shareStartEl.addEventListener('click', () => {
  hideShareError();
  shareAction('POST', { state: 'starting', progress: 'Starting tunnel…' });
});

shareStopEl.addEventListener('click', () => {
  shareStopEl.disabled = true;
  shareAction('DELETE', null);
});

shareCopyEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrlEl.value);
  } catch {
    shareUrlEl.select(); // fallback: let the user copy it
    document.execCommand?.('copy');
  }
  shareCopyEl.textContent = 'Copied';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { shareCopyEl.textContent = 'Copy'; }, 2000);
});

shareUrlEl.addEventListener('focus', () => shareUrlEl.select());
document.getElementById('share-error-close').addEventListener('click', hideShareError);

// --- Connection: reconnect, re-sync, session ended ----------------------------------------------

/**
 * After 'init': if this tab presented a host secret but the host did not accept it, the secret is
 * from an earlier run of the CLI (restarted). The tab stays a plain local editor: no Share controls.
 */
function checkRole(role, reconnected) {
  if (isCollaborator || !hostSecret || role === undefined || role === 'host') return;
  dropHostSecret();
  shareEl.hidden = true;
  hideShareError();
  if (reconnected) {
    showToast('info', 'bpmn-edit was restarted. This tab can still edit; to share, open the link printed in the terminal.');
  }
}

/**
 * New connection after a drop: bring this window in line with the host's document (`message` is the
 * new 'init') without losing edits the host has not accepted:
 * - the host has exactly the document these edits are based on (nobody edited meanwhile), or the
 *   update in flight was accepted: keep the document showing and send what is left;
 * - otherwise show the host's document and re-apply the edits op by op (rebaseLocalEdits), as after
 *   a 'conflict'; ops already in the document are no-ops, edits that cannot be re-applied are
 *   reported, deleted elements stay deleted.
 * Version numbers start again after a restart of the host, so the old version is forgotten.
 * Accepted edits not confirmed on disk (unsavedEdits) are first sorted out (reconcileAccepted): those
 * a change on disk discarded while this window was away join the edits to re-apply (Q2).
 */
async function resync(message) {
  flushRequested = false;
  lastError = null;
  deferredUpdate = null;
  const sameHost = hostInstance !== null && message.instance === hostInstance;
  hostInstance = message.instance ?? null;
  const base = version;
  const sent = inflight;
  // The host remembers the newest update it accepted from this page (by its number): an update in
  // flight whose 'ack' was lost is then known to be accepted, at that version, and is handled like
  // the other accepted edits below (never re-applied unless a change on disk discarded it).
  const accepted = sameHost && sent && message.accepted?.seq === sent.seq ? message.accepted : null;
  if (accepted) {
    rememberChanges(sent.edits);
    if (sent.edits.length) unsavedEdits.push({ version: accepted.version, edits: sent.edits });
    syncedXml = sent.xml;
    syncedBaseline = sent.xml;
    inflight = null;
  }
  const lostOnDisk = reconcileAccepted(message, sameHost);
  if (inflight) {
    localEdits = [...inflight.edits, ...localEdits];
    pendingReapplied = [...inflight.reapplied, ...pendingReapplied];
    inflight = null;
  }
  // What replaced this window's document while it was away, for the wording of notices: only
  // changes on disk (Q2), or (also) other windows' edits.
  const own = accepted ? accepted.version : base;
  const onlyDisk = sameHost && base !== null && Number.isInteger(message.lastDisk) && message.lastDisk > base
    && !(Number.isInteger(message.lastEdit) && message.lastEdit > own);
  version = null;
  if (!mustRebase && message.xml === syncedXml) {
    version = message.version; // nothing changed at the host: our edits (if any) apply as they are
    // The host may be a new one that has not seen the base of what is on disk (Q4).
    if (syncedBaseline !== null) sendMessage({ type: 'baseline', version, xml: syncedBaseline });
  } else if (!mustRebase && !accepted && sent && message.xml === sent.xml) {
    // The update in flight had been accepted (its 'ack' was lost with the connection).
    localEdits = localEdits.slice(sent.edits.length);
    rememberChanges(sent.edits);
    if (sameHost && sent.edits.length) unsavedEdits.push({ version: message.version, edits: sent.edits });
    syncedXml = sent.xml;
    syncedBaseline = sent.xml;
    version = message.version;
  } else if (!localEdits.length && !dirty && !mustRebase && !interactionActive()) {
    await showRemoteDocument(message);
  } else {
    if (localEdits.length || lostEdits.length) mustRebase = true;
    // 'disk': accepted edits of ours were replaced by a change on disk (merged / disk wording, Q2).
    deferredUpdate = {
      type: 'remote-update', xml: message.xml, version: message.version, origin: lostOnDisk || onlyDisk ? 'disk' : 'host',
    };
  }
  if (version !== null && (dirty || localEdits.length)) {
    dirty = true;
    sendHeld = true;
  }
  unsent = false;
  await settleNow();
  sendReapplied();
  // A save from an older copy replaced written edits while this window was away: say so now.
  const missed = sameHost && base !== null && Array.isArray(message.staleSaves)
    ? message.staleSaves.filter((entry) => Number.isInteger(entry?.version) && entry.version > base && typeof entry.name === 'string')
    : [];
  if (missed.length) showStaleSaveNotice(missed.at(-1).name);
}

/**
 * On a new connection: what became of the accepted edits waiting for 'saved' (unsavedEdits), from
 * the host's 'init' (`instance`, `saved`, `discards`, see src/server.js). Same host session: edits a
 * change on disk discarded (version inside a discards range) move to lostEdits to be re-applied;
 * edits up to `saved` are on disk and forgotten; the rest are still waiting for the host's write
 * (they are in its document) and keep waiting for 'saved'. Another host session (bpmn-edit was
 * restarted): versions mean nothing any more and that host wrote or kept aside what it had accepted
 * when it stopped, so they are forgotten. Returns whether edits were moved to lostEdits.
 */
function reconcileAccepted(message, sameHost) {
  if (!sameHost) {
    unsavedEdits = [];
    lostVersions = []; // that host is gone; its versions mean nothing here (the edits stay in lostEdits)
    pendingReapplied = [];
    return false;
  }
  const discards = Array.isArray(message.discards) ? message.discards : [];
  const saved = Number.isInteger(message.saved) ? message.saved : -Infinity;
  const lost = [];
  const waiting = [];
  for (const entry of unsavedEdits) {
    if (discards.some(({ after, version: at }) => after < entry.version && entry.version < at)) lost.push(entry);
    else if (entry.version > saved) waiting.push(entry);
  }
  unsavedEdits = waiting;
  if (!lost.length) return false;
  lostEdits.push(...lost.flatMap((entry) => entry.edits));
  lostVersions.push(...lost.map((entry) => entry.version));
  mustRebase = true;
  return true;
}

/** Starts or continues reconnecting after the connection was lost; `failed`: an attempt failed. */
async function reconnectLater(failed) {
  if (ended) return;
  const state = reconnect ?? (reconnect = { attempts: 0, since: Date.now(), tunnelGoneSince: null, timer: null });
  renderStatus();
  if (failed) {
    state.attempts += 1;
    const verdict = probeVerdict(await probeStatus());
    if (ended || reconnect !== state) return;
    if (verdict === 'gone') return endSession('link-gone');
    if (verdict === 'tunnel-gone') state.tunnelGoneSince ??= Date.now();
    else state.tunnelGoneSince = null;
    if (shouldGiveUp(state, Date.now(), reconnectPolicy)) return endSession('unreachable');
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!ended && reconnect === state) connect();
  }, reconnectDelay(state.attempts + 1, reconnectPolicy));
}

function clearReconnect() {
  if (reconnect) clearTimeout(reconnect.timer);
  reconnect = null;
}

/** HTTP status of this page's `api/file` (null if unreachable): tells a dead link from a network problem. */
async function probeStatus() {
  try {
    const response = await fetch('api/file', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return null;
  }
}

const ENDED_TEXT = {
  'share-stopped': { title: 'Sharing stopped', text: 'The host stopped sharing. This link no longer works.' },
  ended: {
    title: 'Session ended',
    text: 'The host closed this session.',
    local: 'bpmn-edit was stopped. Run it again and open the link it prints, or reconnect once it runs again.',
  },
  'link-gone': { title: 'Session ended', text: 'This link no longer works. Ask the host for a new link.' },
  unreachable: { title: 'Session ended', text: 'Lost the connection to the host and could not reconnect.' },
  'other-file': { title: 'Session ended', text: 'bpmn-edit now edits another file here.' },
};

/**
 * The session is over for this window: stop reconnecting, close the connection and say so in an
 * overlay (the diagram stays visible behind it). Local windows (not collaborators) can try to
 * reconnect from there, e.g. after the host restarted bpmn-edit.
 */
function endSession(reason, detail) {
  if (ended) return;
  ended = reason;
  clearReconnect();
  stopHeartbeat();
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  connected = false;
  synced = false;
  presence.onClose();
  const copy = ENDED_TEXT[reason] ?? ENDED_TEXT.unreachable;
  overlayEl.dataset.reason = reason;
  overlayTitleEl.textContent = copy.title;
  let text = (!isCollaborator && copy.local) || copy.text;
  if (reason === 'other-file' && detail) text = `bpmn-edit now edits ${detail} here.`;
  // The host writes (or keeps aside) what it accepted when it ends the session or stops sharing;
  // otherwise accepted edits not confirmed on disk may be lost too.
  if (hasUnsavedWork() || unsent) text += ' Your latest changes could not be saved.';
  else if (unsavedEdits.length && reason !== 'ended' && reason !== 'share-stopped') {
    text += ' Your latest changes may not have been saved.';
  }
  overlayTextEl.textContent = text;
  const canRetry = reason === 'unreachable' || (reason === 'ended' && !isCollaborator);
  overlayActionEl.hidden = !canRetry;
  overlayActionEl.textContent = reason === 'ended' ? 'Reconnect' : 'Try again';
  overlayEl.hidden = false;
  hideError();
  renderStatus();
  if (canRetry) overlayActionEl.focus();
}

overlayActionEl.addEventListener('click', () => {
  overlayEl.hidden = true;
  delete overlayEl.dataset.reason;
  ended = null;
  reconnect = { attempts: 0, since: Date.now(), tunnelGoneSince: null, timer: null };
  renderStatus();
  connect();
});

function startHeartbeat() {
  stopHeartbeat();
  lastPingAt = null;
  heartbeatTimer = setInterval(() => {
    if (!isOpen()) return;
    if (lastPingAt !== null && lastReceivedAt < lastPingAt) {
      // Nothing (not even the 'pong') since the last ping: the connection is dead without a close.
      console.warn('bpmn-edit: no answer from the host; reconnecting');
      const old = socket;
      socket = null;
      old.close();
      connectionLost(false);
      return;
    }
    lastPingAt = Date.now();
    sendMessage({ type: 'ping' });
  }, heartbeatMs);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** The current connection is gone; `code` is its close code (or null). */
function connectionLost(failedAttempt, code = null) {
  const wasSynced = synced;
  connected = false;
  synced = false;
  stopHeartbeat();
  presence.onClose();
  if (code === CLOSE_SHARE_STOPPED) return endSession('share-stopped');
  if (code === CLOSE_SESSION_ENDED) return endSession('ended');
  reconnectLater(failedAttempt || !wasSynced);
  return undefined;
}

/** WebSocket URL next to this page (`/ws` or `/s/<token>/ws`), with the host secret if any. */
function socketUrl() {
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  if (hostSecret) url.searchParams.set('host', hostSecret);
  url.searchParams.set('page', pageKey); // see 'init' accepted
  url.hash = '';
  return url.href;
}

function connect() {
  const ws = new WebSocket(socketUrl());
  socket = ws;
  let opened = false;
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    opened = true;
    connected = true;
    lastReceivedAt = Date.now();
    startHeartbeat();
    renderStatus();
    presence.onOpen();
  });
  ws.addEventListener('message', (event) => {
    if (socket !== ws) return; // a connection given up on
    lastReceivedAt = Date.now();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'pong') return;
    enqueue(() => handleMessage(message)); // in order: init imports asynchronously
  });
  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    connectionLost(!opened, event.code);
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

// After an import, select again what was selected before (by id, if still there), in the same
// 'import.done' as the properties panel's switch to the root element (priority 1000), so the panel
// keeps showing the element the user was looking at.
modeler.on('import.done', 500, ({ error }) => {
  if (error || !carriedView) return;
  const stillThere = carriedView.selectedIds.map((id) => elementRegistry.get(id)).filter(Boolean);
  if (stillThere.length) selection.select(stillThere);
});

// Closing the label editor, ending a drag (committed or cancelled) or closing a popup menu may
// release a held-back remote update.
modeler.on('directEditing.deactivate', () => settleLocalActivity());
modeler.on('drag.cleanup', () => settleLocalActivity());
modeler.on('popupMenu.close', () => settleLocalActivity());

// Leaving or hiding the page: send a pending edit now rather than after the debounce. Firefox closes
// the page's WebSocket right after 'beforeunload' (before 'pagehide'), so leaving sends from both.
function sendBeforeLeaving() {
  if (directEditing.isActive()) directEditing.complete();
  if (sendTimer) sendNow();
}
window.addEventListener('beforeunload', sendBeforeLeaving);
window.addEventListener('pagehide', sendBeforeLeaving);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && sendTimer) sendNow();
});

renderStatus();
connect();
