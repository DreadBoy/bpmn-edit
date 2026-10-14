// Minimal-diff writer (Q4, see docs/decisions.md "Q4-impl"). bpmn-js serialises the whole document on
// every save: it drops comments, processing instructions and the DOCTYPE, re-indents, reorders
// attributes and DI elements and respells numbers. Writing its output as it is turns the first save
// of a file made by another tool into a huge, lossy diff.
//
// Instead, a save is written as a 3-way merge:
//   disk  the text on disk (the latest version we read or wrote),
//   base  bpmn-js' serialisation of exactly that text (the browser sends it right after importing a
//         version that came from disk; after our own write it is the XML we wrote it from),
//   out   bpmn-js' serialisation after the edit (what the browser sent).
// Only what changed between `base` and `out` is patched into `disk` (attributes, texts, elements
// added, removed, replaced or moved); everything else stays byte for byte. New elements are written
// in the file's own style (indent, line endings, quotes, attribute layout, namespace prefixes).
//
// Every result is checked before it is written (checkMinimal): parsed again, its model must relate to
// `out` exactly as `disk` relates to `base` (what bpmn-js changed is in it, nothing else changed, and
// what bpmn-js would drop is still there), and an independent element-level comparison
// (src/elements.js) must agree that nothing else was touched. If the writer cannot be sure, it falls
// back to writing bpmn-js' output in the file's style ('format', also checked: same model as `out`),
// and as a last resort to bpmn-js' output as it is ('raw', what the editor wrote before Q4).
//
// The XML reader here is small and strict: anything it does not understand (an entity defined
// outside the file, malformed markup, duplicate ids, ...) is an error, which only means a fallback.
import { elementForms } from './elements.js';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const BPMN_MODEL_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const BPMN_DI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';

/** The text is not XML this reader understands. */
export class XmlError extends Error {}

/** The minimal writer cannot produce a result it is sure of (the caller falls back). */
export class WriterFallback extends Error {}

// ---------------------------------------------------------------------------------------------
// Reading

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME_RE = /[^\s<>/=!?"'&;]+/y;
const NAME_CHECK = /^[A-Za-z_À-￿][^\s<>/=!?"'&;:]*(?::[A-Za-z_À-￿][^\s<>/=!?"'&;:]*)?$/;
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * Marks an entity reference in decoded text: `\u0001name;`. bpmn-js does not expand DOCTYPE entities
 * (it shows `&name;` as text), so a reference compares equal to bpmn-js' copy only through `literal`,
 * but never equal to the literal text `&amp;name;` (which would be a lost reference).
 */
const ENTITY_MARK = '\u0001';
/** A decoded value with its entity references as bpmn-js reads them (literal text `&name;`). */
export const literal = (value) => (typeof value === 'string' ? value.replaceAll(ENTITY_MARK, '&') : value);

/**
 * Expands character references and the five predefined entities. Other entity references are kept
 * as references (see ENTITY_MARK): the file keeps them (see refsBack).
 */
function decodeRefs(text) {
  return text.replace(/&([^;&\s<]*);|&/g, (match, ref) => {
    if (ref === undefined) throw new XmlError('a "&" that is not a reference');
    if (ref[0] === '#') {
      if (!/^#x[0-9a-fA-F]+$|^#[0-9]+$/.test(ref)) throw new XmlError(`bad character reference &${ref};`);
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code > 0x10ffff || code === 0) throw new XmlError(`bad character reference &${ref};`);
      return String.fromCodePoint(code);
    }
    if (Object.hasOwn(PREDEFINED, ref)) return PREDEFINED[ref];
    if (!NAME_CHECK.test(ref) || ref.includes(':')) throw new XmlError(`bad entity reference &${ref};`);
    return `${ENTITY_MARK}${ref};`;
  });
}

/** Text content as a parser reports it: line ends normalised, references expanded. */
const decodeText = (raw) => decodeRefs(raw.replace(/\r\n?/g, '\n'));
/** Attribute value as a parser reports it (attribute-value normalisation for CDATA attributes). */
const decodeAttr = (raw) => decodeRefs(raw.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' '));

/** End (exclusive) of the DOCTYPE starting at `i` (its internal subset may contain '>' and quotes). */
function doctypeEnd(xml, i) {
  let quote = null;
  let subset = false;
  for (let j = i + 9; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (subset && xml.startsWith('<!--', j)) {
      const end = xml.indexOf('-->', j + 4);
      if (end === -1) break;
      j = end + 2;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') subset = true;
    else if (c === ']') subset = false;
    else if (c === '>' && !subset) return j + 1;
  }
  throw new XmlError('unterminated DOCTYPE');
}

/**
 * Names of the general entities a DOCTYPE declares in its internal subset, and whether it refers to an
 * external DTD (which may declare more): references to those are written back as references.
 */
function doctypeEntities(raw) {
  const names = new Set();
  const subset = /\[([\s\S]*)\]/.exec(raw)?.[1] ?? '';
  for (const [, name] of subset.matchAll(/<!ENTITY\s+([^\s%][^\s]*)\s/g)) names.add(name);
  const external = /^<!DOCTYPE\s+[^\s[>]+\s+(SYSTEM|PUBLIC)\b/.test(raw);
  return { names, external };
}

function resolvePrefix(el, prefix) {
  if (prefix === 'xml') return XML_NS;
  for (let e = el; e; e = e.parent) {
    if (Object.hasOwn(e.nsDecls, prefix)) return e.nsDecls[prefix] || null; // xmlns="" undeclares
  }
  return prefix === '' ? null : undefined;
}

const splitName = (name) => {
  const colon = name.indexOf(':');
  return colon === -1 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
};

/**
 * Parses `xml` into { text, root, prolog, epilog, entities }. Elements: { kind: 'element', name,
 * prefix, local, uri, attrs (no xmlns), allAttrs (all, in order), nsDecls, children, parent, start,
 * nameEnd, openEnd, closeStart, end, selfClosing }; attributes: { name, prefix, local, uri, raw,
 * value, quote, start, end, valueStart, valueEnd }; other nodes: { kind: 'text' | 'cdata' |
 * 'comment' | 'pi' | 'decl' | 'doctype', start, end, raw, value }. Throws XmlError.
 */
export function parse(xml) {
  if (typeof xml !== 'string') throw new XmlError('not a string');
  const n = xml.length;
  const bom = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let i = bom;
  const prolog = [];
  const epilog = [];
  const stack = [];
  let root = null;
  let entities = { names: new Set(), external: false };
  const fail = (message, at = i) => { throw new XmlError(`${message} (offset ${at})`); };
  const add = (node) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else (root ? epilog : prolog).push(node);
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = xml.slice(i, textEnd);
      if (stack.length) add({ kind: 'text', start: i, end: textEnd, raw, value: decodeText(raw) });
      else if (/\S/.test(raw)) fail('text outside the root element');
      i = textEnd;
      if (lt === -1) break;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end === -1) fail('unterminated comment');
      add({ kind: 'comment', start: i, end: end + 3, raw: xml.slice(i, end + 3), value: xml.slice(i + 4, end) });
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('CDATA outside the root element');
      const end = xml.indexOf(']]>', i + 9);
      if (end === -1) fail('unterminated CDATA section');
      add({ kind: 'cdata', start: i, end: end + 3, raw: xml.slice(i, end + 3), value: xml.slice(i + 9, end).replace(/\r\n?/g, '\n') });
      i = end + 3;
    } else if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end === -1) fail('unterminated processing instruction');
      const raw = xml.slice(i, end + 2);
      const target = /^<\?([^\s?]+)/.exec(raw)?.[1];
      if (!target) fail('processing instruction without a target');
      const decl = target.toLowerCase() === 'xml';
      if (decl && i !== bom) fail('XML declaration not at the start');
      add({ kind: decl ? 'decl' : 'pi', start: i, end: end + 2, raw, value: raw });
      i = end + 2;
    } else if (xml.startsWith('<!DOCTYPE', i)) {
      if (root || stack.length || prolog.some((node) => node.kind === 'doctype')) fail('misplaced DOCTYPE');
      const end = doctypeEnd(xml, i);
      const raw = xml.slice(i, end);
      entities = doctypeEntities(raw);
      add({ kind: 'doctype', start: i, end, raw, value: raw });
      i = end;
    } else if (xml.startsWith('</', i)) {
      NAME_RE.lastIndex = i + 2;
      const name = NAME_RE.exec(xml)?.[0];
      if (!name) fail('bad end tag');
      let j = i + 2 + name.length;
      while (j < n && isWs(xml[j])) j += 1;
      if (xml[j] !== '>') fail('bad end tag');
      const el = stack.pop();
      if (!el || el.name !== name) fail(`end tag </${name}> does not match`);
      el.closeStart = i;
      el.end = j + 1;
      i = j + 1;
    } else if (xml.startsWith('<!', i)) {
      fail('unsupported markup');
    } else {
      if (root && !stack.length) fail('a second root element');
      NAME_RE.lastIndex = i + 1;
      const name = NAME_RE.exec(xml)?.[0];
      if (!name || !NAME_CHECK.test(name)) fail('bad element name');
      let j = i + 1 + name.length;
      const nameEnd = j;
      const allAttrs = [];
      let selfClosing = false;
      for (;;) {
        const wsStart = j;
        while (j < n && isWs(xml[j])) j += 1;
        if (xml[j] === '>') { j += 1; break; }
        if (xml.startsWith('/>', j)) { j += 2; selfClosing = true; break; }
        if (j >= n) fail('unterminated start tag');
        if (j === wsStart) fail('missing space before an attribute', j);
        NAME_RE.lastIndex = j;
        const attrName = NAME_RE.exec(xml)?.[0];
        if (!attrName || !NAME_CHECK.test(attrName)) fail('bad attribute name', j);
        const start = j;
        j += attrName.length;
        while (j < n && isWs(xml[j])) j += 1;
        if (xml[j] !== '=') fail('attribute without a value', j);
        j += 1;
        while (j < n && isWs(xml[j])) j += 1;
        const quote = xml[j];
        if (quote !== '"' && quote !== "'") fail('unquoted attribute value', j);
        const valueStart = j + 1;
        const valueEnd = xml.indexOf(quote, valueStart);
        if (valueEnd === -1) fail('unterminated attribute value', j);
        const raw = xml.slice(valueStart, valueEnd);
        if (raw.includes('<')) fail('"<" in an attribute value', j);
        if (allAttrs.some((a) => a.name === attrName)) fail(`duplicate attribute ${attrName}`, start);
        allAttrs.push({ name: attrName, raw, quote, start, end: valueEnd + 1, valueStart, valueEnd });
        j = valueEnd + 1;
      }
      const parent = stack[stack.length - 1] ?? null;
      const [prefix, local] = splitName(name);
      const el = {
        kind: 'element', name, prefix, local, uri: null, attrs: [], allAttrs, nsDecls: {}, children: [], parent,
        start: i, nameEnd, openEnd: j, closeStart: null, end: selfClosing ? j : null, selfClosing,
      };
      for (const a of allAttrs) {
        if (a.name === 'xmlns') el.nsDecls[''] = decodeAttr(a.raw);
        else if (a.name.startsWith('xmlns:')) el.nsDecls[a.name.slice(6)] = decodeAttr(a.raw);
      }
      el.uri = resolvePrefix(el, prefix);
      if (el.uri === undefined) fail(`unbound prefix ${prefix}`);
      const seen = new Set();
      for (const a of allAttrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const [ap, al] = splitName(a.name);
        const uri = ap ? resolvePrefix(el, ap) : null;
        if (uri === undefined) fail(`unbound prefix ${ap}`, a.start);
        const key = `{${uri ?? ''}}${al}`;
        if (seen.has(key)) fail(`duplicate attribute ${key}`, a.start);
        seen.add(key);
        el.attrs.push(Object.assign(a, { prefix: ap, local: al, uri, value: decodeAttr(a.raw) }));
      }
      if (parent) parent.children.push(el);
      else root = el;
      if (!selfClosing) stack.push(el);
      i = j;
    }
  }
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is not closed`, n);
  if (!root) fail('no root element', n);
  return { text: xml, root, prolog, epilog, entities };
}

// ---------------------------------------------------------------------------------------------
// Element identity: ids and paths

const qn = (el) => `{${el.uri ?? ''}}${el.local}`;
const attrKey = (a) => `{${a.uri ?? ''}}${a.local}`;
const elementChildren = (el) => el.children.filter((c) => c.kind === 'element' && !isInvisible(c));

export function idOf(el) {
  const attr = el.attrs.find((a) => a.local === 'id' && a.uri === null);
  return attr && attr.value !== '' ? attr.value : null;
}

/**
 * An empty <bpmndi:BPMNLabel/> (no attributes, no content): bpmn-js adds one to a shape whenever its
 * label is edited. It carries no information, so it is never written and never compared.
 */
function isInvisible(el) {
  return el.uri === BPMN_DI_NS && el.local === 'BPMNLabel' && el.attrs.length === 0
    && el.children.every((c) => c.kind === 'text' && !/\S/.test(c.raw));
}

/**
 * Gives every visible element its path (`#id`, or the nearest ancestor with an id plus
 * `/{uri}local[n]` per level, counting siblings without an id of the same name) and the document
 * a map of its ids. Throws XmlError on duplicate ids.
 */
