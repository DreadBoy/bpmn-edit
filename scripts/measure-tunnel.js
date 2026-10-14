#!/usr/bin/env node
// Q3 experiment: how a shared quick-tunnel link behaves over time and across a CLI restart.
//
//   node scripts/measure-tunnel.js --out <dir> [options]
//
// Runs the real CLI on a copy of test/fixtures/order.bpmn, opens a Cloudflare quick tunnel to its port with
// startTunnel() from src/tunnel.js (the CLI has no share flag yet), and then:
//   1. records startup timings: spawn -> URL printed -> authoritative DNS -> tunnel ready -> system DNS ->
//      first HTTP 200 through the system resolver;
//   2. polls the public URL every --interval-s seconds for --duration-min minutes, keeps a WebSocket open on
//      wss://<host>/ws (reconnecting on drops) and a Chrome page open on the public URL;
//   3. loads the diagram in Chrome at the start and at the end (screenshots + shape counts);
//   4. stops the tunnel and Ctrl-Cs the CLI, then probes the old URL for --probe-old-s seconds;
//   5. waits until --gap-s seconds after the stop, restarts the CLI, opens tunnel #2 (startup timings,
//      one Chrome load), stops it and probes its old URL for --probe-old2-s seconds.
// At most two tunnels are opened, never retried (Cloudflare rate-limits quick tunnels per IP).
//
// Since S7 the server only answers for the tunnel it started itself (Share button / POST /api/share): a
// request for any other hostname gets 421 and one coming through a tunnel needs /s/<token>/. Run against
// a CLI of S7 or later, this script therefore no longer reaches the editor; it records the Q3 run as it
// was (commit e406a46) and would need to share through /api/share to be repeated.
//
// Options:
//   --out <dir>            where all logs go (required)
//   --local                no tunnel: the "public" URL is the CLI's local URL (dry run)
//   --duration-min <n>     stability window for tunnel #1 (default 31)
//   --interval-s <n>       poll interval (default 20)
//   --probe-old-s <n>      how long to probe tunnel #1's URL after stopping it (default 120)
//   --probe-old2-s <n>     same for tunnel #2 (default 60)
//   --gap-s <n>            minimum seconds between stopping tunnel #1 and opening tunnel #2 (default 150)
//   --port <n>             CLI port (default 3917)
//   --home <dir>           cloudflared cache home (default: BPMN_EDIT_HOME or ~/.bpmn-edit)
//   --single               open only tunnel #1 (skip the restart part)
//
// Output files in --out: events.jsonl (timeline), startup.json, poll.jsonl, ws.jsonl, browser.jsonl,
// old-url-1.jsonl, old-url-2.jsonl, cloudflared-<n>.log, cli-<n>.log, browser-*.png, summary.json.
import { spawn as nodeSpawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { cloudflareProvider, probeTunnelDns, startTunnel } from '../src/tunnel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'bpmn-edit.js');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'order.bpmn');
const LABELS = ['Order received', 'Check stock', 'In stock?', 'Ship order', 'Cancel order', 'Order shipped', 'Order cancelled'];

const { values: opt } = parseArgs({
  options: {
    out: { type: 'string' },
    local: { type: 'boolean', default: false },
    single: { type: 'boolean', default: false },
    'duration-min': { type: 'string', default: '31' },
    'interval-s': { type: 'string', default: '20' },
    'probe-old-s': { type: 'string', default: '120' },
    'probe-old2-s': { type: 'string', default: '60' },
    'gap-s': { type: 'string', default: '150' },
    port: { type: 'string', default: '3917' },
    home: { type: 'string' },
  },
});
if (!opt.out) {
  console.error('usage: node scripts/measure-tunnel.js --out <dir> [--local] [--duration-min n] ...');
  process.exit(2);
}
const OUT = resolve(opt.out);
const DURATION_MS = Number(opt['duration-min']) * 60_000;
const INTERVAL_MS = Number(opt['interval-s']) * 1000;
const PROBE_OLD_MS = Number(opt['probe-old-s']) * 1000;
const PROBE_OLD2_MS = Number(opt['probe-old2-s']) * 1000;
const GAP_MS = Number(opt['gap-s']) * 1000;
const PORT = Number(opt.port);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t = Date.now()) => new Date(t).toISOString();
function jsonl(file, record) {
  appendFileSync(join(OUT, file), `${JSON.stringify({ t: iso(), ...record })}\n`);
}
function event(name, data = {}) {
  jsonl('events.jsonl', { event: name, ...data });
  console.error(`${iso()} ${name} ${JSON.stringify(data)}`);
}

