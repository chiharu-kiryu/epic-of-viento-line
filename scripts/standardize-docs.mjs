import fs from 'node:fs/promises';
import { buildStandardCatalog, cleanupStandardStaleFiles, STANDARD_ROOT } from './standardize-docs/core.mjs';

async function main() {
  await fs.rm(STANDARD_ROOT, { recursive: true, force: true });
  const output = await buildStandardCatalog();
  await cleanupStandardStaleFiles(output);
  console.log(`standardized ${output.length} files`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
