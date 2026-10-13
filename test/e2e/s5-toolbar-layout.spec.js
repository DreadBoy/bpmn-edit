// S5 + S7: the toolbar with the connected-users list and the Share controls at narrow window widths.
// Nothing may wrap, overlap or be pushed out of the window; when names do not fit, the list shows
// colour dots and a "+N" entry (full names in tooltips) instead of squeezing them.
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collectPageErrors, startCli } from './helpers/cli.js';
import { expectNoTempFiles, openEditor, setupRepo } from './helpers/editor.js';
import { ownEntry, userList } from './helpers/presence.js';

/** Where the toolbar screenshots go (LOCAL_BPMN_SCREENSHOT_DIR, else the test's output directory). */
const screenshotDir = (testInfo) => process.env.LOCAL_BPMN_SCREENSHOT_DIR ?? testInfo.outputDir;

/** The toolbar's geometry as laid out in the page. */
function toolbarLayout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    /** Number of lines an element's text takes. */
    const lines = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    };
    const toolbar = document.getElementById('toolbar');
    const list = document.getElementById('users');
    return {
      toolbar: box(toolbar),
      children: [...toolbar.children].filter(shown).map((el) => ({ id: el.id || el.className, ...box(el) })),
      brandLines: lines(toolbar.querySelector('.brand')),
      buttonLines: [...document.querySelectorAll('#share button')].filter(shown)
        .map((el) => ({ text: el.textContent, lines: lines(el) })),
      list: box(list),
      items: [...list.children].filter(shown).map((el) => ({
        text: el.textContent,
        title: el.title,
        ...box(el),
        // The own entry's parts are inside its button.
        parts: [...el.children].flatMap((child) => (child.matches('button.user-self') ? [...child.children] : [child]))
          .filter(shown).map((part) => ({
          cls: part.className,
          ...box(part),
          fullWidth: part.scrollWidth,
        })),
      })),
    };
  });
}

/** Asserts that boxes (sorted left to right) do not overlap horizontally. */
function expectNoOverlap(boxes, what) {
  const sorted = [...boxes].sort((a, b) => a.left - b.left);
  for (let i = 1; i < sorted.length; i += 1) {
    expect(sorted[i].left, `${what}: ${JSON.stringify(sorted[i - 1])} overlaps ${JSON.stringify(sorted[i])}`)
      .toBeGreaterThanOrEqual(sorted[i - 1].right - 0.5);
  }
}

