import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fixture, write, serve, request } from './helpers.mjs';
import { runCommand } from '../lib/process.mjs';
import { registerWorkspace, readRegistry, readWorkspace, verifyWorkspace, writeJson } from '../lib/workspace.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function rebuild(app, root) {
  const env = { ...process.env, VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: root };
  for (const script of ['standardize-docs.mjs', 'build-static-doc-site.mjs']) await runCommand(process.execPath, [path.join(app, 'scripts', script)], { cwd: os.tmpdir(), env });
  return JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
}

test('registration preserves raw bytes and stable IDs; indexing never accepts changed content as the original', async (t) => {
  const root = await temporary(t);
  const source = Buffer.from('\ufeff# 正文\r\n原有大纲\r\n');
  const asset = Buffer.from([0, 1, 255, 128]);
  await write(root, 'design-data/故事.md', source);
  await write(root, 'assets/images/原画.png', asset);
  await write(root, 'assets/empty.bin', Buffer.alloc(0));
  await registerWorkspace(root);
  const before = await readRegistry(root);
  const manifest = await fs.readFile(path.join(root, 'workspace.json'));
  const second = await registerWorkspace(root);
  assert.equal(second.addedAssets, 0);
  assert.equal(second.addedDocuments, 0);
  assert.deepEqual(await readRegistry(root), before);
  assert.deepEqual(await fs.readFile(path.join(root, 'workspace.json')), manifest);
  assert.deepEqual(await fs.readFile(path.join(root, 'design-data/故事.md')), source);
  assert.equal((await verifyWorkspace(root)).ok, true);
  await write(root, 'assets/images/原画.png', Buffer.from([0, 2, 255, 128]));
  await registerWorkspace(root);
  assert.deepEqual(await readRegistry(root), before);
  assert.equal((await verifyWorkspace(root)).ok, false);
});

test('separate application/workspace roots support editing, external media, offline metadata and legacy/ID URLs', async (t) => {
  const app = await fixture(t);
  const parent = await temporary(t);
  const root = path.join(parent, '作品库');
  const sourcePath = 'design-data/design-rules/规则.md';
  const original = '\ufeff# 规则\r\n![原画](assets/images/原画.png)\r\n';
  const binary = Buffer.from([0, 10, 255, 128]);
  await write(root, sourcePath, original);
  await write(root, 'assets/images/原画.png', binary);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const asset = registry.assets[0];
  const unknown = randomUUID();
  await write(root, sourcePath, original + `asset:${asset.id}\nasset:${unknown}\n`);
  const external = path.join(parent, '外置素材');
  await fs.rename(path.join(root, 'assets'), external);
  await writeJson(path.join(root, '.viento/local.json'), { version: 1, assetStores: { main: external } });
  const index = await rebuild(app, root);
  assert.equal(index.count, 1);
  assert.equal(index.docs[0].id, registry.documents[0].id);
  assert.ok(index.docs[0].assetRefs.includes(asset.id));
  assert.ok(index.docs[0].assetRefs.includes(unknown));
  const applicationIndex = await fs.readFile(path.join(app, 'web/data/index.json'), 'utf8');
  assert.equal(JSON.parse(applicationIndex).count, 0);
  const base = await serve(t, app, { VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: root });
  const canonical = await request(base, `/api/doc?path=${encodeURIComponent(sourcePath)}`);
  assert.equal(canonical.status, 200);
  const saved = await request(base, '/api/doc', { path: sourcePath, content: original + '保存成功\r\n', expectedVersion: canonical.data.version });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), original + '保存成功\r\n');
  for (const url of ['/assets/images/原画.png', `/asset-files/${asset.id}`]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
  }
  await fs.rename(path.join(external, 'images/原画.png'), path.join(external, 'images/新名字.png'));
  asset.location.path = 'images/新名字.png';
  await writeJson(path.join(root, 'metadata/assets', `${asset.id}.json`), asset);
  await rebuild(app, root);
  assert.equal((await fetch(base + '/assets/images/原画.png')).status, 200);
  assert.equal((await fetch(base + `/asset-files/${asset.id}`)).status, 200);
  const secret = path.join(parent, 'secret.txt'); await fs.writeFile(secret, 'private');
  await fs.symlink(secret, path.join(external, 'secret.txt'));
  assert.equal((await fetch(base + '/assets/secret.txt')).status, 403);
  await fs.rename(external, external + '-offline');
  await write(root, '.viento/cache/indexes/documents.json', 'damaged derived cache');
  await rebuild(app, root);
  const offline = await (await fetch(base + '/data/assets.json')).json();
  assert.equal(offline.assets[0].status, 'offline');
  const links = await (await fetch(base + '/data/references.json')).json();
  assert.ok(links.references.some((link) => link.assetId === asset.id));
  assert.equal((await request(base, `/api/doc?path=${encodeURIComponent(sourcePath)}`)).status, 200);
  assert.equal(await fs.readFile(path.join(app, 'web/data/index.json'), 'utf8'), applicationIndex);
});

