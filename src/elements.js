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
  if (typeof xml !== 'string') return null;
  const text = xml.replace(/\r\n?/g, '\n');
  const forms = new Map();
  // Open elements: { name, head, id, parts: [] } (parts: text and the forms of children without id).
  const stack = [{ name: null, head: '', id: '', parts: [] }];
  let end = 0;
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(text); match; match = TOKEN_RE.exec(text)) {
    if (match.index !== end) return null; // something the tokenizer does not understand
    end = TOKEN_RE.lastIndex;
    const [token, cdata, closeName, openName, attrText, selfClose] = match;
    const top = stack[stack.length - 1];
    if (openName !== undefined) {
      const attrs = [];
      let id = null;
      for (const [, key, dq, sq] of attrText.matchAll(ATTR_RE)) {
        const value = dq ?? sq;
        attrs.push(`${key}="${value}"`);
        if (key === 'id') id = value;
      }
      attrs.sort();
      const node = { name: openName, head: `<${openName}${attrs.map((a) => ` ${a}`).join('')}>`, id, parts: [] };
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
  addForm(forms, '', stack[0].parts.join(''));
  return forms;
}

/** An element ends: its form goes to the map (it has an id) or into its parent's form (it has none). */
function close(node, parent, forms) {
  const form = `${node.head}${node.parts.join('')}</${node.name}>`;
  if (node.id !== null) addForm(forms, node.id, form);
  else parent.parts.push(form);
}

function addForm(forms, id, form) {
  forms.set(id, forms.has(id) ? `${forms.get(id)}\n${form}` : form); // duplicate ids: both count
}

/**
 * The ids whose form differs between `base` and `ours` (changed, added or removed), with the three
 * forms of each in `save`, `base`, `ours` (undefined: absent). Null if any document cannot be read.
 */
function changes(save, base, ours) {
  const [s, b, o] = [elementForms(save), elementForms(base), elementForms(ours)];
  if (!s || !b || !o) return null;
  const out = [];
  for (const id of new Set([...b.keys(), ...o.keys()])) {
    if (b.get(id) !== o.get(id)) out.push({ id, save: s.get(id), base: b.get(id), ours: o.get(id) });
  }
  return out;
}

/**
 * Whether `save` looks made from a copy older than `ours`, which turned `base` into `ours` (through
 * the documents in `between`, our writes in between, oldest first): for some element we changed, the
 * save has a form it had before our latest write, i.e. its base form or its form in one of `between`
 * (an element we deleted is back as it was, one we added is absent, one we modified is back to how it
 * was). An element the other program changed in its own way (a form none of ours had) is a
 * concurrent change, not a sign of an old copy. Unknown `base` (not a string): false. A document that
 * cannot be read: true (keep a copy rather than guess).
 */
export function looksStale(save, base, ours, between = []) {
  if (typeof save !== 'string' || typeof base !== 'string' || typeof ours !== 'string') return false;
  const diff = changes(save, base, ours);
  if (diff === null) return true;
  if (diff.some((d) => d.save === d.base)) return true;
  if (!diff.length || !between.length) return false;
  const middles = between.map((xml) => elementForms(xml));
  if (middles.some((forms) => forms === null)) return true;
  return diff.some((d) => d.save !== d.ours && middles.some((forms) => forms.get(d.id) === d.save));
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
  return diff.every((d) => d.save === d.ours);
}
