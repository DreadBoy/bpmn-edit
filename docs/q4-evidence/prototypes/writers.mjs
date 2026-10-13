// Q4 option prototypes (throwaway, not project code; snapshot kept as evidence). Each writer gets
//   disk: the text currently on disk, base: what bpmn-js serialised for the state on disk
//   (saveXML right after import, or the previous update), out: the new bpmn-js serialisation
// and returns the text to write.
import { spawnSync } from 'node:child_process';
import {
  decodeEntities, escapeAttr, facts, diffFacts, parse, pathKey, tokenize, walk,
} from '../../../scripts/q4-xml.mjs';

// ---- (a) accept: write what bpmn-js produced.
export const accept = (disk, base, out) => out;

// ---- helpers
export function detectIndent(text) {
  const sizes = [];
  for (const m of text.matchAll(/\n([ \t]+)</g)) {
    if (m[1].includes('\t')) return '\t';
    sizes.push(m[1].length);
  }
  if (!sizes.length) return '  ';
  return ' '.repeat(Math.min(...sizes));
}
const eolOf = (text) => ((text.match(/\r\n/g) || []).length > (text.match(/(^|[^\r])\n/g) || []).length / 2 ? '\r\n' : '\n');

/** Re-indents whitespace-only text between tags from bpmn-js' 2 spaces per level to `unit`. */
function reindent(xml, unit) {
  if (unit === '  ') return xml;
  const tokens = tokenize(xml);
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const raw = xml.slice(t.start, t.end);
    if (t.type === 'text' && /^\s*$/.test(raw) && raw.includes('\n') && tokens[k + 1] && tokens[k + 1].type !== 'text') {
      out += raw.replace(/\n( *)/g, (m, sp) => `\n${unit.repeat(Math.floor(sp.length / 2))}${' '.repeat(sp.length % 2)}`);
    } else out += raw;
  }
  return out;
}

// ---- (b) keep the original prolog (XML declaration, comments, PIs, DOCTYPE before the root), the
// original root start tag if it declares the same attributes and namespaces, indentation unit,
// line endings and the trailing newline (or its absence).
export function preserveHeaderAndStyle(disk, base, out) {
  const D = parse(disk);
  const N = parse(out);
  const attrSet = (tok) => tok.attrs.map((a) => `${a.name}=${decodeEntities(a.raw)}`).sort().join('\n');
  const rootTag = attrSet(D.root.token) === attrSet(N.root.token)
    ? disk.slice(D.root.token.start, D.root.token.end)
    : out.slice(N.root.token.start, N.root.token.end);
  const prolog = disk.slice(0, D.root.token.start);
  let body = reindent(out.slice(N.root.token.start), detectIndent(disk));
  const tagStart = parse(body).root.token;
  body = rootTag + body.slice(tagStart.end);
  let text = prolog + body.replace(/\s+$/, '');
  const eol = eolOf(disk);
  text = text.replace(/\r?\n/g, eol);
  const trailing = /(\r?\n)+$/.exec(disk.slice(D.root.closeToken?.end ?? D.root.token.end));
  return text + (trailing ? eol : '');
}

// ---- (c) minimal-diff writer: 3-way merge. Changes between `base` and `out` (by element path: id, or
// nearest id'd ancestor + name + index) are patched into the disk text; everything else (order,
// formatting, comments, unknown content) is kept byte for byte. Falls back to (b) if a change cannot
// be located or the result does not re-parse to the same model.
export class Fallback extends Error {}

const parentKey = (el) => (el.parent ? pathKey(el.parent) : null);

function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const ws = /^[ \t]*/.exec(text.slice(lineStart, offset))[0];
  return text.slice(lineStart, offset) === ws ? ws : null; // null: something else before the tag on its line
}

