import {
  INDEX_OUTPUT,
  INDEX_OUTPUT_DIR,
} from './lib/paths.mjs';
import { buildStandardIndex } from './lib/static-index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, CACHE_ROOT } from './lib/paths.mjs';
import { buildRegistryIndexes, writeJson, readWorkspace, registerWorkspace } from './lib/workspace.mjs';

const OUTPUT_PATH = INDEX_OUTPUT;
const OUTPUT_DIR = INDEX_OUTPUT_DIR;

async function main() {
  if ([2, 3].includes(readWorkspace(PROJECT_ROOT)?.version)) await registerWorkspace(PROJECT_ROOT, { scanAssets: false });
  const index = await buildStandardIndex();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  index.generation = randomUUID();
  const registry = await buildRegistryIndexes(PROJECT_ROOT, index.docs, index.generation);
  if (registry) {
    await writeJson(path.join(CACHE_ROOT, 'indexes/assets.json'), registry.assets);
    await writeJson(path.join(CACHE_ROOT, 'indexes/references.json'), registry.references);
  }
  await writeJson(OUTPUT_PATH, index);
  console.log(`Static index created: ${OUTPUT_PATH}`);
  console.log(`docs=${index.count}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
