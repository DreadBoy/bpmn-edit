#!/usr/bin/env node
// CLI entry: `local-bpmn <file> [--port <n>] [--no-open]`
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import open from 'open';
import { createFileStore } from '../src/file.js';
import { createServer } from '../src/server.js';
import { Session } from '../src/session.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fail(message) {
  process.stderr.write(`local-bpmn: error: ${message}\n`);
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
  .name('local-bpmn')
  .description('Open a BPMN file in a browser-based editor.')
  .version(pkg.version)
  .argument('<file>', 'path to the .bpmn file')
  .option('-p, --port <n>', 'preferred port (falls back to the next free one)', parsePort, 3000)
  .option('--no-open', 'do not open the browser')
  // Delay before edits are written to disk; hidden, used by tests to observe a pending write.
  .addOption(new Option('--write-delay <ms>').argParser(parseDelay).default(250).hideHelp())
  .configureOutput({
    // Route commander's own errors through the same "local-bpmn: error:" prefix.
    outputError: (str, write) => write(`local-bpmn: ${str}`),
  })
  .exitOverride((err) => {
    process.exit(err.exitCode === 0 ? 0 : 1);
  })
  .parse();

const [filePath] = program.args;
const options = program.opts();

const store = createFileStore(filePath, { debounceMs: options.writeDelay });
let initialXml;
try {
  initialXml = await store.read();
} catch (err) {
  fail(err.message);
}
const session = new Session({ xml: initialXml, store });
const fileName = basename(filePath);
session.on('change', ({ origin }) => {
  if (origin === 'disk') process.stderr.write(`local-bpmn: reloaded ${fileName} (changed on disk)\n`);
});
session.on('disk-status', ({ state, message }) => {
  const text = {
    ok: `${fileName} on disk is valid again`,
    missing: `${fileName} was deleted on disk; the next edit will recreate it`,
    invalid: `${fileName} on disk is not valid BPMN (${message}); keeping the last good version`,
  }[state];
  if (text) process.stderr.write(`local-bpmn: ${text}\n`);
});
try {
  await store.watch();
} catch (err) {
  // Editing still works without watching; external edits just won't show up.
  process.stderr.write(`local-bpmn: could not watch ${filePath} for changes: ${err.message}\n`);
}

const server = createServer({ filePath, session, port: options.port });
let port;
try {
  port = await server.listen();
} catch (err) {
  fail(`could not start server: ${err.message}`);
}

if (port !== options.port) {
  process.stderr.write(`local-bpmn: port ${options.port} is in use, using ${port} instead\n`);
}
// Single stable line; tests and tooling parse it.
process.stdout.write(`local-bpmn: editing ${filePath} at ${server.url}\n`);

if (options.open) {
  open(server.url).catch((err) => {
    process.stderr.write(`local-bpmn: could not open browser (${err.message}); open ${server.url} manually\n`);
  });
}

// Shutdown: stop accepting, let open editors send their last edits, write everything to disk, exit 0.
// A second signal skips waiting for the editors but still finishes the disk write; a third one
// exits immediately (escape hatch if the disk hangs).
let signals = 0;
async function shutdown() {
  signals += 1;
  if (signals === 3) process.exit(1);
  if (signals === 2) {
    await store.flush();
    process.exit(0);
  }
  if (signals > 1) return;
  server.stopAccepting();
  await server.drainClients(1000);
  if (await session.checkDisk()) await server.drainClients(1000); // re-apply edits on a last-moment save (Q2)
  await store.unwatch(); // our final write must not come back as an external change
  await store.flush();
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
