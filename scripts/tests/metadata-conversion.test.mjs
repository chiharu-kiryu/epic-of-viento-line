import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, node, write, serve, request } from './helpers.mjs';
import { normalizeBackstoryPayload } from '../lib/static-index.mjs';
import { randomUUID } from 'node:crypto';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry, writeJson } from '../lib/workspace.mjs';
import { buildStandardOutputPath } from '../standardize-docs/doc-factory.mjs';

const read = (root, name) => fs.readFile(path.join(root, name), 'utf8');

test('JSON and empty source documents survive standardization, indexing and editor API reads', async (t) => {
  const root = await fixture(t);
  const source = 'design-data/design-scenes/连接表.json';
  const content = '{"count":0,"active":false,"nodes":[{"name":"A"}]}\n';
  await write(root, source, content);
  await write(root, 'design-data/design-rules/空文档.md', '');
  await node(root, ['scripts/standardize-docs.mjs', 'design-data']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const docs = JSON.parse(await read(root, 'web/data/index.json')).docs;
  const jsonDoc = docs.find((doc) => doc.name === '连接表');
  assert.equal(jsonDoc.type, 'json');
  assert.equal(jsonDoc.meta.source, `docs-standard/${source}`);
  assert.equal(jsonDoc.source.path, jsonDoc.meta.source);
  assert.equal(jsonDoc.content, content);
  assert.equal(jsonDoc.fields.count, 0);
  assert.equal(jsonDoc.fields.active, false);
  assert.equal(docs.find((doc) => doc.name === '空文档').content, '');
  await node(root, ['scripts/validate-standard-docs.mjs', '--strict']);
  const base = await serve(t, root);
  const response = await request(base, `/api/doc?path=${encodeURIComponent(jsonDoc.meta.source)}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.content, content);
  const updated = content.replace('"count":0', '"count":1');
  const saved = await request(base, '/api/doc', { path: jsonDoc.meta.source, content: updated, expectedVersion: response.data.version });
  assert.equal(saved.status, 200);
  await node(root, ['scripts/standardize-docs.mjs', source]);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const rebuilt = JSON.parse(await read(root, 'web/data/index.json')).docs.find((doc) => doc.name === '连接表');
  assert.equal(rebuilt.fields.count, 1);
  assert.equal(rebuilt.fields.active, false);
  assert.equal(rebuilt.content, updated);
  assert.equal(await read(root, source), updated);
});

test('merged backstory source strings normalize to path objects without character-index properties', () => {
  const result = normalizeBackstoryPayload({ source: 'design-data/backstory/智力/英雄.txt', raw: '正文' });
  assert.deepEqual(result.source, { path: 'docs-standard/design-data/backstory/智力/英雄.txt' });
  assert.equal(result.meta.source, result.source.path);
});

for (const managed of [false, true]) test(`same-stem sources keep separate caches and identities (${managed ? 'generic v3' : 'legacy'})`, async (t) => {
  const root = await fixture(t);
  const documents = managed ? 'documents' : 'design-data';
  const cache = managed ? '.viento/cache/docs-standard' : 'docs-standard';
  const index = managed ? '.viento/cache/indexes/documents.json' : 'web/data/index.json';
  if (managed) await write(root, 'workspace.json', JSON.stringify({
    format: 'viento-workspace', version: 3, id: randomUUID(), name: '同名文档检查', createdAt: 0,
    paths: { documents, templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } },
    documentTypes: PROJECT_DEFAULTS.documentTypes,
  }));
  const files = {
    [`${documents}/design-rules/规则.md`]: '# Markdown 文档\n',
    [`${documents}/design-rules/规则.txt`]: '纯文本文档\n',
    [`${documents}/design-rules/规则.json`]: '{"title":"JSON 文档","value":0}\n',
    [`${documents}/design-rules/规则`]: '无扩展名文档\n',
  };
  for (const [file, content] of Object.entries(files)) await write(root, file, content);
  await node(root, ['scripts/standardize-docs.mjs', documents]);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  let docs = JSON.parse(await read(root, index)).docs;
  assert.equal(docs.length, 4);
  assert.equal(new Set(docs.map(doc => doc.path)).size, 4);
  for (const [file, content] of Object.entries(files)) {
    const cached = JSON.parse(await read(root, `${cache}/${buildStandardOutputPath(file)}`));
    assert.equal(cached.source.path, file);
    assert.equal(cached.raw, content);
    assert.equal(await read(root, file), content);
  }
  const selected = `${documents}/design-rules/规则.md`;
  const untouched = `${cache}/${buildStandardOutputPath(`${documents}/design-rules/规则.txt`)}`;
  const before = await read(root, untouched);
  await write(root, selected, '# 修改 Markdown\n');
  await write(root, `${documents}/design-rules/规则.txt`, '外部修改，未选择重建\n');
  await node(root, ['scripts/standardize-docs.mjs', selected]);
  assert.equal(await read(root, untouched), before);
  await fs.rm(path.join(root, selected));
  await node(root, ['scripts/standardize-docs.mjs', selected]);
  await assert.rejects(fs.access(path.join(root, cache, buildStandardOutputPath(selected))), { code: 'ENOENT' });
  assert.equal(await read(root, untouched), before);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  docs = JSON.parse(await read(root, index)).docs;
  assert.equal(docs.length, 3);
});

test('partial rebuild respects dotted folders and migrates only matching legacy cache entries', async (t) => {
  const root = await fixture(t);
  const source = 'design-data/chapter.v1/场景.md';
  await write(root, source, '# 新场景\n');
  await write(root, 'docs-standard/design-data/chapter.v1/场景.json', JSON.stringify({ source: { path: source }, raw: '旧缓存' }));
  const other = 'docs-standard/design-data/chapter.v2/保留.json';
  await write(root, other, JSON.stringify({ source: { path: 'design-data/chapter.v2/保留.md' }, raw: '范围外缓存' }));
  const before = await read(root, other);
  await node(root, ['scripts/standardize-docs.mjs', 'design-data/chapter.v1']);
  assert.equal(JSON.parse(await read(root, `docs-standard/${buildStandardOutputPath(source)}`)).raw, '# 新场景\n');
  await assert.rejects(fs.access(path.join(root, 'docs-standard/design-data/chapter.v1/场景.json')), { code: 'ENOENT' });
  assert.equal(await read(root, other), before);
});

test('legacy display-path disambiguation preserves document IDs and part-of navigation', async (t) => {
  const root = await fixture(t);
  const ownerPath = 'design-data/design-scenes/同名.md';
  const siblingPath = 'design-data/design-scenes/同名.txt';
  const childPath = 'design-data/backstory/故事/附属.md';
  await write(root, ownerPath, '# 主档案');
  await write(root, siblingPath, '另一份同名档案');
  await write(root, childPath, '# 附属背景');
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const owner = registry.documents.find(doc => doc.sourcePath === ownerPath);
  const sibling = registry.documents.find(doc => doc.sourcePath === siblingPath);
  const child = registry.documents.find(doc => doc.sourcePath === childPath);
  child.relations = [{ kind: 'part-of', targetId: owner.id, slot: '背景故事' }];
  const childMetadata = path.join(root, 'metadata/documents', `${child.id}.json`);
  await writeJson(childMetadata, child);
  const metadataBefore = await fs.readFile(childMetadata);
  await node(root, ['scripts/standardize-docs.mjs', 'design-data']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const docs = JSON.parse(await read(root, '.viento/cache/indexes/documents.json')).docs;
  const ownerView = docs.find(doc => doc.id === owner.id), siblingView = docs.find(doc => doc.id === sibling.id);
  const childView = docs.find(doc => doc.id === child.id);
  assert.notEqual(ownerView.path, siblingView.path);
  assert.equal(childView.owners[0].path, ownerView.path);
  assert.equal(ownerView.ownedDocuments[0].path, childView.path);
  assert.deepEqual(await fs.readFile(childMetadata), metadataBefore);
  assert.equal(await read(root, ownerPath), '# 主档案');
});

test('metadata sorting supports buildings, first-line fields, BOM and original line endings, and is idempotent', async (t) => {
  const root = await fixture(t);
  for (const [name, content, expected] of [
    ['design-building/建筑.md', '\uFEFF建筑\r\n回血：1\r\n攻击间隔：2\r\n', '\uFEFF建筑\r\n攻击间隔：2\r\n回血：1\r\n'],
    ['design-item/物品.txt', '价格：100\n属性：20', '属性：20\n价格：100'],
  ]) {
    const source = `design-data/${name}`;
    await write(root, source, content);
    const args = ['scripts/reorder-source-metadata-fields.mjs', '--write', '--type', name.startsWith('design-building') ? 'building' : 'item', '--path', source];
    await node(root, args);
    assert.equal(await read(root, source), expected);
    await node(root, args);
    assert.equal(await read(root, source), expected);
  }
});

test('metadata sorting leaves JSON/YAML, fenced examples and separate heading sections intact', async (t) => {
  const root = await fixture(t);
  const contents = {
    'example.json': '{\n  "价格": 100,\n  "属性": 20\n}',
    'example.yaml': '价格: 100\n属性: 20\n',
    'example.md': '# 示例\n\n```\n价格：100\n属性：20\n```\n\n## 第一节\n价格：100\n\n## 第二节\n属性：20\n',
  };
  for (const [name, content] of Object.entries(contents)) await write(root, `design-data/design-item/${name}`, content);
  await node(root, ['scripts/reorder-source-metadata-fields.mjs', '--write', '--path', 'design-data/design-item']);
  for (const [name, content] of Object.entries(contents)) assert.equal(await read(root, `design-data/design-item/${name}`), content);
});

test('invalid metadata sort options fail without expanding the write scope', async (t) => {
  const root = await fixture(t);
  const source = 'design-data/design-item/物品.md';
  const content = '物品\n价格：100\n属性：20\n';
  await write(root, source, content);
  for (const args of [['--type', 'wrong'], ['--type', 'item,wrong'], ['--path'], ['--unknown']]) {
    await assert.rejects(node(root, ['scripts/reorder-source-metadata-fields.mjs', '--write', ...args]));
    assert.equal(await read(root, source), content);
  }
});
