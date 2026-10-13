// Document session: the canonical XML of the edited file plus a monotonically increasing version.
// Transport-agnostic: the server (or anything else) listens to its events and talks to clients.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { looksLikeBpmn } from './file.js';

export class SessionError extends Error {
  /** `details` are extra fields for the client (e.g. { version } for 'conflict'). */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Events:
 * - 'change' ({ xml, version, baseVersion?, origin, overrides?, discardedAfter? }) after an accepted
 *   update. `origin` is the updating client (whatever applyUpdate was given) or 'disk' for a change
 *   made on disk; `overrides` is passed through from applyUpdate. `discardedAfter` (disk only): the
 *   accepted updates with a higher version (but lower than this one) never reached the disk and are
 *   not in this document; the clients that made them re-apply their edits on top of it (Q2).
 * - 'saved' ({ version }) every version up to `version` is on disk.
 * - 'stale-save' ({ name }) a save from an older copy replaced the last write shortly after it; the
 *   editor's version was saved next to the file as `name` (Q2).
 * - 'write-error' (Error) when persisting to disk failed (forwarded from the store).
 * - 'disk-status' ({ state: 'ok' | 'missing' | 'invalid', message? }) when the state of the file on
 *   disk changes (deleted, not valid BPMN, valid again).
 */
/** How many discards syncState() remembers (each is a rare event: a change on disk racing an edit). */
const MAX_DISCARDS = 100;
/** How many saves from an older copy syncState() remembers. */
const MAX_STALE_SAVES = 20;

/**
 * How long discarded edits wait for their window to come back once its connection is gone (S8: a
 * reconnecting page re-applies them) before the unsaved document is kept next to the file.
 */
export const REAPPLY_GRACE_MS = 20_000;

export class Session extends EventEmitter {
  #xml;
  #version = 1;
  #origin = null; // origin of the current version (null for the initial file)
  #lastEditVersion = 1; // newest version made by applyUpdate (the initial file counts as one)
  #minBase = 1; // updates must be based on this version or newer (see applyUpdate)
  #unsaved = []; // [{ version, xml, origin }] accepted updates not on disk yet, oldest first
  #gone = new WeakSet(); // origins that went away (see originGone)
  #instance = randomUUID(); // versions only compare within one session (see syncState)
  #discards = []; // [{ after, version }] see syncState
  #staleSaves = []; // [{ name, version }] see syncState
  #awaiting = []; // [{ xml, versions: Map(version -> origin), timer }] discarded edits not re-applied yet
  #lastDiskVersion = null; // newest version made by a change on disk
  #graceMs;
  #store;
  #log;
  #diskStatus = { state: 'ok' };

