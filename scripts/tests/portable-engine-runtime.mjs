import fs from 'node:fs';
import vm from 'node:vm';

// All source executes inside an empty context, including YAML's browser build.
// Only the loader (outside the context) may read test modules and fixture data.
const root = new URL('../../', import.meta.url);
const yaml = new URL('node_modules/yaml/browser/', root);
const entry = new URL('portable-engine-scenarios.mjs', import.meta.url);
const modules = new Map();
const context = vm.createContext({ TextEncoder });
function load(url) {
  if (!modules.has(url.href)) modules.set(url.href, new vm.SourceTextModule(fs.readFileSync(url, 'utf8'), { context, identifier: url.href }));
  return modules.get(url.href);
}
const test = load(entry);
await test.link((specifier, parent) => {
  if (specifier === 'yaml') return load(new URL('index.js', yaml));
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`Nonportable import: ${specifier}`);
  const url = new URL(specifier, parent.identifier);
  if (!url.href.startsWith(new URL('engine/', root).href) && !url.href.startsWith(yaml.href)) throw new Error(`Outside engine: ${url}`);
  return load(url);
});
await test.evaluate();
const defaults = JSON.parse(fs.readFileSync(new URL('scripts/lib/project-defaults.json', root), 'utf8'));
const results = await test.namespace.runPortableEngineScenarios(defaults);
console.log(JSON.stringify({ runtime: 'isolated-web-globals', modules: modules.size, checks: results }));
