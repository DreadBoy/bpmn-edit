// S7: sharing via a public link — everything that does not need Cloudflare. The CLI runs with a stand-in
// tunnel (LOCAL_BPMN_TEST_TUNNEL, src/test-tunnel.js) that hands out a made-up *.trycloudflare.com URL
// without opening a tunnel. A collaborator "coming through the tunnel" is simulated by sending the
// Cloudflare headers (cf-ray / cf-connecting-ip) directly to localhost. The real tunnel is covered by
// s7-share-tunnel.spec.js.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { collectPageErrors, copyFixture, otherToken, randomPort, startCli } from './helpers/cli.js';
import { label, shape, status, typeLabel } from './helpers/editor.js';

const CF_HEADERS = { 'cf-ray': '8d0e3c7b5a1f2e4d-LJU', 'cf-connecting-ip': '203.0.113.9' };
const SHARE_URL_RE = /^https:\/\/test-[0-9a-f]+\.trycloudflare\.com\/s\/([A-Za-z0-9_-]{32})$/;

/** Locators of the share controls. */
function shareUi(page) {
  return {
    root: page.locator('#share'),
    start: page.locator('#share-start'),
    progress: page.locator('#share-progress'),
    progressText: page.locator('#share-progress-text'),
    url: page.locator('#share-url'),
    copy: page.locator('#share-copy'),
    stop: page.locator('#share-stop'),
    error: page.locator('#share-error'),
  };
}

async function waitForDiagram(page) {
  await expect(shape(page, 'Task_CheckStock')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-state', 'saved');
}

/** Opens a WebSocket from Node; resolves to the HTTP status of a refused upgrade, or 101 if it opened. */
function upgradeStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.once('open', () => { resolve(101); ws.close(); });
    ws.once('error', (err) => { if (!/Unexpected server response/.test(err.message)) reject(err); });
  });
}