export function minimalDiff(disk, base, out, stats = {}) {
  const D = parse(disk);
  const B = parse(base);
  const N = parse(out);
  const index = (doc) => new Map([...walk(doc.root)].map((el) => [pathKey(el), el]));
  const dI = index(D);
  const bI = index(B);
  const nI = index(N);
  const eol = eolOf(disk);
  const unit = detectIndent(disk);
  const edits = [];
  let seq = 0;
  const edit = (start, end, text) => edits.push({ start, end, text, seq: seq++ });
  const need = (p) => {
    const el = dI.get(p);
    if (!el) throw new Fallback(`element ${p} not found in the file on disk`);
    return el;
  };
  const isId = (el) => el.attrs.some((a) => a.local === 'id' && !a.prefix);

  // Elements added, removed, or moved to another parent (only the topmost of each subtree).
  // Moved to another parent, or replaced by an element of another type with the same id.
  const moved = new Set([...nI].filter(([p, n]) => bI.has(p) && isId(n)
    && (parentKey(n) !== parentKey(bI.get(p)) || n.name !== bI.get(p).name)).map(([p]) => p));
  const added = [...nI.keys()].filter((p) => !bI.has(p) || moved.has(p));
  const removed = [...bI.keys()].filter((p) => !nI.has(p) || moved.has(p));
  const topmost = (paths, I) => paths.filter((p) => {
    for (let e = I.get(p).parent; e; e = e.parent) if (paths.includes(pathKey(e))) return false;
    return true;
  });
  const addedTop = topmost(added, nI);
  const removedTop = topmost(removed, bI);
  const insideAny = (el, set) => { for (let e = el; e; e = e.parent) if (set.includes(pathKey(e))) return true; return false; };

  // Namespace declarations added on the root (e.g. a colour extension used for the first time).
  for (const [p, uri] of Object.entries(N.root.nsDecls)) {
    if (D.root.nsDecls[p] === uri) continue;
    if (p in D.root.nsDecls) throw new Fallback(`prefix ${p} bound to another namespace on disk`);
    if (!p) continue; // default namespace of bpmn-js output differs: keep the file's
    insertAttr(D.root, `xmlns:${p}`, uri);
  }

  function insertAttr(dEl, name, value) {
    const tok = dEl.token;
    const last = tok.attrs[tok.attrs.length - 1];
    const q = last?.quote ?? '"';
    if (last) {
      const before = disk.slice(tok.attrs.length > 1 ? tok.attrs[tok.attrs.length - 2].end : tok.nameEnd, last.start);
      const sep = before.includes('\n') ? `${eol}${/[ \t]*$/.exec(before)[0]}` : ' ';
      edit(last.end, last.end, `${sep}${name}=${q}${escapeAttr(value, q)}${q}`);
    } else edit(tok.nameEnd, tok.nameEnd, ` ${name}=${q}${escapeAttr(value, q)}${q}`);
  }

  // Attribute and text changes on elements present in base, out and disk.
  for (const [p, n] of nI) {
    const b = bI.get(p);
    if (!b || insideAny(n, added) || moved.has(p)) continue;
    const bA = new Map(b.attrs.map((a) => [a.name, a.value]));
    const nA = new Map(n.attrs.map((a) => [a.name, a.value]));
    const changed = [...nA].filter(([k, v]) => bA.get(k) !== v);
    const dropped = [...bA.keys()].filter((k) => !nA.has(k));
    const textOf = (el) => (el.children.some((c) => c.kind === 'element') ? null
      : el.children.filter((c) => c.kind === 'text' || c.kind === 'cdata').map((c) => c.value).join(''));
    const textChanged = textOf(b) !== textOf(n) && (textOf(b) ?? '').trim() !== (textOf(n) ?? '').trim();
    const newNs = n === N.root ? [] : Object.entries(n.nsDecls).filter(([k, v]) => b.nsDecls[k] !== v && k);
    if (!changed.length && !dropped.length && !textChanged && !newNs.length) continue;
    const d = need(p);
    for (const [k, v] of newNs) if (d.nsDecls[k] !== v) insertAttr(d, `xmlns:${k}`, v);
    for (const [k, v] of changed) {
      const da = d.attrs.find((a) => a.name === k);
      if (da) edit(da.token.valueStart, da.token.valueEnd, escapeAttr(v, da.token.quote));
      else insertAttr(d, k, v);
    }
    for (const k of dropped) {
      const da = d.attrs.find((a) => a.name === k);
      if (!da) continue;
      const prevEnd = d.token.attrs.indexOf(da.token) > 0 ? d.token.attrs[d.token.attrs.indexOf(da.token) - 1].end : d.token.nameEnd;
      edit(prevEnd, da.token.end, '');
    }
    if (textChanged) {
      if (!d.closeToken) throw new Fallback(`text change on self-closing element ${p}`);
      const t = textOf(n) ?? '';
      edit(d.token.end, d.closeToken.start, t.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
    }
  }

  // Removed elements: cut the element (and its line, if it is alone on it).
  for (const p of removedTop) {
    const d = need(p);
    const end = (d.closeToken ?? d.token).end;
    const indent = lineIndent(disk, d.token.start);
    if (indent !== null) {
      const lineStart = d.token.start - indent.length;
      const nl = disk.startsWith('\r\n', end) ? 2 : disk.startsWith('\n', end) ? 1 : 0;
      edit(lineStart, end + nl, '');
    } else edit(d.token.start, end, '');
  }

  // Added elements: copy bpmn-js' text of the subtree, re-indented to the file's style, next to the
  // previous (or next) sibling that exists on disk, or as the first child of the parent.
  for (const p of addedTop) {
    const n = nI.get(p);
    const nEnd = (n.closeToken ?? n.token).end;
    const nIndent = lineIndent(out, n.token.start) ?? '';
    const snippetLines = out.slice(n.token.start, nEnd).split('\n').map((line, k) => {
      if (k === 0) return line;
      const rel = line.startsWith(nIndent) ? line.slice(nIndent.length) : line.trimStart();
      const sp = /^ */.exec(rel)[0].length;
      return unit.repeat(Math.floor(sp / 2)) + rel.slice(sp - (sp % 2));
    });
    const siblings = n.parent.children.filter((c) => c.kind === 'element');
    const at = siblings.indexOf(n);
    const onDisk = (el) => dI.has(pathKey(el)) && !removed.includes(pathKey(el));
    const prev = siblings.slice(0, at).reverse().find(onDisk);
    const next = siblings.slice(at + 1).find(onDisk);
    const render = (indent) => snippetLines.map((l, k) => (k === 0 ? l : indent + l)).join(eol);
    if (prev) {
      const d = dI.get(pathKey(prev));
      const indent = lineIndent(disk, d.token.start) ?? '';
      edit((d.closeToken ?? d.token).end, (d.closeToken ?? d.token).end, eol + indent + render(indent));
    } else if (next) {
      const d = dI.get(pathKey(next));
      const indent = lineIndent(disk, d.token.start) ?? '';
      edit(d.token.start, d.token.start, render(indent) + eol + indent);
    } else {
      const parent = need(pathKey(n.parent));
      const pIndent = lineIndent(disk, parent.token.start) ?? '';
      const indent = pIndent + unit;
      if (parent.token.selfClosing) {
        const slash = disk.lastIndexOf('/', parent.token.end - 1);
        const ws = /\s*$/.exec(disk.slice(parent.token.start, slash))[0].length;
        edit(slash - ws, parent.token.end, `>${eol}${indent}${render(indent)}${eol}${pIndent}</${parent.name}>`);
      } else edit(parent.token.end, parent.token.end, eol + indent + render(indent));
    }
  }

  // Apply from the end; edits at the same offset keep their creation order.
  edits.sort((x, y) => y.start - x.start || y.seq - x.seq);
  for (let k = 1; k < edits.length; k++) {
    if (edits[k].end > edits[k - 1].start && edits[k].start !== edits[k - 1].start) throw new Fallback('overlapping edits');
  }
  let text = disk;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  stats.edits = edits.length;

  // Verify: the result must describe the same model as bpmn-js' output; only content bpmn-js would
  // have dropped or rewritten (comments, PIs, DOCTYPE, defaults, number spelling, ...) may differ.
  if (stats.noVerify) return text;
  const problems = editMismatches(disk, base, out, text);
  if (problems.length) throw new Fallback(`verification failed: ${problems.slice(0, 3).join(', ')}`);
  return text;
}

/** Differences between two documents that are not "kept extra information". */
export function modelDifferences(candidate, out) {
  const diffs = diffFacts(facts(out), facts(candidate));
  const isNum = (v) => typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v));
  return diffs.filter(({ key, before, after }) => {
    if (/^(decl|doctype|comment:|pi:|cdata:|ns:|prefix:)/.test(key)) return false; // kept from disk
    if (key.startsWith('attr:') && before === undefined) return false; // attribute bpmn-js dropped, kept
    if (key.startsWith('attr:') && isNum(before) && isNum(after) && Number(before) === Number(after)) return false;
    if (key.startsWith('text:') && before !== undefined && after !== undefined) {
      return before.replace(/\s+/g, ' ') !== after.replace(/\s+/g, ' ');
    }
    if (key.startsWith('el:') && before === undefined) return false; // an element bpmn-js dropped (unknown), kept
    return true;
  });
}

