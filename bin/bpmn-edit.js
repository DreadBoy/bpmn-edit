#!/usr/bin/env node
// CLI entry: `bpmn-edit <file> [--create] [--port <n>] [--no-open]`
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import open from 'open';
import { askYesNo, CreateError, ensureFile } from '../src/create.js';
import { createFileStore } from '../src/file.js';
import { renderForDisk } from '../src/minimal-diff.js';
import { createServer } from '../src/server.js';
import { Session } from '../src/session.js';
import { testProviderFactory } from '../src/test-tunnel.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fail(message) {
  process.stderr.write(`bpmn-edit: error: ${message}\n`);
  process.exit(1);
}

function parsePort(value) {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('must be an integer between 1 and 65535.');
  }
  return port;
}

function parseDelay(value) {
  const ms = Number(value);
  if (!/^\d+$/.test(value) || ms > 60_000) throw new InvalidArgumentError('must be an integer between 0 and 60000.');
  return ms;
}

const program = new Command()
  .name('bpmn-edit')
  .description('Open a BPMN file in a browser-based editor.')
  .version(pkg.version)
  .argument('<file>', 'path to the .bpmn file')
  .option('-p, --port <n>', 'preferred port (falls back to the next free one)', parsePort, 3000)
  .option('--create', 'create the file with a blank diagram if it does not exist (no question asked)')
  .option('--no-open', 'do not open the browser')
  // Delay before edits are written to disk; hidden, used by tests to observe a pending write.
  .addOption(new Option('--write-delay <ms>').argParser(parseDelay).default(250).hideHelp())
  .configureOutput({
    // Route commander's own errors through the same "bpmn-edit: error:" prefix.
    outputError: (str, write) => write(`bpmn-edit: ${str}`),
  })
  .addHelpText('after', `
A missing <file> ending in .bpmn is offered for creation when run in a terminal
(\`new.bpmn does not exist. Create it? [y/N]\`); elsewhere (scripts, CI, pipes) pass
--create. Folders are never created.`)
  .exitOverride((err) => {
    process.exit(err.exitCode === 0 ? 0 : 1);
  })
  .parse();

const [filePath] = program.args;
const options = program.opts();

// A missing file: created with a blank diagram after asking (only when a person is at the terminal:
// stdin, stdout and stderr, where the question goes, are all terminals) or with --create (V2-1).
try {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
  const { created } = await ensureFile({
    path: filePath, create: options.create === true, interactive, ask: (question) => askYesNo(question),
  });
  if (created) process.stderr.write(`bpmn-edit: created ${filePath}\n`);
} catch (err) {
  if (!(err instanceof CreateError)) throw err;
  fail(err.message);
}

// Saves keep the file's own formatting (Q4, src/minimal-diff.js). BPMN_EDIT_DEBUG_WRITES=1 prints how
// each save was written (hidden, for tests).
const store = createFileStore(filePath, {
  debounceMs: options.writeDelay, render: renderForDisk, debugWrites: process.env.BPMN_EDIT_DEBUG_WRITES === '1',
});
let initialXml;
try {
  initialXml = await store.read();
} catch (err) {
  fail(err.message);
}
// How long discarded edits wait for their disconnected window to re-apply them (hidden, for tests;
// default: see src/session.js).
let reapplyGraceMs;
if (process.env.BPMN_EDIT_REAPPLY_GRACE_MS !== undefined) {
  reapplyGraceMs = Number(process.env.BPMN_EDIT_REAPPLY_GRACE_MS);
  if (!/^\d+$/.test(process.env.BPMN_EDIT_REAPPLY_GRACE_MS)) fail('BPMN_EDIT_REAPPLY_GRACE_MS must be an integer');
}
const session = new Session({ xml: initialXml, store, ...(reapplyGraceMs === undefined ? {} : { reapplyGraceMs }) });
const fileName = basename(filePath);
session.on('change', ({ origin }) => {
  if (origin === 'disk') process.stderr.write(`bpmn-edit: reloaded ${fileName} (changed on disk)\n`);
});
session.on('disk-status', ({ state, message }) => {
  const text = {
    ok: `${fileName} on disk is valid again`,
    missing: `${fileName} was deleted on disk; the next edit will recreate it`,
    invalid: `${fileName} on disk is not valid BPMN (${message}); keeping the last good version`,
  }[state];
  if (text) process.stderr.write(`bpmn-edit: ${text}\n`);
});
try {
  await store.watch();
} catch (err) {
  // Editing still works without watching; external edits just won't show up.
  process.stderr.write(`bpmn-edit: could not watch ${filePath} for changes: ${err.message}\n`);
}