test.describe('S5/S7: toolbar layout with the users list and the Share controls', () => {
  let fixture;
  let cli;
  let contexts = [];

  test.beforeEach(async () => {
    fixture = await setupRepo();
    cli = await startCli(fixture.file, {
      cwd: fixture.dir,
      env: { LOCAL_BPMN_TEST_TUNNEL: 'fake', LOCAL_BPMN_TEST_TUNNEL_DELAY_MS: '100' },
    });
    contexts = [];
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
  });

  test('640, 800 and 1024 px wide, 2 and 5 users, sharing and not: nothing wraps, overlaps or is cut off', async ({ browser }, testInfo) => {
    const dir = screenshotDir(testInfo);
    await mkdir(dir, { recursive: true });

    async function openWindow() {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      const errors = collectPageErrors(page);
      await openEditor(page, cli);
      await expect.poll(async () => (await ownEntry(page))?.name ?? '').not.toBe('');
      return { page, errors };
    }

    const host = await openWindow();
    const others = [await openWindow()];

    /** Toolbar-level checks: everything inside the window and the toolbar, side by side, one line. */
    async function expectToolbarFits(width, sharing, label) {
      if (sharing) {
        await expect(host.page.locator('#share-stop'), label).toBeVisible();
        await expect(host.page.locator('#share-copy'), label).toBeVisible();
        await expect(host.page.locator('#share-copy'), label).toHaveAttribute('title', `Copy the public link: ${shareUrl}`);
      } else {
        await expect(host.page.locator('#share-start'), label).toBeVisible();
      }
      const layout = await toolbarLayout(host.page);
      for (const child of layout.children) {
        expect(child.left, `${label}: ${child.id}`).toBeGreaterThanOrEqual(-0.5);
        expect(child.right, `${label}: ${child.id}`).toBeLessThanOrEqual(width + 0.5);
        expect(child.top, `${label}: ${child.id}`).toBeGreaterThanOrEqual(layout.toolbar.top - 0.5);
        expect(child.bottom, `${label}: ${child.id}`).toBeLessThanOrEqual(layout.toolbar.bottom + 0.5);
      }
      expectNoOverlap(layout.children, `${label}: toolbar`);
      expect(layout.children.map((c) => c.id), label).toEqual(expect.arrayContaining(['file-name', 'users', 'save-status', 'share']));
      // The brand and the Share / Copy / Stop buttons take one line each.
      expect(layout.brandLines, `${label}: brand`).toBe(1);
      expect(layout.buttonLines.length, label).toBeGreaterThan(0);
      for (const button of layout.buttonLines) expect(button.lines, `${label}: ${button.text}`).toBe(1);
      // User entries: inside the list, not overlapping each other, nor their own parts each other.
      expect(layout.items.length, label).toBeGreaterThan(0);
      for (const item of layout.items) {
        expect(item.left, `${label}: ${item.text}`).toBeGreaterThanOrEqual(layout.list.left - 0.5);
        expect(item.right, `${label}: ${item.text}`).toBeLessThanOrEqual(layout.list.right + 0.5);
        expectNoOverlap(item.parts, `${label}: parts of ${item.text}`);
        for (const part of item.parts) {
          expect(part.left, `${label}: ${part.cls} in ${item.text}`).toBeGreaterThanOrEqual(item.left - 0.5);
          expect(part.right, `${label}: ${part.cls} in ${item.text}`).toBeLessThanOrEqual(item.right + 0.5);
        }
      }
      expectNoOverlap(layout.items, `${label}: users`);
      return layout;
    }

    let shareUrl = null;

    async function check(users, sharing) {
      for (const width of [640, 800, 1024]) {
        const label = `${width}px, ${users} users, ${sharing ? 'sharing' : 'not sharing'}`;
        await host.page.setViewportSize({ width, height: 700 });
        await expect.poll(() => userList(host.page).then((l) => l.length)).toBe(users);
        // The link box is shown where there is room for it (above 720px); Copy always copies the link.
        if (sharing && width > 720) await expect(host.page.locator('#share-url'), label).toBeVisible();
        if (sharing && width <= 720) await expect(host.page.locator('#share-url'), label).toBeHidden();
        // The list re-fits on resize (ResizeObserver): let it settle.
        await host.page.waitForTimeout(100);
        await host.page.locator('#toolbar').screenshot({ path: join(dir, `toolbar-${width}-${users}users-${sharing ? 'sharing' : 'idle'}.png`) });
        const layout = await expectToolbarFits(width, sharing, label);
        const fileName = layout.children.find((c) => c.id === 'file-name');
        expect(fileName.width, `${label}: file name`).toBeGreaterThanOrEqual(40);

        for (const item of layout.items) {
          expect(item.left, `${label}: ${item.text}`).toBeGreaterThanOrEqual(layout.list.left - 0.5);
          expect(item.right, `${label}: ${item.text}`).toBeLessThanOrEqual(layout.list.right + 0.5);
          expectNoOverlap(item.parts, `${label}: parts of ${item.text}`);
          for (const part of item.parts) {
            expect(part.left, `${label}: ${part.cls} in ${item.text}`).toBeGreaterThanOrEqual(item.left - 0.5);
            expect(part.right, `${label}: ${part.cls} in ${item.text}`).toBeLessThanOrEqual(item.right + 0.5);
            // A name is shown in full (up to its maximum width) or not at all, never squeezed.
            if (part.cls === 'user-name') expect(part.width, `${label}: ${item.text}`).toBeGreaterThanOrEqual(Math.min(part.fullWidth, 60) - 1);
          }
        }
        expectNoOverlap(layout.items, `${label}: users`);

        // Every user's full name is still reachable: in a shown entry's tooltip, or in "+N"'s.
        const tooltips = layout.items.map((item) => item.title).join('\n');
        for (const user of await userList(host.page)) expect(tooltips, label).toContain(user.name);
        const more = layout.items.find((item) => /^\+\d+$/.test(item.text));
        const shownUsers = layout.items.filter((item) => item !== more).length;
        expect(shownUsers + (more ? Number(more.text.slice(1)) : 0), label).toBe(users);
      }
    }

    await check(2, false);
    await host.page.locator('#share-start').click();
    await expect(host.page.locator('#share-url')).toBeVisible({ timeout: 5000 });
    shareUrl = await host.page.locator('#share-url').inputValue();
    await check(2, true);
    for (let i = 0; i < 3; i += 1) others.push(await openWindow());
    await check(5, true);

    // Renaming at 800 and 640 px while sharing with 5 users: the own name is hidden there, but the own
    // entry (a button: dot + "(you)") still opens the name field, by click and by keyboard; the toolbar
    // makes room for at least 120px of it, and Copy / Stop sharing stay visible.
    const input = host.page.locator('#users .user-name-input');
    const ownButton = host.page.locator('#users li[data-self] button.user-self');
    const otherNames = () => userList(others[0].page).then((l) => l.map((u) => u.name));

    /** With the name field open: everything fits, and the field is at least 120px wide. */
    async function expectRoomyField(width, label) {
      await host.page.waitForTimeout(100);
      const editing = await expectToolbarFits(width, true, label);
      const inputBox = await input.boundingBox();
      expect(inputBox.width, label).toBeGreaterThanOrEqual(120);
      expect(inputBox.x, label).toBeGreaterThanOrEqual(editing.list.left - 0.5);
      expect(inputBox.x + inputBox.width, label).toBeLessThanOrEqual(editing.list.right + 0.5);
    }

    for (const width of [800, 640]) {
      let label = `${width}px, 5 users, sharing, renaming by click`;
      await host.page.setViewportSize({ width, height: 700 });
      await host.page.waitForTimeout(100);
      await expect(host.page.locator('#users li[data-self] .user-name'), label).toBeHidden();
      await expect(ownButton, label).toBeVisible();
      await ownButton.click();
      await expect(input, label).toBeFocused();
      await expectRoomyField(width, label);
      await host.page.locator('#toolbar').screenshot({ path: join(dir, `toolbar-${width}-5users-sharing-renaming.png`) });
      // The whole name fits (a random name, or the longest one used below).
      await host.page.keyboard.press('ControlOrMeta+a');
      await host.page.keyboard.type(`Narrow Host ${width}`);
      expect(await input.evaluate((el) => el.scrollWidth <= el.clientWidth), label).toBe(true);
      await host.page.keyboard.press('Enter');
      await expect(input).toHaveCount(0);
      await expect.poll(otherNames, { message: label }).toContain(`Narrow Host ${width}`);
      await expect(host.page.locator('#users li[data-self]')).toHaveAttribute('title', `Narrow Host ${width} (you)`);
      await expectToolbarFits(width, true, `${width}px, 5 users, sharing, after renaming`);

      // The same with the keyboard only: Tab from the top of the page reaches the own entry first.
      label = `${width}px, 5 users, sharing, renaming by keyboard`;
      await host.page.mouse.move(5, 300); // off the toolbar
      await host.page.evaluate(() => document.activeElement?.blur());
      await host.page.keyboard.press('Tab');
      await expect(ownButton, label).toBeFocused();
      await expect(ownButton, label).toHaveAttribute('aria-label', `Your name: Narrow Host ${width}, change`);
      expect(await ownButton.evaluate((el) => el.matches(':focus-visible')), label).toBe(true);
      // "+N" (if the list is folded this far) is next, with the folded names as its accessible name.
      const more = host.page.locator('#users .user-more');
      if (await more.count()) {
        await host.page.keyboard.press('Tab');
        await expect(more, label).toBeFocused();
        await expect(more, label).toHaveAttribute('aria-label', /^\d+ more: .+/);
        await host.page.keyboard.press('Shift+Tab');
        await expect(ownButton, label).toBeFocused();
      }
      await host.page.keyboard.press('Enter');
      await expect(input, label).toBeFocused();
      await expectRoomyField(width, label);
      await host.page.keyboard.press('ControlOrMeta+a');
      await host.page.keyboard.type(`Keyboard Host ${width}`);
      await host.page.keyboard.press('Enter');
      await expect(input).toHaveCount(0);
      await expect.poll(otherNames, { message: label }).toContain(`Keyboard Host ${width}`);
      // Focus is back on the own entry, also after the host's 'presence' answer re-rendered the list.
      await expect(ownButton, label).toBeFocused();
      await host.page.waitForTimeout(200);
      await expect(ownButton, label).toBeFocused();
      expect(await ownButton.evaluate((el) => el.matches(':focus-visible')), label).toBe(true);
      // Space opens it as well; Escape closes it without renaming and also returns focus.
      await host.page.keyboard.press('Space');
      await expect(input, label).toBeFocused();
      await host.page.keyboard.type('Not this');
      await host.page.keyboard.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(ownButton, label).toBeFocused();
      await expect(ownButton, label).toHaveAttribute('aria-label', `Your name: Keyboard Host ${width}, change`);
    }
    // At 800 px the list is folded into "+N" (checked above when present): make sure that case ran.
    await host.page.setViewportSize({ width: 800, height: 700 });
    await host.page.waitForTimeout(100);
    await expect(host.page.locator('#users .user-more')).toHaveCount(1);

    // A focused "+N" keeps the focus when the window is resized (the list re-fits and re-creates
    // "+N"): on "+N" if it is still there, else on the own entry.
    const more = host.page.locator('#users .user-more');
    await more.focus();
    await expect(more).toBeFocused();
    let expected = 'more';
    for (const width of [810, 800, 760, 1600, 800]) {
      await host.page.setViewportSize({ width, height: 700 });
      await host.page.waitForTimeout(150);
      const where = await host.page.evaluate(() => {
        const el = document.activeElement;
        return el?.classList.contains('user-more') ? 'more' : el?.classList.contains('user-self') ? 'self' : el?.tagName;
      });
      // Once "+N" is gone, the focus stays on the own entry (also when "+N" comes back).
      if (expected === 'more' && (await more.count()) === 0) expected = 'self';
      expect(where, `focus after resizing to ${width}px`).toBe(expected);
    }
    expect(expected, 'resizing to 1600 px removes "+N"').toBe('self');

    // The own entry's focus ring (outline + offset) is not clipped by the list in any state.
    for (const width of [640, 740, 760, 800, 1024]) {
      await host.page.setViewportSize({ width, height: 700 });
      await host.page.waitForTimeout(150);
      await ownButton.focus();
      const ring = await host.page.evaluate(() => {
        const button = document.querySelector('#users button.user-self');
        const list = document.getElementById('users');
        const b = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const out = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const l = list.getBoundingClientRect();
        const ls = getComputedStyle(list);
        return {
          visible: button.matches(':focus-visible') && style.outlineStyle !== 'none',
          ring: { left: b.left - out, right: b.right + out, top: b.top - out, bottom: b.bottom + out },
          clip: {
            left: l.left + parseFloat(ls.borderLeftWidth),
            right: l.right - parseFloat(ls.borderRightWidth),
            top: l.top + parseFloat(ls.borderTopWidth),
            bottom: l.bottom - parseFloat(ls.borderBottomWidth),
          },
          state: list.dataset.compact ?? 'full',
        };
      });
      const label = `${width}px (${ring.state}): focus ring ${JSON.stringify(ring.ring)} in ${JSON.stringify(ring.clip)}`;
      expect(ring.visible, label).toBe(true);
      expect(ring.ring.left, label).toBeGreaterThanOrEqual(ring.clip.left - 0.5);
      expect(ring.ring.right, label).toBeLessThanOrEqual(ring.clip.right + 0.5);
      expect(ring.ring.top, label).toBeGreaterThanOrEqual(ring.clip.top - 0.5);
      expect(ring.ring.bottom, label).toBeLessThanOrEqual(ring.clip.bottom + 0.5);
      await expectToolbarFits(width, true, `${width}px, own entry focused`);
      if (width === 740) await host.page.locator('#toolbar').screenshot({ path: join(dir, 'toolbar-740-5users-sharing-focused.png') });
    }

    // At 1024 px the own name is shown: after renaming by mouse and Enter (pointer still on it) the
    // name has no leftover hover / focus frame; keyboard focus still shows one.
    await host.page.setViewportSize({ width: 1024, height: 700 });
    await host.page.waitForTimeout(100);
    const ownName = host.page.locator('#users li[data-self] .user-name');
    await expect(ownName).toBeVisible();
    await ownName.click();
    await expect(input).toBeFocused();
    await host.page.keyboard.press('ControlOrMeta+a');
    await host.page.keyboard.type('Wide Host');
    await host.page.keyboard.press('Enter');
    await expect(ownName).toHaveText('Wide Host');
    await expect.poll(otherNames).toContain('Wide Host');
    const frame = () => ownButton.evaluate((el) => getComputedStyle(el).borderTopColor);
    await expect.poll(frame).toBe('rgba(0, 0, 0, 0)');
    await host.page.waitForTimeout(200); // and it stays so (the host's 'presence' answer re-renders)
    expect(await frame()).toBe('rgba(0, 0, 0, 0)');
    await expect(ownButton).not.toBeFocused(); // a mouse rename leaves focus where it was
    await ownButton.screenshot({ path: join(dir, 'own-name-after-rename.png') });
    await host.page.evaluate(() => document.activeElement?.blur());
    await host.page.keyboard.press('Tab');
    await expect(ownButton).toBeFocused();
    await expect.poll(frame).not.toBe('rgba(0, 0, 0, 0)');
    await ownButton.screenshot({ path: join(dir, 'own-name-keyboard-focus.png') });
    await host.page.locator('#canvas').click({ position: { x: 5, y: 5 } });

    await host.page.locator('#share-stop').click();
    await expect(host.page.locator('#share-start')).toBeVisible();
    await check(5, false);

    // Wide again: every name is shown, no "+N".
    await host.page.setViewportSize({ width: 1600, height: 700 });
    await expect(host.page.locator('#users .user-more')).toHaveCount(0);
    await expect(host.page.locator('#users .user-name')).toHaveCount(5);
    for (const name of await host.page.locator('#users .user-name').all()) await expect(name).toBeVisible();

    expect(host.errors).toEqual([]);
    for (const { errors } of others) expect(errors).toEqual([]);
  });

  test('sharing host, 2 and 5 users: no width from 640 to 1100 px overflows the toolbar or clips the focus ring', async ({ browser }) => {
    const contextsOpened = [];
    async function openPage() {
      const context = await browser.newContext();
      contexts.push(context);
      contextsOpened.push(context);
      const page = await context.newPage();
      await openEditor(page, cli);
      await expect.poll(async () => (await ownEntry(page))?.name ?? '').not.toBe('');
      return page;
    }
    const host = await openPage();
    const errors = collectPageErrors(host);
    await openPage();
    await host.locator('#share-start').click();
    await expect(host.locator('#share-url')).toBeVisible({ timeout: 5000 });

    const widths = new Set();
    for (let w = 640; w <= 1100; w += 10) widths.add(w);
    for (let w = 700; w <= 760; w += 1) widths.add(w);
    const sorted = [...widths].sort((a, b) => a - b);

    async function sweep(users) {
      await expect.poll(() => userList(host).then((l) => l.length)).toBe(users);
      const problems = [];
      // Up and down, so both growing and shrinking re-fits are covered.
      for (const width of [...sorted, ...[...sorted].reverse()]) {
        await host.setViewportSize({ width, height: 600 });
        const result = await host.evaluate(() => new Promise((resolve) => {
          // Two frames: layout, ResizeObserver -> fit(), layout again.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const toolbar = document.getElementById('toolbar');
            const list = document.getElementById('users');
            const stop = document.getElementById('share-stop').getBoundingClientRect();
            const button = document.querySelector('#users button.user-self');
            if (document.activeElement !== button) button.focus();
            const b = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            const out = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
            const l = list.getBoundingClientRect();
            const ls = getComputedStyle(list);
            resolve({
              scrollWidth: toolbar.scrollWidth,
              clientWidth: toolbar.clientWidth,
              innerWidth: window.innerWidth,
              stop: { left: stop.left, right: stop.right, width: stop.width },
              ring: { left: b.left - out, right: b.right + out, top: b.top - out, bottom: b.bottom + out },
              clip: {
                left: l.left + parseFloat(ls.borderLeftWidth),
                right: l.right - parseFloat(ls.borderRightWidth),
                top: l.top + parseFloat(ls.borderTopWidth),
                bottom: l.bottom - parseFloat(ls.borderBottomWidth),
              },
              url: document.getElementById('share-url').getBoundingClientRect().width,
            });
          }));
        }));
        const fail = (what) => problems.push(`${width}px, ${users} users: ${what} ${JSON.stringify(result)}`);
        if (result.scrollWidth > result.clientWidth) fail('toolbar overflows');
        if (result.stop.width === 0 || result.stop.left < 0 || result.stop.right > result.innerWidth + 0.01) fail('Stop sharing not fully visible');
        const { ring, clip } = result;
        if (ring.left < clip.left - 0.01 || ring.right > clip.right + 0.01 || ring.top < clip.top - 0.01 || ring.bottom > clip.bottom + 0.01) fail('focus ring clipped');
        if (width > 720 && result.url < 80 - 0.01) fail('link box narrower than 80px');
        if (width <= 720 && result.url !== 0) fail('link box shown at 720px or less');
      }
      expect(problems).toEqual([]);
    }

    await sweep(2);
    for (let i = 0; i < 3; i += 1) await openPage();
    await sweep(5);
    expect(errors).toEqual([]);
  });
});
