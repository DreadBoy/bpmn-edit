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
 * - 'change' ({ xml, version, baseVersion?, origin, overrides? }) after an accepted update. `origin`
 *   is the updating client (whatever applyUpdate was given) or 'disk' for a change made on disk;
 *   `overrides` is passed through from applyUpdate.
 * - 'write-error' (Error) when persisting to disk failed (forwarded from the store).
 * - 'disk-status' ({ state: 'ok' | 'missing' | 'invalid', message? }) when the state of the file on
 *   disk changes (deleted, not valid BPMN, valid again).
 */
export class Session extends EventEmitter {
  #xml;
  #version = 1;
  #origin = null; // origin of the current version (null for the initial file)
  #lastEditVersion = 1; // newest version made by applyUpdate (the initial file counts as one)
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
      store.on('external-change', ({ xml: diskXml }) => {
        this.#setDiskStatus({ state: 'ok' });
        this.replaceFromDisk(diskXml);
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
   * The update is accepted if it is based on the current version, or on a version that only changes
   * made on disk have replaced since (those are overwritten: last write wins, with a warning; see
   * Q2 in PLAN.md). An update based on a version some other update replaced is refused with
   * SessionError('conflict', …, { version }): the client re-applies its edits on the newer version
   * (which it receives as a 'change') and sends again, so concurrent edits never overwrite each
   * other. Identical content is a no-op (accepted whatever its base).
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
    if (!Number.isInteger(baseVersion) || baseVersion < this.#lastEditVersion || baseVersion > this.#version) {
      throw new SessionError('conflict',
        `Update refused: based on version ${baseVersion}, but the document is at version ${this.#version}`,
        { version: this.#version });
    }
    if (baseVersion < this.#version) {
      this.#log('local-bpmn: warning: an edit from the browser replaced a change made on disk\n');
    }
    this.#xml = xml;
    this.#version += 1;
    this.#lastEditVersion = this.#version;
    this.#origin = origin;
    this.#store?.write(xml);
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
    return true;
  }

  /**
   * Replaces the document with content that changed on disk (origin 'disk'). Never writes it back.
   * Identical content is a no-op.
   *
   * @returns {number} the version after the replacement
   */
  replaceFromDisk(xml) {
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) throw new TypeError('replaceFromDisk needs BPMN XML');
    if (xml === this.#xml) return this.#version;
    this.#xml = xml;
    this.#version += 1;
    this.#origin = 'disk';
    this.emit('change', { xml, version: this.#version, origin: 'disk' });
    return this.#version;
  }
}

function defaultLog(message) {
  process.stderr.write(message);
}
