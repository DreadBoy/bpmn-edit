// Q4 experiment helpers: a small position-preserving XML tokenizer / tree builder (no dependencies)
// and a "facts" extraction used to compare two BPMN documents semantically. Not used by the app.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Decodes the five predefined entities and numeric character references; unknown entities stay as is. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, ref) => {
    if (ref[0] === '#') return String.fromCodePoint(ref[1] === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[ref];
  });
}

/**
 * Tokenizes `xml`. Every token has { type, start, end } (offsets into xml) and:
 *   decl / pi: { target, raw }; comment: { value }; doctype: { raw }; cdata: { value }; text: { raw };
 *   open: { name, attrs: [{ name, raw, quote, start, end, valueStart, valueEnd }], selfClosing, nameEnd };
 *   close: { name }.
 */
export function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) { tokens.push({ type: 'text', start: i, end: n, raw: xml.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', start: i, end: lt, raw: xml.slice(i, lt) });
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4) + 3;
      tokens.push({ type: 'comment', start: lt, end, value: xml.slice(lt + 4, end - 3) });
      i = end;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9) + 3;
      tokens.push({ type: 'cdata', start: lt, end, value: xml.slice(lt + 9, end - 3) });
      i = end;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2) + 2;
      const raw = xml.slice(lt, end);
      const target = /^<\?([^\s?]+)/.exec(raw)[1];
      tokens.push({ type: target === 'xml' ? 'decl' : 'pi', start: lt, end, target, raw });
      i = end;
    } else if (xml.startsWith('<!', lt)) {
      const bracket = xml.indexOf('[', lt);
      const close = xml.indexOf('>', lt);
      const end = bracket !== -1 && bracket < close ? xml.indexOf(']>', bracket) + 2 : close + 1;
      tokens.push({ type: 'doctype', start: lt, end, raw: xml.slice(lt, end) });
      i = end;
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt) + 1;
      tokens.push({ type: 'close', start: lt, end, name: xml.slice(lt + 2, end - 1).trim() });
      i = end;
    } else {
      // Start tag with attributes.
      const nameMatch = /[^\s/>]+/y;
      nameMatch.lastIndex = lt + 1;
      const name = nameMatch.exec(xml)[0];
      let j = lt + 1 + name.length;
      const attrs = [];
      const attrRe = /\s*([^\s=/>]+)\s*=\s*(["'])/y;
      for (;;) {
        attrRe.lastIndex = j;
        const m = attrRe.exec(xml);
        if (!m) break;
        const attrStart = j + m[0].length - m[0].trimStart().length;
        const valueStart = j + m[0].length;
        const valueEnd = xml.indexOf(m[2], valueStart);
        attrs.push({ name: m[1], quote: m[2], raw: xml.slice(valueStart, valueEnd), start: attrStart, end: valueEnd + 1, valueStart, valueEnd });
        j = valueEnd + 1;
      }
      const end = xml.indexOf('>', j) + 1;
      const selfClosing = xml[end - 2] === '/';
      tokens.push({ type: 'open', start: lt, end, name, attrs, selfClosing, nameEnd: lt + 1 + name.length });
      i = end;
    }
  }
  return tokens;
}

/**
 * Builds an element tree with namespace resolution. Nodes: { kind: 'element', name, prefix, local,
 * uri, attrs: [{ name, prefix, local, uri, value, raw, token }], nsDecls: { prefix: uri }, children,
 * token (open), closeToken, parent } and { kind: 'text' | 'cdata' | 'comment' | 'pi', value, token }.
 * Returns { root, prolog: tokens before root, epilog: tokens after root, tokens }.
 */
