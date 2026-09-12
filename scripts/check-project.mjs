import fs from 'node:fs/promises';
import { INDEX_OUTPUT } from './lib/paths.mjs';
import path from 'node:path';
import { collectFiles } from './lib/scan-files.mjs';
import { runCommand, runNodeScript } from './lib/process.mjs';
import { runDocApiContractPreflight } from './lib/verify-doc-api-contract.mjs';
import { verifyReleaseVersions } from '../desktop/version.mjs';

async function main() {
  const release = await verifyReleaseVersions();
  console.log(`版本一致性检查通过：${release.version}（构建 ${release.buildVersion}）`);
  const files = (await Promise.all(['scripts', 'web'].map((root) => collectFiles(root, {
    relativeBase: root,
    isAccepted: (name) => /\.(?:mjs|js)$/.test(name),
  })))).flat();
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      await runCommand(process.execPath, ['--check', file]);
    }
  }));
  console.log(`语法检查通过：${files.length} 个 JavaScript 文件`);
  await runDocApiContractPreflight();
  console.log('API 契约预检通过');
  if (!process.argv.includes('--app-only')) {
    for (const script of ['validate-standard-docs.mjs', 'validate-data-template-alignment.mjs']) {
      const result = await runNodeScript(path.join('scripts', script), ['--strict']);
      console.log(result.stdout);
    }
    const index = JSON.parse(await fs.readFile(INDEX_OUTPUT, 'utf8'));
    if (index.count !== index.docs.length || new Set(index.docs.map((doc) => doc.path)).size !== index.docs.length) {
      throw new Error('静态索引数量不一致或存在重复文档标识，请重新构建索引');
    }
    console.log(`静态索引检查通过：${index.count} 个唯一文档`);
  }
  const tests = (await fs.readdir('scripts/tests')).filter((name) => name.endsWith('.test.mjs'));
  const result = await runCommand(process.execPath, ['--test', ...tests.map((name) => path.join('scripts/tests', name))]);
  console.log(result.stdout);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
