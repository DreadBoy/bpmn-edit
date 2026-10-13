// File access for the edited .bpmn file: reading/validation, debounced atomic writes, and watching
// for changes made on disk by other programs (IDE saves, git checkout, ...).
import { watch as chokidarWatch } from 'chokidar';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

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

/** The parts of a stat result that change whenever a program writes or replaces a file. */
function statKey(info) {
  return { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}

function sameStat(a, b) {
  return a !== null && b !== null && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
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
 * Never writes over a change it has not seen (Q2 in docs/decisions.md): right before a write
 * replaces the file, the file is checked (stat as a cheap pre-check, then the content) against what
 * we last read or wrote. If another program changed it, the write is held back and the change is
 * reported like any other ('external-change', with `discarded: true` as the pending write is
 * dropped: the session has those edits re-applied on top of it). During flush() (shutdown) nobody
 * can re-apply them any more: the file keeps the version on disk and ours is saved next to it
 * ('kept-aside').
 *
 * Events: 'written' ({ xml, hash, mtimeMs, size }), 'write-error' (Error),
 *   'saved' ({ xml }) `xml` is on disk now (written, or already there),
 *   'external-change' ({ xml, discarded? }) valid new content on disk; `discarded: true` if a
 *     pending write of ours was dropped because of it,
 *   'kept-aside' ({ path, xml }) during flush() the file had changed on disk: it was left alone and
 *     the content we were about to write was saved to `path` instead,
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
  let diskStat = null;       // { ino, size, mtimeMs } of the file holding diskXml (cheap change check)
  let blockedByDisk = false; // a write was held back because the file changed on disk (see checkDisk)
  let flushing = 0;          // flush() calls running: a change on disk then keeps both versions
  let checkingNow = false;   // checkNow() is running (shutdown)
  const savingAside = new Set(); // keepAside() calls still running (flush() waits for them)
  let unclaimedXml = null;   // write checkNow() dropped for a change on disk; saved aside by flush()
                             // unless new content is written meanwhile (the edits were re-applied)

  /**
   * Content another program wrote over what we last read or wrote, or null if the file still holds
   * diskXml. If the file was missing or invalid when last seen (diskXml null), only complete BPMN
   * counts as a change: a file that is still missing or invalid is replaced by our write.
   */
  async function externalContent() {
    let info;
    let xml;
    try {
      info = statKey(await stat(targetPath));
      if (diskXml !== null && sameStat(info, diskStat)) return null;
      xml = await readFile(targetPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; // deleted: recreated by the write
      throw err;
    }
    if (diskXml === null) {
      // The file was missing or invalid when last seen: replacing it is fine while it still is, but
      // a complete document saved there since is a change like any other.
      return isCompleteBpmn(xml) ? xml : null;
    }
    if (xml === diskXml) {
      diskStat = info; // e.g. touched, or rewritten with the same content
      return null;
    }
    return xml;
  }

  /**
   * Writes `xml` to a temp file and renames it over the target, unless the target was changed by
   * another program (checked right before the rename). Resolves to { stat } when written, else
   * { external } (the content found on disk).
   */
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
      let written;
      const handle = await open(tmp, 'wx', mode ?? 0o644);
      try {
        await handle.writeFile(xml, 'utf8');
        if (mode !== undefined) await handle.chmod(mode); // the open() mode is subject to umask
        await handle.sync();
        written = statKey(await handle.stat()); // inode, size and mtime are kept by the rename
      } finally {
        await handle.close();
      }
      const external = await externalContent();
      if (external !== null) {
        await unlink(tmp).catch(() => {});
        return { external };
      }
      await rename(tmp, targetPath);
      return { stat: written };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Saves `xml` next to the file as <name>.local-bpmn-unsaved-<time>.bpmn; resolves to its path. */
  async function saveAside(xml) {
    const ext = extname(path);
    const stem = basename(path, ext === '.bpmn' ? ext : '');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
      + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    for (let n = 1; ; n++) {
      const aside = join(dirname(path), `${stem}.local-bpmn-unsaved-${time}${n > 1 ? `-${n}` : ''}.bpmn`);
      try {
        const handle = await open(aside, 'wx', 0o644);
        try {
          await handle.writeFile(xml, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return aside;
      } catch (err) {
        if (err.code !== 'EEXIST' || n >= 100) throw err;
      }
    }
  }

  /**
   * A write of `xml` found the file changed by another program (`external`). Normally the write
   * waits and the change is reported (checkDisk), and the session has the edits re-applied on top
   * of it. During flush() there is no time for that: the file keeps its content and `xml` is saved
   * aside, so neither version is lost.
   */
  async function onBlockedWrite(xml, external) {
    if (pendingXml === null) pendingXml = xml;
    if (!flushing) {
      ready = false;
      blockedByDisk = true;
      // Report the change after the usual settle delay (the other program may still be writing).
      if (checking) recheck = true;
      else if (!settleTimer) settleTimer = setTimeout(runCheck, settleMs);
      return;
    }
    const content = pendingXml;
    pendingXml = null;
    diskXml = external; // seen now
    diskStat = null;
    if (!(await keepAside(content))) pendingXml = content; // nowhere else to keep it: the retry writes it
  }

  /** Saves `xml` next to the file instead of writing it (see 'kept-aside'); resolves to success. */
  async function keepAside(xml) {
    let aside;
    try {
      aside = await saveAside(xml);
    } catch (err) {
      log(`local-bpmn: warning: ${path} changed on disk, but the editor's version could not be saved next to it `
        + `(${err.message}); writing it to the file instead\n`);
      return false;
    }
    log(`local-bpmn: warning: ${path} changed on disk while the editor's last changes were being saved; `
      + `the file keeps the version on disk, the editor's version was saved to ${aside}\n`);
    store.emit('kept-aside', { path: aside, xml });
    return true;
  }

  async function writeOne(xml) {
    if (xml === diskXml) {
      store.emit('saved', { xml });
      return;
    }
    writeSeq += 1;
    inFlightXml = xml;
    try {
      const result = await writeAtomically(xml);
      if (result.external !== undefined) {
        await onBlockedWrite(xml, result.external);
        return;
      }
      diskXml = xml;
      diskStat = result.stat;
      lastWrite = { xml, hash: sha256(xml), mtimeMs: result.stat.mtimeMs, size: result.stat.size };
      store.emit('written', lastWrite);
      store.emit('saved', { xml });
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

  /** A write held back by a change on disk may go ahead (nothing changed after all, or the file is broken or gone). */
  function unblockWrite() {
    if (!blockedByDisk) return;
    blockedByDisk = false;
    if (pendingXml !== null && !timer) {
      ready = true;
      kick();
    }
  }

  /** Reads the file after it settled and reports what changed (see the 'external-*' events). */
  async function checkDisk() {
    try {
      await inspectDisk();
    } finally {
      unblockWrite();
    }
  }

  async function inspectDisk() {
    // Never judge content read while one of our writes ran: wait for writes, retry if one started.
    let xml;
    let info;
    try {
      for (;;) {
        if (running) await running;
        const seq = writeSeq;
        info = statKey(await stat(targetPath)); // before reading: a change in between is seen later
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
      diskStat = info;
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
    diskStat = info;
    // The external change reached us before our pending (not yet started or held back) write: the
    // change on disk is the newer base; the session has that write's edits re-applied on top of it.
    const pending = pendingXml;
    const discarded = dropPendingWrite();
    if (discarded && checkingNow) unclaimedXml = pending;
    blockedByDisk = false;
    setDiskOk();
    store.emit('external-change', discarded ? { xml, discarded: true } : { xml });
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
      let info = null;
      try {
        info = statKey(await stat(path)); // before reading: a change in between is seen as a change
      } catch {
        // readBpmnFile reports it
      }
      const xml = await readBpmnFile(path);
      try {
        targetPath = await realpath(path);
      } catch {
        targetPath = path;
      }
      diskXml = xml;
      diskStat = info;
      return xml;
    },

    /** Schedules a debounced write of `xml`. */
    write(xml) {
      if (typeof xml !== 'string') throw new TypeError('xml must be a string');
      pendingXml = xml;
      unclaimedXml = null;
      ready = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onTimer, debounceMs);
    },

    /**
     * Writes anything pending right away and waits for all writes to finish. Never rejects. If the
     * file was changed by another program meanwhile, it is left alone and the pending content is
     * saved next to it ('kept-aside'): flush() is for shutdown, when the edits can no longer be
     * re-applied on top of that change. So is a write checkNow() dropped for a change on disk if
     * nothing was written since (nobody re-applied the edits on it).
     */
    async flush() {
      flushing += 1;
      try {
        if (unclaimedXml !== null && pendingXml === null) {
          const xml = unclaimedXml;
          unclaimedXml = null;
          await keepAside(xml);
        }
        await Promise.all(savingAside);
        for (;;) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (pendingXml !== null) ready = true;
          const active = kick();
          if (!active) return;
          await active;
        }
      } finally {
        flushing -= 1;
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

    /**
     * Checks the file for changes made by other programs right away (instead of after the settle
     * delay) and reports them like the watcher does; resolves when done. Used at shutdown, so a
     * change saved just before can still be merged (Q2).
     */
    async checkNow() {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      while (checking) await checking;
      checkingNow = true;
      try {
        runCheck();
        while (checking) await checking;
      } finally {
        checkingNow = false;
      }
    },

    /**
     * Saves `xml` next to the file instead of writing it ('kept-aside', stderr warning); for content
     * a change on disk replaced and nobody can re-apply. Resolves to whether it was saved.
     */
    keepAside(xml) {
      if (unclaimedXml === xml) unclaimedXml = null; // kept now, not again by flush()
      const saving = keepAside(xml).finally(() => savingAside.delete(saving));
      savingAside.add(saving); // flush() waits for it
      return saving;
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