// --- CLI -----------------------------------------------------------------------------------------

const workDir = join(OUT, 'work');
mkdirSync(workDir, { recursive: true });
const bpmnFile = join(workDir, 'order.bpmn');
copyFileSync(FIXTURE, bpmnFile);

function startCli(n) {
  const log = join(OUT, `cli-${n}.log`);
  const child = nodeSpawn(process.execPath, [CLI, bpmnFile, '--no-open', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => {
    appendFileSync(log, `${iso()} [exit] code=${code} signal=${signal}\n`);
    r({ code, signal });
  }));
  return new Promise((resolveStart, reject) => {
    let stdout = '';
    const tee = (name) => (d) => {
      appendFileSync(log, String(d).split(/\r?\n/).filter(Boolean).map((l) => `${iso()} [${name}] ${l}\n`).join(''));
    };
    child.stderr.on('data', tee('stderr'));
    child.stdout.on('data', (d) => {
      tee('stdout')(d);
      stdout += d;
      const m = /^bpmn-edit: editing .+ at (http:\/\/\S+)$/m.exec(stdout);
      if (m) resolveStart({ child, exited, url: m[1], port: Number(new URL(m[1]).port) });
    });
    child.on('exit', () => reject(new Error(`CLI ${n} exited early; see ${log}`)));
    setTimeout(() => reject(new Error('CLI did not start in 10 s')), 10_000);
  });
}

async function ctrlC(cli) {
  if (cli.child.exitCode !== null || cli.child.signalCode !== null) return cli.exited;
  cli.child.kill('SIGINT');
  const timer = setTimeout(() => cli.child.kill('SIGKILL'), 10_000);
  const res = await cli.exited;
  clearTimeout(timer);
  return res;
}

// --- tunnel --------------------------------------------------------------------------------------

let tunnelsOpened = 0;

