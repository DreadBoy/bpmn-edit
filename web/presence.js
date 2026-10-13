// Connected-users list: who else has this diagram open (see src/presence.js for the messages).
// This window's name and colour are stored in localStorage, so a reload (or the next session in this
// browser) keeps them; the name can be changed by clicking it in the list.
import { MAX_NAME_LENGTH, PALETTE, cleanName, isColor } from './presence-shared.js';

const STORAGE_KEY = 'local-bpmn.user';

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
 * @param {(message: object) => boolean} options.send  sends a message to the host (false if not connected)
 * @param {HTMLElement} options.toolbar  the list is added at its end
 */
export function createPresence({ send, toolbar }) {
  let me = null;      // this window's entry { id, name, color } once the host has welcomed it
  let users = [];     // everyone joined, this window included, in join order
  let editor = null;  // the rename <input> while it is open

  const listEl = document.createElement('ul');
  listEl.id = 'users';
  listEl.setAttribute('aria-label', 'Connected users');
  toolbar.append(listEl);

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
    },

    /** The connection is gone: nobody else is known to be here any more. */
    onClose() {
      users = me ? [me] : [];
      render();
    },

    /** Handles 'welcome' and 'presence' from the host; returns whether `message` was one of them. */
    handleMessage(message) {
      switch (message.type) {
        case 'welcome':
          me = { id: message.user.id, name: message.user.name, color: message.user.color };
          store(me);
          if (!users.some((u) => u.id === me.id)) users = [...users, me];
          render();
          return true;
        case 'presence':
          users = message.users.filter((u) => isColor(u.color) && typeof u.name === 'string');
          if (me) me = users.find((u) => u.id === me.id) ?? me;
          render();
          return true;
        default:
          return false;
      }
    },
  };
}