function annotate(doc) {
  const ids = new Map();
  const visit = (el, parentPath) => {
    const id = idOf(el);
    if (id !== null) {
      if (ids.has(id)) throw new XmlError(`duplicate id ${id}`);
      ids.set(id, el);
      el.path = `#${id}`;
    } else el.path = `${parentPath}/${qn(el)}[${el.index}]`;
    const counts = new Map();
    for (const c of el.children) {
      if (c.kind !== 'element') continue;
      if (isInvisible(c)) {
        c.path = null;
        continue;
      }
      if (idOf(c) === null) {
        c.index = counts.get(qn(c)) ?? 0;
        counts.set(qn(c), c.index + 1);
      }
      visit(c, el.path);
    }
  };
  doc.root.index = 0;
  visit(doc.root, '');
  doc.ids = ids;
  return doc;
}

/** Visible elements of the subtree, in document order. */
function* walk(el) {
  if (isInvisible(el)) return;
  yield el;
  for (const c of el.children) if (c.kind === 'element') yield* walk(c);
}

/** Parses and annotates (see parse, annotate). */
export function load(xml) {
  return annotate(parse(xml));
}

/** Value of an attribute for comparing: xsi:type (a QName) as {uri}local. */
function attrValue(el, a) {
  if (a.uri === XSI_NS && a.local === 'type') {
    const [p, l] = splitName(a.value.trim());
    const uri = resolvePrefix(el, p);
    if (uri !== undefined) return `{${uri ?? ''}}${l}`;
  }
  return a.value;
}

const isNumber = (v) => typeof v === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v);
/** Equal attribute values: the same text, or the same number spelled differently (bpmn-js respells). */
const sameValue = (a, b) => a === b || (isNumber(a) && isNumber(b) && Number(a) === Number(b));

function textOf(el) {
  return el.children.filter((c) => c.kind === 'text' || c.kind === 'cdata').map((c) => c.value).join('').trim();
}

// ---------------------------------------------------------------------------------------------
// Model facts and the checks

const SEP = '\u0000';
/** Facts kept from the file whatever bpmn-js does (it drops them all on import). */
const KEPT = new Set(['comment', 'pi', 'cdata', 'decl', 'doctype']);

/**
 * The model of a document as Map(key -> value), key = `type\0path\0detail`:
 *   el (qualified name), parent (path of the parent, elements with an id), attr (value; detail =
 *   {uri}local), text (trimmed text and CDATA), cdata (text uses CDATA), comment / pi (detail = n),
 *   decl / doctype (path '^'). Comments and PIs before / after the root have path '^' / '$'.
 */
export function facts(doc) {
  const f = new Map();
  const put = (type, path, detail, value) => f.set(`${type}${SEP}${path}${SEP}${detail}`, value);
  for (const [where, nodes] of [['^', doc.prolog], ['$', doc.epilog]]) {
    let comments = 0;
    let pis = 0;
    for (const node of nodes) {
      if (node.kind === 'decl') put('decl', where, '', node.raw);
      else if (node.kind === 'doctype') put('doctype', where, '', node.raw);
      else if (node.kind === 'comment') put('comment', where, comments++, node.value.trim());
      else if (node.kind === 'pi') put('pi', where, pis++, node.raw);
    }
  }
  for (const el of walk(doc.root)) {
    const p = el.path;
    put('el', p, '', qn(el));
    if (idOf(el) !== null) put('parent', p, '', el.parent ? el.parent.path : '');
    for (const a of el.attrs) put('attr', p, attrKey(a), attrValue(el, a));
    const text = textOf(el);
    if (text) put('text', p, '', text);
    if (el.children.some((c) => c.kind === 'cdata')) put('cdata', p, '', '1');
    let comments = 0;
    let pis = 0;
    for (const c of el.children) {
      if (c.kind === 'comment') put('comment', p, comments++, c.value.trim());
      else if (c.kind === 'pi') put('pi', p, pis++, c.raw);
    }
  }
  return f;
}

const typeOf = (key) => key.slice(0, key.indexOf(SEP));
const pathOf = (key) => key.split(SEP)[1];

/** Paths of the visible elements in the subtree of `el`. */
function subtreePaths(el, into) {
  for (const e of walk(el)) into.add(e.path);
  return into;
}

const DC_NS = 'http://www.omg.org/spec/DD/20100524/DC';
const DD_DI_NS = 'http://www.omg.org/spec/DD/20100524/DI';
/** Namespaces bpmn-js knows (bpmn-moddle and its colour extensions); anything else is an extension. */
const KNOWN_NS = new Set([
  BPMN_MODEL_NS, BPMN_DI_NS, DC_NS, DD_DI_NS, XSI_NS, XML_NS,
  'http://bpmn.io/schema/bpmn/biocolor/1.0', 'http://www.omg.org/spec/BPMN/non-normative/color/1.0',
]);
const isUnknownNs = (uri) => typeof uri === 'string' && uri !== '' && !KNOWN_NS.has(uri);
const isExtensionElements = (el) => el.uri === BPMN_MODEL_NS && el.local === 'extensionElements';
const isLayoutAttr = (a) => a.uri === null && (a.local === 'x' || a.local === 'y');

/** A layout value moved by `delta` (rounded like bpmn-js writes numbers). */
export function shiftValue(value, delta) {
  return String(Number((Number(value) + delta).toFixed(6)));
}

/**
 * DI shapes and edges whose layout on disk is bpmn-js' layout moved by one constant offset: bpmn-js
 * (>= 9) moves the content of a collapsed sub-process into a diagram of its own on import, with other
 * coordinates. Map(id -> { dx, dy }) of those with a non-zero offset; their coordinates are written
 * moved back by it.
 */
function layoutOffsets(D, B) {
  const offsets = new Map();
  const coords = (el) => new Map([...walk(el)].flatMap((e) => e.attrs.filter(isLayoutAttr).map((a) => [`${e.path}@${a.local}`, a.value])));
  for (const [id, b] of B.ids) {
    if (b.uri !== BPMN_DI_NS || (b.local !== 'BPMNShape' && b.local !== 'BPMNEdge')) continue;
    const d = D.ids.get(id);
    if (!d) continue;
    const cd = coords(d);
    const cb = coords(b);
    if (!cd.size || cd.size !== cb.size) continue;
    const delta = { x: null, y: null };
    let consistent = true;
    for (const [key, value] of cd) {
      const other = cb.get(key);
      if (!isNumber(value) || !isNumber(other)) {
        consistent = false;
        break;
      }
      const axis = key.endsWith('@x') ? 'x' : 'y';
      const diff = Number(value) - Number(other);
      if (delta[axis] === null) delta[axis] = diff;
      else if (Math.abs(delta[axis] - diff) > 1e-6) consistent = false;
    }
    const dx = delta.x ?? 0;
    const dy = delta.y ?? 0;
    if (consistent && (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9)) offsets.set(id, { dx, dy });
  }
  return offsets;
}

/** The layout offset (see layoutOffsets) that applies to `el`: of its nearest ancestor-or-self with one. */
function offsetOf(el, offsets) {
  for (let e = el; e; e = e.parent) {
    const id = idOf(e);
    if (id !== null && offsets.has(id)) return offsets.get(id);
  }
  return null;
}

const isDiElement = (el) => el.uri === BPMN_DI_NS && (el.local === 'BPMNShape' || el.local === 'BPMNEdge');

