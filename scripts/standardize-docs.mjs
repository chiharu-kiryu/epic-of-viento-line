import path from 'node:path';
import fs from 'node:fs/promises';
import {
  buildStandardCatalog,
  cleanupStandardStaleFiles,
  STANDARD_ROOT,
  PROJECT_ROOT,
} from './standardize-docs/core.mjs';
import { APPLICATION_ROOT, ASSET_ROOT } from './lib/paths.mjs';

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function realLocation(value) {
  let existing = path.resolve(value);
  const missing = [];
  while (true) {
    try { return path.join(await fs.realpath(existing), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(existing) === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

async function validateOutput(outputRoot) {
  const output = await realLocation(outputRoot);
  const project = await realLocation(PROJECT_ROOT);
  const cache = await realLocation(path.join(PROJECT_ROOT, '.viento/cache'));
  const insideCache = output !== cache && within(cache, output);
  const privateRoot = await realLocation(path.join(PROJECT_ROOT, '.viento'));
  const sourceRoots = ['.git', 'documents', 'templates', 'design-data', 'data-template', 'assets', 'engine', 'mobile', 'scripts', 'web', 'docs',
    'metadata', 'workspaces', 'schemas', 'desktop', 'src-tauri'];
  const protectedRoots = [await realLocation(ASSET_ROOT)];
  for (const base of new Set([PROJECT_ROOT, APPLICATION_ROOT])) {
    for (const name of sourceRoots) {
      const source = await realLocation(path.join(base, name));
      // The developer's selected workspace may live under app/workspaces/. Its
      // own generated cache is allowed; authored folders are still checked.
      if (name === 'workspaces' && within(source, project) && insideCache) continue;
      protectedRoots.push(source);
    }
  }
  if (within(output, project) || (within(privateRoot, output) && !insideCache)
    || protectedRoots.some((source) => within(source, output) || within(output, source))) {
    throw new Error('--output must be a generated-data directory separate from project sources.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sourceFilters = [];
  let outputRoot = STANDARD_ROOT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output') {
      const next = args[index + 1];
      if (next && !next.startsWith('-')) {
        outputRoot = path.isAbsolute(next) ? next : path.join(PROJECT_ROOT, next);
        index += 1;
        continue;
      }
      throw new Error('--output requires a directory path.');
    }
    if (arg.startsWith('--output=')) {
      const explicit = arg.slice('--output='.length).trim();
      outputRoot = explicit.length > 0
        ? (path.isAbsolute(explicit) ? explicit : path.join(PROJECT_ROOT, explicit))
        : outputRoot;
      continue;
    }
    if (!arg.startsWith('-') && arg.trim().length > 0) {
      sourceFilters.push(arg);
    }
  }

  const fullBuild = sourceFilters.length === 0;
  outputRoot = path.resolve(outputRoot);
  await validateOutput(outputRoot);

  // Write the selected output first, then prune stale documents only in that output.
  await fs.mkdir(outputRoot, { recursive: true });
  const output = await buildStandardCatalog(sourceFilters, { outputRoot });
  await cleanupStandardStaleFiles(output, {
    scope: sourceFilters,
    outputRoot,
  });
  console.log(
    `${fullBuild ? 'standardized' : 'standardized subset'} ${output.length} files`
    + (fullBuild ? '' : ` from [${sourceFilters.join(', ')}]`)
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
