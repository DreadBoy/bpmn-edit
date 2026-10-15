// Creating a missing file at startup (V2-1): `bpmn-edit new.bpmn` asks first in a terminal,
// `--create` creates without asking, anything else (scripts, CI, pipes) fails with a hint.
import { stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { BLANK_DIAGRAM } from './blank.js';

/** A user-facing reason why the file was not created (the CLI prints it and exits 1). */
export class CreateError extends Error {}

/** Whether `path` may be created: its name ends in `.bpmn`, in any letter case (`Order.BPMN` too). */
export function hasBpmnExtension(path) {
  const name = basename(path);
  return name.length > '.bpmn'.length && name.toLowerCase().endsWith('.bpmn');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    // Not there (ENOTDIR: a file where a folder should be; the folder check says so). Anything else
    // (no permission, …): the normal startup check reports it.
    return err.code !== 'ENOENT' && err.code !== 'ENOTDIR';
  }
}

async function checkFolder(path) {
  const folder = dirname(path);
  let info;
  try {
    info = await stat(folder);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new CreateError(`cannot create ${path}: folder ${folder} does not exist (bpmn-edit does not create folders)`);
    }
    throw new CreateError(`cannot create ${path}: cannot access folder ${folder} (${err.code || err.message})`);
  }
  if (!info.isDirectory()) throw new CreateError(`cannot create ${path}: ${folder} is not a folder`);
}

/**
 * Makes sure there is something to open at `path`. An existing path is left alone (also with
 * `create`; the normal startup check then validates it). A missing one is created with the blank
 * diagram when `create` is set, or when `interactive` and `ask(question)` resolves true. Resolves to
 * { created } (`created` false: nothing written). Throws CreateError when the file is not created:
 * not interactive without `create` (the message says to pass --create), declined, the name does not
 * end in .bpmn, or its folder is missing. Never overwrites: the file is created with `wx`; if it
 * appeared in the meantime, it is opened as it is.
 */
export async function ensureFile({ path, create = false, interactive = false, ask = null }) {
  if (await exists(path)) return { created: false };
  if (!hasBpmnExtension(path)) throw new CreateError(`cannot create ${path}: the name must end in .bpmn`);
  await checkFolder(path);
  if (!create) {
    if (!interactive || !ask) throw new CreateError(`File not found: ${path} (pass --create to create it)`);
    if (!(await ask(`${path} does not exist. Create it? [y/N] `))) throw new CreateError(`${path} was not created`);
  }
  try {
    await writeFile(path, BLANK_DIAGRAM, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return { created: false }; // appeared meanwhile: open it as it is
    if (err.code === 'ENOENT') await checkFolder(path); // folder removed meanwhile: say so
    throw new CreateError(`cannot create ${path} (${err.code || err.message})`);
  }
  return { created: true };
}

/**
 * Asks a yes/no `question` on `output`, reading the answer from `input` (a terminal). Resolves true
 * for y/yes (any case), false for anything else, an empty answer, Ctrl-C or end of input (Ctrl-D).
 */
export function askYesNo(question, { input = process.stdin, output = process.stderr } = {}) {
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(answer);
    };
    rl.on('SIGINT', () => {
      output.write('\n');
      finish(false);
    });
    rl.on('close', () => {
      if (!done) output.write('\n');
      finish(false);
    });
    rl.question(question, (answer) => finish(/^y(es)?$/i.test(answer.trim())));
  });
}
