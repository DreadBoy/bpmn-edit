// Document session: the canonical XML of the edited file plus a monotonically increasing version.
// Transport-agnostic: the server (or anything else) listens to its events and talks to clients.
import { EventEmitter } from 'node:events';
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
 * - 'write-error' (Error) when persisting to disk failed (forwarded from the store).
 * - 'disk-status' ({ state: 'ok' | 'missing' | 'invalid', message? }) when the state of the file on
 *   disk changes (deleted, not valid BPMN, valid again).
 */
export class Session extends EventEmitter {
  #xml;
  #version = 1;
  #origin = null; // origin of the current version (null for the initial file)
  #lastEditVersion = 1; // newest version made by applyUpdate (the initial file counts as one)
  #minBase = 1; // updates must be based on this version or newer (see applyUpdate)
  #unsaved = []; // [{ version, xml }] accepted updates not on disk yet, oldest first
  #store;
  #log;
  #diskStatus = { state: 'ok' };

  /**
   * @param {object} options
   * @param {string} options.xml  the XML as read at startup (version 1)
   * @param {object} [options.store]  file store (see createFileStore); updates are written through it
   *   and its external-change events replace the document (see replaceFromDisk)
   * @param {(message: string) => void} [options.log]  warnings (default: stderr)
   */
  constructor({ xml, store = null, log = defaultLog }) {
    super();
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) throw new TypeError('Session needs initial BPMN XML');
    this.#xml = xml;
    this.#store = store;
    this.#log = log;
    if (store) {
      store.on('write-error', (err) => this.emit('write-error', err));
      store.on('external-change', ({ xml: diskXml, discarded }) => {
        this.#setDiskStatus({ state: 'ok' });
        // A pending write was dropped for this change: the updates in it never reached the disk.
        const lost = discarded && this.#unsaved.length && diskXml !== this.#xml ? this.#unsaved[0].version - 1 : null;
        this.#unsaved = [];
        if (lost !== null) {
          this.#log(`local-bpmn: ${store.path ?? 'the file'} changed on disk before the latest edits were saved; `
            + 'they are re-applied on top of the change\n');
        }
        this.replaceFromDisk(diskXml, lost === null ? {} : { discardedAfter: lost });
      });
      store.on('saved', ({ xml: savedXml }) => {
        const index = this.#unsaved.findLastIndex((entry) => entry.xml === savedXml);
        if (index === -1) return;
        const { version } = this.#unsaved[index];
        this.#unsaved.splice(0, index + 1);
        this.emit('saved', { version });
      });
      store.on('external-missing', () => this.#setDiskStatus({ state: 'missing' }));
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
   *
   * @returns {number} the version after the update
   */
  applyUpdate(xml, baseVersion, origin = null, { overrides } = {}) {
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) {
      throw new SessionError('invalid-xml', 'Update rejected: not BPMN XML (no bpmn:definitions element)');
    }
    if (xml === this.#xml) return this.#version;
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
      this.#unsaved.push({ version: this.#version, xml });
      this.#store.write(xml);
    }
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
  replaceFromDisk(xml, { discardedAfter } = {}) {
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) throw new TypeError('replaceFromDisk needs BPMN XML');
    if (xml === this.#xml) return this.#version;
    this.#xml = xml;
    this.#version += 1;
    this.#minBase = this.#version;
    this.#origin = 'disk';
    this.emit('change', {
      xml, version: this.#version, origin: 'disk', ...(discardedAfter !== undefined ? { discardedAfter } : {}),
    });
    return this.#version;
  }
}

function defaultLog(message) {
  process.stderr.write(message);
}
