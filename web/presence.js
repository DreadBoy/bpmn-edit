// Connected-users list: who else has this diagram open (see src/presence.js for the messages).
// This window's name and colour are stored in localStorage, so a reload (or the next session in this
// browser) keeps them; the name can be changed by clicking it in the list.
//
// Remote selection: this window sends the ids it has selected; what the others have selected is
// outlined in their colour with canvas markers (`remote-sel-<colour slot>`). Markers are kept as a
// wanted state and reconciled with the canvas whenever it may differ: on presence messages, after
// every import (importXML recreates every element without markers) and after every edit (an element
// can be deleted, or re-created by undo). Ids that do not exist (yet) are skipped, and marked as soon
// as they appear.
import {
  MAX_ID_LENGTH, MAX_NAME_LENGTH, MAX_SELECTION, PALETTE, cleanName, isColor,
} from './presence-shared.js';

const STORAGE_KEY = 'local-bpmn.user';

/** A selection is sent this long after it last changed (an import clears and restores it at once). */
const SELECTION_DELAY_MS = 50;

const markerClass = (color) => `remote-sel-${color}`;

/** CSS for the remote selection markers, one rule set per palette colour. */
function markerStyles() {
  return PALETTE.map((color, slot) => [
    `.djs-shape.${markerClass(slot)} .djs-outline { visibility: visible; stroke: ${color}; stroke-width: 2px; }`,
    `.djs-connection.${markerClass(slot)} .djs-visual > path { stroke: ${color} !important; }`,
  ].join('\n')).join('\n');
}

/** The name and colour this browser used last time ({} if none, or storage is unavailable). */
function loadStored() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      name: cleanName(stored?.name) || undefined,
      color: isColor(stored?.color) ? stored.color : undefined,
    };
  } catch {
    return {};
  }
}

function store({ name, color }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, color }));
  } catch {
    // Private mode or storage disabled: the name lasts for this page only.
  }
}

/**
 * @param {object} options
 * @param {object} options.modeler  the bpmn-js modeler
 * @param {(message: object) => boolean} options.send  sends a message to the host (false if not connected)
 * @param {HTMLElement} options.toolbar  the list is added at its end
 */