export function parse(xml) {
  const tokens = tokenize(xml);
  const prolog = [];
  const epilog = [];
  let root = null;
  const stack = [];
  const resolve = (prefix, scope, isAttr) => {
    if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace';
    if (isAttr && prefix === null) return null;
    for (let s = scope; s; s = s.parent) {
      const key = prefix ?? '';
      if (s.nsDecls && key in s.nsDecls) return s.nsDecls[key];
    }
    return null;
  };
  for (const t of tokens) {
    const parent = stack[stack.length - 1];
    if (t.type === 'open') {
      const [p, l] = t.name.includes(':') ? t.name.split(':') : [null, t.name];
      const el = { kind: 'element', name: t.name, prefix: p, local: l, attrs: [], nsDecls: {}, children: [], token: t, parent };
      for (const a of t.attrs) {
        if (a.name === 'xmlns') el.nsDecls[''] = decodeEntities(a.raw);
        else if (a.name.startsWith('xmlns:')) el.nsDecls[a.name.slice(6)] = decodeEntities(a.raw);
      }
      el.uri = resolve(p, el, false);
      for (const a of t.attrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const [ap, al] = a.name.includes(':') ? a.name.split(':') : [null, a.name];
        el.attrs.push({ name: a.name, prefix: ap, local: al, uri: resolve(ap, el, true), value: decodeEntities(a.raw), raw: a.raw, token: a });
      }
      if (parent) parent.children.push(el);
      else root = el;
      if (!t.selfClosing) stack.push(el);
    } else if (t.type === 'close') {
      const el = stack.pop();
      el.closeToken = t;
    } else if (parent) {
      const value = t.type === 'text' ? decodeEntities(t.raw) : t.value ?? t.raw;
      parent.children.push({ kind: t.type, value, token: t, parent });
    } else (root ? epilog : prolog).push(t);
  }
  return { root, prolog, epilog, tokens };
}

export function* walk(el) {
  yield el;
  for (const c of el.children) if (c.kind === 'element') yield* walk(c);
}

const qn = (uri, local) => `{${uri ?? ''}}${local}`;

/** Path of an element: nearest ancestor-or-self with an id, plus the element names below it. */
function elementPath(el) {
  const parts = [];
  for (let e = el; e; e = e.parent) {
    const id = e.attrs?.find((a) => a.local === 'id' && !a.prefix)?.value;
    if (id) { parts.unshift(`#${id}`); break; }
    const siblings = e.parent ? e.parent.children.filter((c) => c.kind === 'element' && c.uri === e.uri && c.local === e.local) : [e];
    parts.unshift(`${qn(e.uri, e.local)}[${siblings.indexOf(e)}]`);
  }
  return parts.join('/');
}

/**
 * Facts about a document as a Map<key, value> for comparing two versions. Keys:
 *   el:<path>                    element exists (value: qualified name)
 *   attr:<path>@{uri}local       attribute value (decoded)
 *   text:<path>                  concatenated non-whitespace text + CDATA (trimmed)
 *   cdata:<path>                 a CDATA section is used for the text
 *   comment:<where>:<n>          comment text; pi:<where>:<n> processing instruction; doctype; decl
 *   ns:<path>:<prefix>           namespace declaration on an element; prefix:<path> prefix used by an element
 */
export function facts(xml) {
  // Expand internal-subset entities (<!ENTITY name "value">) so that their meaning is compared.
  const doctype = /<!DOCTYPE[^[>]*\[([\s\S]*?)\]\s*>/.exec(xml);
  if (doctype) {
    const body = xml.slice(doctype.index + doctype[0].length);
    let expanded = body;
    for (const [, name, value] of doctype[1].matchAll(/<!ENTITY\s+([\w.-]+)\s+"([^"]*)"\s*>/g)) {
      expanded = expanded.replaceAll(`&${name};`, value);
    }
    xml = xml.slice(0, doctype.index + doctype[0].length) + expanded;
  }
  const { root, prolog, epilog } = parse(xml);
  const f = new Map();
  for (const t of prolog) {
    if (t.type === 'decl') f.set('decl', t.raw);
    if (t.type === 'doctype') f.set('doctype', t.raw);
  }
  [['prolog', prolog], ['epilog', epilog]].forEach(([where, list]) => {
    list.filter((t) => t.type === 'comment').forEach((t, k) => f.set(`comment:${where}:${k}`, t.value.trim()));
    list.filter((t) => t.type === 'pi').forEach((t, k) => f.set(`pi:${where}:${k}`, t.raw));
  });
  for (const el of walk(root)) {
    const path = elementPath(el);
    f.set(`el:${path}`, qn(el.uri, el.local));
    f.set(`prefix:${path}`, el.prefix ?? '');
    for (const [p, uri] of Object.entries(el.nsDecls)) f.set(`ns:${path}:${p}`, uri);
    for (const a of el.attrs) f.set(`attr:${path}@${qn(a.uri, a.local)}`, a.value);
    const textParts = el.children.filter((c) => c.kind === 'text' || c.kind === 'cdata');
    const text = textParts.map((c) => c.value).join('').trim();
    if (text) f.set(`text:${path}`, text);
    if (el.children.some((c) => c.kind === 'cdata')) f.set(`cdata:${path}`, true);
    el.children.filter((c) => c.kind === 'comment').forEach((c, k) => f.set(`comment:${path}:${k}`, c.value.trim()));
    el.children.filter((c) => c.kind === 'pi').forEach((c, k) => f.set(`pi:${path}:${k}`, c.token.raw));
  }
  return f;
}

