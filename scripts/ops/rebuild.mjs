import { rebuildIndex } from '../lib/rebuild-workflow.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('重建当前作品库：npm run rebuild；指定作品可使用 VIENTO_WORKSPACE_ROOT');
    const result = await rebuildIndex();
    console.log(result.standardize?.stdout || '');
    console.log(result.build?.stdout || '');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

export {
  rebuildIndex,
};