/**
 * When bpmn-js replaces an element by another type, it gives its DI shape (or edge) a new id. Such a
 * shape is the old one with another id: Map(new id in U -> old id in B), for DI elements removed and
 * added for the same `bpmnElement` in the same plane (one each).
 */
function diAliases(B, U) {
  const keyOf = (el) => {
    const ref = el.attrs.find((a) => a.local === 'bpmnElement' && a.uri === null)?.value;
    return ref ? `${qn(el)}|${ref}|${el.parent?.path ?? ''}` : null;
  };
  const gone = new Map();
  for (const [id, b] of B.ids) {
    if (U.ids.has(id) || !isDiElement(b) || !keyOf(b)) continue;
    gone.set(keyOf(b), gone.has(keyOf(b)) ? null : id);
  }
  const fresh = new Map();
  for (const [id, u] of U.ids) {
    if (B.ids.has(id) || !isDiElement(u) || !keyOf(u)) continue;
    fresh.set(keyOf(u), fresh.has(keyOf(u)) ? null : id);
  }
  const aliases = new Map();
  for (const [key, id] of fresh) if (id && gone.get(key)) aliases.set(id, gone.get(key));
  return aliases;
}

/** `path` with the old ids of `aliases` (see diAliases) replaced by the new ones. */
function aliasPath(path, back) {
  if (typeof path !== 'string' || !path.startsWith('#')) return path;
  const end = path.indexOf('/');
  const id = path.slice(1, end === -1 ? undefined : end);
  return back.has(id) ? `#${back.get(id)}${end === -1 ? '' : path.slice(end)}` : path;
}

/** Facts with the old ids of `aliases` replaced by the new ones (paths, and parent values). */
function aliasFacts(f, back) {
  if (!back.size) return f;
  const out = new Map();
  for (const [key, value] of f) {
    const [type, path, detail] = key.split(SEP);
    out.set(`${type}${SEP}${aliasPath(path, back)}${SEP}${detail}`, type === 'parent' ? aliasPath(value, back) : value);
  }
  return out;
}

/**
 * When bpmn-js replaces an element by another type (same id), it drops the extensions of the old one
 * (attributes and elements in namespaces it does not know, `extensionElements`). They are kept on
 * disk: the new type can carry them as well. Marks, below element `b` (of the base), the paths whose
 * content is kept that way (`keep`) and the paths whose unknown-namespace attributes are kept (`attrs`).
 */
function markKept(b, keep, attrs, inside = false) {
  attrs.add(b.path);
  const kept = inside || isUnknownNs(b.uri) || isExtensionElements(b);
  if (kept) keep.add(b.path);
  for (const c of elementChildren(b)) if (idOf(c) === null) markKept(c, keep, attrs, kept);
}

/**
 * The 3-way check of a minimal-diff result `W` (all four annotated documents): for every fact,
 * - extensions bpmn-js dropped when it replaced an element by another type: as on disk (see markKept);
 * - under an element bpmn-js removed: gone from W;
 * - comments, PIs, CDATA, XML declaration, DOCTYPE in what is on disk: as on disk (bpmn-js drops them
 *   on import);
 * - anything bpmn-js changed (base -> out): as in `out` (layout values of DI that bpmn-js moved on
 *   import: moved back by the same offset, see layoutOffsets);
 * - anything else: exactly as on disk.
 * Elements moved to another parent or replaced by another type are compared like any other: their
 * content must be the disk's, with bpmn-js' changes. Returns the mismatching keys (empty: fine).
 */
export function checkMinimal(D, B, U, W, restored = []) {
  const { fm, paths: restoredPaths } = restoredFacts(restored);
  const restoredTops = new Set(restored.map((r) => `#${r.id}`));
  const underRestored = (path) => {
    for (let p = path; p; p = p.slice(0, Math.max(p.lastIndexOf('/'), 0))) if (restoredPaths.has(p)) return true;
    return false;
  };
  const back = new Map([...diAliases(B, U)].map(([fresh, old]) => [old, fresh]));
  const [fd, fb, fu, fw] = [aliasFacts(facts(D), back), aliasFacts(facts(B), back), facts(U), facts(W)];
  const offsets = layoutOffsets(D, B);
  const byPath = (doc) => new Map([...walk(doc.root)].map((e) => [e.path, e]));
  const [pu, pb] = [byPath(U), byPath(B)];
  const keep = new Set();
  const keepAttrs = new Set();
  for (const [id, b] of B.ids) {
    const u = U.ids.get(id);
    if (u && qn(u) !== qn(b)) markKept(b, keep, keepAttrs);
  }
  const removed = new Set();
  for (const b of walk(B.root)) {
    const path = aliasPath(b.path, back);
    if (!fu.has(`el${SEP}${path}${SEP}`) && !removed.has(path)) for (const e of walk(b)) removed.add(aliasPath(e.path, back));
  }
  // Under an element bpmn-js removed, also what only the disk has there (e.g. kept extensions).
  const underRemoved = (path) => {
    for (let p = path; p; p = p.slice(0, Math.max(p.lastIndexOf('/'), 0))) {
      if (removed.has(p) && !fu.has(`el${SEP}${p}${SEP}`)) return true;
    }
    return false;
  };
  const problems = [];
  for (const key of new Set([...fd.keys(), ...fb.keys(), ...fu.keys(), ...fw.keys()])) {
    const type = typeOf(key);
    const path = pathOf(key);
    const detail = key.split(SEP)[2];
    const droppedByType = (keep.has(path) && !fu.has(`el${SEP}${path}${SEP}`))
      || (type === 'attr' && fb.has(key) && !fu.has(key) && keepAttrs.has(path) && isUnknownNs(/^\{([^}]*)\}/.exec(detail)?.[1]));
    let ok;
    // Written back from memory: exactly its old text's content (which may hold more than bpmn-js' model
    // of it, e.g. extensions kept on a type change), every element bpmn-js has, under bpmn-js' parent.
    if (underRestored(path)) {
      if (type === 'parent' && restoredTops.has(path)) ok = fw.get(key) === fu.get(key);
      else ok = fw.get(key) === fm.get(key) && (type !== 'el' || !fu.has(key) || fw.get(key) === fu.get(key));
    }
    else if (droppedByType) ok = fw.get(key) === fd.get(key);
    else if (underRemoved(path)) ok = !fw.has(key);
    else if (KEPT.has(type) && (path === '^' || path === '$' || fd.has(`el${SEP}${path}${SEP}`))) ok = fw.get(key) === fd.get(key);
    else if (!(type === 'attr' ? sameValue(literal(fb.get(key)), fu.get(key)) : literal(fb.get(key)) === fu.get(key))) {
      let expected = fu.get(key);
      const offset = type === 'attr' && /^\{\}[xy]$/.test(detail) && expected !== undefined && isNumber(expected)
        ? offsetOf(pu.get(path) ?? pb.get(path), offsets) ?? offsetOf(pb.get(aliasPath(path, new Map([...back].map(([o, f]) => [f, o])))), offsets) : null;
      if (offset) expected = shiftValue(expected, detail === '{}x' ? offset.dx : offset.dy);
      // A reference written back for bpmn-js' "&name;" text; a number as the file spells it (e.g. a
      // waypoint kept in place while bpmn-js inserted others before it).
      ok = type === 'attr' ? sameValue(literal(fw.get(key)), expected) : literal(fw.get(key)) === expected;
    } else ok = fw.get(key) === fd.get(key);
    if (!ok) problems.push(key.replaceAll(SEP, ' '));
  }
  return problems;
}

/**
 * Independent second opinion (src/elements.js, its own tokenizer): every element the result changed
 * compared with the disk must be one that bpmn-js changed (base -> out). Namespace declarations are
 * ignored (a declaration may be placed differently). Null documents (not readable that way): no
 * opinion.
 */