/** Differences between two fact maps: [{ key, before, after }] (undefined = absent). */
export function diffFacts(a, b) {
  const out = [];
  for (const [k, v] of a) if (!b.has(k)) out.push({ key: k, before: v });
  else if (b.get(k) !== v) out.push({ key: k, before: v, after: b.get(k) });
  for (const [k, v] of b) if (!a.has(k)) out.push({ key: k, after: v });
  return out;
}

/** Escapes text for an attribute value delimited by `quote`. */
export function escapeAttr(value, quote = '"') {
  const out = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\n', '&#10;');
  return quote === '"' ? out.replaceAll('"', '&quot;') : out.replaceAll("'", '&apos;');
}

/**
 * The minimal textual edit: `xml` with the `name` attribute of the element with id `id` set to `name`,
 * touching nothing else (keeps the attribute's quote style). Returns null if not found.
 */
export function idealRename(xml, id, name) {
  const { root } = parse(xml);
  for (const el of walk(root)) {
    if (el.attrs.find((a) => a.local === 'id' && !a.prefix)?.value !== id) continue;
    const attr = el.attrs.find((a) => a.local === 'name' && !a.prefix);
    if (attr) {
      const { valueStart, valueEnd, quote } = attr.token;
      return xml.slice(0, valueStart) + escapeAttr(name, quote) + xml.slice(valueEnd);
    }
    const at = el.token.nameEnd;
    return `${xml.slice(0, at)} name="${escapeAttr(name)}"${xml.slice(at)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Measuring helpers shared by q4-churn-analyse.mjs and the option prototypes.

const diffDir = mkdtempSync(join(tmpdir(), 'q4-diff-'));
let diffSeq = 0;

function diffFiles(a, b) {
  const fa = join(diffDir, `${++diffSeq}.a`);
  const fb = join(diffDir, `${diffSeq}.b`);
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  return [fa, fb];
}

/** Changed lines between two texts as git counts them: { added, deleted, total } (`-w` with ignoreSpace). */
export function numstat(a, b, { ignoreSpace = false } = {}) {
  const [fa, fb] = diffFiles(a, b);
  const args = ['diff', '--no-index', '--numstat', ...(ignoreSpace ? ['-w'] : []), fa, fb];
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
  const line = r.stdout.trim().split('\n').find(Boolean);
  if (!line) return { added: 0, deleted: 0, total: 0 };
  const [added, deleted] = line.split('\t').map(Number);
  return { added, deleted, total: added + deleted };
}

/** Unified diff text between two texts (for evidence files). */
export function unifiedDiff(a, b, labelA = 'a', labelB = 'b') {
  const [fa, fb] = diffFiles(a, b);
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', `--src-prefix=${labelA}/`, `--dst-prefix=${labelB}/`, fa, fb], { encoding: 'utf8' });
  return r.stdout.replace(/^(diff --git|---|\+\+\+) .*$/gm, (line) => line.replace(/\/[^ ]*q4-diff-[^ ]*\/\d+\.[ab]/g, ''));
}

// What the plain bpmn-js modeler (bpmn-moddle) knows; everything else is an "unknown" extension.
export const KNOWN_NS = new Set([
  'http://www.omg.org/spec/BPMN/20100524/MODEL',
  'http://www.omg.org/spec/BPMN/20100524/DI',
  'http://www.omg.org/spec/DD/20100524/DC',
  'http://www.omg.org/spec/DD/20100524/DI',
  'http://www.w3.org/2001/XMLSchema-instance',
  'http://www.w3.org/XML/1998/namespace',
  'http://bpmn.io/schema/bpmn/biocolor/1.0',
  'http://www.omg.org/spec/BPMN/non-normative/color/1.0',
]);

const isNum = (v) => typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v));
const attrUri = (key) => /@\{([^}]*)\}[^@]*$/.exec(key)?.[1] ?? '';

/**
 * Unintended semantic-level differences between `expected` (the text with only the intended edit)
 * and `actual`: [{ category, key, before, after, loss }]. `loss` marks information that is gone.
 */
export function semanticChanges(expected, actual) {
  const d = diffFacts(facts(expected), facts(actual));
  const addedEls = d.filter((x) => x.key.startsWith('el:') && x.before === undefined).map((x) => x.key.slice(3));
  const removedEls = d.filter((x) => x.key.startsWith('el:') && x.after === undefined).map((x) => x.key.slice(3));
  const elPaths = [...addedEls, ...removedEls];
  const rest = (key) => key.replace(/^(el|attr|prefix|ns|text|cdata|comment|pi):/, '');
  const inside = (key, isEl) => elPaths.some((p) => {
    const r = rest(key);
    return isEl ? r.startsWith(`${p}/`) : (r === p || r.startsWith(`${p}/`) || r.startsWith(`${p}@`) || r.startsWith(`${p}:`));
  });
  // bpmn-js (>= 9) moves the content of collapsed sub-processes into a diagram of their own on import.
  const migrated = addedEls.some((p) => /BPMNDiagram\[\d+\]$/.test(p));
  const out = [];
  for (const { key, before, after } of d) {
    const isEl = key.startsWith('el:');
    if (inside(key, isEl)) continue; // folded into the added/removed element
    let category;
    let loss = false;
    if (key === 'decl') category = 'XML declaration changed';
    else if (key === 'doctype') { category = 'DOCTYPE dropped'; loss = true; }
    else if (key.startsWith('comment:')) { category = after === undefined ? 'comment dropped' : 'comment changed'; loss = true; }
    else if (key.startsWith('pi:')) { category = 'processing instruction dropped'; loss = true; }
    else if (key.startsWith('cdata:')) category = 'CDATA section turned into escaped text';
    else if (key.startsWith('ns:')) {
      category = after === undefined ? 'namespace declaration dropped' : before === undefined ? 'namespace declaration added' : 'namespace declaration changed';
    } else if (key.startsWith('prefix:')) category = 'namespace prefix changed';
    else if (key.startsWith('text:')) { category = 'text content changed'; loss = true; }
    else if (isEl) {
      const uri = /\{([^}]*)\}/.exec(before ?? after)?.[1] ?? '';
      if (before === undefined) {
        category = /BPMNLabel$/.test(after) ? 'edit side effect: BPMNLabel element added'
          : /BPMNDiagram$/.test(after) ? 'bpmn-js DI migration: diagram added for collapsed sub-process' : 'element added';
      }
      else { category = KNOWN_NS.has(uri) ? 'element dropped' : 'unknown-namespace element dropped'; loss = true; }
    } else if (key.startsWith('attr:')) {
      const known = attrUri(key) === '' || KNOWN_NS.has(attrUri(key));
      if (after === undefined) { category = known ? 'BPMN attribute dropped (default value)' : 'unknown-namespace attribute dropped'; loss = !known; }
      else if (before === undefined) category = 'attribute added';
      else if (isNum(before) && isNum(after) && Number(before) === Number(after)) category = 'number formatting changed';
      else if (migrated && /(Bounds|waypoint)\[\d+\]@\{\}[xy]$/.test(key)) category = 'bpmn-js DI migration: collapsed sub-process content moved';
      else { category = 'attribute value changed'; loss = true; }
    } else category = 'other';
    out.push({ category, key, before, after, loss });
  }
  return out;
}

function indentUnit(text) {
  const sizes = new Set();
  for (const m of text.matchAll(/\n([ \t]+)</g)) {
    if (m[1].includes('\t')) return 'tab';
    sizes.add(m[1].length);
  }
  return sizes.size ? `${Math.min(...sizes)} spaces` : 'none';
}

/** Items of `a` (all present in `b`) that are not part of a longest common subsequence with `b`. */
function movedItems(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  const kept = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { kept.add(a[i]); i += 1; j += 1; } else if (t[i + 1][j] >= t[i][j + 1]) i += 1; else j += 1;
  }
  return a.filter((x) => !kept.has(x));
}

export function pathKey(el) {
  const parts = [];
  for (let e = el; e; e = e.parent) {
    const id = e.attrs.find((a) => a.local === 'id' && !a.prefix)?.value;
    if (id) { parts.unshift(`#${id}`); break; }
    const sib = e.parent ? e.parent.children.filter((c) => c.kind === 'element' && c.name === e.name) : [e];
    parts.unshift(`${e.name}[${sib.indexOf(e)}]`);
  }
  return parts.join('/');
}

