// Properties panel (V2-5): the official bpmn-js-properties-panel with the plain BPMN provider (no
// Camunda/Zeebe extensions), vendored as a browser bundle (window.BpmnJSPropertiesPanel, built by
// scripts/vendor.js). It shows and edits names, IDs, documentation and event definitions (signal,
// message, error, escalation, timer, …) of the selected element; every edit is a command on the
// bpmn-js command stack, so it is sent, saved and undone like any other edit.
//
// The panel sits right of the canvas and is toggled from the toolbar; whether it is open is
// remembered in localStorage (per browser, for every file). Without a remembered choice it starts
// closed: the editor looks and behaves as before (the whole window is canvas, e.g. a click at the
// right edge is a click on the canvas), and the **Properties** button in the toolbar shows it. Open
// by default on wide windows was tried and changes the canvas everyone is used to (and that
// collaborators who never asked for a panel get) for a feature not everyone needs.
//
// Someone else's document arriving while the user types in a panel field: importing it re-creates
// every element, and the panel re-mounts its fields for the new objects (the old input elements are
// removed). So that typed text is neither lost nor written to the old, detached objects or to
// another element, and the user stays in the field, an import is wrapped in takeFieldState() /
// restoreFieldState() (see web/app.js, importDiagram):
//   - take, before the import: which element the panel shows, the focused field and every field
//     with a commit still pending (the input elements themselves) are noted; pending commits are
//     cancelled. From then on, until restore, the panel no longer hears those inputs (input, change,
//     blur: they would commit to the old objects), but the browser keeps updating their text, so
//     keys typed while the import runs still land in the old field; keys typed after it was removed
//     (focus on the page body) are kept aside.
//   - restore, after the import: if the panel shows the same element again (by id), each noted
//     field's text (plus the keys kept aside) goes into the new field of the same id, with an
//     'input' event, so the panel commits it to the new document as usual; focus and caret return.
//     If the panel shows another element (it was deleted), the text is dropped and the caller is told
//     ('deleted'). If the import changed that field's value while the user had uncommitted text in it,
//     the import's value is kept and the caller is told ('changed'), as for any other concurrent edit
//     of the same value.
// Incoming updates are never held back for a focused field.
//
// Select all on focus (V2-5a): a new signal, message, error or escalation gets a generated id as its
// name (e.g. "Signal_3imqgu0"), so the Name field of these reference elements selects its whole text
// when the user focuses it (click, Tab, a label click, or the panel focusing it after "Create new ..."):
// typing replaces the id instead of appending to it. Browsers collapse a selection made on focus at
// the end of the focusing click, so a field focused by a press of the mouse, or focused by the panel
// itself, selects all again on the first mouseup in it (unless the user dragged out a selection); any
// later click places the caret as usual, and so does the first click after Tab or after typing.
// The focus restoreFieldState() gives back after an import is not the user's: it selects nothing, and
// the caret stays where the user left it (selecting all there would make the next key wipe the text);
// nor does the focus the browser gives back when the user returns to the window or tab, also when an
// import replaced the field meanwhile. A given-back focus keeps a pending "first click selects all"
// (e.g. the panel's focus after "Create new ..." with the id still untouched).

/** Entry ids (`data-entry-id`) of the Name fields of signals, messages, errors and escalations. */
const REFERENCE_NAME_ENTRIES = new Set(['signalName', 'messageName', 'errorName', 'escalationName']);

/**
 * After a select-all focus, the panel may still replace the field's text (see watchFresh): checked
 * this often, this many times (about 300 ms).
 */
const FRESH_CHECK_MS = 20;
const FRESH_CHECKS = 15;

/** Key in localStorage: 'open' or 'closed'. */
const STORAGE_KEY = 'bpmn-edit.properties-panel';

/**
 * Text typed in a panel field is committed (one command, one undo step) this long after the last
 * keystroke, or right away on blur.
 */
