// S8 against the real network: a collaborator connected through a real Cloudflare quick tunnel stays
// connected while idle for longer than the ~125 s after which Cloudflare cuts idle WebSockets
// (docs/q3-tunnel-measurements.md), then edits, and the edit reaches disk.
//
// ONE tunnel per run (Cloudflare rate-limits quick tunnels per IP; retries: 0). Default timings: the
// host pings every socket every 30 s, the page sends a heartbeat every 30 s. Next to the page, a plain
// WebSocket client joins through the same link and sends nothing at all, so whether the host's
// WebSocket pings alone keep a connection open is measured too (it is logged, not asserted).
// Set LOCAL_BPMN_SKIP_TUNNEL_E2E=1 to skip (offline, or to spare the rate limit).
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { collectPageErrors, startCli } from './helpers/cli.js';
import { label, setupRepo, shape, status, typeLabel } from './helpers/editor.js';
import { userList } from './helpers/presence.js';

test.describe.configure({ retries: 0 });

const SHARE_URL_RE = /^https:\/\/([a-z0-9-]+\.trycloudflare\.com)\/s\/([A-Za-z0-9_-]{32})$/;

/** Longer than Cloudflare's ~125 s idle cut. */
const IDLE_MS = 150_000;

function cloudflaredPids(port) {
  try {
    return execFileSync('pgrep', ['-f', `cloudflared tunnel --url http://127.0.0.1:${port} `], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test.describe('S8: keepalive through a real Cloudflare tunnel', () => {
  test.skip(process.env.LOCAL_BPMN_SKIP_TUNNEL_E2E === '1', 'LOCAL_BPMN_SKIP_TUNNEL_E2E=1');
  test.setTimeout(420_000);

  let fixture;
  let cli;

  test.afterEach(async () => {
    const port = cli?.port;
    await cli?.stop();
    if (port) await expect.poll(() => cloudflaredPids(port), { timeout: 5_000 }).toEqual([]);
    await fixture?.cleanup();
    cli = fixture = undefined;
  });

  test('a collaborator idle for more than 125 s stays connected, then edits and the edit reaches disk',
    async ({ browser }) => {
      fixture = await setupRepo();
      cli = await startCli(fixture.file, { cwd: fixture.dir });
      const disk = () => readFile(fixture.file, 'utf8');
      const hostContext = await browser.newContext();
      const collabContext = await browser.newContext();
      let raw = null;
      try {
        const host = await hostContext.newPage();
        const hostErrors = collectPageErrors(host);
        await host.goto(cli.url);
        await expect(status(host)).toHaveText('Saved');
        await host.locator('#share-start').click();
        await expect(host.locator('#share')).toHaveAttribute('data-state', /^(active|error)$/, { timeout: 120_000 });
        if (await host.locator('#share').getAttribute('data-state') === 'error') {
          const message = await host.locator('#share-error-text').textContent();
          test.skip(/HTTP 429/.test(message), `Cloudflare rate-limited quick tunnels from this network: ${message}`);
          throw new Error(`Share failed: ${message}\n${cli.stderr()}`);
        }
        const shareUrl = await host.locator('#share-url').inputValue();
        const [, tunnelHost, token] = SHARE_URL_RE.exec(shareUrl) ?? [];
        expect(tunnelHost, shareUrl).toBeTruthy();

        const collab = await collabContext.newPage();
        const collabErrors = collectPageErrors(collab);
        const sockets = [];
        collab.on('websocket', (ws) => {
          const entry = { url: ws.url(), openedAt: Date.now(), closedAt: null };
          sockets.push(entry);
          ws.on('close', () => { entry.closedAt = Date.now(); });
        });
        await collab.goto(shareUrl);
        await expect(shape(collab, 'Task_CheckStock')).toBeVisible({ timeout: 20_000 });
        await expect(status(collab)).toHaveText('Saved', { timeout: 10_000 });
        await expect.poll(() => userList(host).then((l) => l.length), { timeout: 10_000 }).toBe(2);

        // A bare client on the same link: answers the host's pings (the ws library does) and sends nothing.
        raw = { ws: new WebSocket(`wss://${tunnelHost}/s/${token}/ws`), openedAt: null, closed: null, pings: 0 };
        raw.ws.on('error', () => {});
        raw.ws.on('ping', () => { raw.pings += 1; });
        raw.ws.once('close', (code) => { raw.closed = { code, after: Date.now() - raw.openedAt }; });
        await new Promise((resolve, reject) => { raw.ws.once('open', resolve); raw.ws.once('error', reject); });
        raw.openedAt = Date.now();

        // Idle: nobody touches anything.
        const idleStart = Date.now();
        await collab.waitForTimeout(IDLE_MS); // the point of this test is to wait out Cloudflare's idle cut
        const idleMs = Date.now() - idleStart;

        const result = {
          idleMs,
          collabSockets: sockets.map((s) => ({ openFor: (s.closedAt ?? Date.now()) - s.openedAt, closed: s.closedAt !== null })),
          collabStatus: await status(collab).textContent(),
          rawClient: raw.closed ? { closedWith: raw.closed.code, afterMs: raw.closed.after, pings: raw.pings }
            : { open: raw.ws.readyState === WebSocket.OPEN, openForMs: Date.now() - raw.openedAt, pings: raw.pings },
        };
        console.log(`S8 tunnel keepalive: ${JSON.stringify(result)}`);

        // The page stayed on its first connection the whole time.
        expect(idleMs).toBeGreaterThan(125_000);
        expect(sockets).toHaveLength(1);
        expect(sockets[0].closedAt).toBeNull();
        await expect(status(collab)).toHaveText('Saved');
        await expect(collab.locator('#reconnecting')).toBeHidden();

        // And it still works: an edit reaches the host and disk.
        await typeLabel(collab, 'Task_CheckStock', 'Edited after 150 s idle');
        await expect(label(host, 'Task_CheckStock')).toHaveText('Edited after 150 s idle', { timeout: 10_000 });
        await expect.poll(disk, { timeout: 10_000 }).toContain('name="Edited after 150 s idle"');
        await expect(status(collab)).toHaveText('Saved');
        expect(sockets).toHaveLength(1);

        expect(hostErrors).toEqual([]);
        expect(collabErrors).toEqual([]);
      } finally {
        raw?.ws.terminate();
        await hostContext.close();
        await collabContext.close();
      }
    });
});
