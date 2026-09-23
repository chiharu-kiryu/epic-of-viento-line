import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../lib/process.mjs';
import { importMediaAsset } from '../lib/media-assets.mjs';
import { registerWorkspace, readRegistry, resolveAssetRoot, verifyWorkspace, writeJson } from '../lib/workspace.mjs';
import { write } from './helpers.mjs';

const application = fileURLToPath(new URL('../../', import.meta.url));

async function workspace(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-asset-binding-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  await write(root, 'design-data/story.md', '\ufeff# 故事\r\n原始正文\r\n');
  await write(root, 'assets/portraits/hero.png', Buffer.from([0, 1, 255, 128]));
  await registerWorkspace(root);
  return { parent, root, registry: await readRegistry(root) };
}

function cli(root, command, ...args) {
  const env = { ...process.env, VIENTO_APP_ROOT: application, VIENTO_WORKSPACE_ROOT: root };
  delete env.VIENTO_SESSION_TOKEN;
  return runCommand(process.execPath, [path.join(application, 'scripts/workspace.mjs'), command, '--root', root, ...args], { cwd: root, env });
}

test('asset rebinding retains other local settings, raw data and registered identities', async (t) => {
  const { parent, root, registry } = await workspace(t);
  const external = path.join(parent, 'external');
  await fs.cp(path.join(root, 'assets'), external, { recursive: true });
  const alias = path.join(parent, 'external-alias');
  await fs.symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const local = path.join(root, '.viento/local.json');
  const settings = { version: 1, assetStores: { main: path.join(root, 'assets') }, extensionState: { value: 'keep' } };
  await writeJson(local, settings);
  const manifest = await fs.readFile(path.join(root, 'workspace.json'));
  const source = await fs.readFile(path.join(root, 'design-data/story.md'));
  const result = JSON.parse((await cli(root, 'bind-assets', '--directory', alias)).stdout);
  assert.equal(result.assetDirectory, await fs.realpath(external));
  assert.deepEqual(JSON.parse(await fs.readFile(local, 'utf8')), { ...settings, assetStores: { main: await fs.realpath(external) } });
  assert.equal((await verifyWorkspace(root)).ok, true);
  const again = await registerWorkspace(root);
  assert.equal(again.addedAssets, 0);
  assert.equal(again.addedDocuments, 0);
  assert.deepEqual(await readRegistry(root), registry);
  assert.deepEqual(await fs.readFile(path.join(root, 'workspace.json')), manifest);
  assert.deepEqual(await fs.readFile(path.join(root, 'design-data/story.md')), source);
  await fs.rename(external, `${external}-offline`);
  assert.equal(resolveAssetRoot(root), external);
  assert.equal((await verifyWorkspace(root)).ok, false);
  await cli(root, 'bind-assets', '--directory', path.join(root, 'assets'));
  assert.equal((await verifyWorkspace(root)).ok, true);
});

test('asset rebinding respects a live registry lock without replacing the original binding', async (t) => {
  const { parent, root } = await workspace(t);
  const external = path.join(parent, 'external');
  await fs.mkdir(external);
  const local = path.join(root, '.viento/local.json');
  await writeJson(local, { version: 1, assetStores: { main: path.join(root, 'assets') } });
  const before = await fs.readFile(local);
  const lock = path.join(root, '.viento/registry.lock');
  await writeJson(lock, { pid: process.pid, nonce: 'active-operation' });
  const lockBytes = await fs.readFile(lock);
  await assert.rejects(cli(root, 'bind-assets', '--directory', external), /作品库正在登记/);
  assert.deepEqual(await fs.readFile(local), before);
  assert.deepEqual(await fs.readFile(lock), lockBytes);
});