export function checkForms(disk, base, out, written) {
  const strip = (forms) => forms && new Map([...forms].map(([id, form]) => [id, form.replace(/ xmlns(?::[^=\s]+)?="[^"]*"/g, '')]));
  const [d, b, u, w] = [disk, base, out, written].map((xml) => strip(elementForms(xml)));
  if (!d || !b || !u || !w) return [];
  const problems = [];
  for (const id of new Set([...d.keys(), ...w.keys()])) {
    if (d.get(id) !== w.get(id) && b.get(id) === u.get(id)) problems.push(`element ${id || '(document)'}`);
  }
  return problems;
}

/**
 * Check of a format-preserving result: the same model as `out`, apart from comments, PIs, CDATA, the
 * XML declaration and the DOCTYPE (kept from the file where possible). Returns mismatching keys.
 */
export function checkModel(W, U) {
  const [fw, fu] = [facts(W), facts(U)];
  const problems = [];
  for (const key of new Set([...fw.keys(), ...fu.keys()])) {
    if (KEPT.has(typeOf(key))) continue;
    if (literal(fw.get(key)) !== fu.get(key)) problems.push(key.replaceAll(SEP, ' '));
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The file's style

/** Indentation in front of `offset` if only whitespace precedes it on its line, else null. */
function lineIndent(text, offset) {
  const lineStart = Math.max(text.lastIndexOf('\n', offset - 1) + 1, 0);
  const before = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(before) ? before : null;
}

/**
 * Formatting conventions of a document: line ending, indent unit, attribute quote, self-closing
 * style (`/>` or ` />`), attribute layout (all on one line, or one per line aligned under the first,
 * or one per line with a hanging indent), and the entities its DOCTYPE declares.
 */
export function detectStyle(doc) {
  const text = doc.text;
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const eol = crlf > lf ? '\r\n' : '\n';
  const units = new Map();
  const quotes = { '"': 0, "'": 0 };
  let spaced = 0;
  let tight = 0;
  let single = 0;
  let multi = 0;
  let layout = null;
  for (const el of walk(doc.root)) {
    for (const a of el.allAttrs) quotes[a.quote] += 1;
    if (el.selfClosing) {
      if (isWs(text[el.openEnd - 3])) spaced += 1;
      else tight += 1;
    }
    const indent = lineIndent(text, el.start);
    if (el.parent && indent !== null) {
      const parentIndent = lineIndent(text, el.parent.start);
      if (parentIndent !== null && indent.length > parentIndent.length && indent.startsWith(parentIndent)) {
        const unit = indent.slice(parentIndent.length);
        units.set(unit, (units.get(unit) ?? 0) + 1);
      }
    }
    if (el.allAttrs.length >= 2) {
      const gap = text.slice(el.allAttrs[0].end, el.allAttrs[1].start);
      if (gap.includes('\n')) {
        multi += 1;
        if (!layout && indent !== null && !text.slice(el.nameEnd, el.allAttrs[0].start).includes('\n')) {
          const cont = /[ \t]*$/.exec(gap)[0];
          if (cont === indent + ' '.repeat(el.name.length + 2)) layout = { mode: 'aligned' };
          else if (cont.startsWith(indent) && cont.length > indent.length) layout = { mode: 'hanging', hang: cont.slice(indent.length) };
        }
      } else single += 1;
    }
  }
  const unit = [...units].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '  ';
  // Namespaces the file declares on the elements themselves (xmlns="…" on each, e.g. Bizagi's DI and
  // DC elements) rather than with a prefix on the root: new elements do the same.
  const rootBound = new Set(Object.values(doc.root.nsDecls));
  const localNs = new Set();
  let declLast = 0;
  let declFirst = 0;
  for (const el of walk(doc.root)) {
    if (el === doc.root || el.nsDecls[''] === undefined || el.nsDecls[''] !== el.uri || rootBound.has(el.uri)) continue;
    localNs.add(el.uri);
    const k = el.allAttrs.findIndex((a) => a.name === 'xmlns');
    if (el.allAttrs.length > 1 && k === el.allAttrs.length - 1) declLast += 1;
    else if (el.allAttrs.length > 1 && k === 0) declFirst += 1;
  }
  return {
    localNs,
    localDeclLast: declLast > declFirst,
    eol,
    unit,
    quote: quotes["'"] > quotes['"'] ? "'" : '"',
    selfClose: tight > spaced ? '/>' : ' />',
    layout: multi > single && layout ? layout : { mode: 'single' },
    entities: doc.entities ?? { names: new Set(), external: false },
  };
}

/** Escapes an attribute value for the given quote. */
export function escapeAttr(value, quote = '"') {
  const out = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
  return quote === '"' ? out.replaceAll('"', '&quot;') : out.replaceAll("'", '&apos;');
}

const escapeText = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Escaped text with the references to the file's own entities written back as references
 * (`&amp;company;` -> `&company;`): bpmn-js shows and writes them as literal text.
 */
function refsBack(escaped, entities) {
  if (!entities.names.size && !entities.external) return escaped;
  return escaped.replace(/&amp;([^;&\s<]+);/g, (match, name) => (
    !Object.hasOwn(PREDEFINED, name) && NAME_CHECK.test(name) && (entities.names.has(name) || entities.external) ? `&${name};` : match));
}

// ---------------------------------------------------------------------------------------------
// Writing elements in the file's style

/**
 * Renders element `u` (of bpmn-js' output) in the file's style. `indent` is the indentation of the
 * line it starts on; `names` maps names and values to what is written on disk (element(u),
 * attr(u, a), value(u, a); substitute(u, indent): text to write instead of a child, if any;
 * declarations(u): [name, uri] namespace declarations to write on it).
 */
function renderElement(u, style, indent, names) {
  const substitute = names.substitute?.(u, indent);
  if (substitute !== undefined) return substitute;
  const name = names.element(u);
  const attrs = [];
  for (const a of u.allAttrs) {
    const isDecl = a.name === 'xmlns' || a.name.startsWith('xmlns:');
    const attrName = isDecl ? a.name : names.attr(u, a);
    const value = isDecl ? decodeAttr(a.raw) : names.value(u, a);
    attrs.push(`${attrName}=${style.quote}${refsBack(escapeAttr(value, style.quote), style.entities)}${style.quote}`);
  }
  // A namespace declared on the element itself, where the file does that (see detectStyle localNs).
  const extra = (names.declarations?.(u) ?? []).map(([attrName, uri]) => `${attrName}=${style.quote}${escapeAttr(uri, style.quote)}${style.quote}`);
  if (style.localDeclLast) attrs.push(...extra);
  else attrs.unshift(...extra);
  let head = `<${name}`;
  if (attrs.length) {
    if (attrs.length < 2 || style.layout.mode === 'single') head += ` ${attrs.join(' ')}`;
    else {
      const cont = style.eol + indent + (style.layout.mode === 'aligned' ? ' '.repeat(name.length + 2) : style.layout.hang);
      head += ` ${attrs.join(cont)}`;
    }
  }
  const kids = u.children.filter((c) => !(c.kind === 'text' && !/\S/.test(c.raw)) && !(c.kind === 'element' && isInvisible(c)));
  if (!kids.length) return head + style.selfClose;
  const eolText = (c) => (c.kind === 'text' ? refsBack(c.raw, style.entities) : c.raw).replace(/\r?\n/g, style.eol);
  if (kids.every((c) => c.kind === 'text' || c.kind === 'cdata')) {
    return `${head}>${kids.map(eolText).join('')}</${name}>`;
  }
  const inner = indent + style.unit;
  const body = kids.map((c) => style.eol + inner
    + (c.kind === 'element' ? renderElement(c, style, inner, names) : eolText(c).trim())).join('');
  return `${head}>${body}${style.eol}${indent}</${name}>`;
}

/** Applies edits ({ start, end, str, seq }) to `text`; throws WriterFallback if two overlap. */
function applyEdits(text, edits) {
  // From the end. At the same offset a replaced range first, then insertions in the order they were
  // made (each lands in front of the ones applied before it).
  const isRange = (e) => (e.end > e.start ? 1 : 0);
  const sorted = [...edits].sort((x, y) => y.start - x.start || isRange(y) - isRange(x) || y.seq - x.seq);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].end > sorted[k - 1].start) throw new WriterFallback('overlapping changes');
  }
  let result = text;
  for (const e of sorted) result = result.slice(0, e.start) + e.str + result.slice(e.end);
  return result;
}

// ---------------------------------------------------------------------------------------------
// The minimal-diff writer

/** Canonical form of an element's own content (attributes, text, children; children with an id as #id). */
function contentForm(el) {
  const attrs = el.attrs.map((a) => `${attrKey(a)}=${attrValue(el, a)}`).sort().join(' ');
  return `${qn(el)}[${attrs}](${textOf(el)}){${elementChildren(el).map(shapeForm).join(',')}}`;
}

/** Form of an element for aligning lists of elements without ids. */
function shapeForm(el) {
  const id = idOf(el);
  return id === null ? contentForm(el) : `#${id}`;
}

/**
 * Aligns two lists of elements without ids: equal forms (longest common subsequence) are 'same';
 * between those, elements of the same name are paired in order as 'changed'; the rest are removed
 * (b only) or added (u only). Returns { pairs: [{ b, u, same }], removed, added }.
 */
function align(bList, uList) {
  const bf = bList.map(shapeForm);
  const uf = uList.map(shapeForm);
  const m = bList.length;
  const n = uList.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) lcs[i][j] = bf[i] === uf[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const pairs = [];
  const removed = [];
  const added = [];
  let gapB = [];
  let gapU = [];
  const closeGap = () => {
    for (const b of gapB) {
      const k = gapU.findIndex((u) => qn(u) === qn(b));
      if (k === -1) removed.push(b);
      else {
        pairs.push({ b, u: gapU[k], same: false });
        added.push(...gapU.slice(0, k));
        gapU = gapU.slice(k + 1);
      }
    }
    added.push(...gapU);
    gapB = [];
    gapU = [];
  };
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && bf[i] === uf[j]) {
      closeGap();
      pairs.push({ b: bList[i], u: uList[j], same: true });
      i += 1;
      j += 1;
    } else if (j >= n || (i < m && lcs[i + 1][j] >= lcs[i][j + 1])) {
      gapB.push(bList[i]);
      i += 1;
    } else {
      gapU.push(uList[j]);
      j += 1;
    }
  }
  closeGap();
  return { pairs, removed, added };
}

/** Form of an element with its whole subtree, ids included (bpmn-js' model of it). */
function deepForm(el) {
  const attrs = el.attrs.map((a) => `${attrKey(a)}=${attrValue(el, a)}`).sort().join(' ');
  return `${qn(el)}[${attrs}](${textOf(el)}){${elementChildren(el).map(deepForm).join(',')}}`;
}

/** Namespace declarations in scope at `el` (closest first wins). */
function scopeAt(el) {
  const scope = {};
  for (let e = el; e; e = e.parent) for (const [p, uri] of Object.entries(e.nsDecls)) if (!Object.hasOwn(scope, p)) scope[p] = uri;
  return scope;
}

/** Re-indents `text` (an element's text that started on a line indented `from`) for indentation `to`. */
function reindentText(text, from, to) {
  return text.split('\n').map((line, k) => (k > 0 && line.startsWith(from) ? to + line.slice(from.length) : line)).join('\n');
}

/**
 * The text of an element (with id) written back from memory (see writeMinimal), parsed in a wrapper
 * with the namespaces it was in scope of: its facts, and the paths it covers.
 */
function restoredFacts(restored) {
  const fm = new Map();
  const paths = new Set();
  for (const r of restored) {
    const decls = Object.entries(r.scope).map(([p, uri]) => `${p ? `xmlns:${p}` : 'xmlns'}="${escapeAttr(uri)}"`).join(' ');
    const doc = load(`<restored ${decls}>${r.text}</restored>`);
    for (const [k, v] of facts(doc)) fm.set(k, v);
    for (const el of walk(doc.root)) if (el !== doc.root) paths.add(el.path);
  }
  return { fm, paths };
}

/**
 * Writes the changes bpmn-js made (B -> U) into the file's text (D); all three annotated documents.
 * Returns { text, removed, restored }. Throws WriterFallback when it cannot (the caller falls back).
 *
 * `memory`: Map(id -> [{ text, form, indent, scope, after, before }], oldest first) of elements with an id that earlier writes cut
 * from the file (`removed` are this write's). An element bpmn-js brings back (e.g. undo of a delete)
 * with exactly the model it had then is written back with its old text (`restored`), comments and all.
 *
 * Elements that keep their id keep their text on disk: changes are patched into it, an element moved
 * to another parent is cut and inserted there with its own text (re-indented), an element replaced by
 * another type gets the new name in its tags. Only new elements are written from bpmn-js' output.
 */
