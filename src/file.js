// File access for the edited .bpmn file: reading/validation, debounced atomic writes, and watching
// for changes made on disk by other programs (IDE saves, git checkout, ...).
import { watch as chokidarWatch } from 'chokidar';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const BPMN_MODEL_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

/**
 * Index of the '>' closing the tag that starts at `lt`, honouring quoted attribute values; -1 if the
 * tag never closes or contains a '<' (never allowed inside a tag or an attribute value).
 */
function findTagEnd(xml, lt) {
  let quote = null;
  for (let j = lt + 1; j < xml.length; j++) {
    const c = xml[j];
    if (c === '<') return -1;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

/**
 * If `xml` has a comment, CDATA section, processing instruction (or XML declaration) or DOCTYPE at
 * `lt`, returns the index just after it (-1 if it never ends); otherwise null.
 */
function skipNonElement(xml, lt) {
  const skipTo = (terminator, from) => {
    const end = xml.indexOf(terminator, from);
    return end === -1 ? -1 : end + terminator.length;
  };
  if (xml.startsWith('<!--', lt)) return skipTo('-->', lt + 4);
  if (xml.startsWith('<![CDATA[', lt)) return skipTo(']]>', lt + 9);
  if (xml.startsWith('<?', lt)) return skipTo('?>', lt + 2);
  if (xml.startsWith('<!', lt)) {
    const bracket = xml.indexOf('[', lt);
    const close = xml.indexOf('>', lt);
    return bracket !== -1 && bracket < close ? skipTo(']>', bracket) : skipTo('>', lt); // internal subset or not
  }
  return null;
}

/**
 * Lightweight check (no XML parser) that the root element of `xml` (the first element after the
 * XML declaration, comments, processing instructions and DOCTYPE) is <definitions> (any or no
 * prefix) bound to the BPMN 2.0 model namespace.
 */
export function looksLikeBpmn(xml) {
  if (typeof xml !== 'string') return false;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0; // byte order mark
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i])) i += 1;
    if (xml[i] !== '<') return false; // text before the root element
    const next = skipNonElement(xml, i);
    if (next === null) break;
    if (next === -1) return false;
    i = next;
  }
  const match = /<(?:([\w.-]+):)?definitions[\s>/]/y;
  match.lastIndex = i;
  const found = match.exec(xml);
  if (!found) return false;
  const prefix = found[1];
  const attr = prefix ? `xmlns:${prefix}` : 'xmlns';
  const tagEnd = findTagEnd(xml, i);
  const openTag = xml.slice(i, tagEnd === -1 ? undefined : tagEnd);
  const nsDecl = new RegExp(`\\s${attr.replaceAll('.', '\\.')}\\s*=\\s*["']([^"']*)["']`).exec(openTag);
  return nsDecl !== null && nsDecl[1] === BPMN_MODEL_NS;
}

/**
 * Cheap completeness check (no XML parser): `xml` looks like BPMN (see looksLikeBpmn) and is
 * structurally sound up to the end of its root element, with only whitespace, comments and
 * processing instructions after it (see scanMarkup). Catches files that are truncated or still
 * being written (which still have the opening tag) and the common ways a file gets broken in the
 * middle.
 */
export function isCompleteBpmn(xml) {
  return looksLikeBpmn(xml) && scanMarkup(xml) !== null;
}

/**
 * Linear scan (not a full XML parser) that the markup is structurally sound: exactly one root
 * element with only whitespace, comments, processing instructions (and a DOCTYPE before it) outside;
 * every tag closed; element names starting with a valid character; attribute quotes closed (no '<'
 * inside a tag or a quoted value); every end tag matching the open element; nothing left open.
 */
export function hasBalancedTags(xml) {
  return typeof xml === 'string' && scanMarkup(xml) !== null;
}

/** See hasBalancedTags; returns the root element's name, or null if the markup is not sound. */
function scanMarkup(xml) {
  const stack = [];
  let root = null;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    const lt = xml.indexOf('<', i);
    // Outside the root element only whitespace is allowed as text.
    if (!stack.length && /\S/.test(xml.slice(i, lt === -1 ? undefined : lt))) return null;
    if (lt === -1) break;
    const next = skipNonElement(xml, lt);
    if (next !== null) {
      if (next === -1) return null;
      if (!stack.length && xml.startsWith('<![CDATA[', lt)) return null; // CDATA only inside elements
      i = next;
      continue;
    }
    const end = findTagEnd(xml, lt);
    if (end === -1) return null;
    const body = xml.slice(lt + 1, end);
    if (body.startsWith('/')) {
      if (stack.pop() !== body.slice(1).trim()) return null;
    } else {
      const name = /^[^\s/>0-9.-][^\s/>]*/.exec(body); // names cannot start with a digit, '.' or '-'
      if (!name) return null;
      if (!stack.length) {
        if (root !== null) return null; // a second root element
        root = name[0];
      }
      if (!body.endsWith('/')) stack.push(name[0]);
    }
    i = end + 1;
  }
  return stack.length === 0 && root !== null ? root : null;
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
 * Watching (`watch()` / `unwatch()`): changes made to the file by other programs are reported once
 * the file has been quiet for `settleMs`. Content equal to what we believe is on disk (including our
 * own writes) is ignored, so our writes never come back as external changes. Watching never writes.
 *
 * Events: 'written' ({ xml, hash, mtimeMs, size }), 'write-error' (Error),
 *   'external-change' ({ xml }) valid new content on disk (a pending write of ours was dropped),
 *   'external-missing' the file was deleted (emitted once until it reappears),
 *   'external-invalid' ({ message }) the file is not (or not yet) a complete BPMN document,
 *   'disk-ok' the file is valid again after 'external-missing' / 'external-invalid'.
 */