for (const kind of ['private-directory', 'local-file']) {
  test(`asset rebinding rejects a linked ${kind} without changing its target`, async (t) => {
    const { parent, root } = await workspace(t);
    const external = path.join(parent, 'external');
    await fs.mkdir(external);
    const local = path.join(root, '.viento/local.json');
    await writeJson(local, { version: 1, assetStores: { main: path.join(root, 'assets') } });
    const target = path.join(parent, kind);
    if (kind === 'private-directory') {
      await fs.rename(path.join(root, '.viento'), target);
      await fs.symlink(target, path.join(root, '.viento'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await fs.rename(local, target);
      await fs.symlink(target, local);
    }
    const before = await fs.readFile(local);
    await assert.rejects(cli(root, 'bind-assets', '--directory', external), /链接|实际文件/);
    assert.deepEqual(await fs.readFile(local), before);
    assert.ok((await fs.lstat(kind === 'private-directory' ? path.join(root, '.viento') : local)).isSymbolicLink());
    assert.deepEqual(await fs.readFile(kind === 'private-directory' ? path.join(target, 'local.json') : target), before);
  });
}

test('asset rebinding rejects invalid destinations without changing the original configuration', async (t) => {
  const { parent, root } = await workspace(t);
  const local = path.join(root, '.viento/local.json');
  await writeJson(local, { version: 1, assetStores: { main: path.join(root, 'assets') } });
  const before = await fs.readFile(local);
  for (const target of [path.join(parent, 'missing'), path.join(root, 'design-data/story.md')]) {
    await assert.rejects(cli(root, 'bind-assets', '--directory', target));
    assert.deepEqual(await fs.readFile(local), before);
    await assert.rejects(fs.access(path.join(root, '.viento/registry.lock')), { code: 'ENOENT' });
  }
});

for (const kind of ['asset-file', 'asset-directory', 'default-asset-root', 'document-file', 'document-directory', 'document-as-directory']) {
  test(`workspace verification rejects a replaced ${kind} and leaves data untouched`, async (t) => {
    const { parent, root, registry } = await workspace(t);
    let source, target, directory = false;
    if (kind === 'asset-file') {
      source = path.join(root, 'assets/portraits/hero.png');
      target = path.join(root, 'assets/portraits/original.png');
    } else if (kind === 'asset-directory') {
      source = path.join(root, 'assets/portraits');
      target = path.join(root, 'assets/original');
      directory = true;
    } else if (kind === 'default-asset-root') {
      source = path.join(root, 'assets');
      target = path.join(parent, 'original-assets');
      directory = true;
    } else if (kind === 'document-directory') {
      source = path.join(root, 'design-data');
      target = path.join(parent, 'original-documents');
      directory = true;
    } else {
      source = path.join(root, 'design-data/story.md');
      target = path.join(parent, 'original-story.md');
    }
    await fs.rename(source, target);
    if (kind === 'document-as-directory') await fs.mkdir(source);
    else await fs.symlink(target, source, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    const report = await verifyWorkspace(root);
    assert.equal(report.ok, false);
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0].path, kind.includes('document') ? registry.documents[0].sourcePath : registry.assets[0].location.path);
    assert.match(report.problems[0].error, /链接|实际文件/);
    assert.deepEqual(await readRegistry(root), registry);
    if (!directory) assert.deepEqual(await fs.readFile(target), kind === 'asset-file' ? Buffer.from([0, 1, 255, 128]) : Buffer.from('\ufeff# 故事\r\n原始正文\r\n'));
  });
}

test('workspace verification accepts legal asset names starting with two dots', async (t) => {
  const { root } = await workspace(t);
  await write(root, 'assets/..portrait.png', 'portrait');
  await write(root, 'assets/..draft/art.png', 'art');
  await registerWorkspace(root);
  const report = await verifyWorkspace(root);
  assert.equal(report.assets, 3);
  assert.deepEqual(report.problems, []);
  assert.equal(JSON.parse((await cli(root, 'verify')).stdout).ok, true);
});

test('media upload refuses a store changed during streaming and can retry into the new store', async (t) => {
  const { parent, root, registry } = await workspace(t);
  const external = path.join(parent, 'external');
  await fs.cp(path.join(root, 'assets'), external, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const upload = {
    async *iterator() {
      yield png.subarray(0, 10);
      await cli(root, 'bind-assets', '--directory', external);
      yield png.subarray(10);
    },
  };
  await assert.rejects(importMediaAsset(root, upload, 'new.png'), (error) => error.statusCode === 409 && /素材目录.*变化/.test(error.message));
  assert.deepEqual(await readRegistry(root), registry);
  assert.deepEqual(await fs.readdir(path.join(root, '.viento/uploads')), []);
  for (const store of [path.join(root, 'assets'), external]) {
    assert.deepEqual(await fs.readdir(store), ['portraits']);
    assert.deepEqual(await fs.readFile(path.join(store, 'portraits/hero.png')), Buffer.from([0, 1, 255, 128]));
  }
  const retried = await importMediaAsset(root, { async *iterator() { yield png; } }, 'new.png');
  assert.equal(retried.reused, false);
  const asset = (await readRegistry(root)).assets.find((record) => record.id === retried.asset.id);
  assert.deepEqual(await fs.readFile(path.join(external, asset.location.path)), png);
  await assert.rejects(fs.access(path.join(root, 'assets', asset.location.path)), { code: 'ENOENT' });
  assert.equal((await verifyWorkspace(root)).ok, true);
});