export function createPresence({ modeler, send, toolbar }) {
  const canvas = modeler.get('canvas');
  const elementRegistry = modeler.get('elementRegistry');
  const selection = modeler.get('selection');
  const outline = modeler.get('outline', false);

  let me = null;      // this window's entry { id, name, color } once the host has welcomed it
  let users = [];     // everyone joined, this window included, in join order
  let editor = null;  // the rename <input> while it is open
  const selections = new Map(); // user id -> ids that user has selected (others only)
  const applied = new Map();    // markers on the canvas: "id class" -> { id, cls }
  let sentSelection = null;     // ids last sent (joined), null = nothing sent on this connection
  let selectionTimer = null;

  const listEl = document.createElement('ul');
  listEl.id = 'users';
  listEl.setAttribute('aria-label', 'Connected users');
  toolbar.append(listEl);

  const styleEl = document.createElement('style');
  styleEl.id = 'remote-selection-styles';
  styleEl.textContent = markerStyles();
  document.head.append(styleEl);

  /** Brings the canvas markers in line with what the other users have selected. */
  function reconcileMarkers() {
    const wanted = new Map();
    for (const user of users) {
      if (me && user.id === me.id) continue; // never mark this window's own selection
      for (const id of selections.get(user.id) ?? []) {
        const cls = markerClass(user.color);
        wanted.set(`${id} ${cls}`, { id, cls });
      }
    }
    for (const [key, { id, cls }] of applied) {
      if (wanted.has(key)) continue;
      const element = elementRegistry.get(id);
      if (element) canvas.removeMarker(element, cls);
      applied.delete(key);
    }
    for (const [key, marker] of wanted) {
      const element = elementRegistry.get(marker.id);
      if (!element) {
        applied.delete(key); // not there (yet): marked once it appears
        continue;
      }
      if (!canvas.hasMarker(element, marker.cls)) {
        // bpmn-js only draws a shape's outline once it is hovered or selected here.
        if (!element.waypoints) outline?.createOutline?.(element);
        canvas.addMarker(element, marker.cls);
      }
      applied.set(key, marker);
    }
  }

  /** Sends this window's selection if it changed since it was last sent. */
  function sendSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = null;
    if (!me) return;
    const ids = selection.get().map((element) => element.id)
      .filter((id) => id.length <= MAX_ID_LENGTH).slice(0, MAX_SELECTION);
    const key = ids.join('\n');
    if (key === sentSelection) return;
    if (send({ type: 'selection', ids })) sentSelection = key;
  }

  modeler.on('selection.changed', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(sendSelection, SELECTION_DELAY_MS);
  });
  modeler.on('import.done', reconcileMarkers);
  modeler.on('elements.changed', reconcileMarkers);

  /** Takes the selections from a 'presence' list (the host's latest state of everyone). */
  function takeSelections() {
    selections.clear();
    for (const user of users) {
      if (Array.isArray(user.selection)) selections.set(user.id, user.selection.filter((id) => typeof id === 'string'));
    }
  }

  function render() {
    const ordered = me ? [users.find((u) => u.id === me.id) ?? me, ...users.filter((u) => u.id !== me.id)] : users;
    const items = ordered.map((user) => {
      const self = me !== null && user.id === me.id;
      const item = document.createElement('li');
      item.className = 'user';
      item.dataset.userId = user.id;
      item.dataset.color = String(user.color);
      if (self) item.dataset.self = '';
      const dot = document.createElement('span');
      dot.className = 'user-dot';
      dot.style.backgroundColor = PALETTE[user.color];
      item.append(dot);
      if (self && editor) {
        if (!editor.isConnected) item.append(editor); // else kept where it is (see below)
      } else if (self) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'user-name';
        button.textContent = user.name;
        button.title = 'Click to change your name';
        button.addEventListener('click', startRename);
        item.append(button);
      } else {
        const name = document.createElement('span');
        name.className = 'user-name';
        name.textContent = user.name;
        name.title = user.name;
        item.append(name);
      }
      if (self) {
        const you = document.createElement('span');
        you.className = 'user-you';
        you.textContent = '(you)';
        item.append(you);
      }
      return item;
    });
    const editing = editor?.parentElement;
    if (editing && editing.parentElement === listEl) {
      // Keep the entry being renamed in place: taking the focused input out of the page would end the edit.
      for (const child of [...listEl.children]) if (child !== editing) child.remove();
      listEl.append(...items.slice(1));
    } else {
      listEl.replaceChildren(...items);
    }
    listEl.title = users.length === 1 ? '1 user connected' : `${users.length} users connected`;
  }

  function startRename() {
    if (!me || editor) return;
    editor = document.createElement('input');
    editor.type = 'text';
    editor.className = 'user-name-input';
    editor.maxLength = MAX_NAME_LENGTH;
    editor.value = me.name;
    editor.setAttribute('aria-label', 'Your name');
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finishRename(true);
      else if (event.key === 'Escape') finishRename(false);
    });
    editor.addEventListener('blur', () => finishRename(true));
    render();
    editor.focus();
    editor.select();
  }

  function finishRename(commit) {
    if (!editor) return;
    const name = cleanName(editor.value);
    editor = null;
    if (commit && name && name !== me.name) {
      me = { ...me, name };
      users = users.map((u) => (u.id === me.id ? { ...u, name } : u));
      store(me);
      send({ type: 'rename', name });
    }
    render();
  }

  return {
    /** The connection to the host is open: join the session. */
    onOpen() {
      const stored = loadStored();
      send({ type: 'hello', name: me?.name ?? stored.name, color: me?.color ?? stored.color });
      sentSelection = null; // the host knows nothing of this connection's selection yet
    },

    /** The connection is gone: nobody else is known to be here any more. */
    onClose() {
      users = me ? [me] : [];
      selections.clear();
      reconcileMarkers();
      render();
    },

    /** Handles 'welcome', 'presence' and 'selection' from the host; returns whether `message` was one of them. */
    handleMessage(message) {
      switch (message.type) {
        case 'welcome':
          me = { id: message.user.id, name: message.user.name, color: message.user.color };
          store(me);
          if (!users.some((u) => u.id === me.id)) users = [...users, me];
          render();
          sendSelection(); // e.g. selected before the connection was (re)established
          return true;
        case 'presence':
          users = message.users.filter((u) => isColor(u.color) && typeof u.name === 'string');
          if (me) me = users.find((u) => u.id === me.id) ?? me;
          takeSelections();
          reconcileMarkers();
          render();
          return true;
        case 'selection':
          if (typeof message.userId !== 'string' || !Array.isArray(message.ids)) return true;
          selections.set(message.userId, message.ids.filter((id) => typeof id === 'string'));
          reconcileMarkers();
          return true;
        default:
          return false;
      }
    },
  };
}
