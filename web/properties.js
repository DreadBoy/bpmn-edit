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

/** Debounced input commits that have not run yet: debounced function -> the field it came from. */
const pending = new Map();

/** Called with (field, value) when a debounced commit runs (see createPropertiesPanel). */
let onCommit = () => {};

/**
 * Replacement for the panel's 'debounceInput' service: the same trailing debounce (with flush and
 * cancel, as the panel expects), but this module knows which commits are still pending.
 */
function trackedDebounce(fn) {
  let timer = null;
  let args = null;
  let self = null;
  let field = null;
  function run() {
    clearTimeout(timer);
    timer = null;
    pending.delete(debounced);
    onCommit(field, args[0]);
    fn.apply(self, args);
  }
  function debounced(...callArgs) {
    args = callArgs;
    self = this;
    clearTimeout(timer);
    timer = setTimeout(run, INPUT_DEBOUNCE_MS);
    const active = document.activeElement;
    field = active instanceof HTMLElement ? active : null;
    pending.set(debounced, field);
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
  // Committed value of each field as last seen, per element: "elementId|fieldId" -> text. Typed text
  // is "uncommitted" while it differs from this; an import that changes this is a concurrent edit.
  const committed = new Map();
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
  container.addEventListener('focusin', (event) => {
    if (!carry && isTextField(event.target) && event.target.id) committed.set(keyOf(event.target), event.target.value);
  });
  onCommit = (field, value) => {
    if (field?.id && container.contains(field)) committed.set(keyOf(field), value ?? '');
  };

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
      for (const [debounced, field] of pending) {
        debounced.cancel();
        if (isTextField(field) && field.id && container.contains(field) && !fields.some((f) => f.el === field)) {
          fields.push({ el: field, id: field.id });
        }
      }
      if (!fields.length) return null;
      for (const f of fields) f.committed = committed.get(`${shownId}|${f.id}`);
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
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const active = document.activeElement;
        if (focusTarget && focusWasLost && (!active || active === document.body)) {
          const { field, caret } = focusTarget;
          field.focus({ preventScroll: true });
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
