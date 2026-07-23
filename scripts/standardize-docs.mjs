import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildStandardCatalog,
  cleanupStandardStaleFiles,
  STANDARD_ROOT,
  PROJECT_ROOT,
} from './standardize-docs/core.mjs';

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

  if (fullBuild) {
    await fs.rm(STANDARD_ROOT, { recursive: true, force: true });
  }

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
