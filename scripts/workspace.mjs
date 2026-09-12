#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { PROJECT_ROOT } from './lib/paths.mjs';
import { appStoragePaths } from './lib/app-storage.mjs';
import { registerWorkspace, verifyWorkspace, writeJson, readWorkspace, updateDocumentModels } from './lib/workspace.mjs';
import { planLegacyDocumentModels } from './lib/document-model.mjs';
import { applyProjectDefinition } from './lib/project-definition.mjs';
import { readProjectConfiguration } from './lib/project-service.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const value = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const root = path.resolve(value('--root') || PROJECT_ROOT);
  let result;
  if (command === 'paths') {
    result = { ...appStoragePaths(), workspace: root };
  } else if (command === 'register') {
    const indexPath = value('--legacy-index');
    const legacyIndex = indexPath ? JSON.parse(await fs.readFile(path.resolve(indexPath), 'utf8')) : undefined;
    result = await registerWorkspace(root, { name: value('--name'), legacyIndex });
  } else if (command === 'verify') {
    result = await verifyWorkspace(root);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'migrate-documents') {
    const mappingFile = value('--shared-owners');
    const mapping = mappingFile ? JSON.parse(await fs.readFile(path.resolve(mappingFile), 'utf8')) : {};
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('归属映射必须为对象');
    result = await updateDocumentModels(root, (records) => planLegacyDocumentModels(records, mapping), { write: args.includes('--write') });
  } else if (command === 'check-project') {
    const config = await readProjectConfiguration(root);
    const inventory = await verifyWorkspace(root);
    result = { ...inventory, types: config.entries.length, templateProblems: config.warnings, ok: inventory.ok && !config.warnings.length };
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'apply-definition') {
    const file = value('--definition');
    if (!file) throw new Error('需要 --definition 项目定义.json');
    result = await applyProjectDefinition(root, JSON.parse(await fs.readFile(path.resolve(file), 'utf8')), { write: args.includes('--write') });
  } else if (command === 'bind-assets') {
    if (![2, 3].includes(readWorkspace(root)?.version)) throw new Error('请先登记作品库');
    const directory = value('--directory');
    if (!directory) throw new Error('需要 --directory；使用作品库内的 assets/ 时填写该目录');
    const target = await fs.realpath(path.resolve(directory));
    if (!(await fs.stat(target)).isDirectory()) throw new Error('素材位置必须是文件夹');
    await writeJson(path.join(root, '.viento/local.json'), { version: 1, assetStores: { main: target } });
    result = { root, assetDirectory: target };
  } else {
    throw new Error('用法：npm run workspace -- paths|register|verify|check-project|bind-assets|migrate-documents|apply-definition [--root 作品库] [--name 名称] [--legacy-index 旧索引] [--directory 素材目录] [--shared-owners 归属映射.json] [--definition 项目定义.json] [--write]');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
