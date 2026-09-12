import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appStoragePaths, resolveWorkspaceRoot } from '../lib/app-storage.mjs';
import { cleanBuilds } from '../../desktop/clean.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'app');
  const storage = appStoragePaths({ env: {}, home: path.join(root, 'user') });
  const options = { appRoot, cwd: appRoot, env: {}, storage };
  await fs.mkdir(appRoot);
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  };
  return { root, appRoot, storage, options, write };
}

test('application storage matches native platform paths and ignores relative XDG locations', () => {
  const linux = appStoragePaths({ platform: 'linux', home: '/users/test', env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' } });
  assert.equal(linux.configFile, '/cfg/io.viento.studio/viento.config.json');
  assert.equal(linux.workspaces, '/data/io.viento.studio/workspaces');
  const fallback = appStoragePaths({ platform: 'linux', home: '/users/test', env: { XDG_CONFIG_HOME: 'relative', XDG_DATA_HOME: 'relative' } });
  assert.equal(fallback.configRoot, '/users/test/.config/io.viento.studio');
  assert.equal(fallback.dataRoot, '/users/test/.local/share/io.viento.studio');
  assert.equal(appStoragePaths({ platform: 'darwin', home: '/Users/test', env: {} }).dataRoot, '/Users/test/Library/Application Support/io.viento.studio');
  assert.equal(appStoragePaths({ platform: 'win32', home: 'C:\\Users\\test', env: { APPDATA: 'D:\\Profile' } }).dataRoot, 'D:\\Profile\\io.viento.studio');
});

test('local selection and native recent workspaces resolve outside application source', async (t) => {
  const { root, storage, options, write } = await setup(t);
  const selected = path.join(root, '作品');
  const recent = path.join(root, '最近作品');
  await fs.mkdir(path.join(recent, 'design-data'), { recursive: true });
  await write(storage.libraryFile, { recent: [{ path: path.join(root, '已搬走') }, { path: recent }] });
  assert.equal(resolveWorkspaceRoot(options), recent);
  await write(storage.configFile, { version: 1, workspace: selected });
  assert.equal(resolveWorkspaceRoot(options), selected);
  // A missing explicit selection remains visible as an error downstream instead
  // of silently opening and writing into some other recent work.
  assert.equal(resolveWorkspaceRoot(options), selected);
});

test('explicit workspace and workspace cwd take precedence over damaged default settings', async (t) => {
  const { root, appRoot, storage, options, write } = await setup(t);
  await write(storage.configFile, null);
  await write(path.join(appRoot, 'viento.config.json'), { version: 1, workspace: '' });
  assert.equal(resolveWorkspaceRoot({ ...options, env: { VIENTO_WORKSPACE_ROOT: '../chosen' } }), path.join(root, 'chosen'));
  const cwd = path.join(root, 'legacy-work');
  await fs.mkdir(path.join(cwd, 'design-data'), { recursive: true });
  assert.equal(resolveWorkspaceRoot({ ...options, cwd }), cwd);
  await fs.unlink(path.join(appRoot, 'viento.config.json'));
  assert.throws(() => resolveWorkspaceRoot(options), /默认作品配置无效/);
});

test('legacy explicit source selectors remain usable but fresh installs never default to the application directory', async (t) => {
  const { appRoot, storage, options, write } = await setup(t);
  assert.equal(resolveWorkspaceRoot(options), path.join(storage.workspaces, 'default'));
  await write(path.join(appRoot, 'viento.config.json'), { version: 1, workspace: '../external-work' });
  assert.equal(resolveWorkspaceRoot(options), path.resolve(appRoot, '../external-work'));
});

test('cleanup protects local selections and application data placed beneath build directories', async (t) => {
  const { appRoot, storage, options, write } = await setup(t);
  const source = path.join(appRoot, 'src-tauri/target/story/design-data/keep.md');
  await write(source, 'saved');
  await write(storage.configFile, { version: 1, workspace: path.dirname(path.dirname(source)) });
  await assert.rejects(cleanBuilds(appRoot, { storage }), /重叠/);
  assert.equal(JSON.parse(await fs.readFile(source, 'utf8')), 'saved');
  await fs.unlink(storage.configFile);
  const custom = { ...options.storage, dataRoot: path.join(appRoot, 'src-tauri/target/local-data') };
  await fs.mkdir(custom.dataRoot, { recursive: true });
  await assert.rejects(cleanBuilds(appRoot, { storage: custom }), /重叠/);
  assert.equal(JSON.parse(await fs.readFile(source, 'utf8')), 'saved');
});
