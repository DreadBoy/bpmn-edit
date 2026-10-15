// Runs the CLI in a real pseudo-terminal, the way a person at a terminal runs it (V2-1: the "Create
// it?" question is only asked there). macOS `script` cannot take its input from a pipe (it needs a
// terminal or a file there), so a few lines of Python's standard `pty` module relay instead: what the
// test writes goes to the terminal as typed keys, what the CLI prints comes back.
import { spawn, spawnSync } from 'node:child_process';
import { CLI, ROOT } from './cli.js';

const RELAY = `
import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
stdin_open = True
while True:
    fds = [fd] + ([0] if stdin_open else [])
    try:
        ready, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if 0 in ready:
        data = os.read(0, 1024)
        if data:
            os.write(fd, data)
        else:
            stdin_open = False
    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else status >> 8)
`;

/** Whether a pseudo-terminal can be driven here (Python 3 with the pty module). */
export const ptyAvailable = (() => {
  if (process.platform === 'win32') return false;
  const probe = spawnSync('python3', ['-c', 'import pty, select'], { stdio: 'ignore' });
  return probe.status === 0;
})();

/**
 * Starts the CLI with `args` in a pseudo-terminal (stdin, stdout and stderr all the terminal, unless
 * `pipeStdout`).
 * Returns { child, output(), waitFor(re, ms), type(text), exited }. `exited` resolves to
 * { code, signal } of the CLI. Terminal output is collected as it is, escape sequences included.
 */
export function startInPty(args, { cwd = ROOT, env = {}, pipeStdout = false } = {}) {
  // pipeStdout: the CLI's stdout goes through `| cat` (stdin and stderr stay the terminal); its exit
  // status is printed as "exit=<n>".
  const command = pipeStdout
    ? ['/bin/sh', '-c', '{ "$0" "$@"; echo "exit=$?"; } | cat', process.execPath, CLI, ...args]
    : [process.execPath, CLI, ...args];
  const child = spawn('python3', ['-c', RELAY, ...command], {
    cwd, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env },
  });
  let out = '';
  const waiters = new Set();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d;
    for (const w of waiters) w();
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      for (const w of waiters) w();
      resolve({ code, signal });
    });
  });

  /** Resolves with the output once it matches `re`; rejects after `ms` or if the CLI exits first. */
  function waitFor(re, ms = 10_000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (re.test(out)) done(() => resolve(out));
        else if (child.exitCode !== null || child.signalCode !== null) {
          done(() => reject(new Error(`exited before ${re}; output: ${JSON.stringify(out)}`)));
        }
      };
      const timer = setTimeout(() => done(() => reject(new Error(`no ${re} within ${ms} ms; output: ${JSON.stringify(out)}`))), ms);
      function done(fn) {
        clearTimeout(timer);
        waiters.delete(check);
        fn();
      }
      waiters.add(check);
      check();
    });
  }

  return {
    child,
    exited,
    output: () => out,
    waitFor,
    type: (text) => child.stdin.write(text),
    /** Ends the CLI (the relay passes SIGTERM on to it). */
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };
}
