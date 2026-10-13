// S7 against the real network: the real CLI shares through a real Cloudflare quick tunnel, started from the
// Share button. ONE tunnel covers every public-URL check (Cloudflare rate-limits quick tunnels per IP, so
// this test never retries and is never repeated in a loop; retries: 0).
//
// The CLI finds cloudflared the way it does for users: on PATH, else in ~/.local-bpmn/bin (LOCAL_BPMN_HOME),
// else it downloads it there (~20 MB) — then the download progress on the Share spinner is checked too.
// Set LOCAL_BPMN_SKIP_TUNNEL_E2E=1 to skip (offline, or to spare the rate limit); every other S7 rule is
// covered without a tunnel in s7-share.spec.js.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultHome, findOnPath } from '../../src/tunnel.js';
import { collectPageErrors, copyFixture, otherToken, startCli } from './helpers/cli.js';
import { label, shape, status, typeLabel } from './helpers/editor.js';

test.describe.configure({ retries: 0 });

const SHARE_URL_RE = /^https:\/\/([a-z0-9-]+\.trycloudflare\.com)\/s\/([A-Za-z0-9_-]{32})$/;

/** PIDs of cloudflared tunnels pointed at `port`. */
function cloudflaredPids(port) {
  try {
    return execFileSync('pgrep', ['-f', `cloudflared tunnel --url http://127.0.0.1:${port} `], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** GET through the public hostname: { status, body } (no redirects followed), or { error }. */
async function publicGet(url, { method = 'GET', headers = {} } = {}) {
  try {
    const res = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.text(), location: res.headers.get('location') };
  } catch (err) {
    return { error: err.cause?.code || err.message };
  }
}

test.describe('S7: share via public link (real Cloudflare tunnel)', () => {
  test.skip(process.env.LOCAL_BPMN_SKIP_TUNNEL_E2E === '1', 'LOCAL_BPMN_SKIP_TUNNEL_E2E=1');
  test.setTimeout(420_000); // a first run downloads cloudflared; on a slow line that takes minutes

  let fixture;
  let cli;

  test.afterEach(async () => {
    const port = cli?.port;
    await cli?.stop();
    // No cloudflared may outlive the CLI.
    if (port) await expect.poll(() => cloudflaredPids(port), { timeout: 5_000 }).toEqual([]);
    await fixture?.cleanup();
    cli = fixture = undefined;
  });

  test('Share gives a public link; a collaborator edits through it; nothing else is reachable; Stop ends it',
    async ({ browser }) => {
      fixture = await copyFixture('order.bpmn');
      const cached = join(defaultHome(), 'bin', 'cloudflared');
      const willDownload = !(await findOnPath('cloudflared')) && !(await access(cached).then(() => true, () => false));
      cli = await startCli(fixture.file);
      const disk = () => readFile(fixture.file, 'utf8');

      const hostContext = await browser.newContext();
      const collabContext = await browser.newContext();
      try {
        const host = await hostContext.newPage();
        const hostErrors = collectPageErrors(host);
        await host.goto(cli.url);
        await expect(shape(host, 'Task_CheckStock')).toBeVisible();
        await expect(status(host)).toHaveText('Saved');

        // Record every progress text the spinner shows.
        await host.evaluate(() => {
          window.progressSeen = [];
          const el = document.getElementById('share-progress-text');
          new MutationObserver(() => window.progressSeen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
        });
        const startedAt = Date.now();
        await host.locator('#share-start').click();
        await expect(host.locator('#share-progress')).toBeVisible();
        await expect(host.locator('#share')).toHaveAttribute('data-state', /^(active|error)$/, { timeout: 300_000 });
        if (await host.locator('#share').getAttribute('data-state') === 'error') {
          const message = await host.locator('#share-error-text').textContent();
          // Provisioning limits are per IP and outside our control: report, never retry.
          test.skip(/HTTP 429/.test(message), `Cloudflare rate-limited quick tunnels from this network: ${message}`);
          throw new Error(`Share failed: ${message}\n${cli.stderr()}`);
        }
        const shareUrl = await host.locator('#share-url').inputValue();
        const match = SHARE_URL_RE.exec(shareUrl);
        expect(match, shareUrl).toBeTruthy();
        const [, tunnelHost, token] = match;
        const origin = `https://${tunnelHost}`;
        const progressSeen = await host.evaluate(() => window.progressSeen);
        console.log(`share url: ${shareUrl} (after ${Date.now() - startedAt} ms; progress: ${[...new Set(progressSeen)].join(' | ')})`);
        expect(progressSeen.some((text) => text.startsWith('Waiting for the public link'))).toBe(true);
        if (willDownload) {
          expect(progressSeen.some((text) => /^Downloading cloudflared… \d+%$/.test(text))).toBe(true);
          await access(cached); // cached for next time
        }
        expect(cloudflaredPids(cli.port).length).toBe(1);

        // Collaborator: opens the link as given, in a separate browser context.
        const collab = await collabContext.newPage();
        const collabErrors = collectPageErrors(collab);
        await collab.goto(shareUrl);
        expect(collab.url()).toBe(`${shareUrl}/`);
        await expect(collab.locator('#file-name')).toHaveText('order.bpmn', { timeout: 20_000 });
        await expect(shape(collab, 'Task_CheckStock')).toBeVisible();
        await expect(status(collab)).toHaveText('Saved', { timeout: 10_000 });
        await collab.waitForTimeout(1000);
        await expect(collab.locator('#share')).toBeHidden(); // no host powers

        // Edits sync both ways (through wss://<tunnel>/s/<token>/ws) and reach disk.
        await typeLabel(collab, 'Task_CheckStock', 'Checked via tunnel');
        await expect(label(host, 'Task_CheckStock')).toHaveText('Checked via tunnel', { timeout: 10_000 });
        await expect.poll(disk, { timeout: 10_000 }).toContain('name="Checked via tunnel"');
        await typeLabel(host, 'Task_ShipOrder', 'Shipped by host');
        await expect(label(collab, 'Task_ShipOrder')).toHaveText('Shipped by host', { timeout: 10_000 });
        await expect.poll(disk, { timeout: 10_000 }).toContain('name="Shipped by host"');
        await expect(status(collab)).toHaveText('Saved');

        // Through the public hostname, nothing but /s/<token>/ exists — not even with the host secret.
        const secret = { 'X-Local-Bpmn-Host': cli.hostSecret };
        const checks = {
          'wrong token': await publicGet(`${origin}/s/${'A'.repeat(32)}/`),
          'wrong token, no slash': await publicGet(`${origin}/s/${otherToken(token)}`),
          'host page': await publicGet(`${origin}/`),
          'host page with secret': await publicGet(`${origin}/?host=${cli.hostSecret}`),
          'api/file outside the share': await publicGet(`${origin}/api/file`),
          'GET /api/share': await publicGet(`${origin}/api/share`, { headers: secret }),
          'POST /api/share': await publicGet(`${origin}/api/share`, { method: 'POST', headers: secret }),
          'DELETE /api/share': await publicGet(`${origin}/api/share`, { method: 'DELETE', headers: secret }),
          'POST /s/<token>/api/share': await publicGet(`${origin}/s/${token}/api/share`, { method: 'POST', headers: secret }),
        };
        for (const [name, result] of Object.entries(checks)) expect(result.status, `${name}: ${JSON.stringify(result)}`).toBe(404);
        const page = await publicGet(`${origin}/s/${token}/`);
        expect(page.status).toBe(200);
        expect(page.body).toContain('id="canvas"');
        const redirect = await publicGet(`${origin}/s/${token}`);
        expect(redirect.status).toBe(302);
        expect(redirect.location).toBe(`/s/${token}/`);
        // Still sharing after all that.
        await expect(host.locator('#share-url')).toHaveValue(shareUrl);

        // Stop sharing: the collaborator is cut off, cloudflared exits, the old link stops working.
        await host.locator('#share-stop').click();
        await expect(host.locator('#share-start')).toBeVisible();
        await expect(collab.locator('#error')).toHaveText('The host stopped sharing. This link no longer works.', { timeout: 10_000 });
        await expect.poll(() => cloudflaredPids(cli.port), { timeout: 10_000 }).toEqual([]);
        await expect.poll(async () => {
          const res = await publicGet(`${origin}/s/${token}/`);
          return res.status === 200 && res.body.includes('id="canvas"') ? 'serving' : `gone (${res.status ?? res.error})`;
        }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toMatch(/^gone/);

        expect(hostErrors).toEqual([]);
        expect(collabErrors).toEqual([]);
      } finally {
        await hostContext.close();
        await collabContext.close();
      }
    });
});
