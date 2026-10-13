// Element-level comparison of BPMN XML documents, for telling a save made from an older copy of the
// file from one that already has our changes (Q2: src/file.js, looksStale / containsChanges).
//
// Each document becomes a map: id -> canonical form of that element's own content. The form is the
// element name, its attributes in sorted order (the id included), its trimmed text, and the forms of
// its child elements that have no id (dc:Bounds, di:waypoint, bpmn:incoming, conditionExpression,
// documentation, labels, …), in document order. Children that have an id are elements of their own
// and are not part of the parent's form, so adding or removing one changes only that id. Content with
// no element with an id above it belongs to the pseudo id '' (the document). Formatting (indentation,
// line endings, attribute order, `<a></a>` versus `<a/>`) does not change any form; namespace
// prefixes are taken as they are.

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+/g;
const ATTR_RE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parses `xml` into Map(id -> canonical form), see above. Returns null if it is not well-formed
 * enough to be read that way (unbalanced tags, stray `<`).
 */
export function elementForms(xml) {
  const elements = parseElements(xml);
  return elements && new Map([...elements].map(([id, element]) => [id, element.form]));
}

/**
 * Like elementForms, with the parts of each form too: Map(id -> { form, attrs, parts }), `attrs` a
 * Map(name -> value) with the element name under TAG, `parts` the text and child forms (see above).
 * An id that occurs more than once has no parts (null: compared as a whole only).
 */
function parseElements(xml) {
  if (typeof xml !== 'string') return null;
  const text = xml.replace(/\r\n?/g, '\n');
  const forms = new Map();
  // Open elements: { name, head, id, parts: [] } (parts: text and the forms of children without id).
  const stack = [{ name: null, head: '', id: '', attrs: new Map(), parts: [] }];
  let end = 0;
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(text); match; match = TOKEN_RE.exec(text)) {
    if (match.index !== end) return null; // something the tokenizer does not understand
    end = TOKEN_RE.lastIndex;
    const [token, cdata, closeName, openName, attrText, selfClose] = match;
    const top = stack[stack.length - 1];
    if (openName !== undefined) {
      const attrs = [];
      const attrMap = new Map([[TAG, openName]]);
      let id = null;
      for (const [, key, dq, sq] of attrText.matchAll(ATTR_RE)) {
        const value = dq ?? sq;
        attrs.push(`${key}="${value}"`);
        attrMap.set(key, value);
        if (key === 'id') id = value;
      }
      attrs.sort();
      const node = {
        name: openName, head: `<${openName}${attrs.map((a) => ` ${a}`).join('')}>`, id, attrs: attrMap, parts: [],
      };
      if (selfClose) close(node, top, forms);
      else stack.push(node);
    } else if (closeName !== undefined) {
      if (stack.length < 2 || top.name !== closeName) return null;
      stack.pop();
      close(top, stack[stack.length - 1], forms);
    } else if (cdata !== undefined) {
      top.parts.push(`<![CDATA[${cdata}]]>`);
    } else if (token.startsWith('<')) {
      if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!DOCTYPE')) continue;
      return null; // a stray '<'
    } else {
      const trimmed = token.trim();
      if (trimmed) top.parts.push(trimmed);
    }
  }
  if (end !== text.length || stack.length !== 1) return null;
  addForm(forms, '', { ...stack[0], form: stack[0].parts.join('') });
  return forms;
}

/** An element ends: its form goes to the map (it has an id) or into its parent's form (it has none). */
function close(node, parent, forms) {
  const form = `${node.head}${node.parts.join('')}</${node.name}>`;
  if (node.id !== null) addForm(forms, node.id, { form, attrs: node.attrs, parts: node.parts });
  else parent.parts.push(form);
}

function addForm(forms, id, element) {
  const known = forms.get(id);
  // Duplicate ids: both forms count, the parts of neither (see parseElements).
  forms.set(id, known ? { form: `${known.form}\n${element.form}`, attrs: null, parts: null } : element);
}

/** Key of the element name in `attrs` (not a valid attribute name). */
const TAG = '<';

/**
 * The ids whose form differs between `base` and `ours` (changed, added or removed), with the three
 * elements of each in `save`, `base`, `ours` (see parseElements; undefined: absent). Null if any
 * document cannot be read.
 */
