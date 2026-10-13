// File access for the edited .bpmn file: reading/validation, debounced atomic writes, and watching
// for changes made on disk by other programs (IDE saves, git checkout, ...).
import { watch as chokidarWatch } from 'chokidar';
import { createHash, randomBytes } from 'node:crypto';
import { fstatSync, linkSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { containsChanges, looksStale } from './elements.js';

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

// Telling a save made from an older copy from one that has our changes: element-level comparison.
export { containsChanges, looksStale } from './elements.js';

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

/** sameStat, where null means "missing": two missing files are the same too. */
function sameOrBothMissing(a, b) {
  return (a === null && b === null) || sameStat(a, b);
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
 * ('kept-aside'). A write that replaced a missing or invalid file is only 'saved' once the file has
 * kept it for `confirmMs` (another program may be finishing a slow save from its own copy); a valid
 * save arriving before that is reported as replacing it (`discarded: true`) too. So is a save that
 * the other program finishes through a file descriptor it opened before our write: its bytes go to
 * the file we replaced (renamed over), so that file is kept open and watched while our write is
 * unconfirmed, and a complete document there is put back in place and reported like a save on disk
 * (see watchReplaced).
 *
 * Events: 'written' ({ xml, hash, mtimeMs, size }), 'write-error' (Error),
 *   'saved' ({ xml }) `xml` is on disk now (written, or already there) and confirmed,
 *   'external-change' ({ xml, discarded?, stale? }) valid new content on disk; `discarded: true` if
 *     a pending or unconfirmed write of ours was dropped or replaced because of it; `stale: true` if
 *     it looks made from a copy older than our recent writes ('kept-aside' with reason 'stale'
 *     follows),
 *   'kept-aside' ({ path, xml, reason? }) a version of ours was saved next to the file, at `path`
 *     (e.g. during flush() the file had changed on disk: it was left alone and the content we were
 *     about to write was saved there instead); reason 'stale': a save from an older copy replaced
 *     our last write shortly after it (see inspectDisk),
 *   'external-missing' the file was deleted (emitted once until it reappears),
 *   'external-invalid' ({ message }) the file is not (or not yet) a complete BPMN document,
 *   'disk-ok' the file is valid again after 'external-missing' / 'external-invalid'.
 */
/** How often the files replaced by an unconfirmed write are polled (see watchReplaced). */
const REPLACED_POLL_MS = 50;
/** A save from an older copy this soon after our last write is reported (see inspectDisk). */
const STALE_SAVE_MS = 5000;
/** How many earlier writes of a chain are kept to recognise a copy from between them (see inspectDisk). */
const MAX_CHAIN_WRITES = 20;
/** At shutdown, a replaced file someone writes to counts as finished after this long without a change. */
const REPLACED_QUIET_MS = 50;
/** At shutdown, a file replaced less than this long ago is watched until then (its writer may be slow to start). */
const REPLACED_WATCH_MS = 300;

export function createFileStore(path, { debounceMs = 250, settleMs = 150, confirmMs = 2000, log = defaultLog } = {}) {
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
  let provisional = null;    // { xml, timer } our writes over a missing/invalid file, not confirmed yet
  let checkedStat = null;    // stat seen by the last externalContent() (null: missing)
  let lastWriteAt = null;    // when our last write was renamed in (see flush)
  let flushQueue = Promise.resolve(); // flush() calls run one after the other
  let postCheckedFor = null; // lastWriteAt of the write flush() last looked after
  let staleCheckedFor = null; // lastWriteAt of the write a stale save was last reported for
  let finalFlush = false;    // flush({ final: true }) is running (see writeOne)
  let brokenAt = null;       // when the file was last seen newly missing or newly broken (see flush)
  // Our recent writes (each less than STALE_SAVE_MS after the one before, no change from another
  // program in between) form a chain; chainBase is the disk version before its first write (null:
  // unknown, e.g. that write replaced a broken or missing file). A save from an older copy is judged
  // against everything the chain changed (see inspectDisk, flushOnce).
  let chainBase = null;
  let chainWrites = []; // the chain's writes before the last one, oldest first (the most recent MAX_CHAIN_WRITES)
  let chainOpen = false;
  let adopting = null;       // complete save found in a file we replaced, to put back (adoptReplaced)
  let replacedTimer = null;  // polls the files we replaced while unconfirmed (see watchReplaced)

  /** The file's stat right now (synchronously), or null if it is missing. */
  function currentStat() {
    try {
      return statKey(statSync(targetPath));
    } catch {
      return null;
    }
  }
  let unclaimedXml = null;   // write checkNow() dropped for a change on disk; saved aside by flush()
                             // unless new content is written meanwhile (the edits were re-applied)

  /**
   * Content another program wrote over what we last read or wrote, or null if the file still holds
   * diskXml. If the file was missing or invalid when last seen (diskXml null), a file that is still
   * missing, or still holds exactly the invalid content reported, is replaced by our write.
   */
  async function externalContent() {
    let info;
    let xml;
    checkedStat = null;
    try {
      info = statKey(await stat(targetPath));
      checkedStat = info;
      if (diskXml !== null && sameStat(info, diskStat)) return null;
      xml = await readFile(targetPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; // deleted: recreated by the write
      throw err;
    }
    if (diskXml === null) {
      // The file was missing or invalid when last seen: replacing it is fine while it still is
      // exactly that (the broken content reported after it settled), but a complete document saved
      // there since is a change like any other, and anything else means another program is still
      // writing it (e.g. truncated, not yet rewritten): wait until it settles.
      return diskState === 'invalid' && xml === invalidXml ? null : xml;
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
  async function writeAtomically(xml, { linkBroken = false } = {}) {
    const dir = dirname(targetPath);
    const tmp = join(dir, `.${basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    let mode;
    try {
      mode = (await stat(targetPath)).mode & 0o7777;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    let old = null;
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
      // The file we are about to replace, kept open: a program that opened it for writing before our
      // rename writes there (see watchReplaced).
      old = await open(targetPath, 'r').catch(() => null);
      let external = await externalContent();
      // Narrow the gap to the rename: if the file changed while it was being checked (read), check
      // again (a synchronous stat, so nothing else runs between it and starting the rename).
      for (let i = 0; i < 3 && external === null && !sameOrBothMissing(currentStat(), checkedStat); i++) {
        external = await externalContent();
      }
      if (external !== null) {
        await unlink(tmp).catch(() => {});
        await old?.close().catch(() => {});
        return { external };
      }
      // Only the file that was checked, not one that took its place meanwhile.
      const same = old !== null && checkedStat !== null && statKey(fstatSync(old.fd)).ino === checkedStat.ino;
      // Replacing a broken file: keep it reachable under another name until our write is confirmed.
      const link = same && linkBroken ? linkReplaced(checkedStat.ino) : null;
      // Synchronous, right after the synchronous re-stat: nothing of ours runs in between, which keeps
      // the window for another program's save between the last check and the rename minimal.
      try {
        renameSync(tmp, targetPath);
      } catch (err) {
        removeLink({ link });
        throw err;
      }
      let replaced = null;
      if (same) {
        // Written to since it was checked (e.g. truncated by an in-place save just before the rename,
        // whose content then goes there): watched like a broken file we replaced, and our write is
        // not confirmed meanwhile (see writeOne).
        const info = statKey(fstatSync(old.fd));
        const changed = !sameStat(info, checkedStat);
        const now = Date.now();
        replaced = {
          handle: old, key: info, changed, changedAt: changed ? now : null, lastChange: changed ? now : null, replacedAt: now, link,
        };
      } else {
        old?.close().catch(() => {});
      }
      old = null;
      return { stat: written, replaced, missing: checkedStat === null };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      await old?.close().catch(() => {});
      throw err;
    }
  }

  /** Saves `xml` next to the file as <name>.local-bpmn-unsaved-<time>.bpmn; resolves to its path. */
  /** `<name>.local-bpmn-<kind>-<time>[-n].bpmn` next to the file, for attempt `n` (1, 2, …). */
  function asideName(kind, n) {
    const ext = extname(path);
    const stem = basename(path, ext === '.bpmn' ? ext : '');
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const time = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
      + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return join(dirname(path), `${stem}.local-bpmn-${kind}-${time}${n > 1 ? `-${n}` : ''}.bpmn`);
  }

  /**
   * Gives the broken file we are about to replace a second name (a hard link), so that what another
   * program still writes into it through a descriptor it has open stays reachable after we exit (see
   * flushOnce). Removed again once our write is confirmed or that save was put back. Synchronous:
   * called right before the rename. Returns the link's path, or null (no link: e.g. not supported).
   */
  function linkReplaced(ino) {
    for (let n = 1; n <= 100; n++) {
      const link = asideName('replaced', n);
      try {
        linkSync(targetPath, link);
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        return null;
      }
      try {
        if (statSync(link).ino === ino) return link;
      } catch {
        // fall through
      }
      try {
        unlinkSync(link); // the file changed in between: not the one we checked
      } catch {
        // already gone
      }
      return null;
    }
    return null;
  }

  function removeLink(file) {
    if (!file.link) return;
    try {
      unlinkSync(file.link);
    } catch {
      // already gone
    }
    file.link = null;
  }

  async function saveAside(xml) {
    for (let n = 1; ; n++) {
      const aside = asideName('unsaved', n);
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
  async function keepAside(xml, {
    unconfirmed = false, since = null, other = false, kind = 'broken', overwritten = false, busy = false,
    leftAlone = false, stale = false,
  } = {}) {
    let aside;
    try {
      aside = await saveAside(xml);
    } catch (err) {
      log(other
        ? `local-bpmn: warning: another program's save of ${path} could not be kept (${err.message})\n`
        : `local-bpmn: warning: ${path} changed on disk, but the editor's version could not be saved next to it `
          + `(${err.message})${unconfirmed ? '' : '; writing it to the file instead'}\n`);
      return false;
    }
    if (other) {
      log(`local-bpmn: warning: another program finished saving ${path} into the broken file the editor had `
        + `replaced, while the file changed again; that save was saved to ${aside}\n`);
    } else if (stale) {
      log(`local-bpmn: warning: ${path} was saved on disk from a copy without the editor's last changes; `
        + `the file keeps that save, the editor's version was saved to ${aside}\n`);
    } else if (leftAlone) {
      log(`local-bpmn: warning: another program is rewriting ${path} (it was ${diskState === 'missing' ? 'deleted' : 'broken'} `
        + `just now); local-bpmn left it alone and saved the editor's version to ${aside}\n`);
    } else if (busy) {
      log(`local-bpmn: warning: another program was still writing ${path} when local-bpmn stopped, after `
        + `the editor's last save; the editor's version was saved to ${aside}\n`);
    } else if (overwritten) {
      log(`local-bpmn: warning: another program saved ${path} right after the editor's last save, from a copy `
        + `without the editor's last changes; the file keeps that save, the editor's version was saved to ${aside}\n`);
    } else if (unconfirmed && kind === 'raced') {
      log(`local-bpmn: warning: another program was writing ${path} while the editor replaced it; `
        + `the editor's version was also saved to ${aside}\n`);
    } else if (unconfirmed) {
      const ago = since === null ? '' : ` ${((Date.now() - since) / 1000).toFixed(1)} s ago`;
      const what = kind === 'recreated' ? `recreated the deleted ${basename(path)}` : `replaced the broken ${basename(path)}`;
      log(`local-bpmn: warning: the editor ${what}${ago}; `
        + `its version was also saved to ${aside} (in case another program finishes an older save)\n`);
    } else {
      log(`local-bpmn: warning: ${path} changed on disk while the editor's last changes were being saved; `
        + `the file keeps the version on disk, the editor's version was saved to ${aside}\n`);
    }
    store.emit('kept-aside', { path: aside, xml, ...(stale ? { reason: 'stale' } : {}) });
    return true;
  }

  /**
   * Our write replaced a missing or invalid file: another program may be in the middle of saving it
   * (e.g. a slow, non-atomic IDE save) and finish from its own copy. Until the file has kept our
   * content for `confirmMs`, what we wrote counts as not saved: a valid save arriving meanwhile is
   * reported as replacing it (`discarded`), so its edits are re-applied on top (Q2).
   */
  function confirmLater(xml, replaced = null, { kind = 'broken' } = {}) {
    const since = provisional?.since ?? Date.now();
    const files = provisional?.replaced ?? [];
    // Why it is unconfirmed (for the shutdown warning): 'broken' (replaced an invalid file),
    // 'recreated' (the file was missing), 'raced' (another program wrote to the file we replaced).
    const why = provisional && provisional.kind !== kind ? 'broken' : kind;
    if (provisional) clearTimeout(provisional.timer);
    const timer = setTimeout(confirmProvisional, confirmMs);
    timer.unref?.();
    if (replaced) files.push(replaced);
    provisional = { xml, timer, since, replaced: files, kind: why };
    if (files.length) watchReplaced();
  }

  /**
   * While a write over a broken file is unconfirmed, the file it replaced (kept open) is polled. A
   * program that opened it before our rename and is still writing (a slow save in place through one
   * file descriptor) writes there, not to the file at the path. Once such a file has changed and then
   * settled (`settleMs` without a change) with a complete document in it, that document is put back
   * in place (adoptReplaced).
   */
  function watchReplaced() {
    if (replacedTimer) return;
    replacedTimer = setInterval(() => {
      checkReplaced().catch((err) => log(`local-bpmn: error while checking ${path}: ${err.message}\n`));
    }, REPLACED_POLL_MS);
    replacedTimer.unref?.();
  }

  /**
   * Closes the given replaced files (and removes their second names, unless kept). Polling stops once
   * the unconfirmed write has no replaced file left to watch (not for another write's files).
   */
  function stopWatchingReplaced(entry) {
    for (const file of entry?.replaced ?? []) {
      file.handle.close().catch(() => {});
      if (!file.keepLink) removeLink(file);
    }
    if (entry) entry.replaced = [];
    if (!provisional || provisional === entry || !provisional.replaced.length) {
      clearInterval(replacedTimer);
      replacedTimer = null;
    }
  }

  /**
   * Waits (at most `maxMs`) until the replaced files that changed have been left alone for `quietMs`
   * (for flush(): a save into them that is under way gets the time to finish).
   */
  async function settleReplaced(maxMs, quietMs) {
    const end = Date.now() + maxMs;
    while (provisional && Date.now() < end) {
      let busy = false;
      for (const file of provisional.replaced) {
        try {
          const info = statKey(fstatSync(file.handle.fd));
          if (!sameStat(info, file.key)) {
            file.key = info;
            file.changed = true;
            file.changedAt = Date.now();
            file.lastChange = file.changedAt;
          }
        } catch {
          continue; // closed meanwhile
        }
        if (file.changedAt !== null && Date.now() - file.changedAt < quietMs) busy = true;
        if (Date.now() - file.replacedAt < REPLACED_WATCH_MS) busy = true; // it may not have begun yet
      }
      if (!busy) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  /**
   * For flush(): the file's content once it holds our last write, or a complete document that has not
   * changed for REPLACED_QUIET_MS (another program's save), or `deadline` passed. `settled` is false
   * if it was still changing or not complete BPMN at the deadline.
   */
  async function settledContent(deadline) {
    let previous;
    let since = Date.now();
    for (;;) {
      const xml = await readFile(targetPath, 'utf8').catch(() => null);
      if (xml !== previous) {
        previous = xml;
        since = Date.now();
      }
      if (xml === lastWrite?.xml) return { xml, settled: true };
      const complete = xml !== null && isCompleteBpmn(xml);
      if (complete && Date.now() - since >= REPLACED_QUIET_MS) return { xml, settled: true };
      if (Date.now() >= deadline) return { xml, settled: false };
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  /** Reads a whole file through its handle, from the start. */
  async function readHandle(handle) {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  }

  /**
   * One poll of the replaced files (see watchReplaced). `now` (shutdown): read a changed file right
   * away instead of waiting for it to settle. Resolves once a save found there is being put back.
   */
  async function checkReplaced({ now = false } = {}) {
    const entry = provisional;
    if (!entry?.replaced.length || adopting !== null) return;
    for (const file of entry.replaced) {
      let info;
      try {
        info = statKey(fstatSync(file.handle.fd));
      } catch {
        continue; // closed meanwhile
      }
      if (!sameStat(info, file.key)) {
        file.key = info;
        file.changed = true;
        file.changedAt = Date.now();
        file.lastChange = file.changedAt;
        if (!now) continue;
      }
      if (file.changedAt === null || (!now && Date.now() - file.changedAt < settleMs)) continue;
      file.changedAt = null;
      const xml = await readHandle(file.handle).catch(() => null);
      if (provisional !== entry || adopting !== null) return;
      if (xml !== null && isCompleteBpmn(xml) && xml !== entry.xml) {
        adopting = xml;
        await kick();
        return;
      }
    }
  }

  /**
   * Another program finished its save in the file we had replaced (see watchReplaced). That save was
   * meant for the file, so it is put there: like a save on disk landing on our unconfirmed write, the
   * windows re-apply their edits on top of it ('external-change', discarded). During flush() nobody
   * can any more: the file keeps that save and our version is kept aside.
   */
  async function adoptReplaced(xml) {
    const entry = provisional;
    const pending = pendingXml;
    writeSeq += 1;
    inFlightXml = xml;
    let result = null;
    try {
      result = await writeAtomically(xml);
    } catch (err) {
      log(`local-bpmn: warning: could not put back the save another program made to ${path} (${err.message})\n`);
    } finally {
      inFlightXml = null;
    }
    if (!result || result.external !== undefined) {
      // The file changed yet again (that change is reported on its own): keep this save too.
      await keepAside(xml, { other: true });
      stopWatchingReplaced(entry);
      return;
    }
    const unconfirmed = dropProvisional();
    const ours = pending ?? unconfirmed;
    dropPendingWrite();
    diskXml = xml;
    diskStat = result.stat;
    lastWrite = { xml, hash: sha256(xml), mtimeMs: result.stat.mtimeMs, size: result.stat.size };
    blockedByDisk = false;
    chainOpen = false; // another program's save: our next write starts a new chain
    log(`local-bpmn: warning: another program finished saving ${path} after the editor had replaced the `
      + 'half-written file; its save was put back in place\n');
    store.emit('written', lastWrite);
    setDiskOk();
    if (flushing) {
      if (ours !== null) await keepAside(ours);
      return;
    }
    if (checkingNow && ours !== null) unclaimedXml = ours;
    store.emit('external-change', { xml, discarded: true });
  }

  async function confirmProvisional() {
    const entry = provisional;
    entry.timer = null;
    // A file we replaced is still being written to (see watchReplaced): confirm only once it has been
    // left alone for confirmMs (its save, once complete, is put back instead).
    const lastChange = Math.max(0, ...entry.replaced.map((f) => f.lastChange ?? 0));
    if (adopting !== null || Date.now() - lastChange < confirmMs) {
      entry.timer = setTimeout(confirmProvisional, Math.max(settleMs, lastChange + confirmMs - Date.now()));
      entry.timer.unref?.();
      return;
    }
    entry.confirming = true;
    // Only once the file really holds our content (read it: a save that just landed may not have
    // been reported yet). Otherwise our write stays unconfirmed until that save is reported
    // (re-applied on top), or flush() keeps it aside.
    const current = await readFile(targetPath, 'utf8').catch(() => null);
    entry.confirming = false;
    if (provisional !== entry || adopting !== null) return; // superseded meanwhile
    if (current !== entry.xml || entry.xml !== diskXml) {
      if (current !== entry.xml && watcher && !settleTimer) settleTimer = setTimeout(runCheck, settleMs);
      // We believe the file holds our latest write: the read probably raced one of our own writes
      // (it returned the content before it). Look again shortly, or the write would stay
      // unconfirmed for good. (If another program changed the file, its check ends this state.)
      if (current !== entry.xml && entry.xml === diskXml) {
        entry.timer = setTimeout(confirmProvisional, settleMs);
        entry.timer.unref?.();
      }
      return;
    }
    provisional = null;
    stopWatchingReplaced(entry);
    store.emit('saved', { xml: entry.xml });
  }

  /** Ends the unconfirmed state (see confirmLater); returns the unconfirmed content, or null. */
  function dropProvisional() {
    if (!provisional) return null;
    clearTimeout(provisional.timer);
    stopWatchingReplaced(provisional);
    const { xml } = provisional;
    provisional = null;
    return xml;
  }

  async function writeOne(xml) {
    if (xml === diskXml) {
      if (provisional) provisional.xml = xml;
      else store.emit('saved', { xml });
      return;
    }
    // Shutdown while another program is rewriting the file (it became broken or disappeared less than
    // confirmMs ago, e.g. a slow in-place save half done, or a save that moved the file away first):
    // replacing it now would send the rest of that save into a file nobody sees after we exit, or
    // have it replace ours unnoticed. Leave the file to that program; ours is kept aside.
    if (finalFlush && diskXml === null && diskState !== 'ok' && brokenAt !== null && Date.now() - brokenAt < confirmMs) {
      if (await keepAside(xml, { leftAlone: true })) return;
    }
    writeSeq += 1;
    inFlightXml = xml;
    const before = diskXml;
    try {
      const replacesUnknown = diskXml === null; // the file was missing or invalid
      const result = await writeAtomically(xml, { linkBroken: replacesUnknown });
      if (result.external !== undefined) {
        await onBlockedWrite(xml, result.external);
        return;
      }
      diskXml = xml;
      diskStat = result.stat;
      const previousXml = lastWrite?.xml;
      lastWrite = { xml, hash: sha256(xml), mtimeMs: result.stat.mtimeMs, size: result.stat.size };
      const previousWriteAt = lastWriteAt;
      lastWriteAt = Date.now();
      if (!chainOpen || previousWriteAt === null || lastWriteAt - previousWriteAt >= STALE_SAVE_MS) {
        chainBase = replacesUnknown || result.missing ? null : before;
        chainWrites = [];
        chainOpen = true;
      } else {
        if (previousXml !== undefined) chainWrites.push(previousXml);
        if (chainWrites.length > MAX_CHAIN_WRITES) chainWrites.shift();
        if (replacesUnknown || result.missing) chainBase = null;
      }
      store.emit('written', lastWrite);
      const raced = result.replaced?.changed === true; // see writeAtomically
      // The file was gone when checked (deleted, or moved away by a save that writes a new file next):
      // like a broken file, the program that removed it may be about to write its own copy.
      const recreated = result.missing === true;
      if (!replacesUnknown && !raced && result.replaced) {
        // Not watched (a normal write): close only this write's handle.
        result.replaced.handle.close().catch(() => {});
        removeLink(result.replaced);
      }
      if (replacesUnknown || raced || recreated) {
        confirmLater(xml, result.replaced, { kind: recreated ? 'recreated' : raced ? 'raced' : 'broken' });
      }
      // Still unconfirmed, like the write before it. The wait is not restarted: under continuous
      // editing it would never end (and every Ctrl-C would keep a copy aside).
      else if (provisional) provisional.xml = xml;
      else store.emit('saved', { xml });
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
    if (!running && (adopting !== null || (ready && pendingXml !== null))) {
      running = (async () => {
        while (adopting !== null || (ready && pendingXml !== null)) {
          if (adopting !== null) {
            try {
              await adoptReplaced(adopting);
            } finally {
              adopting = null;
            }
            continue;
          }
          const xml = pendingXml;
          pendingXml = null;
          await writeOne(xml);
        }
      })().finally(() => {
        running = null;
        if (adopting !== null) kick(); // found while the loop was ending
      });
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
        if (provisional) confirmLater(provisional.xml); // another program is still at it: wait longer
        if (diskState !== 'missing') {
          brokenAt = Date.now(); // newly gone
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
      if (provisional) confirmLater(provisional.xml); // another program is still at it: wait longer
      if (diskState !== 'invalid' || xml !== invalidXml) {
        brokenAt = Date.now(); // newly broken (or broken differently: still being written)
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
    const was = diskXml;
    diskXml = xml;
    diskStat = info;
    // The external change reached us before our pending (not yet started or held back) write: the
    // change on disk is the newer base; the session has that write's edits re-applied on top of it.
    // So has an unconfirmed write over a missing or invalid file (see confirmLater).
    const pending = pendingXml;
    const unconfirmed = dropProvisional();
    const discarded = dropPendingWrite() || unconfirmed !== null;
    if (discarded && checkingNow) unclaimedXml = pending ?? unconfirmed;
    blockedByDisk = false;
    setDiskOk();
    // A save from a copy older than our recent writes, shortly after them (an editor that read the
    // file before them and saves without reloading): it replaces the edits in those writes, which the
    // windows will not re-apply (they were written). Whether or not it also replaced a pending
    // write (whose edits the windows do re-apply), it is still taken as the newer version (it may be
    // deliberate, e.g. a revert), but our latest version (written or pending) is kept next to the
    // file and the windows are told: 'stale' on the change, then 'kept-aside' (reason 'stale').
    const ours = lastWrite?.xml;
    const stale = ours !== undefined && lastWriteAt !== null && staleCheckedFor !== lastWriteAt
      && Date.now() - lastWriteAt < STALE_SAVE_MS && (was === ours || was === null) && xml !== ours
      && looksStale(xml, chainBase, ours, chainWrites);
    if (stale) staleCheckedFor = lastWriteAt;
    chainOpen = false; // a change by another program: our next write starts a new chain
    store.emit('external-change', { xml, ...(discarded ? { discarded: true } : {}), ...(stale ? { stale: true } : {}) });
    if (stale && !flushing) {
      const saving = keepAside(discarded && pending !== null ? pending : ours, { stale: true })
        .finally(() => savingAside.delete(saving));
      savingAside.add(saving);
    }
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

  /** One flush (see flush()). */
  async function flushOnce({ final = false } = {}) {
    flushing += 1;
    if (final) finalFlush = true;
    try {
      // A save finished in a file our unconfirmed write replaced (see watchReplaced): the file keeps
      // that save, our version is kept aside (adoptReplaced, run by the loop below).
      await checkReplaced({ now: true });
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
        if (!active) break;
        await active;
      }
      // Another program may be writing to a file we replaced just now (an in-place save that began
      // before our rename, e.g. one that truncated the file and made it look broken): give it a
      // moment to finish (at most 1 s), then put its save back in place.
      if (provisional?.replaced.length) {
        await settleReplaced(1000, REPLACED_QUIET_MS);
        await checkReplaced({ now: true });
        while (running) await running;
      }
      // A write over a broken file that is still unconfirmed (see confirmLater): the program that
      // was saving it may finish after we exit, from a copy without these edits. Keep a copy aside
      // whether or not the file holds it right now (Q2: never lose it silently; no shutdown delay).
      if (provisional) {
        const current = await readFile(targetPath, 'utf8').catch(() => null);
        const { since, kind } = provisional;
        // The broken files our unconfirmed write replaced keep their second name: a program still
        // writing into one through its descriptor finishes its save there after we exit.
        const kept = provisional.replaced.filter((file) => file.link);
        for (const file of kept) file.keepLink = true;
        const unconfirmed = dropProvisional();
        await keepAside(unconfirmed, { unconfirmed: current === unconfirmed, since, kind });
        for (const file of kept) {
          log(`local-bpmn: warning: the half-written ${basename(path)} the editor replaced was kept as ${file.link}; `
            + 'if the program that was writing it finishes its save after local-bpmn stopped, that save ends up there\n');
        }
      } else if (lastWrite !== null && lastWriteAt !== null && postCheckedFor !== lastWriteAt
        && (Date.now() - lastWriteAt < REPLACED_WATCH_MS
        || (brokenAt !== null && brokenAt > lastWriteAt && Date.now() - brokenAt < confirmMs))) {
        postCheckedFor = lastWriteAt; // once per write (a second flush does not keep it aside again)
        // We have just written (the last edits), or another program has been rewriting the file
        // since our last write (it was seen broken or gone just now): a save from that program's
        // own copy may replace ours right after. Look once more before exiting (the file left alone
        // for a moment, at most 1 s); if it then holds content that lacks what our write changed,
        // or is still being written, the file keeps it and ours is kept aside.
        await new Promise((resolveWait) => setTimeout(resolveWait, lastWriteAt + REPLACED_WATCH_MS - Date.now()));
        const ours = lastWrite.xml;
        const { xml: current, settled } = await settledContent(Math.max(lastWriteAt + REPLACED_WATCH_MS, Date.now()) + 1000);
        if (current !== ours && (diskXml === ours || diskXml === null)) { // null: seen broken or gone since
          if (!settled) await keepAside(ours, { busy: true });
          else if (!containsChanges(current, chainBase, ours)) await keepAside(ours, { overwritten: true });
        }
      }
    } finally {
      flushing -= 1;
      if (final) finalFlush = false;
    }
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
     * nothing was written since (nobody re-applied the edits on it). `final` (the last flush before
     * exit): a file another program is rewriting right now (broken or gone less than confirmMs ago)
     * is left to it, and the pending content is kept aside (see writeOne).
     */
    flush(options) {
      // One at a time: a second call (e.g. a second Ctrl-C) waits for the one running, including its
      // last look at the file, then has nothing left to do (no duplicate side files).
      const run = flushQueue.then(() => flushOnce(options));
      flushQueue = run.catch(() => {});
      return run;
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
        await checkReplaced({ now: true }); // a save finished in a file we replaced (see watchReplaced)
        while (running) await running;
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
