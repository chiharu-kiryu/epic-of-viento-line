import {
  INDEX_OUTPUT,
  INDEX_OUTPUT_DIR,
} from './lib/paths.mjs';
import { buildStandardIndex } from './lib/static-index.mjs';
import fs from 'node:fs/promises';

const OUTPUT_PATH = INDEX_OUTPUT;
const OUTPUT_DIR = INDEX_OUTPUT_DIR;

async function main() {
  const index = await buildStandardIndex();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(index)}\n`, 'utf8');
  console.log(`Static index created: ${OUTPUT_PATH}`);
  console.log(`docs=${index.count}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
