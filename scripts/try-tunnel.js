#!/usr/bin/env node
// Dev-only: open a quick tunnel to a local port and keep it up until Ctrl-C.
//   node scripts/try-tunnel.js <port>
// Pointed at a local-bpmn server, every request answers 421: since S7 the server only accepts the tunnel
// hostname it started itself (Share button). Use the Share button there instead.
import { startTunnel } from '../src/tunnel.js';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('usage: node scripts/try-tunnel.js <port>');
  process.exit(2);
}

let lastReport = 0;
function onProgress(event) {
  if (event.phase === 'download') {
    if (Date.now() - lastReport < 1_000) return;
    lastReport = Date.now();
    const total = event.total ? ` of ${(event.total / 1e6).toFixed(1)} MB` : '';
    console.error(`downloading cloudflared: ${(event.received / 1e6).toFixed(1)} MB${total}`);
  } else {
    console.error(`[${event.phase}]${event.path ? ` ${event.path}` : ''}${event.url ? ` ${event.url}` : ''}`);
  }
}

try {
  const tunnel = await startTunnel({ port, onProgress });
  console.log(tunnel.url);
  const shutdown = async () => {
    console.error('stopping tunnel...');
    await tunnel.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