test('v1 registration retains workspace identity and the old manifest; unsupported versions do not mutate sources', async (t) => {
  const root = await temporary(t);
  const original = { format: 'viento-workspace', version: 1, id: randomUUID(), name: '旧作品', createdAt: 0 };
  await writeJson(path.join(root, '.viento/workspace.json'), original);
  await write(root, 'design-data/原文.txt', '原文');
  await write(root, 'assets/portrait.png', Buffer.from([0, 1]));
  await writeJson(path.join(root, '.viento/cache/web/data/index.json'), { docs: [{ source: { path: 'docs-standard/design-data/原文.txt' }, heroImages: ['assets/portrait.png'] }] });
  await registerWorkspace(root);
  assert.equal(readWorkspace(root).id, original.id);
  assert.equal(readWorkspace(root).version, 2);
  assert.equal(readWorkspace(root).createdAt, 0);
  assert.equal((await readRegistry(root)).documents[0].assetBindings.length, 1);
  const history = await fs.readdir(path.join(root, '.viento/legacy'));
  assert.equal(history.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.viento/legacy', history[0]), 'utf8')), original);
  const guard = JSON.parse(await fs.readFile(path.join(root, '.viento/workspace.json'), 'utf8'));
  assert.equal(guard.version, 2);
  assert.equal(guard.compatibilityGuard, true);
  const bad = { ...readWorkspace(root), version: 999 };
  await writeJson(path.join(root, 'workspace.json'), bad);
  await assert.rejects(registerWorkspace(root), /版本/);
  assert.equal(await fs.readFile(path.join(root, 'design-data/原文.txt'), 'utf8'), '原文');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8')), bad);
});

test('ambiguous registry identities and unsafe paths fail before replacing existing metadata', async (t) => {
  const root = await temporary(t);
  await registerWorkspace(root);
  await write(root, 'assets/a.png', Buffer.from([1]));
  await registerWorkspace(root);
  const first = (await readRegistry(root)).assets[0];
  const duplicate = { ...first, id: randomUUID() };
  await writeJson(path.join(root, 'metadata/assets', `${duplicate.id}.json`), duplicate);
  await assert.rejects(registerWorkspace(root), /重复/);
  await fs.unlink(path.join(root, 'metadata/assets', `${duplicate.id}.json`));
  await writeJson(path.join(root, 'metadata/assets', `${first.id}.json`), { ...first, location: { store: 'main', path: '../outside.png' } });
  await assert.rejects(readRegistry(root), /无效/);
});

test('registration refuses symlinked metadata directories without writing outside the workspace', async (t) => {
  const parent = await temporary(t);
  const root = path.join(parent, 'work');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'metadata'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(registerWorkspace(root), /实际文件夹/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('read-only preview serves a separate workspace and refuses write requests', async (t) => {
  const app = await fixture(t);
  const root = await temporary(t);
  const source = 'design-data/design-rules/只读.md';
  await write(root, source, '# 只读正文');
  await registerWorkspace(root);
  await rebuild(app, root);
  const base = await serve(t, app, { VIENTO_WORKSPACE_ROOT: root, VIENTO_APP_ROOT: app }, 'browse-server.mjs');
  assert.equal((await fetch(base + '/web/')).status, 200);
  assert.equal((await (await fetch(base + '/web/data/index.json')).json()).count, 1);
  assert.equal((await request(base, '/api/doc', { path: source, content: '不应写入', force: true })).status, 405);
  assert.equal(await fs.readFile(path.join(root, source), 'utf8'), '# 只读正文');
});

test('registration keeps a live lock and recovers a lock whose owner no longer exists', async (t) => {
  const root = await temporary(t);
  await registerWorkspace(root);
  const lock = path.join(root, '.viento/registry.lock');
  await writeJson(lock, { pid: process.pid, nonce: 'live-owner' });
  await assert.rejects(registerWorkspace(root), /正在登记/);
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).nonce, 'live-owner');
  await writeJson(lock, { pid: 2147483647, nonce: 'exited-owner' });
  await registerWorkspace(root);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('reusing a renamed asset alias cannot write a conflicting registry', async (t) => {
  const root = await temporary(t);
  await write(root, 'assets/original.png', 'original');
  await registerWorkspace(root);
  const asset = (await readRegistry(root)).assets[0];
  await fs.rename(path.join(root, 'assets/original.png'), path.join(root, 'assets/renamed.png'));
  asset.location.path = 'renamed.png';
  await writeJson(path.join(root, 'metadata/assets', `${asset.id}.json`), asset);
  const before = await readRegistry(root);
  const manifest = await fs.readFile(path.join(root, 'workspace.json'));
  await write(root, 'assets/first-new.png', 'new unrelated asset');
  await write(root, 'assets/original.png', 'a different asset');
  await assert.rejects(registerWorkspace(root), /旧路径|冲突/);
  assert.deepEqual(await readRegistry(root), before);
  assert.deepEqual(await fs.readFile(path.join(root, 'workspace.json')), manifest);
  assert.equal(await fs.readFile(path.join(root, 'assets/original.png'), 'utf8'), 'a different asset');
});

test('automatic workspace names and manifests stay compatible with the native importer', async (t) => {
  const parent = await temporary(t);
  const root = path.join(parent, process.platform === 'win32' ? 'valid-name' : 'bad:name');
  await registerWorkspace(root);
  const original = readWorkspace(root);
  assert.equal(original.name, process.platform === 'win32' ? 'valid-name' : '作品库');
  for (const patch of [{ createdAt: -1 }, { name: 'bad/name' }, { name: 'bad\u007fname' },
    { assetStores: { main: { path: 'assets', unexpected: true } } }]) {
    await writeJson(path.join(root, 'workspace.json'), { ...original, ...patch });
    await assert.rejects(registerWorkspace(root), /格式|目录/);
  }
});

test('image references support any asset folder and encoded filenames', async (t) => {
  const app = await fixture(t);
  const root = await temporary(t);
  const files = ['assets/portrait.png', 'assets/concept/art#1.png', 'assets/images/空 格.png'];
  for (const file of files) await write(root, file, Buffer.from([1, 2, 3]));
  const refs = files.map((file) => `![图](${file.split('/').map(encodeURIComponent).join('/')})`).join('\n');
  await write(root, 'design-data/design-rules/引用.md', '# 图片引用\n\n' + refs);
  await registerWorkspace(root);
  const index = await rebuild(app, root);
  assert.deepEqual([...index.docs[0].heroImages].sort(), files.sort());
  assert.equal(index.docs[0].assetRefs.length, 3);
  assert.deepEqual(index.docs[0].unresolvedAssetPaths, []);
});

test('custom standardization output cannot prune application files or an external asset store', async (t) => {
  const app = await fixture(t);
  const parent = await temporary(t);
  const root = path.join(parent, 'workspace');
  const external = path.join(parent, 'external-assets');
  await write(root, 'design-data/story.md', '# 正文');
  await write(external, 'asset-notes.md', '必须保留的素材说明');
  await registerWorkspace(root);
  await writeJson(path.join(root, '.viento/local.json'), { version: 1, assetStores: { main: external } });
  const appReadme = await fs.readFile(path.join(app, 'scripts/README.md'));
  const alias = path.join(parent, 'output-alias');
  await fs.symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: root };
  for (const output of [external, path.join(app, 'scripts'), alias]) {
    await assert.rejects(runCommand(process.execPath, [path.join(app, 'scripts/standardize-docs.mjs'), '--output', output], { env }), /separate from project sources/);
    assert.equal(await fs.readFile(path.join(external, 'asset-notes.md'), 'utf8'), '必须保留的素材说明');
    assert.deepEqual(await fs.readFile(path.join(app, 'scripts/README.md')), appReadme);
  }
});
