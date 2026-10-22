// Vendors the browser libraries into web/vendor/. The result is committed so the
// published package needs no bundling step.
//
//  - bpmn-js: copies the prebuilt modeler bundle (window.BpmnJS) and its assets
//    into web/vendor/bpmn-js/.
//  - bpmn-js-properties-panel: has no minified browser bundle, so esbuild builds
//    one (an IIFE exposing window.BpmnJSPropertiesPanel = { BpmnPropertiesPanelModule,
//    BpmnPropertiesProviderModule }; no Camunda/Zeebe modules) plus the panel CSS
//    into web/vendor/bpmn-js-properties-panel/. LICENSE holds the license of every
//    package that ends up in the bundle.
//  - bpmn-js-color-picker: ships no browser build either; esbuild bundles it
//    (window.BpmnColorPickerModule) with its CSS into web/vendor/bpmn-js-color-picker/.
//
// The output is deterministic: running this twice changes nothing, which the
// release workflow checks (`git status --porcelain -- web/vendor`).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');

function readVersion(pkgDir, name) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  } catch {
    console.error(`vendor: ${name} not installed; run \`npm install\` first`);
    process.exit(1);
  }
}

function vendorBpmnJs() {
  const pkgDir = join(modules, 'bpmn-js');
  const dist = join(pkgDir, 'dist');
  const target = join(root, 'web', 'vendor', 'bpmn-js');

  const files = [
    'bpmn-modeler.production.min.js',
    'assets/diagram-js.css',
    'assets/bpmn-js.css',
    'assets/bpmn-font', // css + font files
  ];

  const version = readVersion(pkgDir, 'bpmn-js');

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  for (const file of files) {
    cpSync(join(dist, file), join(target, file), { recursive: true });
  }
  cpSync(join(pkgDir, 'LICENSE'), join(target, 'LICENSE'));
  writeFileSync(join(target, 'VERSION'), `${version}\n`);

  console.log(`vendor: copied bpmn-js ${version} to ${target}`);
}

// Package directory (relative to node_modules) of a bundled input path such as
// "node_modules/@bpmn-io/properties-panel/dist/index.esm.js".
function packageOf(inputPath) {
  const parts = inputPath.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return null;
  const name = parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
  return parts.slice(0, at + 1).concat(name.split('/')).join('/');
}

async function vendorPropertiesPanel() {
  const pkgDir = join(modules, 'bpmn-js-properties-panel');
  const panelDir = join(modules, '@bpmn-io', 'properties-panel');
  const target = join(root, 'web', 'vendor', 'bpmn-js-properties-panel');

  const version = readVersion(pkgDir, 'bpmn-js-properties-panel');
  const panelVersion = readVersion(panelDir, '@bpmn-io/properties-panel');

  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.error('vendor: esbuild not installed; run `npm install` first');
    process.exit(1);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  // Only the two plain-BPMN modules are imported, so tree shaking leaves the
  // Camunda/Zeebe providers out of the bundle.
  const result = await esbuild.build({
    stdin: {
      contents:
        "export { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } from 'bpmn-js-properties-panel';\n",
      resolveDir: root,
      sourcefile: 'properties-panel-entry.js',
      loader: 'js',
    },
    absWorkingDir: root,
    bundle: true,
    format: 'iife',
    globalName: 'BpmnJSPropertiesPanel',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none', // the licenses are collected into LICENSE below
    charset: 'utf8',
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
    write: false,
    logLevel: 'warning',
  });

  const bundle = result.outputFiles[0].contents;
  writeFileSync(join(target, 'bpmn-js-properties-panel.min.js'), bundle);
  cpSync(join(panelDir, 'dist', 'assets', 'properties-panel.css'), join(target, 'properties-panel.css'));

  // One LICENSE with the license of each package in the bundle, sorted by name.
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const pkg = packageOf(input);
    if (pkg) packages.add(pkg);
  }
  const sections = [...packages]
    .map((pkg) => {
      const dir = join(root, pkg);
      const { name, version: v, license, repository } = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      );
      let text;
      for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
        try {
          text = readFileSync(join(dir, file), 'utf8').trim();
          break;
        } catch {
          // try the next name
        }
      }
      if (!text) {
        // A few packages ship only the license field (e.g. @bpmn-io/semver-compat).
        if (!license) {
          console.error(`vendor: ${name} has neither a LICENSE file nor a license field`);
          process.exit(1);
        }
        const repo = typeof repository === 'string' ? repository : repository?.url;
        text = `Licensed under ${license}; the package ships no license text${repo ? ` (source: ${repo})` : ''}.`;
      }
      return { name, text: `${name}@${v} (${license})\n\n${text}\n` };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const header =
    'web/vendor/bpmn-js-properties-panel/bpmn-js-properties-panel.min.js is built by\n' +
    'scripts/vendor.js from the packages below; each keeps its own license.\n';
  writeFileSync(
    join(target, 'LICENSE'),
    [header, ...sections.map((s) => s.text)].join(`\n${'-'.repeat(78)}\n\n`),
  );
  writeFileSync(
    join(target, 'VERSION'),
    `bpmn-js-properties-panel ${version}\n@bpmn-io/properties-panel ${panelVersion}\nesbuild ${esbuild.version}\n`,
  );

  console.log(
    `vendor: built bpmn-js-properties-panel ${version} (${(bundle.length / 1024).toFixed(0)} KiB, ` +
      `${sections.length} packages) to ${target}`,
  );
}

// bpmn-js-color-picker (V2-6): context pad "Set color" → popup with the bpmn.io colours and "Default"; applies
// them with `modeling.setColor`. The package ships only ES module sources, so esbuild bundles it into
// web/vendor/bpmn-js-color-picker/ as one minified IIFE that sets `window.BpmnColorPickerModule` (a didi
// module), which web/app.js passes as `additionalModules` to the page's one Modeler. The plugin imports nothing
// from bpmn-js or diagram-js (its services are injected), and the build fails if the bundle would contain any
// file outside the package, so a later version can't slip a second copy of them in unnoticed.
async function vendorColorPicker() {
  const { buildSync } = await import('esbuild');
  const name = 'bpmn-js-color-picker';
  const pluginDir = join(modules, name);
  const pluginTarget = join(root, 'web', 'vendor', name);

  const pluginVersion = readVersion(pluginDir, name);

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

vendorBpmnJs();
await vendorPropertiesPanel();
await vendorColorPicker();
