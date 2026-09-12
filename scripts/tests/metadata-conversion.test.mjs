import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, node, write, serve, request } from './helpers.mjs';
import { normalizeBackstoryPayload } from '../lib/static-index.mjs';

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

test('colliding source basenames fail before overwriting standardized output', async (t) => {
  const root = await fixture(t);
  await write(root, 'design-data/design-rules/规则.md', '第一份');
  await write(root, 'design-data/design-rules/规则.txt', '第二份');
  await write(root, 'docs-standard/design-data/design-rules/规则.json', 'sentinel');
  await assert.rejects(node(root, ['scripts/standardize-docs.mjs', 'design-data']), /标准化输出路径冲突/);
  assert.equal(await read(root, 'docs-standard/design-data/design-rules/规则.json'), 'sentinel');
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