const INPUT_DEBOUNCE_MS = 500;

/** A take that is never restored (an import that failed for good) stops holding keys after this. */
const CARRY_MAX_MS = 5000;

function loadOpen() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    // storage blocked: fall back to the default
  }
  return false;
}

function storeOpen(open) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

/**
 * Debounced input commits that have not run yet: debounced function -> { field, key }, the input
 * element it came from and that field's key (see createPropertiesPanel; null if not a panel field).
 */
const pending = new Map();

/** Called with ({ field, key }, value) when a debounced commit runs (see createPropertiesPanel). */
let onCommit = () => {};

/** The key of a panel field, or null (see createPropertiesPanel). */
let fieldKey = () => null;

/**
 * Target of the 'input' event being handled: the panel commits from its input handler, and this is
 * the field typed in (also the one restoreFieldState() fills, while the focus is still elsewhere).
 */
let inputTarget = null;
window.addEventListener('input', (event) => {
  inputTarget = event.target;
  setTimeout(() => { if (inputTarget === event.target) inputTarget = null; }, 0);
}, true);

/**
 * Replacement for the panel's 'debounceInput' service: the same trailing debounce (with flush and
 * cancel, as the panel expects), but this module knows which commits are still pending.
 */
function trackedDebounce(fn) {
  let timer = null;
  let args = null;
  let self = null;
  let source = null;
  function run() {
    clearTimeout(timer);
    timer = null;
    pending.delete(debounced);
    onCommit(source, args[0]);
    fn.apply(self, args);
  }
  function debounced(...callArgs) {
    args = callArgs;
    self = this;
    clearTimeout(timer);
    timer = setTimeout(run, INPUT_DEBOUNCE_MS);
    const target = inputTarget ?? document.activeElement;
    const field = target instanceof HTMLElement ? target : null;
    source = { field, key: fieldKey(field) }; // the key now: by commit time the panel may show another element
    pending.set(debounced, source);
  }
  debounced.flush = () => {
    if (timer) run();
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pending.delete(debounced);
  };
  return debounced;
}

const TrackedDebounceModule = {
  debounceInput: ['value', trackedDebounce],
};

/**
 * Options for `new BpmnJS(...)`: the panel modules and where the panel goes. Empty if the bundle did
 * not load (the editor then works without a panel).
 */
export function propertiesPanelOptions(parent) {
  const bundle = window.BpmnJSPropertiesPanel;
  if (!bundle?.BpmnPropertiesPanelModule || !bundle?.BpmnPropertiesProviderModule) return {};
  return {
    // TrackedDebounceModule last: it replaces the panel's own 'debounceInput'.
    additionalModules: [bundle.BpmnPropertiesPanelModule, bundle.BpmnPropertiesProviderModule, TrackedDebounceModule],
    propertiesPanel: { parent },
  };
}

const isTextField = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/** `value` with `keys` (kept aside while the field was gone) typed at the caret. */
function typeKeys(value, caret, keys) {
  let [start, end] = caret ?? [value.length, value.length];
  let text = value;
  for (const key of keys) {
    if (key === 'Backspace') {
      if (start === end && start > 0) start -= 1;
      text = text.slice(0, start) + text.slice(end);
    } else if (key === 'Delete') {
      if (start === end && end < text.length) end += 1;
      text = text.slice(0, start) + text.slice(end);
    } else {
      text = text.slice(0, start) + key + text.slice(end);
      start += key.length;
    }
    end = start;
  }
  return { text, caret: [start, end] };
}

/**
 * Wires the toggle button and the panel container.
 *
 * @param {object} options
 * @param {object} options.modeler  the bpmn-js modeler (created with propertiesPanelOptions())
 * @param {HTMLElement} options.container  the panel's parent element
 * @param {HTMLButtonElement} options.toggle  the toolbar button that opens and closes it
 */
