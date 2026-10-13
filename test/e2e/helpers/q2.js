// Helpers for the Q2 specs (an edit in the browser racing a save made on disk by another program).
import { expect } from '@playwright/test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { copyFixture } from './cli.js';
import { git, label, openEditor } from './editor.js';

/** Fixture copy in a fresh git repo with `core.autocrlf` set explicitly, the file committed. */
export async function setupRepoWithAutocrlf(autocrlf = 'false') {
  const fixture = await copyFixture('order.bpmn');
  git(fixture.dir, 'init', '-q');
  git(fixture.dir, 'config', 'core.autocrlf', autocrlf);
  git(fixture.dir, 'add', 'order.bpmn');
  git(fixture.dir, 'commit', '-q', '-m', 'initial');
  return fixture;
}

/**
 * Before the page loads: records every toast shown (kind, text, time) in `window.__q2Toasts` and the
 * arrival time of every 'ack' in `window.__q2Acks` (Date.now(), the same clock as the test).
 */
export async function instrument(page) {
  await page.addInitScript(() => {
    window.__q2Toasts = [];
    window.__q2Acks = [];
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          try {
            if (JSON.parse(event.data).type === 'ack') window.__q2Acks.push(Date.now());
          } catch {
            // not JSON: ignored
          }
        });
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      const toast = document.getElementById('toast');
      new MutationObserver(() => {
        if (!toast.hidden) window.__q2Toasts.push({ kind: toast.dataset.kind, text: toast.textContent, at: Date.now() });
      }).observe(toast, { attributes: true, childList: true, characterData: true, subtree: true });
    });
  });
}

/** Opens an instrumented editor window on the CLI's URL. */
export async function openWindow(browser, cli) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await instrument(page);
  await openEditor(page, cli);
  return { context, page };
}

export function toastsSince(page, since) {
  return page.evaluate((t) => window.__q2Toasts.filter((x) => x.at >= t), since);
}

/** Resolves to the time (test clock) of the first 'ack' the page receives after `since`. */
export async function ackAfter(page, since, timeout = 5000) {
  await page.waitForFunction((t) => window.__q2Acks.some((a) => a >= t), since, { timeout });
  return page.evaluate((t) => window.__q2Acks.find((a) => a >= t), since);
}

/** The name of element `id` in BPMN XML (unescaped quotes only), or null. */
export function nameInXml(xml, id) {
  const m = new RegExp(`<bpmn:\\w+ id="${id}" name="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
}

/** `xml` with element `id` renamed to `name`. */
export function renameInXml(xml, id, name) {
  const out = xml.replace(new RegExp(`(<bpmn:\\w+ id="${id}" name=")[^"]*"`), `$1${name}"`);
  if (out === xml) throw new Error(`cannot rename ${id}`);
  return out;
}

/** Saves the file like an IDE whose buffer is in sync with the file: read, change one name, write. */
export async function ideRename(file, id, name) {
  const xml = await readFile(file, 'utf8');
  await writeFile(file, renameInXml(xml, id, name));
}

/** Names of the given elements as shown in a window. */
export function windowNames(page, ids) {
  return page.evaluate((list) => Object.fromEntries(list.map((id) => {
    const element = window.bpmnModeler.get('elementRegistry').get(id);
    return [id, element ? element.businessObject.name ?? null : null];
  })), ids);
}

/** Waits until every window says "Saved" with nothing held back, then a little longer. */
export async function settleWindows(pages, quietMs = 1200) {
  for (const page of pages) {
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  }
  await new Promise((r) => setTimeout(r, quietMs));
  for (const page of pages) {
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
  }
}

/** Files next to the target that hold a version kept aside (see src/file.js, saveAside). */
export async function asideFiles(dir) {
  return (await readdir(dir)).filter((n) => /\.local-bpmn-.+\.bpmn$/.test(n));
}

export { label };