function writeMinimal(D, B, U, memory = new Map()) {
  const text = D.text;
  const style = detectStyle(D);
  const { eol, unit } = style;
  const edits = [];
  let seq = 0;
  const edit = (start, end, str) => edits.push({ start, end, str, seq: seq++ });
  const counterpart = new Map(); // element of U -> element of D
  const planned = new Map(); // element of D -> { prefix: uri } declarations to add
  // element of D -> { prefix: uri } declarations bpmn-js added there; written only where needed.
  const offered = new Map();
  const cut = new Set(); // elements of D removed
  const moving = []; // [u, d]: moved to another parent, relocated with its text
  const intoNew = new Map(); // element of U moved into a new element -> { mark, indent } where its text goes
  const retyped = []; // [u, d]: replaced by another type (same id), renamed in place
  const renamed = new Map(); // element of D -> its new qualified name
  const inserts = []; // elements of U to insert
  const status = new Map();
  const offsets = layoutOffsets(D, B);
  const aliases = diAliases(B, U); // new id in U -> the id it has on disk (and in B)
  const aliased = new Set(aliases.values());
  const onDiskId = (id) => aliases.get(id) ?? id;
  const parentPath = (el) => (el.parent ? el.parent.path : '');
  const nameOf = (d) => renamed.get(d) ?? d.name;
  const attrText = (value, quote) => refsBack(escapeAttr(value, quote), style.entities);

  if (qn(D.root) !== qn(B.root) || qn(B.root) !== qn(U.root)) throw new WriterFallback('the root element differs');
  for (const id of U.ids.keys()) status.set(id, B.ids.has(onDiskId(id)) ? 'kept' : 'added');

  const resolveD = (el, prefix) => {
    if (prefix === 'xml') return XML_NS;
    for (let e = el; e; e = e.parent) {
      const extra = planned.get(e);
      if (extra && Object.hasOwn(extra, prefix)) return extra[prefix];
      if (Object.hasOwn(e.nsDecls, prefix)) return e.nsDecls[prefix] || null;
    }
    return prefix === '' ? null : undefined;
  };
  const planDecl = (d, prefix, uri) => {
    if (resolveD(d, prefix) === uri) return;
    const extra = planned.get(d) ?? {};
    if (Object.hasOwn(d.nsDecls, prefix) || Object.hasOwn(extra, prefix)) {
      throw new WriterFallback(`prefix "${prefix}" is bound to another namespace on disk`);
    }
    extra[prefix] = uri;
    planned.set(d, extra);
  };
  /** Prefix to use on disk at `d` for namespace `uri` that bpmn-js wrote with prefix `p`. */
  const prefixFor = (d, uri, p, isAttr, scope = null) => {
    if (scope && Object.hasOwn(scope, p)) return { prefix: p };
    if (resolveD(d, p) === uri && !(isAttr && p === '')) return { prefix: p };
    const seen = new Set();
    for (let e = d; e; e = e.parent) {
      for (const decls of [planned.get(e) ?? {}, e.nsDecls]) {
        for (const [q, v] of Object.entries(decls)) {
          if (seen.has(q)) continue;
          seen.add(q);
          if (v === uri && !(isAttr && q === '') && (!scope || !Object.hasOwn(scope, q))) return { prefix: q };
        }
      }
    }
    if (p !== '' && resolveD(d, p) === undefined && (!scope || !Object.hasOwn(scope, p))) {
      // Declared where bpmn-js declared it (closest), else on the root element.
      let at = D.root;
      for (let e = d; e; e = e.parent) {
        if (offered.get(e)?.[p] === uri) {
          at = e;
          break;
        }
      }
      planDecl(at, p, uri);
      return { prefix: p };
    }
    if (p === '' && !isAttr) return { prefix: '', declareDefault: true };
    throw new WriterFallback(`no prefix for namespace ${uri} on disk`);
  };
  const qualify = (prefix, local) => (prefix ? `${prefix}:${local}` : local);
  /** The value to write for attribute `a` of `u`: xsi:type with the file's prefix, layout moved back. */
  const valueFor = (u, a, d, scope = null) => {
    if (isLayoutAttr(a) && isNumber(a.value)) {
      const offset = offsetOf(u, offsets);
      if (offset) return shiftValue(a.value, a.local === 'x' ? offset.dx : offset.dy);
    }
    if (a.uri !== XSI_NS || a.local !== 'type') return a.value;
    const [p, l] = splitName(a.value.trim());
    if (!p) return a.value;
    const uri = resolvePrefix(u, p);
    if (uri === undefined || uri === null) return a.value;
    return qualify(prefixFor(d, uri, p, false, scope).prefix, l);
  };

  /** Name mapping for rendering a subtree of U under `dParent` (see renderElement). */
  const namesUnder = (dParent, top, topExtra = {}) => {
    const scopes = new Map(); // element of U -> namespace declarations in scope within the snippet
    const scopeOf = (u) => {
      if (!scopes.has(u)) scopes.set(u, { ...(u === top ? topExtra : scopeOf(u.parent)), ...u.nsDecls });
      return scopes.get(u);
    };
    const local = new Map(); // element of U -> default namespace declared on it
    const names = {
      element(u) {
        const scope = scopeOf(u);
        const p = u.prefix;
        if (Object.hasOwn(scope, p) && scope[p] === u.uri) return qualify(p, u.local);
        const inScope = Object.hasOwn(scope, '') ? scope[''] : resolveD(dParent, '');
        const declareHere = () => {
          scope[''] = u.uri ?? '';
          local.set(u, u.uri ?? '');
          return u.local;
        };
        if (style.localNs.has(u.uri)) return inScope === u.uri ? u.local : declareHere();
        const mapped = prefixFor(dParent, u.uri, p, false, scope);
        return mapped.declareDefault ? declareHere() : qualify(mapped.prefix, u.local);
      },
      declarations: (u) => (local.has(u) ? [['xmlns', local.get(u)]] : []),
      attr(u, a) {
        if (!a.prefix) return a.name;
        return qualify(prefixFor(dParent, a.uri, a.prefix, true, scopeOf(u)).prefix, a.local);
      },
      value: (u, a) => valueFor(u, a, dParent, scopeOf(u)),
      substitute(u, indent) {
        if (u === top || !intoNew.has(u)) return undefined;
        const spot = intoNew.get(u);
        spot.indent = indent;
        return spot.mark;
      },
    };
    return { names };
  };
  const render = (u, dParent, indent) => renderElement(u, style, indent, namesUnder(dParent, u).names);

  const insertAttr = (d, name, value) => {
    const all = d.allAttrs;
    const last = all[all.length - 1];
    const quote = last?.quote ?? style.quote;
    const attr = `${name}=${quote}${attrText(value, quote)}${quote}`;
    if (!last) {
      edit(d.nameEnd, d.nameEnd, ` ${attr}`);
      return;
    }
    let sep = ' ';
    if (all.length > 1) {
      const gap = text.slice(all[all.length - 2].end, last.start);
      if (gap.includes('\n')) sep = eol + /[ \t]*$/.exec(gap)[0];
    } else if (style.layout.mode !== 'single') {
      const indent = lineIndent(text, d.start);
      if (indent !== null) sep = eol + indent + (style.layout.mode === 'aligned' ? ' '.repeat(d.name.length + 2) : style.layout.hang);
    }
    edit(last.end, last.end, sep + attr);
  };
  const removeAttr = (d, a) => {
    const k = d.allAttrs.findIndex((x) => x.start === a.start);
    edit(k > 0 ? d.allAttrs[k - 1].end : d.nameEnd, a.end, '');
  };
  /** The range of `d` in the text, with its line if it is alone on it. */
  const lineRange = (d) => {
    const indent = lineIndent(text, d.start);
    if (indent !== null) {
      const nl = text.indexOf('\n', d.end);
      const rest = text.slice(d.end, nl === -1 ? text.length : nl);
      if (/^[ \t\r]*$/.test(rest) && nl !== -1) return [d.start - indent.length, nl + 1];
    }
    return [d.start, d.end];
  };
  const removeElement = (d) => {
    const [start, end] = lineRange(d);
    edit(start, end, '');
    cut.add(d);
  };
  const writeText = (d, value) => {
    const hasCdata = d.children.some((c) => c.kind === 'cdata');
    const body = (hasCdata && !value.includes(']]>') ? `<![CDATA[${value}]]>` : refsBack(escapeText(value), style.entities))
      .replace(/\r?\n/g, eol);
    if (d.selfClosing) {
      let slash = d.openEnd - 2;
      while (isWs(text[slash - 1])) slash -= 1;
      edit(slash, d.openEnd, `>${body}</${nameOf(d)}>`);
      return;
    }
    const inner = text.slice(d.openEnd, d.closeStart);
    const lead = /^\s*/.exec(inner)[0];
    const trail = inner.length > lead.length ? /\s*$/.exec(inner)[0] : '';
    edit(d.openEnd + lead.length, d.closeStart - trail.length, value ? body : '');
  };
  const sameShape = (u, d) => {
    // Matched (unchanged) elements without an id: map their children to the disk too.
    counterpart.set(u, d);
    const byName = (list) => {
      const groups = new Map();
      for (const e of list.filter((x) => idOf(x) === null)) groups.set(qn(e), [...(groups.get(qn(e)) ?? []), e]);
      return groups;
    };
    const ud = byName(elementChildren(u));
    const dd = byName(elementChildren(d));
    for (const [name, list] of ud) {
      const dl = dd.get(name) ?? [];
      if (dl.length === list.length) list.forEach((e, k) => sameShape(e, dl[k]));
    }
  };

  /** Patches what bpmn-js changed from `b` to `u` into `d`. `keep`: keep extensions bpmn-js dropped (markKept). */
  const diffElement = (b, u, d, keep = false) => {
    counterpart.set(u, d);
    for (const [p, uri] of Object.entries(u.nsDecls)) {
      if (b.nsDecls[p] !== uri && uri && p) offered.set(d, { ...offered.get(d), [p]: uri });
    }
    const bA = new Map(b.attrs.map((a) => [attrKey(a), a]));
    const dA = new Map(d.attrs.map((a) => [attrKey(a), a]));
    const uKeys = new Set();
    const offset = offsetOf(u, offsets);
    for (const ua of u.attrs) {
      const key = attrKey(ua);
      uKeys.add(key);
      const ba = bA.get(key);
      if (ba && sameValue(literal(attrValue(b, ba)), attrValue(u, ua))) continue;
      const value = valueFor(u, ua, d);
      const da = dA.get(key);
      if (da) {
        const dv = literal(attrValue(d, da));
        if (ba) {
          const shift = offset && isLayoutAttr(ba) && isNumber(ba.value) ? (ba.local === 'x' ? offset.dx : offset.dy) : null;
          const expected = shift === null ? literal(attrValue(b, ba)) : shiftValue(ba.value, shift);
          if (!sameValue(dv, expected)) throw new WriterFallback(`${u.path} ${key}: the value on disk differs from the editor's`);
        }
        if (literal(da.value) === value) continue;
        edit(da.valueStart, da.valueEnd, attrText(value, da.quote));
      } else {
        insertAttr(d, ua.prefix ? qualify(prefixFor(d, ua.uri, ua.prefix, true).prefix, ua.local) : ua.name, value);
      }
    }
    for (const [key, ba] of bA) {
      if (uKeys.has(key) || (keep && isUnknownNs(ba.uri))) continue;
      const da = dA.get(key);
      if (da) removeAttr(d, da);
    }
    const bKids = elementChildren(b);
    const uKids = elementChildren(u);
    const dKids = elementChildren(d);
    const tb = literal(textOf(b)); // the base is the disk text when there is no other (unbased)
    const tu = textOf(u);
    if (tb !== tu) {
      if (bKids.length || uKids.length || dKids.length) throw new WriterFallback(`${u.path}: text changed in mixed content`);
      if (literal(textOf(d)) !== tb) throw new WriterFallback(`${u.path}: the text on disk differs from the editor's`);
      if (d.children.some((c) => c.kind === 'comment' || c.kind === 'pi')) throw new WriterFallback(`${u.path}: text next to a comment`);
      writeText(d, tu);
    }
    const noId = (list) => list.filter((e) => idOf(e) === null);
    const bList = noId(bKids);
    const dList = noId(dKids);
    const { pairs, removed, added } = align(bList, noId(uKids));
    const dFor = (bEl) => {
      const same = (list) => list.filter((e) => qn(e) === qn(bEl));
      const bs = same(bList);
      const ds = same(dList);
      return bs.length === ds.length ? ds[bs.indexOf(bEl)] : null;
    };
    for (const { b: bc, u: uc, same } of pairs) {
      const dc = dFor(bc);
      if (same) {
        if (dc) sameShape(uc, dc);
      } else {
        if (!dc) throw new WriterFallback(`${uc.path}: cannot find it on disk`);
        diffElement(bc, uc, dc, keep);
      }
    }
    const claimed = new Set();
    for (const { b: bc } of pairs) claimed.add(dFor(bc));
    for (const bc of removed) {
      if (keep && (isUnknownNs(bc.uri) || isExtensionElements(bc))) {
        claimed.add(dFor(bc));
        continue;
      }
      const dc = dFor(bc);
      if (!dc) throw new WriterFallback(`${bc.path}: cannot find it on disk`);
      claimed.add(dc);
      removeElement(dc);
    }
    for (const uc of added) {
      // What only the disk has here and bpmn-js now has the same of (e.g. extensions kept when bpmn-js
      // dropped them on a type change, back with an undo): that is it, with its text.
      const form = contentForm(uc);
      const dc = dList.find((e) => !claimed.has(e) && qn(e) === qn(uc) && literal(contentForm(e)) === form);
      if (dc) {
        claimed.add(dc);
        sameShape(uc, dc);
      } else inserts.push(uc);
    }
  };

  // Elements of U in document order: changes to elements with an id (and to everything without an id
  // below them), and the elements to insert. `inNew`: inside an element written from bpmn-js' output.
  const visit = (u, inNew = false) => {
    const id = idOf(u);
    if (inNew && (id === null || !B.ids.has(onDiskId(id)))) {
      for (const c of elementChildren(u)) visit(c, true);
      return;
    }
    if (inNew) {
      // Moved into an element that is new: its own text goes where the new element's text has it.
      const d = D.ids.get(onDiskId(id));
      const b = B.ids.get(onDiskId(id));
      if (!d) throw new WriterFallback(`#${id} is not on disk`);
      const retype = qn(b) !== qn(u);
      diffElement(b, u, d, retype);
      if (retype) retyped.push([u, d]);
      moving.push([u, d]);
      intoNew.set(u, { mark: `\u0000move:${id}\u0000`, indent: null });
      for (const c of elementChildren(u)) visit(c);
      return;
    }
    if (id !== null) {
      if (status.get(id) === 'added') {
        inserts.push(u);
        for (const c of elementChildren(u)) visit(c, true);
        return;
      }
      const b = B.ids.get(onDiskId(id));
      const d = D.ids.get(onDiskId(id));
      if (!d) {
        // Only in bpmn-js' view of the file (e.g. a diagram it made for a collapsed sub-process on
        // import): nothing to write unless it changed itself; its descendants may be on disk.
        if (contentForm(b) !== contentForm(u) || parentPath(b) !== parentPath(u)) throw new WriterFallback(`#${id} is not on disk`);
      } else {
        const retype = qn(b) !== qn(u);
        diffElement(b, u, d, retype);
        if (retype) retyped.push([u, d]);
        if (parentPath(u) !== parentPath(b)) moving.push([u, d]);
      }
    } else if (u === U.root) {
      diffElement(B.root, U.root, D.root);
    } else if (!counterpart.has(u)) {
      // Written from bpmn-js' output (inserted below), or not on disk itself: look further down.
      const inserted = inserts.includes(u);
      for (const c of elementChildren(u)) visit(c, inserted);
      return;
    }
    for (const c of elementChildren(u)) visit(c);
  };
  visit(U.root);

  const isMoving = (d) => moving.some(([, m]) => m === d);
  const inside = (d, set) => {
    for (let e = d; e; e = e.parent) if (set(e)) return true;
    return false;
  };
  // Elements with an id that bpmn-js removed: cut from the disk text.
  const removedNow = [];
  for (const id of B.ids.keys()) {
    if (U.ids.has(id) || aliased.has(id)) continue;
    const d = D.ids.get(id);
    if (!d || inside(d, (e) => cut.has(e))) continue; // only bpmn-js had it, or it goes with its parent
    // Where it was: the element (with an id) before it on disk, else the one after it.
    const siblings = d.parent ? elementChildren(d.parent) : [];
    const at = siblings.indexOf(d);
    const after = siblings.slice(0, at).reverse().find((e) => idOf(e) !== null);
    const before = after ? null : siblings.slice(at + 1).find((e) => idOf(e) !== null);
    const b = B.ids.get(id);
    removedNow.push([id, {
      text: text.slice(d.start, d.end), form: deepForm(b), indent: lineIndent(text, d.start) ?? '', scope: scopeAt(d.parent),
      after: after ? idOf(after) : null, before: before ? idOf(before) : null,
      // bpmn-js' text of it then: what it comes back from when bpmn-js changed it meanwhile (see restoreFirst).
      baseText: B.text.slice(b.start, b.end), baseScope: scopeAt(b.parent),
    }]);
    removeElement(d);
  }
  // Replaced by another type: the new name in the tags (the content is patched like any other).
  for (const [u, d] of retyped) {
    const mapped = prefixFor(d, u.uri, u.prefix, false);
    if (mapped.declareDefault) throw new WriterFallback(`#${idOf(u)}: default namespace differs on disk`);
    const name = qualify(mapped.prefix, u.local);
    renamed.set(d, name);
    edit(d.start + 1, d.nameEnd, name);
    if (!d.selfClosing) edit(d.closeStart + 2, d.closeStart + 2 + d.name.length, name);
  }

  /** Where `u` (a new child of `dParent` in U) goes in the disk text: next to its nearest sibling on disk. */
  const placeAt = (u, dParent, write) => {
    const siblings = elementChildren(u.parent);
    const at = siblings.indexOf(u);
    const anchor = (s) => {
      const id = idOf(s);
      const d = id !== null ? (status.get(id) === 'kept' ? D.ids.get(onDiskId(id)) ?? null : null) : counterpart.get(s) ?? null;
      return d && d.parent === dParent && !cut.has(d) && !isMoving(d) ? d : null;
    };
    let prev = null;
    for (let k = at - 1; k >= 0 && !prev; k--) prev = anchor(siblings[k]);
    let next = null;
    if (!prev) for (let k = at + 1; k < siblings.length && !next; k++) next = anchor(siblings[k]);
    const parentIndent = lineIndent(text, dParent.start) ?? '';
    if (prev) {
      const indent = lineIndent(text, prev.start) ?? parentIndent + unit;
      edit(prev.end, prev.end, eol + indent + write(indent));
    } else if (next) {
      const indent = lineIndent(text, next.start);
      edit(next.start, next.start, write(indent ?? parentIndent + unit) + (indent === null ? '' : eol + indent));
    } else {
      const indent = parentIndent + unit;
      const snippet = write(indent);
      if (dParent.selfClosing) {
        let slash = dParent.openEnd - 2;
        while (isWs(text[slash - 1])) slash -= 1;
        edit(slash, dParent.openEnd, `>${eol}${indent}${snippet}${eol}${parentIndent}</${nameOf(dParent)}>`);
      } else if (dParent.children.every((c) => c.kind === 'text' && !/\S/.test(c.raw))) {
        edit(dParent.openEnd, dParent.closeStart, `${eol}${indent}${snippet}${eol}${parentIndent}`);
      } else {
        edit(dParent.openEnd, dParent.openEnd, eol + indent + snippet);
      }
    }
  };

  // New elements, written from bpmn-js' output in the file's style.
  inserts.sort((x, y) => x.start - y.start);
  const restored = [];
  const unused = []; // remembered, but written from bpmn-js' output (see minimalWrite: their losses are reported)
  // Elements bpmn-js brings back with the model they had when a write cut them (see `memory`).
  const plans = new Map(); // id -> { u, kept, dParent }
  for (const u of inserts) {
    const dParent = counterpart.get(u.parent);
    if (!dParent || inside(dParent, (e) => cut.has(e))) throw new WriterFallback(`${u.path}: its parent is not on disk`);
    const versions = idOf(u) !== null ? memory.get(idOf(u)) ?? [] : [];
    if (!versions.length) continue;
    // Its old text if bpmn-js has the same model of it as then (the latest such version: an id can be
    // cut, pasted, cut again, ...); else (bpmn-js changed it on the way back) at least its old place,
    // written from bpmn-js' output.
    const form = deepForm(u);
    const fits = (v) => v.form === form && Object.entries(v.scope).every(([p, uri]) => resolveD(dParent, p) === uri);
    const kept = [...versions].reverse().find(fits) ?? versions[versions.length - 1];
    const same = fits(kept);
    plans.set(idOf(u), { u, kept, dParent, same });
    if (same) restored.push({ id: idOf(u), text: kept.text, scope: kept.scope });
    else unused.push({ id: idOf(u), text: kept.text, scope: kept.scope });
  }
  // One whose old neighbour comes back too goes next to it (e.g. a task and its flows deleted together).
  const follows = new Map(); // id -> [plans placed right after it]
  const precedes = new Map(); // id -> [plans placed right before it]
  const chained = new Set();
  for (const [id, plan] of plans) {
    const { after, before } = plan.kept;
    const to = after ?? before;
    if (to && plans.has(to) && plans.get(to).dParent === plan.dParent && to !== id) {
      const map = after ? follows : precedes;
      map.set(to, [...(map.get(to) ?? []), plan]);
      chained.add(id);
    }
  }
  const emit = (plan, indent, seen = new Set()) => {
    const id = idOf(plan.u);
    if (seen.has(id)) throw new WriterFallback(`#${id}: restored elements in a cycle`);
    seen.add(id);
    const own = plan.same ? reindentText(plan.kept.text, plan.kept.indent, indent) : render(plan.u, plan.dParent, indent);
    const pre = (precedes.get(id) ?? []).map((p) => emit(p, indent, seen) + eol + indent).join('');
    const post = (follows.get(id) ?? []).map((p) => eol + indent + emit(p, indent, seen)).join('');
    return pre + own + post;
  };
  for (const u of inserts) {
    const dParent = counterpart.get(u.parent);
    const plan = idOf(u) !== null ? plans.get(idOf(u)) : undefined;
    if (!plan) {
      placeAt(u, dParent, (indent) => render(u, dParent, indent));
      continue;
    }
    if (chained.has(idOf(u))) continue; // written with the element it goes next to
    const write = (indent) => emit(plan, indent);
    // Back where it was, if its old neighbour is still there (bpmn-js may re-add it elsewhere).
    const { kept } = plan;
    const near = D.ids.get(kept.after ?? kept.before ?? '');
    if (near && near.parent === dParent && !cut.has(near) && !isMoving(near) && status.get(idOf(near)) === 'kept') {
      const indent = lineIndent(text, near.start);
      if (kept.after) edit(near.end, near.end, eol + (indent ?? '') + write(indent ?? kept.indent));
      else edit(near.start, near.start, write(indent ?? kept.indent) + (indent === null ? '' : eol + indent));
    } else placeAt(u, dParent, write);
  }

  // Namespace declarations (rendering may have planned more).
  for (const [d, decls] of planned) {
    for (const [prefix, uri] of Object.entries(decls)) insertAttr(d, prefix ? `xmlns:${prefix}` : 'xmlns', uri);
  }

  // Moved to another parent: the element's own text, with the changes inside it, cut and inserted there.
  moving.sort(([x], [y]) => x.start - y.start);
  for (const [u, d] of moving) {
    const id = idOf(u);
    if (inside(d, (e) => cut.has(e)) || inside(d.parent, isMoving)) throw new WriterFallback(`#${id}: moved together with its parent`);
    const spot = intoNew.get(u);
    const dParent = spot ? null : counterpart.get(u.parent);
    if (!spot && (!dParent || inside(dParent, (e) => e === d || cut.has(e) || isMoving(e)))) {
      throw new WriterFallback(`#${id}: its new parent is not on disk`);
    }
    const [from, to] = [d.start, d.end];
    const within = [];
    for (let k = edits.length - 1; k >= 0; k--) {
      const e = edits[k];
      const insertionAtEdge = e.start === e.end && (e.start === from || e.start === to);
      if (!insertionAtEdge && e.start >= from && e.end <= to) {
        within.push({ ...e, start: e.start - from, end: e.end - from });
        edits.splice(k, 1);
      } else if ((e.start < from && e.end > from) || (e.start < to && e.end > to)) {
        throw new WriterFallback(`#${id}: changes across its boundary`);
      }
    }
    const own = applyEdits(text.slice(from, to), within);
    const oldIndent = lineIndent(text, d.start) ?? '';
    const reindent = (indent) => own.split('\n')
      .map((line, k) => (k > 0 && line.startsWith(oldIndent) ? indent + line.slice(oldIndent.length) : line)).join('\n');
    removeElement(d);
    if (!spot) {
      placeAt(u, dParent, reindent);
      continue;
    }
    const holder = edits.find((e) => e.str.includes(spot.mark));
    if (!holder || spot.indent === null) throw new WriterFallback(`#${id}: its new parent was not written`);
    holder.str = holder.str.replace(spot.mark, () => reindent(spot.indent));
  }
  if (edits.some((e) => e.str.includes('\u0000'))) throw new WriterFallback('an element moved into a new one was not placed');

  return { text: applyEdits(text, edits), removed: removedNow, restored, unused };
}