/** Opens tunnel #n to `port` and records startup timings. Never retries. */
async function openTunnel(n, port) {
  if (tunnelsOpened >= 2) throw new Error('refusing to open more than two tunnels');
  tunnelsOpened += 1;
  const marks = { n, at: { startCalled: Date.now() } };
  const cfLog = join(OUT, `cloudflared-${n}.log`);
  const onProgress = (e) => {
    if (e.phase === 'download') return;
    if (!(e.phase in marks.at)) marks.at[e.phase] = Date.now();
    event(`tunnel${n}.progress`, e);
  };
  let tunnel;
  if (opt.local) {
    // Dry run: same phases, no cloudflared, the local URL plays the public one.
    onProgress({ phase: 'spawn', pid: null });
    onProgress({ phase: 'url', url: `http://127.0.0.1:${port}` });
    onProgress({ phase: 'dns', url: `http://127.0.0.1:${port}`, address: '127.0.0.1' });
    onProgress({ phase: 'ready', url: `http://127.0.0.1:${port}` });
    tunnel = { url: `http://127.0.0.1:${port}`, stop: async () => {}, process: null };
  } else {
    // Tee cloudflared's output into a log while the module parses it.
    const spawn = (cmd, args, options) => {
      const child = nodeSpawn(cmd, args, options);
      appendFileSync(cfLog, `${iso()} [spawn] ${cmd} ${args.join(' ')} pid=${child.pid}\n`);
      for (const name of ['stdout', 'stderr']) {
        child[name]?.on('data', (d) => appendFileSync(cfLog, String(d).split(/\r?\n/).filter(Boolean).map((l) => `${iso()} [${name}] ${l}\n`).join('')));
      }
      child.on('exit', (code, signal) => appendFileSync(cfLog, `${iso()} [exit] code=${code} signal=${signal}\n`));
      return child;
    };
    try {
      tunnel = await startTunnel({
        port,
        provider: cloudflareProvider({ home: opt.home, onProgress, spawn, retries: 0, timeoutMs: 90_000 }),
      });
    } catch (err) {
      marks.error = { at: Date.now(), code: err.code ?? null, message: err.message };
      event(`tunnel${n}.failed`, { code: err.code ?? null, message: err.message });
      return { marks, tunnel: null };
    }
  }
  marks.url = tunnel.url;
  const { hostname } = new URL(tunnel.url);
  // After the module says "ready": when does the system resolver know the name, and when does a plain
  // HTTPS GET (as a collaborator's browser would do it) first return 200?
  const deadline = Date.now() + 60_000;
  while (!marks.at.systemDns && Date.now() < deadline) {
    try {
      const r = await lookup(hostname);
      marks.at.systemDns = Date.now();
      marks.systemDnsAddress = r.address;
    } catch (err) {
      jsonl(`startup-${n}-attempts.jsonl`, { kind: 'system-dns', error: err.code || err.message });
      await sleep(500);
    }
  }
  while (!marks.at.firstHttp200 && Date.now() < deadline) {
    const r = await httpSample(tunnel.url);
    jsonl(`startup-${n}-attempts.jsonl`, { kind: 'http', ...r });
    if (r.status === 200) marks.at.firstHttp200 = Date.now();
    else await sleep(500);
  }
  const rel = (k) => (marks.at[k] ? marks.at[k] - marks.at.spawn : null);
  marks.iso = Object.fromEntries(Object.entries(marks.at).map(([k, v]) => [k, iso(v)]));
  marks.ms = {
    spawnToUrlPrinted: rel('url'),
    spawnToAuthoritativeDns: rel('dns'),
    spawnToReady: rel('ready'),
    spawnToSystemDns: rel('systemDns'),
    spawnToFirstHttp200: rel('firstHttp200'),
    startCallToFirstHttp200: marks.at.firstHttp200 ? marks.at.firstHttp200 - marks.at.startCalled : null,
  };
  return { marks, tunnel };
}

// --- probes --------------------------------------------------------------------------------------

/** One GET of `url` through the system resolver: { status, ms, bytes, server, cfRay, cfError, error }. */
async function httpSample(url, timeoutMs = 15_000) {
  const start = performance.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
    const body = await res.text();
    const cfError = /error code:?\s*(\d{4})/i.exec(body)?.[1] ?? (/\b(10\d\d)\b/.exec(res.status >= 400 ? body : '')?.[1] ?? null);
    return {
      status: res.status,
      ms: Math.round(performance.now() - start),
      bytes: body.length,
      server: res.headers.get('server'),
      cfRay: res.headers.get('cf-ray'),
      cfError,
      hasCanvas: body.includes('id="canvas"'),
      bodyHead: res.status === 200 ? undefined : body.replace(/\s+/g, ' ').slice(0, 200),
    };
  } catch (err) {
    return { status: null, ms: Math.round(performance.now() - start), error: err.cause?.code || err.cause?.message || err.message };
  }
}

async function dnsSample(hostname) {
  const out = {};
  try {
    out.system = (await lookup(hostname)).address;
  } catch (err) {
    out.system = `ERR ${err.code || err.message}`;
  }
  if (!opt.local) out.authoritative = await probeTunnelDns(hostname);
  return out;
}

/** Probes a stopped tunnel's URL every 10 s for `ms`. */
async function probeOld(url, ms, file, stoppedAt) {
  const end = Date.now() + ms;
  const { hostname } = new URL(url);
  for (;;) {
    const http = await httpSample(url, 10_000);
    const dns = await dnsSample(hostname);
    jsonl(file, { url, sinceStopMs: Date.now() - stoppedAt, ...http, dns });
    if (Date.now() + 10_000 > end) break;
    await sleep(10_000);
  }
}