  /**
   * @param {object} options
   * @param {string} options.xml  the XML as read at startup (version 1)
   * @param {object} [options.store]  file store (see createFileStore); updates are written through it
   *   and its external-change events replace the document (see replaceFromDisk)
   * @param {(message: string) => void} [options.log]  warnings (default: stderr)
   * @param {number} [options.reapplyGraceMs=REAPPLY_GRACE_MS]  see REAPPLY_GRACE_MS
   */
  constructor({ xml, store = null, log = defaultLog, reapplyGraceMs = REAPPLY_GRACE_MS }) {
    super();
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) throw new TypeError('Session needs initial BPMN XML');
    this.#xml = xml;
    this.#store = store;
    this.#log = log;
    this.#graceMs = reapplyGraceMs;
    if (store) {
      store.on('write-error', (err) => this.emit('write-error', err));
      store.on('external-change', ({ xml: diskXml, discarded, stale }) => {
        this.#setDiskStatus({ state: 'ok' });
        // A pending write was dropped for this change: the updates in it never reached the disk.
        const lost = discarded && this.#unsaved.length && diskXml !== this.#xml ? this.#unsaved[0].version - 1 : null;
        if (lost !== null) {
          // The windows that made them re-apply them and say so (applyUpdate / reapplied). Until
          // then the unsaved document is remembered; it is kept next to the file if one of those
          // windows is gone for good (see originGone) or at shutdown (keepUnapplied).
          const waiting = {
            xml: this.#xml,
            versions: new Map(this.#unsaved.map((e) => [e.version, { origin: e.origin, owner: e.owner }])),
            timer: null,
          };
          this.#awaiting.push(waiting);
          const gone = [...waiting.versions.values()].filter(({ origin }) => this.#gone.has(origin));
          const name = store.path ?? 'the file';
          if (gone.length === waiting.versions.size) {
            this.#log(`local-bpmn: warning: ${name} changed on disk before the latest edits were saved, and the `
              + `window that made them is disconnected: they are re-applied if it reconnects within `
              + `${Math.round(this.#graceMs / 1000)} s, otherwise the editor's version is saved next to the file\n`);
          } else {
            this.#log(`local-bpmn: warning: ${name} changed on disk before the latest edits were saved; `
              + 'the windows that made them re-apply them on top of the change\n');
          }
          if (gone.length) this.#armGrace(waiting);
        }
        this.#unsaved = [];
        const version = this.replaceFromDisk(diskXml, {
          ...(lost === null ? {} : { discardedAfter: lost }), ...(stale ? { stale: true } : {}),
        });
        if (lost !== null) {
          this.#discards.push({ after: lost, version });
          if (this.#discards.length > MAX_DISCARDS) this.#discards.shift();
        }
      });
      store.on('saved', ({ xml: savedXml }) => {
        const index = this.#unsaved.findLastIndex((entry) => entry.xml === savedXml);
        if (index === -1) return;
        const { version } = this.#unsaved[index];
        this.#unsaved.splice(0, index + 1);
        this.emit('saved', { version });
      });
      store.on('external-missing', () => this.#setDiskStatus({ state: 'missing' }));
      store.on('kept-aside', ({ path, reason }) => {
        if (reason !== 'stale') return;
        const name = basename(path);
        this.#staleSaves.push({ name, version: this.#version });
        if (this.#staleSaves.length > MAX_STALE_SAVES) this.#staleSaves.shift();
        this.emit('stale-save', { name });
      });
      store.on('external-invalid', ({ message }) => this.#setDiskStatus({ state: 'invalid', message }));
      store.on('disk-ok', () => this.#setDiskStatus({ state: 'ok' }));
      // Our own write replaced whatever was on disk with the current (displayable) document.
      store.on('written', () => this.#setDiskStatus({ state: 'ok' }));
    }
  }

  get store() { return this.#store; }

  /** State of the file on disk: { state: 'ok' | 'missing' | 'invalid', message? }. */
  get diskStatus() { return { ...this.#diskStatus }; }

  getState() {
    return { xml: this.#xml, version: this.#version };
  }

  /**
   * What a (re)connecting client needs to sort out its accepted edits that it has not seen written
   * ('saved') yet, e.g. after its connection dropped (Q2 with S8's re-sync):
   * - `instance`: id of this session; versions from another one (local-bpmn restarted) mean nothing;
   * - `saved`: every version up to this is on disk (or was replaced there by a change on disk);
   * - `discards`: [{ after, version }] the accepted updates with a version between `after` and
   *   `version` (exclusive) were replaced by the change on disk at `version` before they were
   *   written, i.e. are not in the document (the 'change' events' discardedAfter, kept for clients
   *   that missed them; the most recent MAX_DISCARDS);
   * - `lastDisk` / `lastEdit`: the newest version made by a change on disk (null if none) and by an
   *   update (the initial file counts as 1), so a client can tell what replaced its document;
   * - `staleSaves`: [{ name, version }] saves from an older copy that replaced written edits (the
   *   'stale-save' events: the side file's name, the version of the document then), the most recent
   *   MAX_STALE_SAVES, so a window that was away can still be told.
   */
  syncState() {
    return {
      instance: this.#instance,
      saved: this.#unsaved.length ? this.#unsaved[0].version - 1 : this.#version,
      discards: this.#discards.map((entry) => ({ ...entry })),
      lastDisk: this.#lastDiskVersion,
      lastEdit: this.#lastEditVersion,
      staleSaves: this.#staleSaves.map((entry) => ({ ...entry })),
    };
  }

  #setDiskStatus(status) {
    const current = this.#diskStatus;
    if (current.state === status.state && current.message === status.message) return;
    this.#diskStatus = status;
    this.emit('disk-status', { ...status });
  }

  /**
   * Replaces the document with an edited version based on `baseVersion` (optimistic concurrency).
   * The update is accepted if it is based on the current version. An update based on a version some
   * other update or a change made on disk replaced is refused with SessionError('conflict', …,
   * { version }): the client re-applies its edits on the newer version (which it receives as a
   * 'change') and sends again, so concurrent edits never overwrite each other, nor a change made on
   * disk (Q2 in docs/decisions.md). The one exception is a change on disk the editor could not
   * display (reportUnreadable): updates based on the version before it replace it, with a warning.
   * Identical content is a no-op (accepted whatever its base).
   * Throws SessionError('invalid-xml') for anything that is not BPMN XML. `overrides` (elements this
   * update deleted although someone else had changed them concurrently) is passed on in 'change'.
   * `owner`: who made it, across reconnects (see reapplied); `reapplied`: versions of that owner's
   * discarded updates this one re-applies.
   *
   * @returns {number} the version after the update
   */
  applyUpdate(xml, baseVersion, origin = null, { overrides, reapplied, owner = null } = {}) {
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) {
      throw new SessionError('invalid-xml', 'Update rejected: not BPMN XML (no bpmn:definitions element)');
    }
    if (xml === this.#xml) {
      this.reapplied(reapplied, owner);
      return this.#version;
    }
    if (!Number.isInteger(baseVersion) || baseVersion < this.#minBase || baseVersion > this.#version) {
      throw new SessionError('conflict',
        `Update refused: based on version ${baseVersion}, but the document is at version ${this.#version}`,
        { version: this.#version });
    }
    if (baseVersion < this.#version) {
      this.#log('local-bpmn: warning: an edit from the browser replaced a change made on disk that the editor could not display\n');
    }
    this.#xml = xml;
    this.#version += 1;
    this.#lastEditVersion = this.#version;
    this.#minBase = this.#version;
    this.#origin = origin;
    if (this.#store) {
      this.#unsaved.push({ version: this.#version, xml, origin, owner });
      this.#store.write(xml);
    }
    this.reapplied(reapplied, owner);
    this.emit('change', { xml, version: this.#version, baseVersion, origin, ...(overrides ? { overrides } : {}) });
    return this.#version;
  }

  /**
   * A client could not display `version` of the document. If that version is the content read from
   * disk (at startup or after an external change), the file is reported as invalid ('disk-status').
   * Nothing is written; the next accepted edit replaces the file.
   *
   * @returns {boolean} whether the report applied to the current version from disk
   */
  reportUnreadable(version, message) {
    if (version !== this.#version || (this.#origin !== 'disk' && this.#origin !== null)) return false;
    this.#setDiskStatus({ state: 'invalid', message: `The editor could not display it: ${message}` });
    // Nobody can re-apply edits on it: an edit based on the last displayable version replaces it.
    this.#minBase = Math.min(this.#minBase, this.#lastEditVersion);
    return true;
  }

  /**
   * The client `origin` (as given to applyUpdate) has disconnected: if its accepted edits are later
   * replaced by a change on disk before they were written, nobody can re-apply them, so the
   * unsaved document is kept next to the file instead (Q2). Objects only (e.g. the WebSocket).
   */
  originGone(origin) {
    if (origin === null || typeof origin !== 'object') return;
    this.#gone.add(origin);
    for (const waiting of this.#awaiting) {
      if ([...waiting.versions.values()].some((entry) => entry.origin === origin)) this.#armGrace(waiting);
    }
  }

  /**
   * A client re-applied its accepted edits of these versions after a change on disk discarded them
   * (they are in an update it sent, or there was nothing left to re-apply). Only versions made by the
   * same `owner` (as given to applyUpdate: the page's scoped key, so a reconnected page counts, see
   * src/server.js) are taken; others, and versions not awaiting re-apply, are ignored.
   */
  reapplied(versions, owner) {
    if (!Array.isArray(versions) || !versions.length || typeof owner !== 'string' || !owner) return;
    for (const waiting of [...this.#awaiting]) {
      for (const version of versions) {
        if (waiting.versions.get(version)?.owner === owner) waiting.versions.delete(version);
      }
      if (!waiting.versions.size) this.#settle(waiting);
    }
  }

  /**
   * For shutdown, once the windows had their chance to re-apply: keeps the unsaved document of every
   * discard not re-applied yet next to the file (nobody can re-apply it any more). Resolves when
   * saved; to the number of documents kept aside.
   */
  async keepUnapplied() {
    const waiting = [...this.#awaiting];
    for (const entry of waiting) this.#settle(entry);
    if (typeof this.#store?.keepAside !== 'function') return 0;
    await Promise.all(waiting.map((entry) => this.#store.keepAside(entry.xml)));
    return waiting.length;
  }

  #armGrace(waiting) {
    if (waiting.timer || !this.#awaiting.includes(waiting)) return;
    waiting.timer = setTimeout(() => {
      waiting.timer = null;
      if (![...waiting.versions.values()].some(({ origin }) => this.#gone.has(origin))) return;
      this.#settle(waiting);
      this.#store?.keepAside?.(waiting.xml);
    }, this.#graceMs);
    waiting.timer.unref?.();
  }

  #settle(waiting) {
    clearTimeout(waiting.timer);
    waiting.timer = null;
    this.#awaiting = this.#awaiting.filter((entry) => entry !== waiting);
  }

  /**
   * Checks the file on disk now for a change the watcher has not reported yet (it waits for the file
   * to settle) and applies it like any change on disk. For shutdown: resolves to true if accepted
   * edits were not written because of it, i.e. the clients were sent the change to re-apply them on
   * (and should be given the chance to send the result before the final write).
   */
  async checkDisk() {
    if (typeof this.#store?.checkNow !== 'function') return false;
    let discarded = false;
    const onChange = ({ discardedAfter }) => {
      if (discardedAfter !== undefined) discarded = true;
    };
    this.on('change', onChange);
    try {
      await this.#store.checkNow();
    } finally {
      this.off('change', onChange);
    }
    return discarded;
  }

  /**
   * Replaces the document with content that changed on disk (origin 'disk'). Never writes it back.
   * Identical content is a no-op. Updates based on older versions are refused from now on (their
   * edits are re-applied on top of this content). `discardedAfter`: see the 'change' event.
   *
   * @returns {number} the version after the replacement
   */
  replaceFromDisk(xml, { discardedAfter, stale = false } = {}) {
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) throw new TypeError('replaceFromDisk needs BPMN XML');
    if (xml === this.#xml) return this.#version;
    this.#xml = xml;
    this.#version += 1;
    this.#minBase = this.#version;
    this.#origin = 'disk';
    this.#lastDiskVersion = this.#version;
    this.emit('change', {
      xml, version: this.#version, origin: 'disk', ...(discardedAfter !== undefined ? { discardedAfter } : {}),
      ...(stale ? { stale: true } : {}),
    });
    return this.#version;
  }
}

function defaultLog(message) {
  process.stderr.write(message);
}
