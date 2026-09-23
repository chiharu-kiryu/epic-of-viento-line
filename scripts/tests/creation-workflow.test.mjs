import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node, serve, request } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import { buildStandardOutputPath } from '../standardize-docs/doc-factory.mjs';

async function project(t, version = 3) {
  const root = await fixture(t);
  const documents = version === 3 ? 'documents' : 'design-data';
  const templates = version === 3 ? 'templates' : 'data-template';
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version,
    id: randomUUID(), name: '新建链路检查', createdAt: 1, paths: { documents, templates, metadata: 'metadata' },
    assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  for (const [name, content] of Object.entries(PROJECT_DEFAULTS.templates)) await write(root, `${templates}/${name}`, content);
  await registerWorkspace(root);
  return { root, documents, cache: '.viento/cache/docs-standard' };
}

async function index(root, source) {
  await node(root, ['scripts/standardize-docs.mjs', ...(source ? [source] : [])]);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  return JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
}

for (const [label, name] of [['ASCII', `${'a'.repeat(252)}.md`], ['Unicode', `${'界'.repeat(84)}.md`]]) {
  test(`creation, repeated save and preview retain a legal 255-byte ${label} filename`, async (t) => {
    const { root } = await project(t);
    const base = await serve(t, root);
    const file = `documents/custom/${name}`;
    const original = '\ufeff# 长名称角色\r\n\r\n原有背景。\r\n';
    assert.equal(Buffer.byteLength(name), 255);
    const created = await request(base, '/api/doc', { path: file, content: original, create: true, documentType: 'character' });
    assert.equal(created.status, 200, JSON.stringify(created));
    const registry = await readRegistry(root);
    assert.equal(registry.documents.length, 1);
    assert.equal(registry.documents[0].documentType, 'character');
    const conflict = await request(base, '/api/doc', { path: file, content: '不能覆盖', create: true, documentType: 'story' });
    assert.equal(conflict.status, 409);
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), original);
    const content = original + '继续修改。\r\n';
    const saved = await request(base, '/api/doc', { path: file, content, expectedVersion: created.data.version });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.deepEqual(await fs.readFile(path.join(root, file)), Buffer.from(content));
    assert.deepEqual(await fs.readdir(path.join(root, 'documents/custom')), [name]);
    assert.deepEqual(await readRegistry(root), registry);
    const rebuilt = await request(base, '/api/rebuild', { source: file });
    assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt));
    const docs = (await (await fetch(base + '/data/index.json')).json()).docs;
    assert.equal(docs.length, 1);
    assert.equal(docs[0].id, registry.documents[0].id);
    assert.equal(docs[0].content, content);
    const cacheResponse = await fetch(`${base}/${docs[0].standardPath}`);
    assert.equal(cacheResponse.status, 200);
    assert.equal((await cacheResponse.json()).raw, content);
    assert.equal((await verifyWorkspace(root)).ok, true);
  });
}

test('scoped rebuild migrates selected legacy caches and retains untouched cached content and identities', async (t) => {
  const { root, cache } = await project(t);
  const selected = 'documents/selected.md', sibling = 'documents/sibling.md';
  await write(root, selected, '# 选中文档\n');
  await write(root, sibling, '# 旁边文档\n');
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  await index(root);
  const original = new Map();
  for (const source of [selected, sibling]) {
    const file = path.join(root, cache, buildStandardOutputPath(source));
    original.set(source, await fs.readFile(file));
    await write(root, `${cache}/${source}.json`, original.get(source));
    await fs.rm(file);
  }
  await write(root, selected, '# 修改选中文档\n');
  await write(root, sibling, '# 尚未选择重建\n');
  const partial = await index(root, selected);
  assert.equal(partial.count, 2);
  assert.equal(partial.docs.find((doc) => doc.source.path === `docs-standard/${sibling}`).content, '# 旁边文档\n');
  assert.deepEqual(await fs.readFile(path.join(root, cache, `${sibling}.json`)), original.get(sibling));
  await assert.rejects(fs.access(path.join(root, cache, `${selected}.json`)), { code: 'ENOENT' });
  const full = await index(root);
  assert.equal(full.count, 2);
  assert.equal(full.docs.find((doc) => doc.source.path === `docs-standard/${sibling}`).content, '# 尚未选择重建\n');
  await assert.rejects(fs.access(path.join(root, cache, `${sibling}.json`)), { code: 'ENOENT' });
  assert.deepEqual(await readRegistry(root), registry);
  assert.equal((await verifyWorkspace(root)).ok, true);
});

test('a deleted source with a damaged hashed cache is removed by an exact scoped rebuild', async (t) => {
  const { root, cache } = await project(t);
  const selected = 'documents/delete.md', keep = 'documents/keep.md';
  await write(root, selected, '# 删除前\n');
  await write(root, keep, '# 必须保留\n');
  await index(root);
  const keptCache = await fs.readFile(path.join(root, cache, buildStandardOutputPath(keep)));
  await fs.rm(path.join(root, selected));
  await write(root, `${cache}/${buildStandardOutputPath(selected)}`, '{damaged');
  const built = await index(root, selected);
  assert.equal(built.count, 1);
  assert.equal(built.docs[0].content, '# 必须保留\n');
  assert.deepEqual(await fs.readFile(path.join(root, cache, buildStandardOutputPath(keep))), keptCache);
  await assert.rejects(fs.access(path.join(root, cache, buildStandardOutputPath(selected))), { code: 'ENOENT' });
});