// --- WebSocket observer --------------------------------------------------------------------------

function watchWs(httpUrl) {
  const wsUrl = httpUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
  const state = { opens: 0, drops: 0, closedByUs: false, socket: null };
  const connect = () => {
    const connectStart = Date.now();
    const ws = new WebSocket(wsUrl);
    state.socket = ws;
    ws.on('open', () => {
      state.opens += 1;
      jsonl('ws.jsonl', { kind: 'open', n: state.opens, connectMs: Date.now() - connectStart, reconnect: state.opens > 1 });
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { msg = { type: '(non-json)' }; }
      jsonl('ws.jsonl', {
        kind: 'message', type: msg.type, version: msg.version, clientId: msg.clientId, name: msg.name,
        xmlLength: typeof msg.xml === 'string' ? msg.xml.length : undefined, bytes: data.length,
      });
    });
    ws.on('ping', () => jsonl('ws.jsonl', { kind: 'ping' }));
    ws.on('error', (err) => jsonl('ws.jsonl', { kind: 'error', error: err.message }));
    ws.on('close', (code, reason) => {
      jsonl('ws.jsonl', { kind: 'close', code, reason: String(reason), byUs: state.closedByUs, openForMs: Date.now() - connectStart });
      if (state.closedByUs) return;
      state.drops += 1;
      setTimeout(() => { if (!state.closedByUs) connect(); }, 2_000);
    });
  };
  jsonl('ws.jsonl', { kind: 'connect', url: wsUrl });
  connect();
  return {
    state,
    close() { state.closedByUs = true; state.socket?.close(1000, 'measurement done'); },
  };
}

// --- browser -------------------------------------------------------------------------------------

async function loadDiagram(page, url, shot) {
  const start = Date.now();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let result;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.locator('#file-name').filter({ hasText: 'order.bpmn' }).waitFor({ timeout: 30_000 });
    await page.locator('#canvas svg text', { hasText: 'Order cancelled' }).first().waitFor({ timeout: 30_000 });
    const info = await page.evaluate((labels) => {
      const texts = [...document.querySelectorAll('#canvas svg text')].map((t) => t.textContent.trim());
      return {
        fileName: document.querySelector('#file-name')?.textContent,
        saveStatus: document.querySelector('#save-status')?.textContent,
        svgCount: document.querySelectorAll('#canvas svg').length,
        shapes: document.querySelectorAll('#canvas .djs-shape').length,
        connections: document.querySelectorAll('#canvas .djs-connection').length,
        labelsFound: labels.filter((l) => texts.some((t) => t.includes(l))),
      };
    }, LABELS);
    result = { ok: info.labelsFound.length === LABELS.length && info.shapes > 0, loadMs: Date.now() - start, ...info };
  } catch (err) {
    result = { ok: false, loadMs: Date.now() - start, error: err.message.split('\n')[0] };
  }
  await page.screenshot({ path: join(OUT, shot), fullPage: false }).catch(() => {});
  result.pageErrors = errors;
  result.screenshot = shot;
  return result;
}

async function pageStatus(page) {
  try {
    return await page.evaluate(() => ({
      saveStatus: document.querySelector('#save-status')?.textContent,
      state: document.querySelector('#save-status')?.dataset.state,
      shapes: document.querySelectorAll('#canvas .djs-shape').length,
    }));
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  }
}

// --- stats ---------------------------------------------------------------------------------------

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const pct = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
  return { n: v.length, min: v[0], median: pct(50), p95: pct(95), max: v.at(-1) };
}

// --- main ----------------------------------------------------------------------------------------