/** Short description of a comment or processing instruction (for notes about what was not kept). */
function describe(node) {
  const value = node.kind === 'comment' ? node.value.trim() : node.raw;
  const short = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return node.kind === 'comment' ? `comment "${short}"` : `processing instruction ${short}`;
}

/**
 * bpmn-js' output (`out`) written in the style of the file on disk, keeping its prolog and epilog,
 * texts as the file writes them (CDATA, entity references) where bpmn-js has the same text, and its
 * comments and processing instructions next to the same elements where those still exist.
 * Returns { text, lost }: `lost` describes the comments / PIs that had nowhere to go.
 */
export function preserveFormat(disk, out) {
  const D = load(disk);
  const U = parse(out);
  const style = detectStyle(D);
  const { eol, unit } = style;
  const identity = {
    element: (u) => u.name,
    attr: (u, a) => a.name,
    value: (u, a) => a.value,
  };
  const attrSet = (el) => el.allAttrs.map((a) => `${a.name}=${decodeAttr(a.raw)}`).sort().join('\n');
  const root = U.root;
  const head = D.root.name === root.name && attrSet(D.root) === attrSet(root)
    ? disk.slice(D.root.start, D.root.openEnd)
    : renderElement({ ...root, children: [] }, style, '', identity).replace(/\s*\/>$/, '>');
  const kids = root.children.filter((c) => !(c.kind === 'text' && !/\S/.test(c.raw)) && !(c.kind === 'element' && isInvisible(c)));
  const body = kids.map((c) => eol + unit
    + (c.kind === 'element' ? renderElement(c, style, unit, identity) : c.raw.trim())).join('');
  const first = `${disk.slice(0, D.root.start)}${head}${body}${eol}</${root.name}>${disk.slice(D.root.end)}`;

  // Carry over what bpmn-js does not keep: texts as written on disk, comments and PIs.
  const W = load(first);
  const byPath = new Map([...walk(W.root)].map((e) => [e.path, e]));
  const edits = [];
  let seq = 0;
  const edit = (start, end, str) => edits.push({ start, end, str, seq: seq++ });
  const carried = new Set();
  for (const d of walk(D.root)) {
    const w = byPath.get(d.path);
    if (!w || elementChildren(d).length || elementChildren(w).length || w.selfClosing || d.selfClosing) continue;
    if (!textOf(d) || literal(textOf(d)) !== literal(textOf(w))) continue;
    edit(w.openEnd, w.closeStart, disk.slice(d.openEnd, d.closeStart));
    for (const c of d.children) carried.add(c);
  }
  const lost = [];
  for (const dp of walk(D.root)) {
    const notes = dp.children.filter((c) => (c.kind === 'comment' || c.kind === 'pi') && !carried.has(c));
    if (!notes.length) continue;
    const wp = byPath.get(dp.path);
    for (const c of notes) {
      const k = dp.children.indexOf(c);
      const onDisk = (e) => e.kind === 'element' && !isInvisible(e) && byPath.get(e.path)?.parent === wp;
      const next = wp && dp.children.slice(k + 1).find(onDisk);
      const prev = wp && !next && dp.children.slice(0, k).reverse().find(onDisk);
      if (next) {
        const a = byPath.get(next.path);
        const indent = lineIndent(first, a.start);
        edit(a.start, a.start, c.raw + (indent === null ? '' : eol + indent));
      } else if (prev) {
        const a = byPath.get(prev.path);
        edit(a.end, a.end, eol + (lineIndent(first, a.start) ?? '') + c.raw);
      } else if (wp && !wp.selfClosing && elementChildren(wp).length) {
        edit(wp.closeStart, wp.closeStart, unit + c.raw + eol + (lineIndent(first, wp.start) ?? ''));
      } else lost.push(describe(c));
    }
  }
  return { text: applyEdits(first, edits), lost };
}