test('rebuilding refuses linked internal cache directories without writing or indexing the target', async (t) => {
  const { root, cache } = await project(t);
  await write(root, 'documents/story.md', '# 原始正文\n');
  await index(root);
  const previousIndex = await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'));
  const outside = path.join(root, 'untouched-cache-target');
  await fs.rename(path.join(root, cache, '.entries'), outside);
  const names = await fs.readdir(outside);
  const bytes = await fs.readFile(path.join(outside, names[0]));
  await fs.symlink(outside, path.join(root, cache, '.entries'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(node(root, ['scripts/standardize-docs.mjs']), /链接/);
  await assert.rejects(node(root, ['scripts/build-static-doc-site.mjs']), /链接/);
  assert.deepEqual(await fs.readdir(outside), names);
  assert.deepEqual(await fs.readFile(path.join(outside, names[0])), bytes);
  assert.deepEqual(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json')), previousIndex);
  assert.equal(await fs.readFile(path.join(root, 'documents/story.md'), 'utf8'), '# 原始正文\n');
});

test('an existing long source can be edited without renaming it or losing permissions', async (t) => {
  const { root } = await project(t);
  const file = `documents/${'旧'.repeat(80)}.txt`;
  await write(root, file, '原始正文');
  await fs.chmod(path.join(root, file), 0o640);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const base = await serve(t, root);
  const before = (await request(base, `/api/doc?path=${encodeURIComponent(file)}`)).data;
  const saved = await request(base, '/api/doc', { path: file, content: '更新后的正文', expectedVersion: before.version });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(await fs.readFile(path.join(root, file), 'utf8'), '更新后的正文');
  assert.equal((await fs.stat(path.join(root, file))).mode & 0o777, 0o640);
  assert.deepEqual(await readRegistry(root), registry);
});

test('standardization handles existing 255-byte names without exceeding cache component limits', async (t) => {
  const { root, cache } = await project(t);
  const file = `documents/${'篇'.repeat(84)}.md`;
  const content = '# 独立原文\n\n必须保留。\n';
  await write(root, file, content);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const built = await index(root, file);
  assert.equal(built.docs.length, 1);
  assert.equal(built.docs[0].id, registry.documents[0].id);
  assert.equal(built.docs[0].content, content);
  const cached = JSON.parse(await fs.readFile(path.join(root, cache, buildStandardOutputPath(file)), 'utf8'));
  assert.equal(cached.source.path, file);
  assert.equal(cached.raw, content);
  await node(root, ['scripts/validate-standard-docs.mjs', '--strict']);
  assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content);
});

test('a source filename and another source directory do not collide in derived caches', async (t) => {
  const { root, cache } = await project(t);
  const files = { 'documents/角色.md': '# 角色\n', 'documents/角色.md.json/背景.md': '# 背景\n' };
  for (const [file, content] of Object.entries(files)) await write(root, file, content);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  let built = await index(root);
  assert.equal(built.count, 2);
  assert.equal(new Set(built.docs.map((doc) => doc.standardPath)).size, 2);
  const sibling = 'documents/角色.md.json/背景.md';
  const siblingCache = path.join(root, cache, buildStandardOutputPath(sibling));
  const siblingBytes = await fs.readFile(siblingCache);
  await write(root, 'documents/角色.md', '# 修改角色\n');
  await write(root, sibling, '# 尚未重建的修改\n');
  built = await index(root, 'documents/角色.md');
  assert.equal(built.docs.find((doc) => doc.source.path === 'docs-standard/documents/角色.md').content, '# 修改角色\n');
  assert.deepEqual(await fs.readFile(siblingCache), siblingBytes);
  assert.deepEqual(await readRegistry(root), registry);
  await fs.rm(path.join(root, 'documents/角色.md'));
  built = await index(root, 'documents/角色.md');
  assert.equal(built.count, 1);
  assert.deepEqual(await fs.readFile(siblingCache), siblingBytes);
});

for (const version of [2, 3]) {
  test(`v${version} creation indexes ordinary document folders named like application resources`, async (t) => {
    const { root, documents } = await project(t, version);
    const base = await serve(t, root);
    const folders = ['assets', 'templates', 'metadata', 'web', 'desktop', 'tmp', 'dist', 'target'];
    for (const folder of folders) {
      const file = `${documents}/${folder}/档案.md`;
      const saved = await request(base, '/api/doc', { path: file, content: `# ${folder} 档案\n`, create: true, documentType: 'character' });
      assert.equal(saved.status, 200, `${file}: ${JSON.stringify(saved)}`);
    }
    const registered = await readRegistry(root);
    assert.equal(registered.documents.length, folders.length);
    const built = await index(root);
    assert.equal(built.count, folders.length);
    assert.deepEqual(new Set(built.docs.map((doc) => doc.id)), new Set(registered.documents.map((doc) => doc.id)));
    const selected = `${documents}/templates/档案.md`;
    await write(root, selected, '# 模板目录内的真实正文\n');
    const updated = await index(root, selected);
    assert.equal(updated.count, folders.length);
    assert.equal(updated.docs.find((doc) => doc.source.path === `docs-standard/${selected}`).content, '# 模板目录内的真实正文\n');
    assert.deepEqual(await readRegistry(root), registered);
  });
}