const cleanup = [];
let shuttingDown = false;
async function runCleanup() {
  while (cleanup.length) {
    const fn = cleanup.pop();
    try { await fn(); } catch (err) { event('cleanup.error', { error: err.message }); }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    event('aborted', { signal: sig });
    await runCleanup();
    process.exit(130);
  });
}

const summary = { startedAt: iso(), mode: opt.local ? 'local' : 'cloudflare', options: opt, node: process.version };
try {
  event('start', { out: OUT, mode: summary.mode, port: PORT });

  // ---- tunnel #1 ----
  const cli1 = await startCli(1);
  cleanup.push(() => ctrlC(cli1));
  event('cli1.ready', { url: cli1.url, pid: cli1.child.pid });

  const t1 = await openTunnel(1, cli1.port);
  summary.tunnel1 = t1.marks;
  writeFileSync(join(OUT, 'startup.json'), JSON.stringify([t1.marks], null, 2));
  if (!t1.tunnel) throw new Error('tunnel #1 failed; not opening another one');
  cleanup.push(() => t1.tunnel.stop());
  const url1 = t1.tunnel.url;
  event('tunnel1.up', { url: url1, ms: t1.marks.ms });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const longPage = await context.newPage();
  const startLoad = await loadDiagram(longPage, url1, 'browser-start.png');
  jsonl('browser.jsonl', { kind: 'load-start', url: url1, ...startLoad });
  event('browser.start', startLoad);

  const ws = watchWs(url1);
  cleanup.push(() => ws.close());

  // ---- stability window ----
  const windowStart = Date.now();
  let i = 0;
  while (Date.now() - windowStart < DURATION_MS) {
    const tick = Date.now();
    const sample = await httpSample(url1);
    const page = await pageStatus(longPage);
    jsonl('poll.jsonl', { i: i++, elapsedS: Math.round((tick - windowStart) / 1000), ...sample, wsOpen: ws.state.socket?.readyState === 1, page });
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - tick)));
  }
  const windowEnd = Date.now();

  // End-of-window browser checks: the page kept open the whole time, and a fresh load.
  const longPageEnd = await pageStatus(longPage);
  await longPage.screenshot({ path: join(OUT, 'browser-kept-open-end.png') }).catch(() => {});
  jsonl('browser.jsonl', { kind: 'kept-open-end', ...longPageEnd, screenshot: 'browser-kept-open-end.png' });
  const endPage = await context.newPage();
  const endLoad = await loadDiagram(endPage, url1, 'browser-end.png');
  jsonl('browser.jsonl', { kind: 'load-end', url: url1, ...endLoad });
  event('browser.end', endLoad);
  await endPage.close();

  // ---- stop as a user would: stop sharing + Ctrl-C ----
  ws.close();
  const stoppedAt = Date.now();
  event('tunnel1.stopping', { url: url1 });
  await Promise.all([t1.tunnel.stop(), ctrlC(cli1)]);
  event('tunnel1.stopped', { stopMs: Date.now() - stoppedAt, cliExit: await cli1.exited });
  await sleep(1_500);
  const longPageAfterStop = await pageStatus(longPage);
  jsonl('browser.jsonl', { kind: 'kept-open-after-stop', ...longPageAfterStop });
  await probeOld(url1, PROBE_OLD_MS, 'old-url-1.jsonl', stoppedAt);

  // ---- poll stats ----
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(join(OUT, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const polls = read('poll.jsonl');
  const wsLog = read('ws.jsonl');
  summary.stability = {
    windowStart: iso(windowStart),
    windowEnd: iso(windowEnd),
    windowMinutes: +((windowEnd - windowStart) / 60_000).toFixed(2),
    samples: polls.length,
    non200: polls.filter((p) => p.status !== 200).length,
    non200Samples: polls.filter((p) => p.status !== 200),
    latencyMs: stats(polls.filter((p) => p.status === 200).map((p) => p.ms)),
    latencyAllMs: stats(polls.map((p) => p.ms)),
    pageNotConnected: polls.filter((p) => p.page?.state && p.page.state !== 'saved').length,
    ws: {
      opens: wsLog.filter((e) => e.kind === 'open').length,
      drops: ws.state.drops,
      reconnects: wsLog.filter((e) => e.kind === 'open' && e.reconnect).length,
      closes: wsLog.filter((e) => e.kind === 'close').map((e) => ({ t: e.t, code: e.code, byUs: e.byUs, openForMs: e.openForMs })),
      messageTypes: [...new Set(wsLog.filter((e) => e.kind === 'message').map((e) => e.type))],
      pingsFromServer: wsLog.filter((e) => e.kind === 'ping').length,
      errors: wsLog.filter((e) => e.kind === 'error').length,
    },
    browserStart: startLoad,
    browserEnd: endLoad,
    browserKeptOpenEnd: longPageEnd,
    browserKeptOpenAfterStop: longPageAfterStop,
  };
  summary.oldUrl1 = read('old-url-1.jsonl').map((r) => ({ sinceStopMs: r.sinceStopMs, status: r.status, cfError: r.cfError, error: r.error, dns: r.dns }));
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  // ---- restart: new CLI process, tunnel #2 ----
  if (!opt.single) {
    const wait = stoppedAt + GAP_MS - Date.now();
    event('gap.wait', { waitMs: Math.max(0, wait) });
    if (wait > 0) await sleep(wait);
    const cli2 = await startCli(2);
    cleanup.push(() => ctrlC(cli2));
    event('cli2.ready', { url: cli2.url, pid: cli2.child.pid });
    const t2 = await openTunnel(2, cli2.port);
    summary.tunnel2 = t2.marks;
    writeFileSync(join(OUT, 'startup.json'), JSON.stringify([t1.marks, t2.marks], null, 2));
    if (t2.tunnel) {
      cleanup.push(() => t2.tunnel.stop());
      const url2 = t2.tunnel.url;
      event('tunnel2.up', { url: url2, ms: t2.marks.ms, sameHostAsTunnel1: new URL(url2).hostname === new URL(url1).hostname });
      const page2 = await context.newPage();
      const load2 = await loadDiagram(page2, url2, 'browser-tunnel2.png');
      jsonl('browser.jsonl', { kind: 'load-tunnel2', url: url2, ...load2 });
      // The page that was opened on the old link: did it come back? (It cannot: different hostname.)
      const oldPage = await pageStatus(longPage);
      jsonl('browser.jsonl', { kind: 'kept-open-old-link-after-restart', ...oldPage });
      const oldAgain = await httpSample(url1, 10_000);
      jsonl('old-url-1.jsonl', { url: url1, sinceStopMs: Date.now() - stoppedAt, note: 'while tunnel #2 is up', ...oldAgain, dns: await dnsSample(new URL(url1).hostname) });
      await page2.close();
      const stopped2 = Date.now();
      await Promise.all([t2.tunnel.stop(), ctrlC(cli2)]);
      event('tunnel2.stopped', { stopMs: Date.now() - stopped2 });
      await probeOld(url2, PROBE_OLD2_MS, 'old-url-2.jsonl', stopped2);
      summary.restart = {
        hostname1: new URL(url1).hostname,
        hostname2: new URL(url2).hostname,
        sameHost: new URL(url2).hostname === new URL(url1).hostname,
        tunnel2Load: load2,
        oldPageAfterRestart: oldPage,
        oldUrl1WhileTunnel2Up: oldAgain,
        oldUrl2: read('old-url-2.jsonl').map((r) => ({ sinceStopMs: r.sinceStopMs, status: r.status, cfError: r.cfError, error: r.error, dns: r.dns })),
      };
    }
  }
  summary.tunnelsOpened = tunnelsOpened;
  summary.finishedAt = iso();
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  event('done', { tunnelsOpened });
} catch (err) {
  summary.error = err.message;
  summary.tunnelsOpened = tunnelsOpened;
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  event('error', { error: err.message });
  process.exitCode = 1;
} finally {
  await runCleanup();
  event('exit', { tunnelsOpened });
}
