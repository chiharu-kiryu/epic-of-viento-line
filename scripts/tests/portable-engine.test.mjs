import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { runCommand } from '../lib/process.mjs';
import { sourceFileName, sourceExtension, normalizeSourcePath } from '../../engine/source-path.mjs';

test('portable engine has no dependency back into Node adapters, frontend or native host', async () => {
  const root = new URL('../../engine/', import.meta.url);
  for (const file of await fs.readdir(root)) {
    if (!file.endsWith('.mjs')) continue;
    const source = await fs.readFile(new URL(file, root), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      assert.notEqual(node.type, 'ImportExpression', `${file}: host imports must be injected`);
      if (/^(ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration)$/.test(node.type) && node.source) {
        const specifier = node.source.value;
        assert.ok(specifier === 'yaml' || (specifier.startsWith('./') && new URL(specifier, root).href.startsWith(root.href)), `${file}: ${specifier}`);
      }
      for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
    };
    visit(ast);
  }
});

test('portable engine workflows execute without Node globals using the browser YAML distribution', async () => {
  const result = await runCommand(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('portable-engine-runtime.mjs', import.meta.url))]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runtime, 'isolated-web-globals');
  assert.equal(report.checks.length, 10);
  assert.ok(report.checks.every((check) => check.status === 'passed'));
});

test('logical source names retain POSIX extension semantics independent of the host OS', () => {
  for (const name of ['', '/', '//', '.', '..', '...', '.hidden', '.hidden.json', 'name.', 'a..md', '角色.yaml', 'a/b.txt', 'a/.b', 'a/b.txt///']) {
    assert.equal(sourceFileName(name), path.posix.basename(name), name);
    assert.equal(sourceExtension(name), path.posix.extname(name), name);
  }
  assert.equal(normalizeSourcePath('./documents//角色/./人物.md'), 'documents/角色/人物.md');
  for (const name of [null, 12, '../documents/a.md', '/documents/a.md', 'documents/a/../b.md', 'documents\\a.md', '.hidden/a.md', 'documents/a\0.md']) {
    assert.equal(normalizeSourcePath(name), '', String(name));
  }
});
