// Tunnel module against the real network: download cloudflared into a fresh cache, open a quick tunnel to the
// running CLI, load the diagram through the public URL, then stop the tunnel.
// Set LOCAL_BPMN_SKIP_TUNNEL_E2E=1 to skip when offline.
import { expect, test } from '@playwright/test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflareProvider, startTunnel } from '../../src/tunnel.js';
import { collectPageErrors, copyFixture, startCli } from './helpers/cli.js';

const LABELS = ['Order received', 'Check stock', 'In stock?', 'Ship order', 'Cancel order', 'Order shipped', 'Order cancelled'];

test.describe('tunnel: public URL via a Cloudflare quick tunnel', () => {
  test.skip(process.env.LOCAL_BPMN_SKIP_TUNNEL_E2E === '1', 'LOCAL_BPMN_SKIP_TUNNEL_E2E=1');
  test.setTimeout(150_000);

  let fixture;
  let cli;
  let tunnel;
  let home;

  test.afterEach(async () => {
    await tunnel?.stop();
    await cli?.stop();
    await fixture?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
    tunnel = cli = fixture = home = undefined;
  });

  test('downloads cloudflared, serves the diagram publicly, and stops cleanly', async ({ page }) => {
    fixture = await copyFixture('order.bpmn');
    cli = await startCli(fixture.file);
    home = await mkdtemp(join(tmpdir(), 'local-bpmn-home-'));

    const phases = [];
    try {
      tunnel = await startTunnel({
        port: cli.port,
        provider: cloudflareProvider({
          home,
          usePath: false, // always exercise the download into the fresh cache
          timeoutMs: 90_000,
          onProgress: (e) => { if (phases.at(-1) !== e.phase) phases.push(e.phase); },
        }),
      });
    } catch (err) {
      // Provisioning limits are per IP and outside our control; anything else is a real failure.
      test.skip(err.code === 'TUNNEL_RATE_LIMITED', `Cloudflare rate-limited quick tunnels from this network: ${err.message.split('\n')[0]}`);
      throw err;
    }
    expect(tunnel.provider).toBe('cloudflare');
    expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    expect(phases).toEqual(expect.arrayContaining(['download', 'done', 'spawn', 'url', 'ready']));
    expect((await readdir(join(home, 'bin'))).sort()).toEqual([process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared']);
    console.log(`tunnel url: ${tunnel.url}`);

    const errors = collectPageErrors(page);
    await page.goto(tunnel.url);
    await expect(page.locator('#file-name')).toHaveText('order.bpmn', { timeout: 20_000 });
    const canvas = page.locator('#canvas');
    for (const label of LABELS) {
      await expect(canvas.locator('svg text', { hasText: label }).first(), label).toBeVisible();
    }
    expect(errors).toEqual([]);

    const child = tunnel.process;
    await tunnel.stop();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    let pidAlive = true;
    try { process.kill(child.pid, 0); } catch { pidAlive = false; }
    expect(pidAlive).toBe(false);

    // The public hostname stops serving the app once the tunnel is gone.
    await expect.poll(async () => {
      try {
        const res = await fetch(tunnel.url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
        const body = await res.text();
        return res.status === 200 && body.includes('id="canvas"') ? 'serving' : `gone (${res.status})`;
      } catch (err) {
        return `gone (${err.cause?.code || err.message})`;
      }
    }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toMatch(/^gone/);
  });
});