/** Formatting-level differences between two texts (counts of affected items). */
export function formattingChanges(expected, actual) {
  const E = parse(expected);
  const A = parse(actual);
  const idOf = (el) => el.attrs.find((a) => a.local === 'id' && !a.prefix)?.value;
  const ids = (doc) => [...walk(doc.root)].map(idOf).filter(Boolean);
  const diIds = new Set([...walk(E.root)].filter((el) => el.uri === 'http://www.omg.org/spec/BPMN/20100524/DI').map(idOf).filter(Boolean));
  const idsE = ids(E);
  const idsA = new Set(ids(A));
  const seqE = idsE.filter((id) => idsA.has(id));
  const setE = new Set(seqE);
  const seqA = ids(A).filter((id) => setE.has(id));
  const byPath = (doc) => new Map([...walk(doc.root)].map((el) => [pathKey(el), el]));
  const pe = byPath(E);
  const pa = byPath(A);
  const multiLine = (doc, text) => [...walk(doc.root)].filter((el) => text.slice(el.token.start, el.token.end).includes('\n')).length;
  const c = { attributeOrderChanged: 0, quoteStyleChanged: 0, escapingChanged: 0, selfClosingChanged: 0, selfCloseSpacingChanged: 0 };
  const textRaw = (el) => el.children.filter((k) => k.kind === 'text').map((k) => k.token.raw.trim()).join('');
  const textVal = (el) => el.children.filter((k) => k.kind === 'text').map((k) => k.value.trim()).join('');
  for (const [p, e] of pe) {
    const a = pa.get(p);
    if (!a) continue;
    const common = e.attrs.map((x) => x.name).filter((n) => a.attrs.some((y) => y.name === n));
    if (common.join() !== a.attrs.map((x) => x.name).filter((n) => common.includes(n)).join()) c.attributeOrderChanged += 1;
    for (const x of e.attrs) {
      const y = a.attrs.find((z) => z.name === x.name);
      if (!y) continue;
      if (x.token.quote !== y.token.quote) c.quoteStyleChanged += 1;
      if (x.raw !== y.raw && x.value === y.value) c.escapingChanged += 1;
    }
    if (textRaw(e) !== textRaw(a) && textVal(e) === textVal(a) && !e.children.some((k) => k.kind === 'cdata')) c.escapingChanged += 1;
    if (!e.children.length && !a.children.length && e.token.selfClosing !== a.token.selfClosing) c.selfClosingChanged += 1;
    if (e.token.selfClosing && a.token.selfClosing && (expected[e.token.end - 3] === ' ') !== (actual[a.token.end - 3] === ' ')) {
      c.selfCloseSpacingChanged += 1;
    }
  }
  const crlf = (t) => (t.match(/\r\n/g) || []).length > 0;
  const nl = (t) => t.endsWith('\n');
  const decl = (doc) => doc.prolog.find((t) => t.type === 'decl')?.raw ?? null;
  return {
    lineEndings: crlf(expected) === crlf(actual) ? null : `${crlf(expected) ? 'CRLF' : 'LF'} -> ${crlf(actual) ? 'CRLF' : 'LF'}`,
    finalNewline: nl(expected) === nl(actual) ? null : `${nl(expected)} -> ${nl(actual)}`,
    indent: indentUnit(expected) === indentUnit(actual) ? null : `${indentUnit(expected)} -> ${indentUnit(actual)}`,
    multiLineTagsReflowed: Math.max(0, multiLine(E, expected) - multiLine(A, actual)),
    ...c,
    elementsReordered: movedItems(seqE, seqA).length,
    diElementsReordered: movedItems(seqE, seqA).filter((id) => diIds.has(id)).length,
    xmlDeclarationChanged: decl(E) !== decl(A),
    rootStartTagChanged: expected.slice(E.root.token.start, E.root.token.end) !== actual.slice(A.root.token.start, A.root.token.end),
  };
}
