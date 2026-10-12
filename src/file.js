// File access for the edited .bpmn file: reading/validation and debounced atomic writes.
// (Watching for external edits comes later.)
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const BPMN_MODEL_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

/**
 * Lightweight check (no XML parser) that `xml` has a <definitions> root element
 * (any or no prefix) bound to the BPMN 2.0 model namespace.
 */
export function looksLikeBpmn(xml) {
  const match = /<(?:([\w.-]+):)?definitions[\s>]/.exec(xml);
  if (!match) return false;
  const prefix = match[1];
  const attr = prefix ? `xmlns:${prefix}` : 'xmlns';
  const tagEnd = xml.indexOf('>', match.index);
  const openTag = xml.slice(match.index, tagEnd === -1 ? undefined : tagEnd);
  const nsDecl = new RegExp(`\\s${attr.replace('.', '\\.')}\\s*=\\s*["']([^"']*)["']`).exec(openTag);
  return nsDecl !== null && nsDecl[1] === BPMN_MODEL_NS;
}

/**
 * Reads `path` as UTF-8 and validates that it is an existing regular file containing BPMN XML.
 * Throws an Error with a user-facing message otherwise.
 */
export async function readBpmnFile(path) {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new Error(`File not found: ${path}`);
    throw new Error(`Cannot access file: ${path} (${err.code || err.message})`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);

  const xml = await readFile(path, 'utf8');
  if (!looksLikeBpmn(xml)) throw new Error(`Not a BPMN file (no bpmn:definitions element): ${path}`);
  return xml;
}

/** Matches the names of the temp files written by a file store (for watchers to ignore). */
export const TEMP_FILE_RE = /^\..+\.\d+\.[0-9a-f]+\.tmp$/;

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Debounced, serialised, atomic writer for one file.
 *
 * - `write(xml)` schedules a write of the latest XML; calls within `debounceMs` coalesce into one.
 * - Writes go to a temp file in the same directory and are renamed over the target (atomic on POSIX),
 *   preserving the file mode. A symlinked target is resolved so the link itself is kept.
 * - At most one write runs at a time; requests made meanwhile run afterwards with the latest XML.
 * - Content identical to what is on disk is never written.
 * - Errors are logged to stderr and emitted as 'write-error' (never thrown, never 'error').
 *
 * Events: 'written' ({ xml, hash, mtimeMs, size }), 'write-error' (Error).
 */
export function createFileStore(path, { debounceMs = 250, log = defaultLog } = {}) {
  const store = new EventEmitter();
  let targetPath = path;     // resolved through symlinks by read()
  let diskXml = null;        // what we believe is on disk (last read or written)
  let lastWrite = null;      // { xml, hash, mtimeMs, size } of the last completed own write
  let inFlightXml = null;    // XML currently being written (temp file or rename pending)
  let pendingXml = null;     // latest XML waiting to be written
  let ready = false;         // pendingXml may be written now (debounce elapsed or flush requested)
  let timer = null;
  let running = null;        // promise of the active write loop

  async function writeAtomically(xml) {
    const dir = dirname(targetPath);
    const tmp = join(dir, `.${basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    let mode;
    try {
      mode = (await stat(targetPath)).mode & 0o7777;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      const handle = await open(tmp, 'wx', mode ?? 0o644);
      try {
        await handle.writeFile(xml, 'utf8');
        if (mode !== undefined) await handle.chmod(mode); // the open() mode is subject to umask
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, targetPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async function writeOne(xml) {
    if (xml === diskXml) return;
    inFlightXml = xml;
    try {
      await writeAtomically(xml);
      diskXml = xml;
      let info = null;
      try {
        info = await stat(targetPath);
      } catch {
        // Removed right after our rename; nothing to record.
      }
      lastWrite = { xml, hash: sha256(xml), mtimeMs: info?.mtimeMs ?? null, size: info?.size ?? null };
      store.emit('written', lastWrite);
    } catch (err) {
      const error = new Error(`Could not write ${path}: ${err.message}`, { cause: err });
      error.code = err.code;
      log(`local-bpmn: ${error.message}\n`);
      store.emit('write-error', error);
    } finally {
      inFlightXml = null;
    }
  }

  /** Starts the write loop if there is something ready to write; returns the active loop (if any). */
  function kick() {
    if (!running && ready && pendingXml !== null) {
      running = (async () => {
        while (ready && pendingXml !== null) {
          const xml = pendingXml;
          pendingXml = null;
          await writeOne(xml);
        }
      })().finally(() => { running = null; });
    }
    return running;
  }

  function onTimer() {
    timer = null;
    ready = true;
    kick();
  }

  // defineProperties (not Object.assign) so the getters stay live.
  Object.defineProperties(store, Object.getOwnPropertyDescriptors({
    path,

    /** Reads and validates the file; records its content as what is on disk. */
    async read() {
      const xml = await readBpmnFile(path);
      try {
        targetPath = await realpath(path);
      } catch {
        targetPath = path;
      }
      diskXml = xml;
      return xml;
    },

    /** Schedules a debounced write of `xml`. */
    write(xml) {
      if (typeof xml !== 'string') throw new TypeError('xml must be a string');
      pendingXml = xml;
      ready = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onTimer, debounceMs);
    },

    /** Writes anything pending right away and waits for all writes to finish. Never rejects. */
    async flush() {
      for (;;) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
          ready = true;
        }
        const active = kick();
        if (!active) return;
        await active;
      }
    },

    /** True while a write is scheduled or running. */
    get pending() {
      return timer !== null || running !== null || pendingXml !== null;
    },

    /** What we believe is currently on disk (last content read or written by this store). */
    get diskXml() { return diskXml; },

    /** The last completed own write: { xml, hash, mtimeMs, size }, or null. */
    get lastWrite() { return lastWrite; },

    /**
     * True if `xmlOnDisk` is content this store wrote (the last completed write or the one in flight).
     * Lets a file watcher ignore the change events caused by our own writes.
     */
    isOwnWrite(xmlOnDisk) {
      return xmlOnDisk === inFlightXml || (lastWrite !== null && xmlOnDisk === lastWrite.xml);
    },
  }));
  return store;
}

function defaultLog(message) {
  process.stderr.write(message);
}
