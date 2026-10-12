// Copies the prebuilt bpmn-js modeler bundle and its assets into web/vendor/bpmn-js/.
// The result is committed so the published package needs no bundling step.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', 'bpmn-js');
const dist = join(pkgDir, 'dist');
const target = join(root, 'web', 'vendor', 'bpmn-js');

const files = [
  'bpmn-modeler.production.min.js',
  'assets/diagram-js.css',
  'assets/bpmn-js.css',
  'assets/bpmn-font', // css + font files
];

let version;
try {
  version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
} catch {
  console.error('vendor: bpmn-js not installed; run `npm install` first');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const file of files) {
  cpSync(join(dist, file), join(target, file), { recursive: true });
}
cpSync(join(pkgDir, 'LICENSE'), join(target, 'LICENSE'));
writeFileSync(join(target, 'VERSION'), `${version}\n`);

console.log(`vendor: copied bpmn-js ${version} to ${target}`);
