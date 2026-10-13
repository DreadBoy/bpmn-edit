// S8: session ended / stop sharing / reconnect, without Cloudflare. The CLI runs with the stand-in tunnel
// (LOCAL_BPMN_TEST_TUNNEL=fake, src/test-tunnel.js); collaborators open the share link on localhost with
// the Cloudflare headers, as in s7-share.spec.js. The keepalive through a real tunnel is covered by
// s8-keepalive-tunnel.spec.js.
//
// Pages get a shorter reconnect schedule through `window.localBpmnTestConnection` (see web/app.js), so
// a page that kept retrying would show many attempts within a second; the default schedule is unit
// tested (test/unit/connection.test.js).
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { collectPageErrors, startCli } from './helpers/cli.js';
import {
  dragBy, expectNoTempFiles, git, label, setupRepo, shape, status, typeLabel,
} from './helpers/editor.js';
import { expectUserNames, ownEntry, userList } from './helpers/presence.js';
import { diskSnapshot, windowSnapshot } from './helpers/snapshot.js';

const CF_HEADERS = { 'cf-ray': '8d0e3c7b5a1f2e4d-LJU', 'cf-connecting-ip': '203.0.113.9' };
const SHARE_URL_RE = /^https:\/\/test-[0-9a-f]+\.trycloudflare\.com\/s\/([A-Za-z0-9_-]{32})$/;

/** Retries quickly and never gives up on its own (only a probe or a close code ends the session). */
const PATIENT = { delays: [100, 200, 400], jitter: 0, giveUpAttempts: 1000, giveUpMs: 600_000, heartbeatMs: 1000 };
/** Retries quickly and gives up after 3 failed attempts and 1 s. */
const IMPATIENT = { delays: [100, 200], jitter: 0, giveUpAttempts: 3, giveUpMs: 1000, heartbeatMs: 1000 };

/** How long a page that kept reconnecting (100–400 ms apart) is watched to see that it does not. */
const QUIET_MS = 1500;

/**
 * Browser messages that are expected while the host is down: Chrome logs the failed WebSocket
 * handshake and the failed probe of api/file (404 / connection refused) as console errors.
 */
const EXPECTED_WHILE_DOWN = /WebSocket connection to .* failed|Failed to load resource|ERR_CONNECTION_REFUSED|404 \(Not Found\)/;

function overlay(page) {
  return {
    root: page.locator('#session-overlay'),
    title: page.locator('#session-overlay-title'),
    text: page.locator('#session-overlay-text'),
    action: page.locator('#session-overlay-action'),
  };
}

