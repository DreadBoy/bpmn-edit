// Copies the prebuilt bpmn-js modeler bundle and its assets into web/vendor/bpmn-js/, and builds bundles of
// bpmn-js plugins that ship no browser build (see buildColorPicker below).
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

await buildColorPicker();

// --- V2-6: bpmn-js-color-picker ------------------------------------------------------------------------
// Context pad "Set color" → popup with the bpmn.io colours and "Default"; applies them with
// `modeling.setColor`. The package ships only ES module sources (no browser build), so esbuild bundles it
// into web/vendor/bpmn-js-color-picker/ as one minified IIFE that sets `window.BpmnColorPickerModule`
// (a didi module: colorContextPadProvider and colorPopupProvider). web/app.js passes it as
// `additionalModules` to the page's one bpmn-js Modeler.
// What the bundle contains: only the package's own three files (colors/index.js,
// ColorContextPadProvider.js, ColorPopupProvider.js). The plugin imports nothing from bpmn-js,
// diagram-js or anything else: contextPad, popupMenu, modeling, canvas, translate and config are injected
// by the Modeler. The build fails if the bundle would contain any file outside the package, so a later
// version can never slip a second copy of bpmn-js/diagram-js modules or services into it unnoticed.
// The output is deterministic (no source maps, no absolute paths): `npm run vendor` twice changes nothing.
async function buildColorPicker() {
  const { buildSync } = await import('esbuild');
  const name = 'bpmn-js-color-picker';
  const pluginDir = join(root, 'node_modules', name);
  const pluginTarget = join(root, 'web', 'vendor', name);

  let pluginVersion;
  try {
    pluginVersion = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version;
  } catch {
    console.error(`vendor: ${name} not installed; run \`npm install\` first`);
    process.exit(1);
  }

  const result = buildSync({
    stdin: {
      contents: `import ColorPickerModule from '${name}';\nwindow.BpmnColorPickerModule = ColorPickerModule;\n`,
      resolveDir: root,
      sourcefile: 'color-picker-entry.js',
      loader: 'js',
    },
    absWorkingDir: root,
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'es2020',
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    write: false,
    logLevel: 'error',
  });

  // metafile input paths are relative to absWorkingDir, with forward slashes.
  const foreign = Object.keys(result.metafile.inputs).filter(
    (input) => input !== 'color-picker-entry.js' && !input.startsWith(`node_modules/${name}/`),
  );
  if (foreign.length > 0) {
    console.error(`vendor: the ${name} bundle would include files outside the package: ${foreign.join(', ')}`);
    process.exit(1);
  }

  rmSync(pluginTarget, { recursive: true, force: true });
  mkdirSync(pluginTarget, { recursive: true });
  const banner = `/*! ${name} ${pluginVersion} | MIT License | Copyright (c) 2016-present Camunda Services GmbH | bundled by scripts/vendor.js */\n`;
  writeFileSync(join(pluginTarget, 'color-picker.min.js'), banner + result.outputFiles[0].text);
  cpSync(join(pluginDir, 'colors', 'color-picker.css'), join(pluginTarget, 'color-picker.css'));
  cpSync(join(pluginDir, 'LICENSE'), join(pluginTarget, 'LICENSE'));
  writeFileSync(join(pluginTarget, 'VERSION'), `${pluginVersion}\n`);

  console.log(`vendor: bundled ${name} ${pluginVersion} to ${pluginTarget}`);
}
