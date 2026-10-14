// TEST ONLY: a stand-in tunnel provider so the share flow (UI, routes, security rules) can be tested without
// Cloudflare. It opens no tunnel and no network connection: it only reports progress and hands back a made-up
// https://<name>.trycloudflare.com URL. Tests then send requests to localhost with that Host header and a
// Cloudflare header (cf-ray) to act as a collaborator coming through the tunnel.
//
// Selected only by the CLI's environment at startup (BPMN_EDIT_TEST_TUNNEL); nothing reachable over HTTP
// can switch it on. Modes:
//   fake                 every start succeeds
//   rate-limited         every start fails with TUNNEL_RATE_LIMITED (Cloudflare's HTTP 429)
//   rate-limited-once    the first start fails with TUNNEL_RATE_LIMITED, later ones succeed
//   fail                 every start fails with a generic error
// BPMN_EDIT_TEST_TUNNEL_DELAY_MS (default 600) is how long a start takes.
import { randomBytes } from 'node:crypto';

export const TEST_TUNNEL_MODES = ['fake', 'rate-limited', 'rate-limited-once', 'fail'];

export function testProviderFactory(mode, { delayMs = 600 } = {}) {
  if (!TEST_TUNNEL_MODES.includes(mode)) {
    throw new Error(`BPMN_EDIT_TEST_TUNNEL must be one of ${TEST_TUNNEL_MODES.join(', ')}`);
  }
  let starts = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return ({ onProgress = () => {} } = {}) => ({
    name: `test-${mode}`,
    async start() {
      starts += 1;
      const step = delayMs / 3;
      onProgress({ phase: 'download', received: 512 * 1024, total: 1024 * 1024 });
      await sleep(step);
      onProgress({ phase: 'spawn' });
      await sleep(step);
      if (mode === 'rate-limited' || (mode === 'rate-limited-once' && starts === 1)) {
        const err = new Error('Cloudflare is rate-limiting quick tunnels from this network (HTTP 429). Try again in a few minutes.');
        err.code = 'TUNNEL_RATE_LIMITED';
        throw err;
      }
      if (mode === 'fail') throw new Error('Tunnel failed to start: cloudflared exited early (code 1).\nLast output:\nfake failure');
      const url = `https://test-${randomBytes(4).toString('hex')}.trycloudflare.com`;
      onProgress({ phase: 'url', url });
      await sleep(step);
      onProgress({ phase: 'ready', url });
      return { url, stop: async () => {} };
    },
  });
}
