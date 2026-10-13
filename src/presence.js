// Presence: who is connected to the session (a display name and a colour per editor window) and
// which elements each of them has selected.
// Transport-agnostic apart from `send(ws, message)`; src/server.js passes the presence messages of
// each WebSocket here and calls leave() when it closes.
//
// Protocol (JSON text frames on the same /ws socket as the sync protocol in src/server.js). Only
// connections that sent 'hello' take part: the others never receive presence messages.
//   client -> server  { type: 'hello', name?, color?, key? }
//                                                        join, with the name and colour the browser has
//                                                        stored; a missing or invalid name is replaced by
//                                                        a random one, a missing or invalid colour by the
//                                                        least used one. Sent again, it updates both.
//                                                        key: random id of the page (kept in memory, so
//                                                        a reload or a second tab has another one); a
//                                                        reconnecting page sends the same key, and an
//                                                        entry with that key on another connection (a
//                                                        connection that died without closing) is taken
//                                                        over in place and that connection dropped.
//                                                        Never sent to anyone.
//   server -> client  { type: 'welcome', user }          to the sender only: its own entry (as in
//                                                        'presence'; id = the clientId of 'init')
//   server -> client  { type: 'presence', users }        to every joined client, on each join, leave and
//                                                        rename: [{ id, name, color, selection }] in
//                                                        join order (selection: the user's latest one)
//   client -> server  { type: 'rename', name }           new display name
//   client -> server  { type: 'selection', ids }         the element ids now selected (after each change;
//                                                        [] = nothing selected)
//   server -> client  { type: 'selection', userId, ids } to every other joined client
// Names are cleaned (see cleanName: invisible characters removed, whitespace collapsed, at most
// MAX_NAME_LENGTH characters); a colour is an index into PALETTE (web/presence-shared.js); a
// selection has at most MAX_SELECTION distinct ids of at most MAX_ID_LENGTH characters. Invalid
// presence messages are ignored rather than answered with 'error', which the editor treats as a failed
// save.
import { CLIENT_KEY_RE } from '../web/connection-shared.js';
import {
  MAX_ID_LENGTH, MAX_SELECTION, PALETTE, cleanName, isColor, randomName,
} from '../web/presence-shared.js';

const MESSAGE_TYPES = new Set(['hello', 'rename', 'selection']);

/**
 * @param {object} options
 * @param {(ws: object, message: object) => void} options.send  sends a message to one connection
 * @param {(ws: object) => void} [options.onReplaced]  a reconnected page took over the entry of `ws`
 *   (see 'hello' key); the caller should drop that connection
 * @param {() => number} [options.random=Math.random]  random source for names and colours (tests)
 */
export function createPresence({ send, onReplaced = () => {}, random = Math.random }) {
  /** Joined connections, in join order: ws -> { id, name, color, selection, key }. */
  let users = new Map();

  const entry = ({ id, name, color, selection }) => ({ id, name, color, selection: [...selection] });

  function broadcastPresence() {
    const message = { type: 'presence', users: [...users.values()].map(entry) };
    for (const ws of users.keys()) send(ws, message);
  }

  /** A colour nobody (or the fewest users) has, picked at random among those. */
  function leastUsedColor() {
    const counts = PALETTE.map(() => 0);
    for (const user of users.values()) counts[user.color] += 1;
    const fewest = Math.min(...counts);
    const candidates = counts.flatMap((count, slot) => (count === fewest ? [slot] : []));
    return candidates[Math.floor(random() * candidates.length) % candidates.length];
  }

  /** The connection whose entry has `key`, other than `ws`, or null. */
  function connectionWithKey(key, ws) {
    for (const [other, user] of users) if (other !== ws && user.key === key) return other;
    return null;
  }

  function hello(ws, message, id, scope) {
    let existing = users.get(ws);
    const key = !existing && typeof message.key === 'string' && CLIENT_KEY_RE.test(message.key)
      ? `${scope ?? ''}|${message.key}` : null;
    const stale = key ? connectionWithKey(key, ws) : null;
    if (stale) {
      // The same page again, on a new connection: keep its place in the list, drop the old one.
      existing = users.get(stale);
      existing.id = String(id);
      users = new Map([...users].map(([conn, user]) => (conn === stale ? [ws, user] : [conn, user])));
    }
    const user = existing ?? { id: String(id), selection: [], key };
    user.name = cleanName(message.name) || existing?.name || randomName(random);
    user.color = isColor(message.color) ? message.color : existing?.color ?? leastUsedColor();
    users.set(ws, user);
    if (stale) onReplaced(stale);
    send(ws, { type: 'welcome', user: entry(user) });
    broadcastPresence();
  }

  function rename(ws, message) {
    const user = users.get(ws);
    const name = cleanName(message.name);
    if (!user || !name || name === user.name) return;
    user.name = name;
    broadcastPresence();
  }

  function select(ws, message) {
    const user = users.get(ws);
    const { ids } = message;
    if (!user || !Array.isArray(ids)) return;
    if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)) return;
    const selection = [...new Set(ids)].slice(0, MAX_SELECTION);
    if (selection.length === user.selection.length && selection.every((id, i) => id === user.selection[i])) return;
    user.selection = selection;
    const relay = { type: 'selection', userId: user.id, ids: selection };
    for (const other of users.keys()) if (other !== ws) send(other, relay);
  }

  return {
    /** Whether a message of this type is a presence message (to pass to handleMessage). */
    handles(type) {
      return MESSAGE_TYPES.has(type);
    },

    /**
     * Handles a presence message from `ws`; `id` is the connection's clientId, `scope` how it was
     * opened (a 'hello' key only takes over entries of the same scope).
     */
    handleMessage(ws, message, id, scope = '') {
      if (message.type === 'hello') hello(ws, message, id, scope);
      else if (message.type === 'rename') rename(ws, message);
      else if (message.type === 'selection') select(ws, message);
    },

    /** `ws` closed: removes its entry (and with it its selection) and tells the others. */
    leave(ws) {
      if (users.delete(ws)) broadcastPresence();
    },

    /** The joined users, in join order. */
    get users() {
      return [...users.values()].map(entry);
    },
  };
}