export function createFileStore(path, { debounceMs = 250, settleMs = 150, log = defaultLog } = {}) {
  const store = new EventEmitter();
  let targetPath = path;     // resolved through symlinks by read()
  let diskXml = null;        // what we believe is on disk (last read or written)
  let lastWrite = null;      // { xml, hash, mtimeMs, size } of the last completed own write
  let inFlightXml = null;    // XML currently being written (temp file or rename pending)
  let pendingXml = null;     // latest XML waiting to be written
  let ready = false;         // pendingXml may be written now (debounce elapsed or flush requested)
  let timer = null;
  let running = null;        // promise of the active write loop
  let watcher = null;        // chokidar watcher on the target's directory
  let settleTimer = null;    // runs a disk check once the file has been quiet for settleMs
  let checking = null;       // promise of the active disk check
  let recheck = false;       // another check was requested while one was running
  let diskState = 'ok';      // 'ok' | 'missing' | 'invalid'
  let invalidXml = null;     // the invalid content last reported (to report each version once)
  let writeSeq = 0;          // incremented whenever one of our writes starts

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
    writeSeq += 1;
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
      setDiskOk(); // e.g. our write recreated a deleted file
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

  function setDiskOk() {
    invalidXml = null;
    if (diskState === 'ok') return;
    diskState = 'ok';
    store.emit('disk-ok');
  }

  /** Drops a scheduled write that has not started yet; returns true if there was one. */
  function dropPendingWrite() {
    const had = pendingXml !== null;
    pendingXml = null;
    ready = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return had;
  }

  /** Reads the file after it settled and reports what changed (see the 'external-*' events). */
  async function checkDisk() {
    // Never judge content read while one of our writes ran: wait for writes, retry if one started.
    let xml;
    try {
      for (;;) {
        if (running) await running;
        const seq = writeSeq;
        xml = await readFile(targetPath, 'utf8');
        if (seq === writeSeq && !running) break;
      }
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        diskXml = null; // whatever we write next must go to disk
        invalidXml = null;
        if (diskState !== 'missing') {
          diskState = 'missing';
          store.emit('external-missing');
        }
      } else {
        log(`local-bpmn: could not read ${path} after it changed on disk: ${err.message}\n`);
      }
      return;
    }
    // Content we believe is on disk (last read, or our own completed / in-flight write): not external.
    if (xml === diskXml || xml === inFlightXml) {
      diskXml = xml;
      setDiskOk();
      return;
    }
    if (!isCompleteBpmn(xml)) {
      diskXml = null; // the file is not what we last wrote or read; our next write must replace it
      if (diskState !== 'invalid' || xml !== invalidXml) {
        diskState = 'invalid';
        invalidXml = xml;
        store.emit('external-invalid', {
          message: looksLikeBpmn(xml)
            ? 'The file is incomplete (no closing definitions tag)'
            : 'The file is not BPMN XML (no bpmn:definitions element)',
        });
      }
      return;
    }
    diskXml = xml;
    // The external change reached us after our pending (not yet started) write: it wins.
    if (dropPendingWrite()) {
      log(`local-bpmn: warning: ${path} changed on disk; a pending save from the editor was discarded\n`);
    }
    setDiskOk();
    store.emit('external-change', { xml });
  }

  /** Runs disk checks one at a time; a request during a check runs one more afterwards. */
  function runCheck() {
    settleTimer = null;
    if (checking) {
      recheck = true;
      return;
    }
    checking = (async () => {
      do {
        recheck = false;
        try {
          await checkDisk();
        } catch (err) {
          log(`local-bpmn: error while checking ${path}: ${err.message}\n`);
        }
      } while (recheck && watcher);
    })().finally(() => { checking = null; });
  }

  function onFsEvent() {
    if (!watcher) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(runCheck, settleMs);
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

    /** State of the file on disk as last observed by the watcher: 'ok' | 'missing' | 'invalid'. */
    get diskState() { return diskState; },

    /**
     * Starts watching the file for changes made by other programs; resolves once the watcher is
     * ready. Watches the parent directory so atomic saves (temp file + rename) and delete/recreate
     * are seen. Call read() first (it resolves symlinks). Safe to call twice.
     */
    async watch() {
      if (watcher) return;
      const dir = dirname(targetPath);
      const name = basename(targetPath);
      watcher = chokidarWatch(dir, {
        depth: 0,
        ignoreInitial: true,
        // Only the target itself (and the directory, which chokidar must not skip).
        ignored: (p) => {
          if (p === dir) return false;
          const entry = basename(p);
          return entry !== name || TEMP_FILE_RE.test(entry);
        },
      });
      watcher.on('all', (event) => {
        if (event === 'add' || event === 'change' || event === 'unlink') onFsEvent();
      });
      watcher.on('error', (err) => log(`local-bpmn: file watcher error: ${err.message}\n`));
      const current = watcher;
      await new Promise((resolveReady) => current.once('ready', resolveReady));
    },

    /** Stops watching (closes the watcher, cancels a scheduled check, waits for a running one). */
    async unwatch() {
      const current = watcher;
      watcher = null;
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (current) await current.close();
      if (checking) await checking;
    },

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
