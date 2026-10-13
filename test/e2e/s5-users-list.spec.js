// S5: connected-users list.
import { expect, test } from '@playwright/test';
import { collectPageErrors, startCli } from './helpers/cli.js';
import { expectNoTempFiles, openEditor, setupRepo, shape, status } from './helpers/editor.js';
import {
  PALETTE, expectUserNames, ownEntry, remoteMarkers, renameSelf, rgb, userList, userNames,
} from './helpers/presence.js';

const CF_HEADERS = { 'cf-ray': '8d0e3c7b5a1f2e4d-LJU', 'cf-connecting-ip': '203.0.113.9' };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A join, leave or rename must show up in the other windows this fast. */
const VISIBLE_MS = 3000;

test.describe('S5: connected-users list', () => {
  let fixture;
  let cli;
  let contexts;
  let windows;

  test.beforeEach(async () => {
    fixture = await setupRepo();
    // Stand-in tunnel (src/test-tunnel.js), for the test of a collaborator joining through a share link.
    cli = await startCli(fixture.file, { cwd: fixture.dir, env: { LOCAL_BPMN_TEST_TUNNEL: 'fake', LOCAL_BPMN_TEST_TUNNEL_DELAY_MS: '100' } });
    contexts = [];
    windows = [];
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    await cli?.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
  });

  /** Opens a separate browser window (own context, so its own localStorage) on the host URL. */
  async function openWindow(browser) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const win = { context, page, errors: collectPageErrors(page) };
    windows.push(win);
    await openEditor(page, cli);
    await expect.poll(async () => (await ownEntry(page))?.name ?? '').not.toBe('');
    return win;
  }

  function expectNoPageErrors() {
    for (const { errors } of windows) expect(errors).toEqual([]);
  }

  test('two windows both list both users with a name and a colour; own entry marked "(you)"', async ({ browser }) => {
    const a = await openWindow(browser);
    const b = await openWindow(browser);

    for (const page of [a.page, b.page]) await expect.poll(() => userList(page).then((l) => l.length)).toBe(2);
    const listA = await userList(a.page);
    const listB = await userList(b.page);

    // Own entry first, marked "(you)"; the same two users (ids, names, colours) in both windows.
    expect(listA[0].self).toBe(true);
    expect(listA[0].you).toBe('(you)');
    expect(listA[1].self).toBe(false);
    expect(listA[1].you).toBeNull();
    expect(listB[0].self).toBe(true);
    expect(listB[0].id).toBe(listA[1].id);
    expect(listA[0].id).toBe(listB[1].id);
    expect(listA[0].id).toBe(await a.page.evaluate(() => window.localBpmn.clientId));
    for (const [mine, theirs] of [[listA[0], listB[1]], [listB[0], listA[1]]]) {
      expect(mine.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/); // a friendly random name such as "Curious Otter"
      expect(theirs.name).toBe(mine.name);
      expect(theirs.color).toBe(mine.color);
      // The dot shows the user's palette colour, the same in every window.
      expect(mine.dot).toBe(rgb(PALETTE[mine.color]));
      expect(theirs.dot).toBe(mine.dot);
    }
    // The second user gets a colour nobody has yet.
    expect(listA[0].color).not.toBe(listA[1].color);

    // The list is visible in the toolbar, next to the save status.
    await expect(a.page.locator('#toolbar #users')).toBeVisible();
    await expect(a.page.locator('#users li[data-self]')).toContainText('(you)');

    // A third window joins: everyone sees 3.
    const c = await openWindow(browser);
    for (const page of [a.page, b.page, c.page]) await expect.poll(() => userList(page).then((l) => l.length), { timeout: VISIBLE_MS }).toBe(3);
    expect(new Set((await userList(c.page)).map((u) => u.color)).size).toBe(3);
    await expect(status(a.page)).toHaveAttribute('data-state', 'saved');
    expectNoPageErrors();
  });

  test('renaming in A updates B; Escape cancels; empty names are ignored; names are shown as text', async ({ browser }) => {
    const a = await openWindow(browser);
    const b = await openWindow(browser);
    const nameA = (await ownEntry(a.page)).name;
    const nameB = (await ownEntry(b.page)).name;
    await expectUserNames(b.page, [nameB, nameA]);

    await renameSelf(a.page, '  Ada   Lovelace  ');
    await expectUserNames(a.page, ['Ada Lovelace', nameB]);
    await expectUserNames(b.page, [nameB, 'Ada Lovelace'], { timeout: VISIBLE_MS });

    // Escape: nothing changes.
    await renameSelf(a.page, 'Not this', 'Escape');
    await expectUserNames(a.page, ['Ada Lovelace', nameB]);
    // Empty (or blank): ignored.
    await renameSelf(a.page, '   ');
    await expectUserNames(a.page, ['Ada Lovelace', nameB]);
    await delay(500);
    expect(await userNames(b.page)).toEqual([nameB, 'Ada Lovelace']);

    // Long names are cut to 32 characters (the input does not take more).
    await renameSelf(a.page, 'x'.repeat(40));
    await expectUserNames(b.page, [nameB, 'x'.repeat(32)], { timeout: VISIBLE_MS });

    // Markup is shown as text, never interpreted.
    const markup = '<img src=x onerror=window.__pwned=1>';
    await renameSelf(a.page, markup);
    await expectUserNames(b.page, [nameB, markup.slice(0, 32)], { timeout: VISIBLE_MS });
    await expect(b.page.locator('#users img')).toHaveCount(0);
    expect(await b.page.evaluate(() => window.__pwned)).toBeUndefined();

    // Renaming does not disturb editing: both windows still saved.
    for (const page of [a.page, b.page]) await expect(status(page)).toHaveAttribute('data-state', 'saved');
    expectNoPageErrors();
  });

  test('closing A removes it from B within a few seconds', async ({ browser }) => {
    const a = await openWindow(browser);
    const b = await openWindow(browser);
    await expect.poll(() => userList(b.page).then((l) => l.length)).toBe(2);

    const started = Date.now();
    await a.page.close(); // closes the window (tab), like a user would
    await expect.poll(() => userList(b.page).then((l) => l.length), { timeout: VISIBLE_MS }).toBe(1);
    const elapsed = Date.now() - started;
    console.log(`A disappeared from B after ${elapsed} ms`);
    expect((await userList(b.page))[0].self).toBe(true);

    // A whole browser (context) closing: the same.
    const c = await openWindow(browser);
    await expect.poll(() => userList(b.page).then((l) => l.length)).toBe(2);
    await c.context.close();
    contexts.splice(contexts.indexOf(c.context), 1);
    await expect.poll(() => userList(b.page).then((l) => l.length), { timeout: VISIBLE_MS }).toBe(1);
    expect(windows.find((w) => w === b).errors).toEqual([]);
  });

  test("a reload keeps A's name and colour (stored in the browser) and does not leave a stale entry", async ({ browser }) => {
    const a = await openWindow(browser);
    const b = await openWindow(browser);
    await renameSelf(a.page, 'Grace Hopper');
    await expectUserNames(b.page, [(await ownEntry(b.page)).name, 'Grace Hopper'], { timeout: VISIBLE_MS });
    const before = await ownEntry(a.page);

    await a.page.reload();
    await expect(status(a.page)).toHaveAttribute('data-state', 'saved');
    await expect.poll(() => ownEntry(a.page).then((u) => u?.name)).toBe('Grace Hopper');
    const after = await ownEntry(a.page);
    expect(after.color).toBe(before.color);
    expect(after.id).not.toBe(before.id); // a new connection

    // B sees A once (the old connection is gone), with the same name and colour.
    await expect.poll(() => userList(b.page).then((l) => l.map((u) => [u.id, u.name, u.color])), { timeout: VISIBLE_MS })
      .toEqual([[(await ownEntry(b.page)).id, (await ownEntry(b.page)).name, (await ownEntry(b.page)).color], [after.id, 'Grace Hopper', before.color]]);

    // A new browser (fresh storage) gets a new random name.
    const c = await openWindow(browser);
    expect((await ownEntry(c.page)).name).not.toBe('Grace Hopper');
    expectNoPageErrors();
  });

  test('a collaborator joining through the share link (/s/<token>/) is listed; presence carries no host path or secrets',
    async ({ browser }) => {
      // The host window (printed URL, with the host secret) starts sharing.
      const host = await openWindow(browser);
      await host.page.locator('#share-start').click();
      await expect(host.page.locator('#share-url')).toBeVisible({ timeout: 5000 });
      const shareUrl = await host.page.locator('#share-url').inputValue();
      const token = /\/s\/([A-Za-z0-9_-]{32})$/.exec(shareUrl)?.[1];
      expect(token, shareUrl).toBeTruthy();

      // The collaborator comes "through the tunnel": every request carries the Cloudflare headers.
      const context = await browser.newContext({ extraHTTPHeaders: CF_HEADERS });
      contexts.push(context);
      const page = await context.newPage();
      const collab = { context, page, errors: collectPageErrors(page) };
      windows.push(collab);
      const frames = [];
      page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => frames.push(String(payload))));
      expect((await page.goto(`${cli.baseUrl}s/${token}`)).status()).toBe(200);
      expect(page.url()).toBe(`${cli.baseUrl}s/${token}/`);
      await expect(shape(page, 'Task_CheckStock')).toBeVisible();
      await expect(status(page)).toHaveAttribute('data-state', 'saved');
      await expect.poll(async () => (await ownEntry(page))?.name ?? '').not.toBe('');

      // Both windows list both users, own entry first.
      const hostName = (await ownEntry(host.page)).name;
      const collabName = (await ownEntry(page)).name;
      await expectUserNames(host.page, [hostName, collabName], { timeout: VISIBLE_MS });
      await expectUserNames(page, [collabName, hostName], { timeout: VISIBLE_MS });
      // The users list and the share controls are both on screen in the host's toolbar.
      const viewport = host.page.viewportSize();
      for (const selector of ['#users', '#share-url', '#share-stop', '#save-status']) {
        const box = await host.page.locator(selector).boundingBox();
        expect(box, selector).not.toBeNull();
        expect(box.x + box.width, selector).toBeLessThanOrEqual(viewport.width);
      }

      // A collaborator's rename (markup included) reaches the host as text.
      const markup = '<img src=x onerror=window.__pwned=1>';
      await renameSelf(page, markup);
      await expectUserNames(host.page, [hostName, markup.slice(0, 32)], { timeout: VISIBLE_MS });
      await expect(host.page.locator('#users img')).toHaveCount(0);
      expect(await host.page.evaluate(() => window.__pwned)).toBeUndefined();

      // Selection highlighting works through the share as well (S6).
      const collabColor = (await ownEntry(page)).color;
      await shape(page, 'Task_CheckStock').click();
      await expect.poll(() => remoteMarkers(host.page, 'Task_CheckStock'), { timeout: VISIBLE_MS })
        .toEqual([`remote-sel-${collabColor}`]);
      const hostColor = (await ownEntry(host.page)).color;
      await shape(host.page, 'Task_ShipOrder').click();
      await expect.poll(() => remoteMarkers(page, 'Task_ShipOrder'), { timeout: VISIBLE_MS })
        .toEqual([`remote-sel-${hostColor}`]);

      // Presence messages the collaborator received name neither the host's path nor the host secret
      // nor the session token; neither does anything else on its socket.
      const presenceFrames = frames.filter((f) => ['welcome', 'presence', 'selection'].includes(JSON.parse(f).type));
      expect(presenceFrames.length).toBeGreaterThan(2);
      for (const f of presenceFrames) {
        const message = JSON.parse(f);
        for (const user of message.users ?? (message.user ? [message.user] : [])) {
          expect(Object.keys(user).sort()).toEqual(['color', 'id', 'name', 'selection']);
        }
      }
      for (const secret of [fixture.dir, fixture.file, cli.hostSecret, token]) {
        expect(frames.filter((f) => f.includes(secret)), secret).toEqual([]);
      }

      // Stop sharing: the collaborator's socket is closed and it leaves the host's list.
      await host.page.locator('#share-stop').click();
      await expect(page.locator('#session-overlay-text')).toHaveText('The host stopped sharing. This link no longer works.');
      await expectUserNames(host.page, [hostName], { timeout: VISIBLE_MS });
      expect(host.errors).toEqual([]);
      expect(collab.errors).toEqual([]);
    });
});
