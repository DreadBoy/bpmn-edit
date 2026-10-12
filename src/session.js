// Document session: the canonical XML of the edited file plus a monotonically increasing version.
// Transport-agnostic: the server (or anything else) listens to its events and talks to clients.
import { EventEmitter } from 'node:events';
import { looksLikeBpmn } from './file.js';

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

/**
 * Events:
 * - 'change' ({ xml, version, origin }) after an accepted update.
 * - 'write-error' (Error) when persisting to disk failed (forwarded from the store).
 */
export class Session extends EventEmitter {
  #xml;
  #version = 1;
  #store;

  /**
   * @param {object} options
   * @param {string} options.xml  the XML as read at startup (version 1)
   * @param {object} [options.store]  file store (see createFileStore); updates are written through it
   */
  constructor({ xml, store = null }) {
    super();
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) throw new TypeError('Session needs initial BPMN XML');
    this.#xml = xml;
    this.#store = store;
    store?.on('write-error', (err) => this.emit('write-error', err));
  }

  get store() { return this.#store; }

  getState() {
    return { xml: this.#xml, version: this.#version };
  }

  /**
   * Replaces the document. Policy: last write wins, so a stale `baseVersion` is accepted (it is kept
   * in the protocol for conflict handling later). Identical content is a no-op.
   * Throws SessionError('invalid-xml') for anything that is not BPMN XML.
   *
   * @returns {number} the version after the update
   */
  applyUpdate(xml, baseVersion, origin = null) {
    if (typeof xml !== 'string' || !looksLikeBpmn(xml)) {
      throw new SessionError('invalid-xml', 'Update rejected: not BPMN XML (no bpmn:definitions element)');
    }
    if (xml === this.#xml) return this.#version;
    this.#xml = xml;
    this.#version += 1;
    this.#store?.write(xml);
    this.emit('change', { xml, version: this.#version, baseVersion, origin });
    return this.#version;
  }
}
