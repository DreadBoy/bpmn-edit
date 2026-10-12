// File access for the edited .bpmn file (reading/validation now; writing and watching come later).
import { readFile, stat } from 'node:fs/promises';

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