export function createPropertiesPanel({ modeler, container, toggle }) {
  const canvas = modeler.get('canvas');
  const available = Boolean(modeler.get('propertiesPanel', false));
  let shownId = null; // id of the element the panel shows (null: several, or none)
  // Committed value of each field the user is typing in, per element: "elementId|fieldId" -> text.
  // Typed text is "uncommitted" while it differs from this; an import that changes this is a
  // concurrent edit. It is the field's text right before the user's first change since the last
  // commit (beforeinput), not the text it had when focused: a local command can still change the
  // value under a focused field (e.g. "Create new ..." puts a new signal's generated name into the
  // Name field that showed the old signal's name), and that new value is the committed one.
  const committed = new Map();
  const typing = new Set(); // keys of fields with text typed since their last commit
  let carry = null; // the state between takeFieldState() and restoreFieldState()

  function render(open) {
    container.hidden = !open;
    toggle.setAttribute('aria-pressed', String(open));
    toggle.title = open ? 'Hide the properties panel' : 'Show the properties panel';
    document.body.classList.toggle('properties-open', open);
    canvas.resized();
  }

  if (!available) {
    container.hidden = true;
    toggle.hidden = true;
  } else {
    toggle.hidden = false;
    render(loadOpen());
    toggle.addEventListener('click', () => {
      const open = container.hidden;
      storeOpen(open);
      render(open);
    });
  }

  modeler.on('propertiesPanel.updated', ({ element }) => {
    shownId = Array.isArray(element) ? null : element?.id ?? null;
  });
  const keyOf = (field) => `${shownId}|${field.id}`;
  container.addEventListener('beforeinput', (event) => {
    const field = event.target;
    if (carry || !isTextField(field) || !field.id) return;
    const key = keyOf(field);
    if (typing.has(key)) return;
    committed.set(key, field.value);
    typing.add(key);
  });
  fieldKey = (field) => (isTextField(field) && field.id && container.contains(field) ? keyOf(field) : null);
  // A commit (also one that runs after the field was removed or the panel moved on to another
  // element) makes its text the field's committed value.
  onCommit = ({ key }, value) => {
    if (!key) return;
    committed.set(key, value ?? '');
    typing.delete(key);
  };
  // Focus on a field without a commit pending: nothing typed there is outstanding, the next change
  // starts from what it shows.
  container.addEventListener('focusin', (event) => {
    const key = carry ? null : fieldKey(event.target);
    if (key && ![...pending.values()].some((p) => p.key === key)) typing.delete(key);
  });

  // Select all on focus in a reference element's Name field (see above). A field is known by its key
  // (element id + field id), not by its input element: an import replaces the input elements, and the
  // focus is then given back to the new one (by restoreFieldState(), or by the browser on return to
  // the window), which is the same field for the user.
  let restoringFocus = false; // restoreFieldState() is giving the focus back: not the user's focus
  let userEvent = false; // a key, mouse button or click is being handled (until the next task)
  let mouseDown = null; // where the mouse button went down, while it is down
  let reselectKey = null; // field whose first mouseup selects all again (focused by a press or the panel)
  let awayKey = null; // field focused when the window lost the focus: its next focus is given back
  let fresh = null; // a select-all focus whose text the panel may still replace (see watchFresh)
  const isReferenceName = (el) => el instanceof HTMLInputElement
    && REFERENCE_NAME_ENTRIES.has(el.closest('[data-entry-id]')?.getAttribute('data-entry-id'))
    && container.contains(el);
  const noteUserEvent = () => {
    if (userEvent) return;
    userEvent = true;
    setTimeout(() => { userEvent = false; }, 0);
  };
  window.addEventListener('keydown', (event) => {
    noteUserEvent();
    fresh = null;
    // Typing: clicks place the caret from now on.
    if (event.key !== 'Tab' && isReferenceName(event.target) && keyOf(event.target) === reselectKey) reselectKey = null;
  }, true);
  window.addEventListener('click', noteUserEvent, true);
  window.addEventListener('input', () => { fresh = null; }, true); // typed, pasted, dropped: the user's text
  window.addEventListener('mousedown', (event) => {
    noteUserEvent();
    fresh = null;
    mouseDown = { target: event.target, x: event.clientX, y: event.clientY };
  }, true);
  window.addEventListener('mouseup', (event) => {
    const down = mouseDown;
    mouseDown = null;
    const field = down?.target;
    if (!reselectKey || !isReferenceName(field) || keyOf(field) !== reselectKey) return;
    reselectKey = null;
    // A drag (the user selecting part of the text) keeps its selection.
    const dragged = Math.abs(event.clientX - down.x) > 3 || Math.abs(event.clientY - down.y) > 3;
    if (event.target === field && document.activeElement === field && !dragged) {
      // Without preventDefault the browser collapses the selection at the click.
      event.preventDefault();
      field.select();
    }
  }, true);
  window.addEventListener('blur', (event) => {
    if (event.target !== window) return;
    const active = document.activeElement;
    awayKey = isTextField(active) && active.id && container.contains(active) ? keyOf(active) : null;
  });
  // "Create new ..." on an event that already has a signal (message, …): the panel focuses the Name
  // input while it still shows the old name and puts the new one in a render later, which collapses
  // the selection. So for a short while after a select-all focus, a new value in the same, still
  // focused field is selected again, until the user types, clicks or pastes.
  function watchFresh(field) {
    const state = { key: keyOf(field), value: field.value };
    fresh = state;
    let checks = 0;
    const check = () => {
      if (fresh !== state) return;
      const active = document.activeElement;
      if (!isReferenceName(active) || keyOf(active) !== state.key) {
        fresh = null;
        return;
      }
      if (active.value !== state.value) {
        state.value = active.value;
        active.select();
      }
      checks += 1;
      if (checks < FRESH_CHECKS) setTimeout(check, FRESH_CHECK_MS);
      else fresh = null;
    };
    setTimeout(check, 0);
  }
  window.addEventListener('focusin', (event) => {
    const field = event.target;
    // Given back (after an import, or on return to the window, also to the field's replacement):
    // nothing is selected, and a pending first-click select stays pending.
    const back = restoringFocus || (awayKey !== null && isTextField(field) && field.id
      && container.contains(field) && keyOf(field) === awayKey);
    if (!restoringFocus) awayKey = null;
    fresh = null;
    if (back || !isReferenceName(field)) return;
    field.select();
    watchFresh(field);
    // Pressed into focus: its mouseup reselects. Tab or a label click: done. The panel's own focus
    // (no user event in this task): the first click in it reselects.
    reselectKey = mouseDown?.target === field || !userEvent ? keyOf(field) : null;
  });
  container.addEventListener('focusout', (event) => {
    const field = event.target;
    if (!isReferenceName(field) || keyOf(field) !== reselectKey) return;
    const key = reselectKey;
    // Left for another place on the page: done. The window losing the focus, or an import replacing
    // the field, is not leaving it (the focus comes back to it).
    setTimeout(() => {
      const active = document.activeElement;
      const stillThere = isReferenceName(active) && keyOf(active) === key;
      if (reselectKey === key && document.hasFocus() && !carry && !stillThere && field.isConnected) reselectKey = null;
    }, 0);
  });

  // While a take is open: the old fields' events do not reach the panel, and keys typed with focus
  // on the page body (the old field was removed) are kept for the field.
  const hold = (event) => {
    if (carry?.fields.some((f) => f.el === event.target)) event.stopImmediatePropagation();
  };
  for (const type of ['blur', 'focusout', 'input', 'change', 'keydown', 'keyup', 'paste']) {
    window.addEventListener(type, hold, true);
  }
  window.addEventListener('keydown', (event) => {
    if (!carry?.focus || (event.target !== document.body && event.target !== document.documentElement)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
      carry.keys.push(event.key);
      event.preventDefault();
    }
  }, true);

  function endCarry(state) {
    clearTimeout(state.timer);
    if (carry === state) carry = null;
  }

  return {
    /**
     * Before an import: notes the element the panel shows, its focused field and its fields with a
     * pending commit, and cancels those commits (see above). Returns the state restoreFieldState()
     * needs, or null if nothing is in progress in the panel. A take while one is open returns it.
     */
    takeFieldState() {
      if (carry) return carry;
      const active = document.activeElement;
      const focus = isTextField(active) && active.id && container.contains(active) ? active : null;
      const fields = focus ? [{ el: focus, id: focus.id }] : [];
      for (const [debounced, { field }] of pending) {
        debounced.cancel();
        if (isTextField(field) && field.id && container.contains(field) && !fields.some((f) => f.el === field)) {
          fields.push({ el: field, id: field.id });
        }
      }
      if (!fields.length) return null;
      for (const f of fields) {
        // Not typed in since the last commit: the text shown is the committed value.
        const key = `${shownId}|${f.id}`;
        f.committed = typing.has(key) ? committed.get(key) : f.el.value;
      }
      carry = { elementId: shownId, fields, focus, keys: [], timer: null, done: false };
      const state = carry;
      state.timer = setTimeout(() => endCarry(state), CARRY_MAX_MS);
      return state;
    },

    /**
     * After an import: puts the noted text back (see above). Resolves to null, or to 'deleted' /
     * 'changed' if typed, uncommitted text was dropped.
     */
    async restoreFieldState(state) {
      if (!state || state.done) return null;
      state.done = true;
      try {
        // The panel re-renders asynchronously (preact) after the import's events: wait until the old
        // fields are gone (a few turns at most).
        for (let i = 0; i < 20 && state.fields.some((f) => f.el.isConnected); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const focusWasLost = !document.activeElement || document.activeElement === document.body;
        let problem = null;
        let focusTarget = null;
        for (const f of state.fields) {
          let text = f.el.value;
          let caret = null;
          try {
            if (typeof f.el.selectionStart === 'number') caret = [f.el.selectionStart, f.el.selectionEnd];
          } catch {
            // no caret for this kind of input
          }
          if (f.el === state.focus && state.keys.length) ({ text, caret } = typeKeys(text, caret, state.keys));
          const typed = f.committed === undefined || text !== f.committed;
          typing.delete(`${state.elementId}|${f.id}`); // added again below if the text goes back in
          if (shownId !== state.elementId) {
            if (typed) problem = 'deleted';
            continue;
          }
          const field = document.getElementById(f.id);
          if (!isTextField(field) || !container.contains(field)) {
            if (typed) problem = 'deleted';
            continue;
          }
          const now = field.value; // the value the imported document has
          committed.set(`${shownId}|${f.id}`, now);
          if (f.el === state.focus) focusTarget = { field, caret };
          if (!typed || text === now) continue;
          if (f.committed !== undefined && now !== f.committed) {
            problem = 'changed'; // changed by someone else while the user typed: theirs is kept
            if (focusTarget?.field === field) focusTarget.caret = null;
            continue;
          }
          field.value = text;
          typing.add(`${shownId}|${f.id}`);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const active = document.activeElement;
        if (focusTarget && focusWasLost && (!active || active === document.body)) {
          const { field, caret } = focusTarget;
          restoringFocus = true;
          try {
            field.focus({ preventScroll: true });
          } finally {
            restoringFocus = false;
          }
          try {
            const length = field.value.length;
            const [start, end] = caret ?? [length, length];
            field.setSelectionRange(Math.min(start, length), Math.min(end, length));
          } catch {
            // no caret for this kind of input
          }
        }
        return problem;
      } finally {
        endCarry(state);
      }
    },
  };
}