function assertBpmn(doc) {
  if (doc.root.uri !== BPMN_MODEL_NS || doc.root.local !== 'definitions') throw new XmlError('not a BPMN definitions document');
}

/**
 * The minimal-diff writer with its check (see the top of this file). `base` null: bpmn-js'
 * serialisation of the disk text is not known; the disk text itself is used as the base (exact for
 * files bpmn-js wrote, otherwise its normalisations are written too). Returns the text; throws
 * WriterFallback / XmlError if it cannot be sure.
 */
export function minimalDiff(disk, base, out, memory = new Map()) {
  return minimalWrite(disk, base, out, memory).text;
}

/** minimalDiff, with the elements it cut and wrote back from `memory` (see writeMinimal). */
function minimalWrite(disk, base, out, memory) {
  let D = load(disk);
  let B = base === null ? D : load(base);
  const U = load(out);
  for (const doc of [D, B, U]) assertBpmn(doc);
  // Elements bpmn-js brings back changed (e.g. undo re-adds its flow references in another order):
  // their remembered text, and bpmn-js' text of them then, go back first; the changes are patched in.
  let diskText = disk;
  let baseText = base ?? disk;
  if (base !== null) {
    const first = restoreFirst(D, B, U, memory);
    if (first) {
      [diskText, baseText] = [first.disk, first.base];
      [D, B] = [load(diskText), load(baseText)];
    }
  }
  const result = writeMinimal(D, B, U, memory);
  result.lost = lostFromMemory(result.unused, load(result.text));
  if (result.text === disk) return result;
  const W = load(result.text);
  const problems = [...checkMinimal(D, B, U, W, result.restored), ...checkForms(diskText, baseText, out, result.text)];
  if (problems.length) {
    throw new WriterFallback(`check failed: ${problems.slice(0, 3).join(', ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
  }
  return result;
}

/**
 * For elements (with an id) that bpmn-js brings back with a model other than any remembered one (see
 * writeMinimal `memory`): the disk text with their remembered text back in place (next to their old
 * neighbour, else last in their parent) and the base with bpmn-js' text of them then, so that the
 * write patches only what bpmn-js changed in them. Null if there are none.
 */
function restoreFirst(D, B, U, memory) {
  if (!memory?.size) return null;
  const plans = [];
  for (const [id, u] of U.ids) {
    if (B.ids.has(id) || D.ids.has(id)) continue;
    const versions = memory.get(id) ?? [];
    if (!versions.length || versions.some((v) => v.form === deepForm(u))) continue; // as it was: restored as such
    const kept = versions[versions.length - 1];
    const parentId = u.parent ? idOf(u.parent) : null;
    if (!kept.baseText || parentId === null) continue;
    plans.push({ id, kept, parentId });
  }
  if (!plans.length) return null;
  const fits = (el, scope) => Object.entries(scope).every(([p, uri]) => (resolvePrefix(el, p) ?? null) === (uri || null));
  let disk = D.text;
  let base = B.text;
  let pending = plans;
  while (pending.length) {
    const next = [];
    for (const plan of pending) {
      const d = load(disk);
      const b = load(base);
      const dParent = d.ids.get(plan.parentId);
      const bParent = b.ids.get(plan.parentId);
      if (!dParent || !bParent || dParent.selfClosing || bParent.selfClosing || d.ids.has(plan.id)
        || !fits(dParent, plan.kept.scope) || !fits(bParent, plan.kept.baseScope)) continue;
      const { after, before } = plan.kept;
      if (pending.some((p) => p !== plan && (p.id === after || p.id === before)) && !d.ids.has(after ?? before)) {
        next.push(plan); // its old neighbour comes back too: after that one
        continue;
      }
      const kids = elementChildren(dParent);
      const near = d.ids.get(after ?? before ?? '');
      const anchor = near && near.parent === dParent ? near : null;
      const last = kids[kids.length - 1];
      const at = anchor ?? last;
      if (!at) continue;
      const indent = lineIndent(disk, at.start) ?? '';
      const own = reindentText(plan.kept.text, plan.kept.indent, indent);
      const eol = detectStyle(d).eol;
      disk = anchor && !after
        ? disk.slice(0, at.start) + own + eol + indent + disk.slice(at.start)
        : disk.slice(0, at.end) + eol + indent + own + disk.slice(at.end);
      base = `${base.slice(0, bParent.closeStart)}${plan.kept.baseText}\n${base.slice(bParent.closeStart)}`;
    }
    if (next.length === pending.length) break; // neighbours in a cycle: leave them to the normal path
    pending = next;
  }
  return disk === D.text ? null : { disk, base };
}

/**
 * What remembered elements written from bpmn-js' output (not from their old text, see writeMinimal)
 * lose of that text: comments, PIs, CDATA, extensions. Descriptions, for notes.
 */
function lostFromMemory(unused, W) {
  if (!unused?.length) return [];
  const { fm } = restoredFacts(unused);
  const fw = facts(W);
  const lost = [];
  for (const [key, value] of fm) {
    const [type, path, detail] = key.split(SEP);
    if (path.startsWith('/') || fw.get(key) === value) continue; // the wrapper; kept
    if (type === 'comment') lost.push(`comment "${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`);
    else if (type === 'pi') lost.push(`processing instruction ${value.length > 40 ? `${value.slice(0, 40)}…` : value}`);
    else if (type === 'cdata') lost.push(`a CDATA section in ${path.replace(/\{[^}]*\}/g, '').replace(/^#/, '')}`);
    else if (type === 'el' && isUnknownNs(/^\{([^}]*)\}/.exec(value)?.[1])) lost.push(`element ${value.replace(/^\{[^}]*\}/, '')} in ${path.replace(/\{[^}]*\}/g, '').replace(/^#/, '').replace(/\/[^/]*$/, '')}`);
    else if (type === 'attr' && isUnknownNs(/^\{([^}]*)\}/.exec(detail)?.[1])) lost.push(`attribute ${detail.replace(/^\{[^}]*\}/, '')} in ${path.replace(/\{[^}]*\}/g, '').replace(/^#/, '')}`);
  }
  return lost;
}