test.describe('S7: share via public link (stand-in tunnel)', () => {
  let fixture;
  let cli;

  test.afterEach(async () => {
    await cli?.stop();
    await fixture?.cleanup();
    cli = fixture = undefined;
  });

  async function start(mode = 'fake', delayMs = 1500) {
    fixture = await copyFixture('order.bpmn');
    cli = await startCli(fixture.file, { env: { LOCAL_BPMN_TEST_TUNNEL: mode, LOCAL_BPMN_TEST_TUNNEL_DELAY_MS: String(delayMs) } });
  }

  const disk = () => readFile(fixture.file, 'utf8');

  test('a local page without the host secret has no Share button, and the host API refuses it', async ({ page, request }) => {
    await start();
    const errors = collectPageErrors(page);
    for (const url of [cli.baseUrl, `${cli.baseUrl}?host=wrong-secret`]) {
      await page.goto(url);
      await waitForDiagram(page);
      // The page is told whether it is the host over its WebSocket, right after 'init'; give it time.
      await page.waitForTimeout(500);
      await expect(shareUi(page).root).toBeHidden();
      await expect(shareUi(page).start).toBeHidden();
    }
    expect(errors).toEqual([]);

    // No secret, a wrong one, or the secret only in the URL: refused, and nothing was started.
    expect((await request.post(`${cli.baseUrl}api/share`)).status()).toBe(403);
    expect((await request.post(`${cli.baseUrl}api/share`, { headers: { 'X-Local-Bpmn-Host': 'wrong' } })).status()).toBe(403);
    expect((await request.post(`${cli.baseUrl}api/share?host=${cli.hostSecret}`)).status()).toBe(403);
    expect((await request.delete(`${cli.baseUrl}api/share`)).status()).toBe(403);
    expect((await request.get(`${cli.baseUrl}api/share`)).status()).toBe(403);
    const state = await request.get(`${cli.baseUrl}api/share`, { headers: { 'X-Local-Bpmn-Host': cli.hostSecret } });
    expect(await state.json()).toEqual({ state: 'idle' });
    expect(cli.stderr()).not.toContain('sharing at');
  });

  test('Cloudflare headers mark a request as remote: only /s/<token>/ works, never the host API', async ({ request }) => {
    await start('fake', 100);
    const remote = (extra = {}) => ({ headers: { ...CF_HEADERS, ...extra } });
    const hostHeader = { 'X-Local-Bpmn-Host': cli.hostSecret };

    // Before sharing: nothing exists for a remote caller.
    expect((await request.get(cli.baseUrl, remote())).status()).toBe(404);
    expect((await request.get(`${cli.baseUrl}s/${'A'.repeat(32)}/`, remote())).status()).toBe(404);

    const shared = await (await request.post(`${cli.baseUrl}api/share`, { headers: hostHeader })).json();
    const [, token] = SHARE_URL_RE.exec(shared.url);
    const tunnelHost = new URL(shared.url).host;

    for (const extra of [{}, { host: tunnelHost }]) {
      const opts = (h = {}) => remote({ ...extra, ...h });
      // The host page and the host API: 404, also with the host secret (header or URL).
      expect((await request.get(cli.baseUrl, opts())).status()).toBe(404);
      expect((await request.get(`${cli.baseUrl}?host=${cli.hostSecret}`, opts())).status()).toBe(404);
      expect((await request.get(`${cli.baseUrl}api/file`, opts())).status()).toBe(404);
      for (const method of ['get', 'post', 'delete']) {
        expect((await request[method](`${cli.baseUrl}api/share`, opts(hostHeader))).status(), method).toBe(404);
        expect((await request[method](`${cli.baseUrl}s/${token}/api/share`, opts(hostHeader))).status(), method).toBe(404);
      }
      // Wrong token / unknown path: 404.
      expect((await request.get(`${cli.baseUrl}s/${'A'.repeat(32)}/`, opts())).status()).toBe(404);
      expect((await request.get(`${cli.baseUrl}s/${otherToken(token)}/`, opts())).status()).toBe(404);
      expect((await request.get(`${cli.baseUrl}nope`, opts())).status()).toBe(404);
      // The valid link: page, assets, document.
      const page = await request.get(`${cli.baseUrl}s/${token}`, opts()); // follows the redirect to /s/<token>/
      expect(page.status()).toBe(200);
      expect(page.url()).toBe(`${cli.baseUrl}s/${token}/`);
      expect(await page.text()).toContain('id="canvas"');
      expect((await request.get(`${cli.baseUrl}s/${token}/app.js`, opts())).status()).toBe(200);
      const file = await request.get(`${cli.baseUrl}s/${token}/api/file`, opts());
      expect((await file.json()).name).toBe('order.bpmn');
    }
    // Still sharing: none of that stopped it.
    expect((await (await request.get(`${cli.baseUrl}api/share`, { headers: hostHeader })).json()).state).toBe('active');

    // Stop: the token is dead.
    expect((await request.delete(`${cli.baseUrl}api/share`, { headers: hostHeader })).status()).toBe(200);
    expect((await request.get(`${cli.baseUrl}s/${token}/`, remote())).status()).toBe(404);
    expect((await request.get(`${cli.baseUrl}s/${token}/`)).status()).toBe(404);
  });

  test('a Host or Origin that is not ours is refused, over HTTP and WebSocket', async ({ request }) => {
    await start();
    const wsUrl = `ws://127.0.0.1:${cli.port}/ws`;
    for (const host of ['evil.example', `evil.example:${cli.port}`, `localhost:${cli.port + 1}`, 'test-12345678.trycloudflare.com']) {
      expect((await request.get(`${cli.baseUrl}`, { headers: { host } })).status(), host).toBe(421);
      expect((await request.get(`${cli.baseUrl}api/file`, { headers: { host } })).status(), host).toBe(421);
      expect(await upgradeStatus(wsUrl, { host }), host).toBe(421);
    }
    expect((await request.get(`${cli.baseUrl}api/file`, { headers: { origin: 'https://evil.example' } })).status()).toBe(403);
    expect(await upgradeStatus(wsUrl, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(`${wsUrl}?host=${cli.hostSecret}`, { origin: 'https://evil.example' })).toBe(403);
    // Remote callers have no /ws.
    expect(await upgradeStatus(`${wsUrl}?host=${cli.hostSecret}`, CF_HEADERS)).toBe(404);
    // Our own names work.
    for (const host of [`localhost:${cli.port}`, `127.0.0.1:${cli.port}`]) {
      expect(await upgradeStatus(wsUrl, { host, origin: `http://${host}` }), host).toBe(101);
    }
  });

  test('host shares: secret leaves the address bar, spinner, link + Copy; a collaborator edits through it; Stop ends it',
    async ({ browser }) => {
      await start('fake', 1500);
      const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      const collabContext = await browser.newContext({ extraHTTPHeaders: CF_HEADERS });
      try {
        const host = await hostContext.newPage();
        const hostErrors = collectPageErrors(host);
        await host.goto(cli.url);
        await waitForDiagram(host);
        // The secret is not left in the address bar (replaceState: the history entry is rewritten too).
        expect(host.url()).toBe(cli.baseUrl);

        const ui = shareUi(host);
        await expect(ui.start).toBeVisible();
        await expect(ui.start).toHaveText('Share');
        await expect(ui.url).toBeHidden();
        await ui.start.click();
        await expect(ui.progress).toBeVisible();
        await expect(ui.start).toBeHidden();
        await expect(ui.progressText).toHaveText(/Downloading cloudflared… 50%|Starting tunnel…|Waiting for the public link/);
        await expect(ui.url).toBeVisible({ timeout: 10_000 });
        await expect(ui.progress).toBeHidden();
        const shareUrl = await ui.url.inputValue();
        const [, token] = SHARE_URL_RE.exec(shareUrl) ?? [];
        expect(token, shareUrl).toBeTruthy();
        await expect(ui.stop).toBeVisible();
        await ui.copy.click();
        await expect(ui.copy).toHaveText('Copied');
        expect(await host.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);

        // A reload keeps host powers (secret in this tab's sessionStorage) and shows the same link.
        await host.reload();
        await waitForDiagram(host);
        await expect(ui.url).toHaveValue(shareUrl);
        expect(host.url()).toBe(cli.baseUrl);

        // The collaborator (all requests carry Cloudflare headers) opens the link as given (no slash).
        const collab = await collabContext.newPage();
        const collabErrors = collectPageErrors(collab);
        // Everything the collaborator's page receives over its WebSocket (checked for host paths below).
        const collabFrames = [];
        collab.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => collabFrames.push(String(payload))));
        // Sanity: the headers really reach the server (the host page is 404 for this context).
        expect((await collab.goto(cli.url)).status()).toBe(404);
        const response = await collab.goto(`${cli.baseUrl}s/${token}`);
        expect(response.status()).toBe(200);
        expect(collab.url()).toBe(`${cli.baseUrl}s/${token}/`);
        await waitForDiagram(collab);
        await expect(collab.locator('#file-name')).toHaveText('order.bpmn');
        await collab.waitForTimeout(500);
        await expect(shareUi(collab).root).toBeHidden();

        // The host's absolute path (user name, directory layout) never reaches the collaborator: the
        // tooltip shows the file name only, and neither 'init' nor api/file carries a path.
        await expect(host.locator('#file-name')).toHaveAttribute('title', fixture.file);
        await expect(collab.locator('#file-name')).toHaveAttribute('title', 'order.bpmn');
        const collabFile = await collab.evaluate(async () => (await fetch('api/file')).json());
        expect(collabFile.name).toBe('order.bpmn');
        expect(collabFile).not.toHaveProperty('path');
        const collabInit = JSON.parse(collabFrames.find((f) => f.includes('"type":"init"')));
        expect(collabInit).not.toHaveProperty('path');

        // Edits sync both ways and reach disk.
        await typeLabel(collab, 'Task_CheckStock', 'Check stock (collaborator)');
        await expect(label(host, 'Task_CheckStock')).toHaveText('Check stock (collaborator)', { timeout: 3000 });
        await expect.poll(disk, { timeout: 3000 }).toContain('name="Check stock (collaborator)"');
        await typeLabel(host, 'Task_ShipOrder', 'Ship order (host)');
        await expect(label(collab, 'Task_ShipOrder')).toHaveText('Ship order (host)', { timeout: 3000 });
        await expect.poll(disk, { timeout: 3000 }).toContain('name="Ship order (host)"');

        // Stop sharing: the collaborator is disconnected and told so; the link is dead.
        await ui.stop.click();
        await expect(ui.start).toBeVisible();
        await expect(ui.url).toBeHidden();
        await expect(collab.locator('#session-overlay')).toBeVisible();
        await expect(collab.locator('#session-overlay-text')).toHaveText('The host stopped sharing. This link no longer works.');
        await expect(status(collab)).toHaveText('Disconnected');
        expect((await collab.goto(`${cli.baseUrl}s/${token}/`)).status()).toBe(404);
        // The host keeps editing.
        await expect(status(host)).toHaveText('Saved');

        expect(collabFrames.length).toBeGreaterThan(2);
        expect(collabFrames.filter((f) => f.includes(fixture.dir))).toEqual([]);
        expect(hostErrors).toEqual([]);
        expect(collabErrors.filter((e) => !/404/.test(e))).toEqual([]);
      } finally {
        await hostContext.close();
        await collabContext.close();
      }
    });

  test('a rate-limited share shows a readable error, and Share can be retried', async ({ page }) => {
    await start('rate-limited-once', 600);
    await page.goto(cli.url);
    await waitForDiagram(page);
    const ui = shareUi(page);
    await ui.start.click();
    await expect(ui.progress).toBeVisible();
    await expect(ui.error).toBeVisible({ timeout: 5000 });
    await expect(ui.error).toContainText('Cloudflare is limiting new quick tunnels from this network right now (HTTP 429)');
    await expect(ui.error).toContainText('try Share again');
    await expect(ui.progress).toBeHidden();
    await expect(ui.start).toBeVisible();

    await ui.start.click();
    await expect(ui.error).toBeHidden();
    await expect(ui.url).toBeVisible({ timeout: 5000 });
    expect(await ui.url.inputValue()).toMatch(SHARE_URL_RE);
  });

  test('other tunnel failures are shown too, and can be dismissed', async ({ page }) => {
    await start('fail', 300);
    await page.goto(cli.url);
    await waitForDiagram(page);
    const ui = shareUi(page);
    await ui.start.click();
    await expect(ui.error).toContainText('Could not start the public tunnel: cloudflared exited early (code 1).');
    await expect(ui.start).toBeVisible();
    await page.locator('#share-error-close').click();
    await expect(ui.error).toBeHidden();
  });

  test('Ctrl-C while sharing stops the tunnel and still writes the last edit', async ({ page }) => {
    await start('fake', 100);
    await page.goto(cli.url);
    await waitForDiagram(page);
    await shareUi(page).start.click();
    await expect(shareUi(page).url).toBeVisible();
    await typeLabel(page, 'Task_CheckStock', 'Edited right before Ctrl-C');
    cli.child.kill('SIGINT');
    expect(await cli.exited).toEqual({ code: 0, signal: null });
    expect(cli.stderr()).toContain('local-bpmn: sharing stopped');
    expect(await disk()).toContain('name="Edited right before Ctrl-C"');
  });

  for (const address of ['0.0.0.0', '::']) {
    test(`the CLI falls back to another port when another process listens on *:PORT (${address})`, async ({ page }) => {
      const busy = randomPort();
      const other = spawn(process.execPath, ['-e', `
        const s = require('node:net').createServer((c) => c.end('HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\n\\r\\nother'));
        s.listen(${busy}, ${JSON.stringify(address)}, () => console.log('listening'));
      `], { stdio: ['ignore', 'pipe', 'inherit'] });
      try {
        await new Promise((resolve, reject) => {
          other.stdout.once('data', resolve);
          other.once('exit', (code) => reject(new Error(`listener exited (${code})`)));
        });
        fixture = await copyFixture('order.bpmn');
        cli = await startCli(fixture.file, { port: busy });
        expect(cli.port).not.toBe(busy);
        expect(cli.stderr()).toContain(`port ${busy} is in use, using ${cli.port} instead`);
        await page.goto(cli.url);
        await waitForDiagram(page);
      } finally {
        other.kill();
      }
    });
  }
});