// Test-only stand-in for the Cloudflare tunnel (see src/test-tunnel.js); set by the E2E tests.
let createTunnelProvider;
if (process.env.BPMN_EDIT_TEST_TUNNEL) {
  try {
    createTunnelProvider = testProviderFactory(process.env.BPMN_EDIT_TEST_TUNNEL, {
      delayMs: Number(process.env.BPMN_EDIT_TEST_TUNNEL_DELAY_MS ?? 600),
    });
  } catch (err) {
    fail(err.message);
  }
  process.stderr.write(`bpmn-edit: TEST MODE: sharing uses a fake tunnel (${process.env.BPMN_EDIT_TEST_TUNNEL})\n`);
}

// WebSocket keepalive interval; hidden, tests shorten it (default: see web/connection-shared.js).
let keepaliveMs;
if (process.env.BPMN_EDIT_KEEPALIVE_MS !== undefined) {
  keepaliveMs = Number(process.env.BPMN_EDIT_KEEPALIVE_MS);
  if (!/^\d+$/.test(process.env.BPMN_EDIT_KEEPALIVE_MS) || (keepaliveMs !== 0 && keepaliveMs < 50)) {
    fail('BPMN_EDIT_KEEPALIVE_MS must be 0 (off) or an integer of at least 50');
  }
}

const server = createServer({ filePath, session, port: options.port, createTunnelProvider, keepaliveMs });
let port;
try {
  port = await server.listen();
} catch (err) {
  fail(`could not start server: ${err.message}`);
}

if (port !== options.port) {
  process.stderr.write(`bpmn-edit: port ${options.port} is in use, using ${port} instead\n`);
}
// Single stable line; tests and tooling parse it. The URL carries the host secret: whoever opens it
// can share the session (the page moves the secret out of the address bar right away).
process.stdout.write(`bpmn-edit: editing ${filePath} at ${server.hostUrl}\n`);

if (options.open) {
  open(server.hostUrl).catch((err) => {
    process.stderr.write(`bpmn-edit: could not open browser (${err.message}); open ${server.hostUrl} manually\n`);
  });
}

// Shutdown: stop accepting, let open editors (collaborators too, through the tunnel) send their last
// edits, check the file for a last-moment save on disk and let the editors re-apply their edits on it
// (Q2), stop watching, tell them the session ended (close 4002: "Session ended", no reconnect; before
// the tunnel stops, so collaborators get it too), stop the tunnel, write everything to disk (or keep
// it aside if the file changed meanwhile), exit 0. Order and reasons: docs/decisions.md, Q2. A second
// signal skips waiting for the editors but still stops the tunnel and finishes the disk write; a
// third one exits immediately (escape hatch if the disk hangs; the tunnel module's exit hook still
// kills cloudflared).
let signals = 0;
async function shutdown() {
  signals += 1;
  if (signals === 3) process.exit(1);
  if (signals === 2) {
    // Skips waiting for the editors, but the disk write and its last look at the file still run to
    // the end: flush() waits for the one the first signal started (Q2).
    await Promise.all([server.endSession(200).then(() => server.share.stop()), session.keepUnapplied().then(() => store.flush({ final: true }))]);
    process.exit(0);
  }
  if (signals > 1) return;
  server.stopAccepting();
  await server.drainClients(1000);
  // A save on disk the watcher has not reported yet (it waits for the file to settle) is applied now;
  // if it replaced accepted edits, the windows (collaborators too: the tunnel is still up) re-apply
  // them on top of it and send them before anything is closed (Q2).
  if (await session.checkDisk()) await server.drainClients(1000);
  // Stop watching before the windows go: a change on disk from now on is caught by the final write's
  // own check (the file keeps it, our version is kept aside), never by a watcher event that would ask
  // windows that are closing to re-apply edits.
  await store.unwatch(); // our final write must not come back as an external change
  await server.endSession(1000);
  // Edits a change on disk replaced that no window re-applied (closed, or its connection died
  // unnoticed) are kept next to the file now: nobody can re-apply them any more (Q2).
  await session.keepUnapplied();
  await Promise.all([server.share.stop(), store.flush({ final: true })]);
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