/**
 * 3-way check: the model-level changes from `disk` to `candidate` must be exactly the changes bpmn-js
 * made from `base` to `out` (same keys, same new values). Returns the mismatching keys.
 */
export function editMismatches(disk, base, out, candidate) {
  const norm = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v);
  const changes = (a, b) => new Map(diffFacts(facts(a), facts(b))
    .filter(({ key }) => !/^(ns:|prefix:)/.test(key))
    .map(({ key, after }) => [key, norm(after)]));
  const want = changes(base, out);
  const got = changes(disk, candidate);
  const fb = facts(base);
  const fo = facts(out);
  const fc = facts(candidate);
  // Elements bpmn-js replaced (same id, other type) are written as bpmn-js wrote them: compare their
  // subtree with bpmn-js' output directly. Comments/PIs/CDATA inside removed elements go with them.
  const replaced = [...fo.keys()].filter((k) => k.startsWith('el:') && fb.has(k) && fb.get(k) !== fo.get(k)).map((k) => k.slice(3));
  const removed = [...fb.keys()].filter((k) => k.startsWith('el:') && !fo.has(k)).map((k) => k.slice(3));
  const under = (k, paths) => {
    const r = k.replace(/^[a-z]+:/, '');
    return paths.some((p) => r === p || r.startsWith(`${p}/`) || r.startsWith(`${p}@`) || r.startsWith(`${p}:`));
  };
  const keys = new Set([...want.keys(), ...got.keys()]);
  return [...keys].filter((k) => {
    if (/^(ns:|prefix:)/.test(k)) return false;
    if (under(k, replaced)) return norm(fc.get(k)) !== norm(fo.get(k));
    if (under(k, removed)) return fc.has(k); // must be gone, whatever bpmn-js had dropped before
    return want.get(k) !== got.get(k) || want.has(k) !== got.has(k);
  });
}

export function minimalDiffOrFallback(disk, base, out, stats = {}) {
  try {
    return minimalDiff(disk, base, out, stats);
  } catch (err) {
    if (!(err instanceof Fallback)) throw err;
    stats.fallback = err.message;
    return preserveHeaderAndStyle(disk, base, out);
  }
}

// ---- (d) canonical formatter on both sides (xmllint --format): the repository file is kept in
// xmllint's style and every save is formatted the same way.
export function xmllintFormat(text) {
  const r = spawnSync('xmllint', ['--format', '-'], { input: text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`xmllint: ${r.stderr}`);
  return r.stdout;
}
