#!/usr/bin/env node
// CLI entry: `local-bpmn <file> [--port <n>] [--no-open]`
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import open from 'open';
import { readBpmnFile } from '../src/file.js';
import { createServer } from '../src/server.js';

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

const program = new Command()
  .name('local-bpmn')
  .description('Open a BPMN file in a browser-based editor.')
  .version(pkg.version)
  .argument('<file>', 'path to the .bpmn file')
  .option('-p, --port <n>', 'preferred port (falls back to the next free one)', parsePort, 3000)
  .option('--no-open', 'do not open the browser')
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

try {
  await readBpmnFile(filePath);
} catch (err) {
  fail(err.message);
}

const server = createServer({ filePath, port: options.port });
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