test.describe('S8: session ended, stop sharing, reconnect', () => {
  let fixture;
  let cli;
  let contexts;
  const extraClis = [];

  test.beforeEach(async () => {
    fixture = await setupRepo();
    contexts = [];
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    await cli?.stop();
    for (const other of extraClis.splice(0)) await other.stop();
    if (fixture) await expectNoTempFiles(fixture.dir);
    await fixture?.cleanup();
    cli = fixture = undefined;
  });

  const disk = () => readFile(fixture.file, 'utf8');

  function startHost({ port, env = {} } = {}) {
    return startCli(fixture.file, {
      cwd: fixture.dir,
      ...(port ? { port } : {}),
      env: { LOCAL_BPMN_TEST_TUNNEL: 'fake', LOCAL_BPMN_TEST_TUNNEL_DELAY_MS: '100', ...env },
    });
  }

  /**
   * Opens `url` in a new browser context with the given reconnect schedule. Returns { page, errors,
   * sockets } (sockets: every WebSocket the page opened, in order).
   */
  async function openWindow(browser, url, { policy = PATIENT, headers, expectStatus = 'saved' } = {}) {
    const context = await browser.newContext(headers ? { extraHTTPHeaders: headers } : {});
    contexts.push(context);
    await context.addInitScript((p) => { window.localBpmnTestConnection = p; }, policy);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    const sockets = [];
    page.on('websocket', (ws) => sockets.push(ws));
    await page.goto(url);
    await expect(shape(page, 'Task_CheckStock')).toBeVisible();
    if (expectStatus) await expect(status(page)).toHaveAttribute('data-state', expectStatus);
    return { page, errors, sockets, context };
  }

  /** Clicks Share in the host window; resolves to { url, token }. */
  async function share(host) {
    await host.locator('#share-start').click();
    await expect(host.locator('#share-url')).toBeVisible({ timeout: 5000 });
    const url = await host.locator('#share-url').inputValue();
    const [, token] = SHARE_URL_RE.exec(url) ?? [];
    expect(token, url).toBeTruthy();
    return { url, token };
  }

  /** The window keeps the number of WebSockets it opened for QUIET_MS (it is not reconnecting). */
  async function expectNoReconnects(win) {
    const count = win.sockets.length;
    await win.page.waitForTimeout(QUIET_MS); // a negative check: retries would come every 100–400 ms
    expect(win.sockets.length).toBe(count);
  }

  test('Stop sharing: the collaborator gets an overlay and stops; the old link is gone; a new share works',
    async ({ browser }) => {
      cli = await startHost();
      const host = await openWindow(browser, cli.url);
      const first = await share(host.page);
      const collab = await openWindow(browser, `${cli.baseUrl}s/${first.token}/`, { headers: CF_HEADERS });
      await expectUserNames(host.page, [
        (await ownEntry(host.page)).name, (await ownEntry(collab.page)).name,
      ]);

      await host.page.locator('#share-stop').click();
      const ui = overlay(collab.page);
      await expect(ui.root).toBeVisible();
      await expect(ui.title).toHaveText('Sharing stopped');
      await expect(ui.text).toHaveText('The host stopped sharing. This link no longer works.');
      await expect(ui.action).toBeHidden(); // nothing to retry
      await expect(status(collab.page)).toHaveText('Disconnected');
      await expect(collab.page.locator('#reconnecting')).toBeHidden();
      await expectNoReconnects(collab);
      expect(collab.sockets).toHaveLength(1);
      // The host carries on alone.
      await expect.poll(() => userList(host.page).then((l) => l.length)).toBe(1);
      await expect(overlay(host.page).root).toBeHidden();
      await expect(status(host.page)).toHaveText('Saved');

      // Reloading the old link: 404.
      expect((await collab.page.goto(`${cli.baseUrl}s/${first.token}/`)).status()).toBe(404);

      // Share again: a new link (new token) that works; the old one stays dead.
      const second = await share(host.page);
      expect(second.token).not.toBe(first.token);
      expect(second.url).not.toBe(first.url);
      const collab2 = await openWindow(browser, `${cli.baseUrl}s/${second.token}/`, { headers: CF_HEADERS });
      await typeLabel(collab2.page, 'Task_CheckStock', 'Checked after re-share');
      await expect(label(host.page, 'Task_CheckStock')).toHaveText('Checked after re-share', { timeout: 3000 });
      await expect.poll(disk, { timeout: 3000 }).toContain('name="Checked after re-share"');
      expect((await collab.page.goto(`${cli.baseUrl}s/${first.token}/`)).status()).toBe(404);

      expect(host.errors).toEqual([]);
      expect(collab2.errors).toEqual([]);
      expect(collab.errors.filter((e) => !EXPECTED_WHILE_DOWN.test(e))).toEqual([]);
    });

  test('Ctrl-C: collaborator, host and local windows get "Session ended" and do not reconnect; the last edit is saved',
    async ({ browser }) => {
      cli = await startHost();
      const host = await openWindow(browser, cli.url);
      const local = await openWindow(browser, cli.baseUrl);
      const { token } = await share(host.page);
      const collab = await openWindow(browser, `${cli.baseUrl}s/${token}/`, { headers: CF_HEADERS });
      await expect.poll(() => userList(host.page).then((l) => l.length)).toBe(3);

      // The collaborator's edit is still being sent when the host stops.
      await typeLabel(collab.page, 'Task_ShipOrder', 'Shipped right before Ctrl-C');
      cli.child.kill('SIGINT'); // the node process itself (startCli spawns process.execPath)
      expect(await cli.exited).toEqual({ code: 0, signal: null });
      expect(await disk()).toContain('name="Shipped right before Ctrl-C"');

      for (const win of [host, local, collab]) {
        const ui = overlay(win.page);
        await expect(ui.root).toBeVisible();
        await expect(ui.title).toHaveText('Session ended');
        await expect(status(win.page)).toHaveText('Disconnected');
        await expect(win.page.locator('#reconnecting')).toBeHidden();
      }
      await expect(overlay(collab.page).text).toHaveText('The host closed this session.');
      await expect(overlay(collab.page).action).toBeHidden();
      for (const win of [host, local]) {
        await expect(overlay(win.page).text).toHaveText(
          'local-bpmn was stopped. Run it again and open the link it prints, or reconnect once it runs again.',
        );
        await expect(overlay(win.page).action).toHaveText('Reconnect');
      }
      for (const win of [host, local, collab]) {
        await expectNoReconnects(win);
        expect(win.sockets).toHaveLength(1);
        expect(win.errors).toEqual([]);
      }
    });

  /**
   * Routes a page's WebSocket through the test (Playwright routeWebSocket), so a connection can be lost
   * without the host noticing (cut(): the page side closes, the host side stays open, like a dead
   * network path), new connections refused (blocking), and acks swallowed (dropAcks).
   */
  async function proxy(page) {
    const state = { blocking: false, dropAcks: false, droppedAcks: 0, connections: 0, current: null };
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      state.connections += 1;
      if (state.blocking) {
        ws.close({ code: 1001, reason: 'test: no connection' });
        return;
      }
      const server = ws.connectToServer();
      const conn = { ws, server, cut: false };
      state.current = conn;
      ws.onClose((code, reason) => { if (!conn.cut) server.close({ code, reason }); });
      server.onClose((code, reason) => { if (!conn.cut) ws.close({ code, reason }); });
      ws.onMessage((message) => { if (!conn.cut) server.send(message); });
      server.onMessage((message) => {
        if (conn.cut) return;
        if (state.dropAcks && JSON.parse(String(message)).type === 'ack') {
          state.droppedAcks += 1;
          return;
        }
        ws.send(message);
      });
    });
    return {
      state,
      cut() {
        const conn = state.current;
        conn.cut = true;
        conn.ws.close({ code: 1001, reason: 'test: connection lost' }); // the host side is left open
      },
      /** Nothing passes any more in either direction, but neither side is closed. */
      blackhole() {
        state.current.cut = true;
      },
    };
  }

  function position(page, id) {
    return page.evaluate((elementId) => {
      const e = window.bpmnModeler.get('elementRegistry').get(elementId);
      return e ? { x: e.x, y: e.y } : null;
    }, id);
  }

  test('a dropped connection shows "Reconnecting…", recovers, and keeps every edit made around the drop',
    async ({ browser }) => {
      cli = await startHost();
      const host = await openWindow(browser, cli.url);
      const { token } = await share(host.page);

      // The collaborator's socket goes through the test proxy.
      const context = await browser.newContext({ extraHTTPHeaders: CF_HEADERS });
      contexts.push(context);
      await context.addInitScript((p) => { window.localBpmnTestConnection = p; }, PATIENT);
      const page = await context.newPage();
      const collab = { page, errors: collectPageErrors(page) };
      const net = await proxy(page);
      await page.goto(`${cli.baseUrl}s/${token}/`);
      await expect(status(page)).toHaveText('Saved');
      await expect.poll(() => userList(host.page).then((l) => l.length)).toBe(2);
      const collabEntry = await ownEntry(page);
      const hostEntry = await ownEntry(host.page);

      // 1. An edit the host accepts, but whose ack is lost with the connection.
      net.state.dropAcks = true;
      await typeLabel(page, 'Task_CheckStock', 'Check stock (collaborator)');
      await expect.poll(disk, { timeout: 3000 }).toContain('name="Check stock (collaborator)"');
      expect(net.state.droppedAcks).toBe(1);
      // 2. An edit not sent yet (waits for that ack).
      await dragBy(page, 'Task_ShipOrder', 60);
      const shipMoved = await position(page, 'Task_ShipOrder');
      await expect(status(page)).toHaveText('Saving…');

      // The connection is lost; new connections fail until the network is back.
      net.state.blocking = true;
      net.cut();
      await expect(page.locator('#reconnecting')).toBeVisible();
      await expect(page.locator('#reconnecting')).toHaveText(/Reconnecting…/);
      await expect(status(page)).toHaveText('Reconnecting…');
      await expect.poll(() => net.state.connections, { timeout: 5000 }).toBeGreaterThan(3); // retrying
      // The host still lists the old connection (it looks open from there): a ghost, until replaced.
      expect(await userList(host.page).then((l) => l.length)).toBe(2);

      // 3. An edit made while disconnected.
      await typeLabel(page, 'Task_CancelOrder', 'Cancel order (offline)');
      await expect(status(page)).toHaveText('Reconnecting…');
      // Meanwhile the host moves "Check stock" (renamed by the collaborator) and deletes "Order cancelled".
      await dragBy(host.page, 'Task_CheckStock', 0, 40);
      const checkMoved = await position(host.page, 'Task_CheckStock');
      await shape(host.page, 'EndEvent_OrderCancelled').click();
      await host.page.keyboard.press('Delete');
      await expect.poll(disk, { timeout: 3000 }).not.toContain('id="EndEvent_OrderCancelled"');
      await expect(status(host.page)).toHaveText('Saved');
      expect(await disk()).not.toContain('Cancel order (offline)');

      // The network is back.
      net.state.dropAcks = false;
      net.state.blocking = false;
      await expect(page.locator('#reconnecting')).toBeHidden({ timeout: 5000 });
      await expect(status(page)).toHaveText('Saved');

      // Everything reached disk and both windows: the collaborator's three edits, the host's move and
      // delete (not resurrected by the collaborator's older document).
      await expect.poll(async () => {
        const xml = await disk();
        const snapshot = diskSnapshot(xml);
        const windows = await Promise.all([windowSnapshot(page), windowSnapshot(host.page)]);
        return windows.every((w) => JSON.stringify(w) === JSON.stringify(snapshot));
      }, { timeout: 3000 }).toBe(true);
      const xml = await disk();
      expect(xml.match(/name="Check stock \(collaborator\)"/g)).toHaveLength(1);
      expect(xml).toContain('name="Cancel order (offline)"');
      expect(xml).not.toContain('id="EndEvent_OrderCancelled"');
      const snapshot = Object.fromEntries(diskSnapshot(xml).map((e) => [e.id, e.geometry]));
      expect(snapshot.Task_ShipOrder.slice(0, 2)).toEqual([shipMoved.x, shipMoved.y]);
      expect(snapshot.Task_CheckStock.slice(0, 2)).toEqual([checkMoved.x, checkMoved.y]);
      expect(git(fixture.dir, 'diff', '--stat')).toContain('order.bpmn');
      await expect(label(host.page, 'Task_CancelOrder')).toHaveText('Cancel order (offline)');
      // Nothing was reported as lost or conflicting.
      await expect(page.locator('#toast')).toBeHidden();
      await expect(host.page.locator('#toast')).toBeHidden();

      // Users list: no ghost of the old connection, same name and colour after the reconnect.
      const expectEntries = (list) => expect(list.map(({ name, color }) => ({ name, color })).sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual([{ name: collabEntry.name, color: collabEntry.color }, { name: hostEntry.name, color: hostEntry.color }]
          .sort((a, b) => a.name.localeCompare(b.name)));
      await expect.poll(() => userList(host.page).then((l) => l.length)).toBe(2);
      await expect.poll(() => userList(page).then((l) => l.length)).toBe(2);
      expectEntries(await userList(host.page));
      expectEntries(await userList(page));

      expect(host.errors).toEqual([]);
      expect(collab.errors).toEqual([]);
    });

  test('heartbeat: a connection that silently stops delivering is noticed by the page, which reconnects',
    async ({ browser }) => {
      cli = await startHost();
      const context = await browser.newContext();
      contexts.push(context);
      await context.addInitScript((p) => { window.localBpmnTestConnection = p; }, PATIENT); // heartbeat 1 s
      const page = await context.newPage();
      const errors = collectPageErrors(page);
      const net = await proxy(page);
      await page.goto(cli.url);
      await expect(status(page)).toHaveText('Saved');
      const before = await ownEntry(page);

      net.blackhole();
      await typeLabel(page, 'Task_CheckStock', 'Sent into the void');
      // Within two heartbeats the page gives up on that connection and opens a new one.
      await expect.poll(() => net.state.connections, { timeout: 5000 }).toBe(2);
      await expect(status(page)).toHaveText('Saved', { timeout: 5000 });
      await expect.poll(disk, { timeout: 3000 }).toContain('name="Sent into the void"');
      await expect(page.locator('#reconnecting')).toBeHidden();
      // Same name and colour; the dead connection's entry was replaced, not duplicated.
      await expect.poll(() => userList(page).then((l) => l.map(({ name, color }) => ({ name, color }))))
        .toEqual([{ name: before.name, color: before.color }]);
      // Still the host tab: Share is there.
      await expect(page.locator('#share-start')).toBeVisible();
      expect(errors).toEqual([]);
    });

  test('keepalive: a connection that stops answering pings is dropped and leaves the users list; live ones stay',
    async ({ browser }) => {
      cli = await startHost({ env: { LOCAL_BPMN_KEEPALIVE_MS: '250' } });
      const host = await openWindow(browser, cli.url);

      /** A raw client that joins as `name`; autoPong false = a connection that died without closing. */
      function rawClient(name, autoPong) {
        const ws = new WebSocket(`ws://127.0.0.1:${cli.port}/ws`, { autoPong });
        const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
        ws.on('error', () => {});
        ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', name })));
        return { ws, closed };
      }
      const half = rawClient('Half Open', false);
      const steady = rawClient('Steady Client', true);
      const hostName = (await ownEntry(host.page)).name;
      await expectUserNames(host.page, [hostName, 'Half Open', 'Steady Client']);

      // The host terminates the silent one within two ping intervals (no close frame: 1006).
      expect(await half.closed).toBe(1006);
      await expectUserNames(host.page, [hostName, 'Steady Client'], { timeout: 2000 });
      // Live connections are pinged too but stay: the page answers pings by itself.
      await host.page.waitForTimeout(1500); // six more ping intervals
      expect(steady.ws.readyState).toBe(WebSocket.OPEN);
      await expectUserNames(host.page, [hostName, 'Steady Client']);
      expect(host.sockets).toHaveLength(1);
      await expect(status(host.page)).toHaveText('Saved');
      await typeLabel(host.page, 'Task_CheckStock', 'Still connected');
      await expect.poll(disk, { timeout: 3000 }).toContain('name="Still connected"');
      steady.ws.close();
      expect(host.errors).toEqual([]);
    });

  test('host process killed and restarted on the same port: the host tab reconnects as a local editor; old links end',
    async ({ browser, request }) => {
      cli = await startHost();
      const { port } = cli;
      const oldSecret = cli.hostSecret;
      const host = await openWindow(browser, cli.url);
      const { token } = await share(host.page);
      const collab = await openWindow(browser, `${cli.baseUrl}s/${token}/`, { headers: CF_HEADERS });
      const local = await openWindow(browser, cli.baseUrl, { policy: IMPATIENT });
      await typeLabel(host.page, 'Task_CheckStock', 'Before the crash');
      await expect.poll(disk, { timeout: 3000 }).toContain('name="Before the crash"');

      // No Ctrl-C: the process vanishes, so no window is told anything.
      cli.child.kill('SIGKILL');
      expect((await cli.exited).signal).toBe('SIGKILL');
      for (const win of [host, collab]) {
        await expect(win.page.locator('#reconnecting')).toBeVisible();
        await expect(status(win.page)).toHaveText('Reconnecting…');
      }
      // A window does not retry forever: the impatient one gives up after its limit.
      await expect(overlay(local.page).root).toBeVisible({ timeout: 5000 });
      await expect(overlay(local.page).text).toHaveText('Lost the connection to the host and could not reconnect.');
      await expect(overlay(local.page).action).toHaveText('Try again');
      // Gives up once 3 attempts failed and 1 s passed (100–200 ms apart): the first socket plus a handful.
      expect(local.sockets.length).toBeGreaterThanOrEqual(1 + IMPATIENT.giveUpAttempts);
      expect(local.sockets.length).toBeLessThanOrEqual(1 + IMPATIENT.giveUpMs / IMPATIENT.delays[0] + 1);
      await expectNoReconnects(local);

      // Edited while the host is down.
      await typeLabel(host.page, 'Task_ShipOrder', 'Edited while the host was down');
      await expect(status(host.page)).toHaveText('Reconnecting…');

      // Restarted on the same port: a new host secret, no share.
      const restarted = await startHost({ port });
      extraClis.push(restarted);
      expect(restarted.port).toBe(port);
      expect(restarted.hostSecret).not.toBe(oldSecret);

      // The host tab reconnects by itself and saves what was edited meanwhile...
      await expect(host.page.locator('#reconnecting')).toBeHidden({ timeout: 5000 });
      await expect(status(host.page)).toHaveText('Saved');
      await expect.poll(disk, { timeout: 3000 }).toContain('name="Edited while the host was down"');
      expect(await disk()).toContain('name="Before the crash"');
      // ...but its secret is from the old run: it is a plain local editor now, and says so.
      await expect(host.page.locator('#toast')).toContainText('local-bpmn was restarted');
      await expect(host.page.locator('#share')).toBeHidden();
      expect(await host.page.evaluate(() => sessionStorage.getItem('local-bpmn:host-secret'))).toBeNull();
      expect((await request.post(`${restarted.baseUrl}api/share`, { headers: { 'X-Local-Bpmn-Host': oldSecret } })).status()).toBe(403);
      expect((await request.get(`${restarted.baseUrl}api/share`, { headers: { 'X-Local-Bpmn-Host': restarted.hostSecret } })).status()).toBe(200);

      // The collaborator's link belongs to the old run: "Session ended", no more attempts.
      await expect(overlay(collab.page).root).toBeVisible({ timeout: 5000 });
      await expect(overlay(collab.page).text).toHaveText('This link no longer works. Ask the host for a new link.');
      await expect(overlay(collab.page).action).toBeHidden();
      await expectNoReconnects(collab);

      // The printed URL of the new run gives Share again.
      const fresh = await openWindow(browser, restarted.url);
      await expect(fresh.page.locator('#share-start')).toBeVisible();
      await expect.poll(() => userList(host.page).then((l) => l.length)).toBe(2);

      expect(host.errors.filter((e) => !EXPECTED_WHILE_DOWN.test(e))).toEqual([]);
      expect(collab.errors.filter((e) => !EXPECTED_WHILE_DOWN.test(e))).toEqual([]);
      expect(fresh.errors).toEqual([]);
    });

  test('after Ctrl-C and a restart, "Reconnect" in the host tab continues as a local editor', async ({ browser }) => {
    cli = await startHost();
    const { port } = cli;
    const host = await openWindow(browser, cli.url);
    await expect(host.page.locator('#share-start')).toBeVisible();
    cli.child.kill('SIGINT');
    expect((await cli.exited).code).toBe(0);
    await expect(overlay(host.page).action).toHaveText('Reconnect');

    const restarted = await startHost({ port });
    extraClis.push(restarted);
    expect(restarted.port).toBe(port);
    await overlay(host.page).action.click();
    await expect(overlay(host.page).root).toBeHidden();
    await expect(status(host.page)).toHaveText('Saved', { timeout: 5000 });
    await expect(host.page.locator('#toast')).toContainText('local-bpmn was restarted');
    await expect(host.page.locator('#share')).toBeHidden();
    await typeLabel(host.page, 'Task_CancelOrder', 'After reconnect');
    await expect.poll(disk, { timeout: 3000 }).toContain('name="After reconnect"');
    expect(host.errors).toEqual([]);
  });
});
