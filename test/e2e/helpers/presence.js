// Helpers for the connected-users list (S5) and remote selection highlighting (S6).
import { expect } from '@playwright/test';
import { PALETTE } from '../../../web/presence-shared.js';

export { PALETTE };

/** The connected-users list as shown: [{ id, name, color, self, dot }] (dot = computed CSS colour). */
export function userList(page) {
  return page.locator('#users > li').evaluateAll((items) => items.map((item) => ({
    id: item.dataset.userId,
    name: item.querySelector('.user-name, .user-name-input')?.textContent || item.querySelector('input')?.value || '',
    color: Number(item.dataset.color),
    self: item.hasAttribute('data-self'),
    you: item.querySelector('.user-you')?.textContent ?? null,
    dot: getComputedStyle(item.querySelector('.user-dot')).backgroundColor,
  })));
}

/** Names in the list, in order (own entry first). */
export async function userNames(page) {
  return (await userList(page)).map((u) => u.name);
}

/** Waits until the list shows exactly `names` (own entry first). */
export async function expectUserNames(page, names, options = {}) {
  await expect.poll(() => userNames(page), options).toEqual(names);
}

/** This window's own entry in the list. */
export async function ownEntry(page) {
  return (await userList(page)).find((u) => u.self);
}

/** Renames this window's user like a user would: click the own name, type, then press `key`. */
export async function renameSelf(page, text, key = 'Enter') {
  await page.locator('#users li[data-self] button.user-name').click();
  const input = page.locator('#users .user-name-input');
  await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press(key);
  await expect(input).toHaveCount(0);
}

/** "rgb(r, g, b)" of a palette colour, as getComputedStyle reports it. */
export function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
