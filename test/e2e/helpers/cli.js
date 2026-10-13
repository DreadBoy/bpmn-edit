// Helpers to run the real CLI as a child process, the way a user would.
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
export const CLI = join(ROOT, 'bin', 'local-bpmn.js');
export const FIXTURES = join(ROOT, 'test', 'fixtures');

const READY_LINE = /^local-bpmn: editing (.+) at (http:\/\/\S+)$/m;

/** Copies a fixture into a fresh temp dir; returns { dir, file, cleanup }. */
export async function copyFixture(name = 'order.bpmn') {
  const dir = await mkdtemp(join(tmpdir(), 'local-bpmn-e2e-'));
  const file = join(dir, basename(name));
  await copyFile(join(FIXTURES, name), file);
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Random port below the OS ephemeral ranges (macOS 49152+, Linux 32768+), so it cannot collide
 * with outgoing connections' source ports, and above common dev-server ports.
 */
export function randomPort() {
  return 20000 + Math.floor(Math.random() * 12000);
}

/**
 * Runs the CLI to completion (for error paths). Resolves to { code, signal, stdout, stderr }.
 */
export function runCli(args, { cwd = ROOT, timeoutMs = 10_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Starts the CLI on `file` (always with --no-open) and waits for the ready line.
 * Resolves to { url, baseUrl, port, child, stdout(), stderr(), stop() }. `url` is the printed URL,
 * which carries the host secret; `baseUrl` is the same without it (no host powers). `env` is added to
 * the CLI's environment. Always call stop() in teardown.
 */
export function startCli(file, { port = randomPort(), args = [], cwd = ROOT, timeoutMs = 10_000, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, file, '--no-open', '--port', String(port), ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });

  const exited = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
  });

  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const result = await exited;
    clearTimeout(timer);
    return result;
  }

  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`CLI did not become ready within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
      const match = READY_LINE.exec(stdout);
      if (match) {
        clearTimeout(timer);
        const url = match[2];
        resolveStart({
          url,
          baseUrl: `${new URL(url).origin}/`,
          hostSecret: new URL(url).searchParams.get('host'),
          port: Number(new URL(url).port),
          child,
          exited,
          stdout: () => stdout,
          stderr: () => stderr,
          stop,
        });
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited early (code ${code}, signal ${signal})\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    child.on('error', reject);
  });
}

/** A token that differs from `token` in its last character only (never equal to it). */
export function otherToken(token) {
  const other = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  if (other === token) throw new Error('otherToken: same token');
  return other;
}

/** Records console errors and uncaught page errors; returns the live array. */
export function collectPageErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}
