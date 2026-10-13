// Connected-users list: who else has this diagram open (see src/presence.js for the messages).
// This window's name and colour are stored in localStorage, so a reload (or the next session in this
// browser) keeps them; the name can be changed by clicking it in the list.
//
// The list takes the free space of the toolbar between the file name and the save status. When the
// names do not fit there, it degrades step by step (see fit()): first the others are shown as colour
// dots only (name in the tooltip), then this window's own name is hidden ("(you)" stays), and then
// the last ones are folded into a "+N" entry (names in its tooltip). It never squeezes names.
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
 * @param {HTMLElement} options.toolbar  the list is added to it, before the save status
 * @param {string} [options.key]  random id of this page, sent in 'hello' so that after a reconnect
 *   the host replaces this page's old entry instead of listing it twice (see src/presence.js)
 */
export function createPresence({ modeler, send, toolbar, key }) {
  const canvas = modeler.get('canvas');
  const elementRegistry = modeler.get('elementRegistry');
  const selection = modeler.get('selection');
  const outline = modeler.get('outline', false);

  let me = null;      // this window's entry { id, name, color } once the host has welcomed it
  let users = [];     // everyone joined, this window included, in join order
  let editor = null;  // the rename <input> while it is open
  let renameByKeyboard = false; // the open name field was opened with the keyboard
  let justRenamed = false; // a rename ended and the pointer has not moved off the own name since
  document.addEventListener('pointermove', (event) => {
    if (!justRenamed || event.target?.closest?.('#users button.user-self')) return;
    justRenamed = false;
    listEl.querySelector('.just-renamed')?.classList.remove('just-renamed');
  });
  const selections = new Map(); // user id -> ids that user has selected (others only)
  const applied = new Map();    // markers on the canvas: "id class" -> { id, cls }
  let sentSelection = null;     // ids last sent (joined), null = nothing sent on this connection
  let selectionTimer = null;

  const listEl = document.createElement('ul');
  listEl.id = 'users';
  listEl.setAttribute('aria-label', 'Connected users');
  // Before the status and the Share controls, so the tab order follows what is on screen.
  toolbar.insertBefore(listEl, toolbar.querySelector('#notice, #save-status'));

  // Re-fit whenever the space for the list changes (window resized, Share controls shown, …).
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(listEl);

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
      const name = document.createElement('span');
      name.className = 'user-name';
      name.textContent = user.name;
      const you = document.createElement('span');
      you.className = 'user-you';
      you.textContent = '(you)';
      if (self && editor) {
        item.append(dot);
        if (!editor.isConnected) item.append(editor); // else kept where it is (see below)
        item.append(you);
      } else if (self) {
        // One button for the whole own entry, so it stays reachable (Tab, Enter / Space) however far
        // the list is collapsed: the CSS hides the name, then "(you)", but never the dot.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'user-self';
        button.setAttribute('aria-label', `Your name: ${user.name}, change`);
        button.append(dot, name, you);
        // detail 0: activated with the keyboard (Enter / Space), not clicked.
        button.addEventListener('click', (event) => startRename(event.detail === 0));
        // Right after a rename the pointer is usually still on it: no hover frame until it moves off.
        if (justRenamed) button.classList.add('just-renamed');
        item.append(button);
      } else {
        item.append(dot, name);
      }
      item.title = self ? `${user.name} (you)` : user.name; // also when only the dot is shown
      return item;
    });
    // A re-render (someone joined, renamed, …) must not take the keyboard focus away from the list.
    const refocus = focusedEntry();
    const editing = editor?.parentElement;
    if (editing && editing.parentElement === listEl) {
      // Keep the entry being renamed in place: taking the focused input out of the page would end the edit.
      for (const child of [...listEl.children]) if (child !== editing) child.remove();
      listEl.append(...items.slice(1));
    } else {
      listEl.replaceChildren(...items);
    }
    listEl.title = users.length === 1 ? '1 user connected' : `${users.length} users connected`;
    fit(refocus);
  }

  /** Which entry of the list has the focus: a selector to find it again after a re-render, or null. */
  function focusedEntry() {
    const focused = listEl.contains(document.activeElement) ? document.activeElement : null;
    if (focused?.classList.contains('user-self')) return 'button.user-self';
    if (focused?.classList.contains('user-more')) return '.user-more';
    return null;
  }

  /** Gives the focus back to that entry, or to the own entry if it is gone (e.g. no "+N" any more). */
  function restoreFocus(selector) {
    if (!selector || listEl.contains(document.activeElement)) return;
    (listEl.querySelector(selector) ?? listEl.querySelector('button.user-self'))?.focus();
  }

  /** Width the visible entries take (they never shrink), and the width the list has for them. */
  function overflows() {
    const shown = [...listEl.children].filter((child) => !child.hidden);
    if (!shown.length) return false;
    const style = getComputedStyle(listEl);
    const room = listEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const needed = shown.at(-1).getBoundingClientRect().right - shown[0].getBoundingClientRect().left;
    return needed > room + 0.5;
  }

  /**
   * Makes the entries fit the list's width: all names; else the others as dots; else (not while
   * renaming) this window's own name hidden as well, "(you)" kept; else the last others folded into "+N".
   */
  function fit(refocus = focusedEntry()) {
    try {
      layOut();
    } finally {
      restoreFocus(refocus); // "+N" is re-created here (on every resize, too)
    }
  }

  function layOut() {
    listEl.querySelector(':scope > .user-more')?.remove();
    const items = [...listEl.querySelectorAll(':scope > li.user')];
    for (const item of items) item.hidden = false;
    delete listEl.dataset.compact;
    delete listEl.dataset.squeeze;
    if (!items.length || listEl.clientWidth === 0 || !overflows()) return;

    listEl.dataset.compact = 'others';
    if (!overflows()) return;

    const others = items.filter((item) => !('self' in item.dataset));
    const more = document.createElement('li');
    more.className = 'user-more';
    more.tabIndex = 0; // its tooltip (aria-label) names the folded users; reachable with Tab
    /** Folds the last others into "+N" until the rest fits (at least one, as it overflows). */
    const fold = () => {
      const folded = [];
      for (let i = others.length - 1; i >= 0 && (folded.length === 0 || overflows()); i -= 1) {
        others[i].hidden = true;
        folded.unshift(others[i].title);
        more.textContent = `+${folded.length}`;
        more.title = folded.join('\n');
        more.setAttribute('aria-label', `${folded.length} more: ${folded.join(', ')}`);
        if (!more.isConnected) listEl.append(more);
      }
    };
    // Then this window's own name (but not while it is being renamed); "(you)" stays by its dot.
    if (!editor) listEl.dataset.compact = 'all';
    if (overflows()) fold();
    // Last resort (a very narrow window): "(you)" goes too; while renaming, everyone else is hidden
    // (no "+N") and the name field shrinks (to 120px at least).
    if (overflows()) {
      if (editor) {
        more.remove();
        listEl.dataset.squeeze = '';
      } else {
        listEl.dataset.compact = 'dots';
      }
    }
  }

  /** Opens the name field; `byKeyboard`: opened with Enter / Space, so focus comes back afterwards. */
  function startRename(byKeyboard = false) {
    if (!me || editor) return;
    renameByKeyboard = byKeyboard;
    editor = document.createElement('input');
    editor.type = 'text';
    editor.className = 'user-name-input';
    editor.maxLength = MAX_NAME_LENGTH;
    editor.value = me.name;
    editor.setAttribute('aria-label', 'Your name');
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      // preventDefault: otherwise the key would also activate the own button that gets the focus back.
      if (event.key === 'Enter') { event.preventDefault(); finishRename(true, renameByKeyboard); }
      else if (event.key === 'Escape') { event.preventDefault(); finishRename(false, renameByKeyboard); }
    });
    editor.addEventListener('blur', (event) => {
      // Focus moved on (Tab, a click elsewhere). If it went to an entry of this list, which is about
      // to be re-created, it goes to the own entry instead of being lost.
      const intoList = event.relatedTarget instanceof Node && listEl.contains(event.relatedTarget);
      finishRename(true, intoList);
    });
    toolbar.dataset.renaming = ''; // the toolbar makes room for the name field (presence.css)
    render();
    editor.focus();
    editor.select();
  }

  /** Closes the name field (saving it if `commit`); `refocus`: focus the own entry afterwards. */
  function finishRename(commit, refocus = false) {
    if (!editor) return;
    const name = cleanName(editor.value);
    editor = null;
    delete toolbar.dataset.renaming;
    justRenamed = true;
    if (commit && name && name !== me.name) {
      me = { ...me, name };
      users = users.map((u) => (u.id === me.id ? { ...u, name } : u));
      store(me);
      send({ type: 'rename', name });
    }
    render();
    if (refocus) listEl.querySelector('button.user-self')?.focus();
  }

  return {
    /** The connection to the host is open: join the session. */
    onOpen() {
      const stored = loadStored();
      send({ type: 'hello', name: me?.name ?? stored.name, color: me?.color ?? stored.color, ...(key ? { key } : {}) });
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