function changes(save, base, ours) {
  const [s, b, o] = [parseElements(save), parseElements(base), parseElements(ours)];
  if (!s || !b || !o) return null;
  const out = [];
  for (const id of new Set([...b.keys(), ...o.keys()])) {
    if (b.get(id)?.form !== o.get(id)?.form) out.push({ id, save: s.get(id), base: b.get(id), ours: o.get(id) });
  }
  return out;
}

function countOf(parts) {
  const counts = new Map();
  for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
  return counts;
}

/**
 * For an element present in the save and in ours that the other program changed too (its form is
 * none of ours): whether a part of it we changed (an attribute such as the name, or a child without
 * an id such as bounds, documentation, incoming / outgoing) is in the save as it was before our
 * latest write, i.e. as in `old` (the element in the base and in the writes in between, where it
 * exists). Then the save came from an older copy that the other program changed in its own way
 * (e.g. added documentation to a task we renamed); a change from our version keeps our parts.
 * Elements with a duplicate id are compared as a whole only (false here).
 */
function hasOldPart(save, ours, old) {
  if (!save.attrs || !ours.attrs || old.some((element) => !element.attrs)) return false;
  for (const key of new Set([...ours.attrs.keys(), ...old.flatMap((element) => [...element.attrs.keys()])])) {
    const value = save.attrs.get(key);
    if (value === ours.attrs.get(key)) continue;
    if (old.some((element) => element.attrs.get(key) !== ours.attrs.get(key) && element.attrs.get(key) === value)) {
      return true;
    }
  }
  const [inSave, inOurs] = [countOf(save.parts), countOf(ours.parts)];
  const olds = old.map((element) => countOf(element.parts));
  for (const part of new Set([...inOurs.keys(), ...olds.flatMap((counts) => [...counts.keys()])])) {
    const count = inSave.get(part) ?? 0;
    const ourCount = inOurs.get(part) ?? 0;
    if (count === ourCount) continue;
    if (olds.some((counts) => (counts.get(part) ?? 0) !== ourCount && (counts.get(part) ?? 0) === count)) return true;
  }
  return false;
}

/**
 * Whether `save` looks made from a copy older than `ours`, which turned `base` into `ours` (through
 * the documents in `between`, our writes in between, oldest first): for some element we changed, the
 * save has a form it had before our latest write, i.e. its base form or its form in one of `between`
 * (an element we deleted is back as it was, one we added is absent, one we modified is back to how it
 * was). The same holds per part of an element the other program also changed (DEF-E1): an attribute
 * or child we changed with the value it had before our latest write (a task we renamed with its old
 * name, and documentation the other program added). An element the other program changed in its own
 * way and that has all of our changes to it, or none of the forms we had for a part we changed (e.g.
 * renamed again), is a concurrent change, not a sign of an old copy. Unknown `base` (not a string):
 * false. A document that cannot be read: true (keep a copy rather than guess).
 */
export function looksStale(save, base, ours, between = []) {
  if (typeof save !== 'string' || typeof base !== 'string' || typeof ours !== 'string') return false;
  const diff = changes(save, base, ours);
  if (diff === null) return true;
  if (diff.some((d) => d.save?.form === d.base?.form)) return true;
  if (!diff.length) return false;
  const middles = between.map((xml) => parseElements(xml));
  if (middles.some((elements) => elements === null)) return true;
  if (diff.some((d) => d.save?.form !== d.ours?.form && middles.some((elements) => elements.get(d.id)?.form === d.save?.form))) {
    return true;
  }
  return diff.some((d) => {
    if (!d.save || !d.ours || d.save.form === d.ours.form) return false;
    const old = [d.base, ...middles.map((elements) => elements.get(d.id))].filter(Boolean);
    return old.length > 0 && hasOldPart(d.save, d.ours, old);
  });
}

/**
 * Whether `save` has every change `ours` made to `base`: each element we changed has our form in it
 * (an element we deleted is absent). Stricter than !looksStale: an element the other program changed
 * again counts as not having our change. Unknown `base`, missing `save`, or a document that cannot
 * be read: false.
 */
export function containsChanges(save, base, ours) {
  if (typeof save !== 'string' || typeof base !== 'string' || typeof ours !== 'string') return false;
  const diff = changes(save, base, ours);
  if (diff === null) return false;
  return diff.every((d) => d.save?.form === d.ours?.form);
}
