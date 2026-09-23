import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry } from '../lib/workspace.mjs';
import { readProjectConfiguration, saveProjectTemplate } from '../lib/project-service.mjs';

async function project(t, template) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '模板版本验证', createdAt: 0,
    paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores,
    documentTypes: [{ id: 'character', label: '角色', directory: 'characters', parserProfile: 'structured',
      ...(template ? { template: 'character.md' } : {}) }],
  }));
  await write(root, 'documents/characters/旅者.md', '\uFEFF# 旅者\r\n背景：保留原文。  \r\n');
  if (template) await write(root, 'templates/character.md', '\uFEFF# 角色\r\n姓名：\r\n');
  await registerWorkspace(root);
  return root;
}

// Simulate an external atomic manifest replacement immediately after the real
// read returned its bytes. This fixes the race without timers or fake project
// services; the hook runs only inside an isolated temporary-workspace process.
const replacement = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { readProjectConfiguration, saveProjectTemplate } from './scripts/lib/project-service.mjs';
  const root = process.cwd(), manifestPath = path.join(root, 'workspace.json');
  const readFileSync = fs.readFileSync;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const modified = structuredClone(manifest);
  modified.documentTypes[0].label = '外部修改的人物';
  modified.documentTypes[0].parserOptions = { titleField: '姓名' };
  const externalBytes = JSON.stringify(modified, null, 2) + '\n';
  let replacements = 0;
  fs.readFileSync = (file, ...args) => {
    const bytes = readFileSync(file, ...args);
    if (String(file) === manifestPath && replacements++ === 0) {
      fs.writeFileSync(manifestPath + '.replacement', externalBytes);
      fs.renameSync(manifestPath + '.replacement', manifestPath);
    }
    return bytes;
  };
  let earlier;
  try { earlier = await readProjectConfiguration(root); }
  finally { fs.readFileSync = readFileSync; }
  assert.ok(replacements > 0, 'the concurrent replacement actually happened');
  assert.equal(earlier.entries[0].type.label, '角色');
  const current = await readProjectConfiguration(root);
  assert.equal(current.entries[0].type.label, '外部修改的人物');
`;

for (const template of [false, true]) {
  test(`project snapshot: ${template ? 'file-backed' : 'generated'} template revision belongs to the displayed manifest`, async (t) => {
    const root = await project(t, template);
    await node(root, ['--input-type=module', '-e', replacement + String.raw`
      assert.notEqual(earlier.revision, current.revision, 'old settings must not receive the newer manifest revision');
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), externalBytes);
    `]);
  });

  test(`project snapshot: stale ${template ? 'file-backed' : 'generated'} form cannot undo a concurrent rule change`, async (t) => {
    const root = await project(t, template);
    const registry = await readRegistry(root);
    const original = await fs.readFile(path.join(root, 'documents/characters/旅者.md'));
    await node(root, ['--input-type=module', '-e', replacement + String.raw`
      const entry = earlier.entries[0];
      await assert.rejects(saveProjectTemplate(root, {
        revision: earlier.revision, create: false, type: entry.type, format: entry.format, content: entry.content,
      }), { statusCode: 409 });
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), externalBytes);
      assert.equal(fs.existsSync(path.join(root, 'templates/types')), false, 'reject before writing a template');
      assert.deepEqual(await readProjectConfiguration(root), current);
      const fresh = current.entries[0];
      const saved = await saveProjectTemplate(root, {
        revision: current.revision, create: false, type: fresh.type, format: fresh.format, content: fresh.content + '\n新模板段落\n',
      });
      assert.equal(saved.entries[0].type.label, '外部修改的人物');
      assert.deepEqual(saved.entries[0].type.parserOptions, { titleField: '姓名' });
      assert.ok(saved.entries[0].content.endsWith('\n新模板段落\n'));
    `]);
    assert.deepEqual(await readRegistry(root), registry);
    assert.deepEqual(await fs.readFile(path.join(root, 'documents/characters/旅者.md')), original);
  });
}

test('project snapshot: reopening and editing only a label keeps template bytes and explicit parser rules', async (t) => {
  const root = await project(t, true);
  const original = await readProjectConfiguration(root);
  const entry = original.entries[0];
  const rules = { allowedFieldKeys: [], multilineFieldKeys: ['背景'], boundaryFieldKeys: ['姓名'], titleField: '姓名' };
  const first = await saveProjectTemplate(root, { revision: original.revision, type: { ...entry.type, parserOptions: rules }, format: entry.format, content: entry.content });
  const reopened = await readProjectConfiguration(root);
  assert.equal(reopened.revision, first.revision);
  const edited = reopened.entries[0];
  const result = await saveProjectTemplate(root, { revision: reopened.revision, type: { ...edited.type, label: '人物' }, format: edited.format, content: edited.content });
  assert.equal(result.entries[0].content, entry.content);
  assert.deepEqual(result.entries[0].type.parserOptions, rules);
  assert.equal(result.entries[0].type.template, first.entries[0].type.template);
  assert.equal((await readProjectConfiguration(root)).revision, result.revision);
});
