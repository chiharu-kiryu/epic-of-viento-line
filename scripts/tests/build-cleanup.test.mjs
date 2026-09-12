import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanBuilds } from '../../desktop/clean.mjs';

test('build cleanup preserves source, releases and every workspace state file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-clean-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keep = ['src-tauri/src/lib.rs', 'desktop/ui/app.js', 'dist/project.viento.zip',
    '.git/objects/saved', 'workspaces/story/design-data/正文.md', 'workspaces/story/assets/image.png',
    'workspaces/story/metadata/assets/id.json', 'workspaces/story/.viento/workspace.json',
    'workspaces/story/.viento/local.json', 'workspaces/story/.viento/cache/indexes/documents.json'];
  const remove = ['src-tauri/target/debug/cache', 'src-tauri/binaries/runtime',
    'src-tauri/gen/schemas/schema.json', 'desktop/resources/web/app.js', 'desktop/.cache/download'];
  for (const name of [...keep, ...remove]) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), name);
  }
  assert.equal((await cleanBuilds(root, { dryRun: true })).length, 5);
  for (const name of remove) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), name);
  assert.equal((await cleanBuilds(root)).length, 5);
  for (const name of keep) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), name);
  for (const name of remove) await assert.rejects(fs.stat(path.join(root, name)), { code: 'ENOENT' });
  assert.deepEqual(await cleanBuilds(root), []);
});

test('build cleanup does not follow symlinks into other data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-clean-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(app, 'src-tauri'), { recursive: true });
  await fs.mkdir(path.join(outside, 'resources'), { recursive: true });
  await fs.writeFile(path.join(outside, 'resources/keep'), 'data');
  await fs.symlink(outside, path.join(app, 'src-tauri/target'), 'junction');
  await fs.symlink(outside, path.join(app, 'desktop'), 'junction');
  await assert.rejects(cleanBuilds(app), /父路径/);
  assert.ok((await fs.lstat(path.join(app, 'src-tauri/target'))).isSymbolicLink());
  await fs.unlink(path.join(app, 'desktop'));
  await cleanBuilds(app);
  assert.equal(await fs.readFile(path.join(outside, 'resources/keep'), 'utf8'), 'data');
});

test('build cleanup refuses a configured workspace or asset store inside generated directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-clean-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = 'src-tauri/target/story';
  await fs.mkdir(path.join(root, workspace), { recursive: true });
  await fs.writeFile(path.join(root, 'viento.config.json'), JSON.stringify({ version: 1, workspace }));
  await assert.rejects(cleanBuilds(root), /重叠/);
  await fs.writeFile(path.join(root, 'viento.config.json'), JSON.stringify({ version: 1, workspace: 'workspaces/story' }));
  await fs.mkdir(path.join(root, 'workspaces/story/.viento'), { recursive: true });
  await fs.mkdir(path.join(root, 'desktop/.cache/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'workspaces/story/.viento/local.json'), JSON.stringify({
    version: 1, assetStores: { main: path.join(root, 'desktop/.cache/assets') },
  }));
  await assert.rejects(cleanBuilds(root), /重叠/);
  assert.ok((await fs.stat(path.join(root, workspace))).isDirectory());
});