/** How many removed elements `memory` keeps (see writeMinimal), and versions of each. */
const MEMORY_SIZE = 200;
const MEMORY_VERSIONS = 5;

/**
 * What `out` written as it is loses of the file on disk: its comments, PIs and DOCTYPE (a plain scan,
 * as the file may not be readable as XML).
 */
function lostByRaw(disk) {
  const lost = [];
  for (const m of disk.matchAll(/<!--([\s\S]*?)-->|<\?(?!xml[\s?])[\s\S]*?\?>|<!DOCTYPE/g)) {
    if (m[0] === '<!DOCTYPE') lost.push('the DOCTYPE');
    else lost.push(describe(m[1] !== undefined ? { kind: 'comment', value: m[1] } : { kind: 'pi', raw: m[0] }));
  }
  return lost;
}

/**
 * What the file `D` has that the text written (`W`) does not, other than in elements the edit deleted
 * (not in `U`, bpmn-js' output): comments, PIs, CDATA sections, the XML declaration and DOCTYPE, and
 * elements and attributes in namespaces bpmn-js does not know (extensions). Descriptions, for notes.
 */
function lostFacts(D, W, U) {
  const [fd, fw] = [facts(D), facts(W)];
  const byPath = new Map([...walk(D.root)].map((e) => [e.path, e]));
  const deleted = (path) => {
    const id = /^#([^/]+)/.exec(path)?.[1];
    return id !== undefined && !U.ids.has(id);
  };
  const where = (path) => (path === '^' || path === '$' ? 'outside the root element' : `in ${path.replace(/\{[^}]*\}/g, '').replace(/^#/, '')}`);
  const lostPaths = new Set();
  const under = (path) => {
    for (let p = path; p; p = p.slice(0, Math.max(p.lastIndexOf('/'), 0))) if (lostPaths.has(p)) return true;
    return false;
  };
  const lost = [];
  for (const [key, value] of fd) {
    const [type, path, detail] = key.split(SEP);
    if (deleted(path) || under(path)) continue;
    if (KEPT.has(type)) {
      if (fw.get(key) === value) continue;
      if (type === 'comment') lost.push(`comment "${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`);
      else if (type === 'pi') lost.push(`processing instruction ${value.length > 40 ? `${value.slice(0, 40)}…` : value}`);
      else if (type === 'cdata') lost.push(`a CDATA section ${where(path)}`);
      else if (type === 'doctype') lost.push('the DOCTYPE');
      else if (type === 'decl') lost.push('the XML declaration');
    } else if (type === 'el' && !fw.has(key) && isUnknownNs(/^\{([^}]*)\}/.exec(value)?.[1])) {
      lostPaths.add(path);
      lost.push(`element ${byPath.get(path)?.name ?? value} ${where(byPath.get(path)?.parent?.path ?? '')}`);
    } else if (type === 'attr' && !fw.has(key) && isUnknownNs(/^\{([^}]*)\}/.exec(detail)?.[1])) {
      const el = byPath.get(path);
      const name = el?.attrs.find((a) => attrKey(a) === detail)?.name ?? detail;
      lost.push(`attribute ${name} ${where(path)}`);
    }
  }
  return lost;
}

/**
 * Text to write for bpmn-js' output `out`, given the text on disk and bpmn-js' serialisation of it
 * (`base`, or null if unknown). Returns { text, mode, reason?, lost? }; mode:
 *   'minimal'  only the edit, patched into the file (checked);
 *   'unbased'  the same without a known base (checked; bpmn-js' normalisations are written too);
 *   'format'   fallback: bpmn-js' output in the file's style, with the file's prolog, epilog, texts,
 *              comments and PIs carried over where their elements still exist (checked);
 *   'raw'      last resort: bpmn-js' output as it is;
 *   'new'      nothing on disk to keep (missing or broken file): bpmn-js' output as it is.
 * `lost`: descriptions of comments / PIs / the DOCTYPE of the file that this text does not keep.
 * `memory` (optional, a Map kept by the caller across writes): the text of elements cut from the file,
 * so that an element bpmn-js brings back unchanged (undo) gets its old text again (see writeMinimal).
 */
export function renderForDisk({ disk, base = null, out, memory = null }) {
  if (typeof disk !== 'string') return { text: out, mode: 'new' };
  const reasons = [];
  const why = (err) => (err instanceof WriterFallback || err instanceof XmlError ? err.message : `internal error: ${err.message}`);
  try {
    const { text, removed, lost: forgotten } = minimalWrite(disk, base, out, memory ?? new Map());
    // Without a base, what bpmn-js does not keep on import looks like an edit: say what went.
    const lost = [...(base === null ? lostFacts(load(disk), load(text), load(out)) : []), ...forgotten];
    if (memory) {
      for (const [id, entry] of removed) {
        const versions = (memory.get(id) ?? []).filter((v) => v.text !== entry.text || v.form !== entry.form);
        memory.delete(id);
        memory.set(id, [...versions, entry].slice(-MEMORY_VERSIONS));
      }
      while (memory.size > MEMORY_SIZE) memory.delete(memory.keys().next().value);
    }
    return {
      text, mode: base === null ? 'unbased' : 'minimal', ...(base === null ? { reason: 'no base' } : {}), ...(lost.length ? { lost } : {}),
    };
  } catch (err) {
    reasons.push(why(err));
  }
  try {
    const { text } = preserveFormat(disk, out);
    const W = load(text);
    assertBpmn(W);
    const U = load(out);
    const problems = checkModel(W, U);
    if (problems.length) throw new WriterFallback(`format check failed: ${problems.slice(0, 3).join(', ')}`);
    const lost = lostFacts(load(disk), W, U);
    return { text, mode: 'format', reason: reasons.join('; '), ...(lost.length ? { lost } : {}) };
  } catch (err) {
    reasons.push(why(err));
  }
  let lost;
  try {
    lost = lostFacts(load(disk), load(out), load(out));
  } catch {
    lost = lostByRaw(disk);
  }
  return { text: out, mode: 'raw', reason: reasons.join('; '), ...(lost.length ? { lost } : {}) };
}
