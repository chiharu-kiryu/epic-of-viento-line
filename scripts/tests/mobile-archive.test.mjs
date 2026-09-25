import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry, writeJson } from '../lib/workspace.mjs';
import { planExport, writeExportZip } from '../lib/export-package.mjs';
import { nativeMobileLibrary } from './mobile-native-harness.mjs';
import { createMobilePlatform } from '../../mobile/platform.mjs';

const binary = process.env.VIENTO_MOBILE_STORE_BIN, archiveBinary = process.env.VIENTO_TEST_ARCHIVE_BINARY;
const run = promisify(execFile);
test('desktop ZIP → mobile index/edit → desktop restore preserves v2/v3 identities, stories and media', {
  skip: (!binary || !archiveBinary) && 'Set both native test binaries',
}, async (t) => {
  for (const version of [2, 3]) await t.test(`v${version} round trip`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-mobile-archive-'));
    const library = await nativeMobileLibrary(binary, path.join(temp, 'mobile'));
    try {
      const root = path.join(temp, 'desktop');
      const documents = version === 3 ? 'documents' : 'design-data', templates = version === 3 ? 'templates' : 'data-template';
      const manifest = { format: 'viento-workspace', version, id: randomUUID(), name: `迁移测试 v${version}`, createdAt: 0,
        paths: { documents, templates, metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes };
      await writeJson(path.join(root, 'workspace.json'), manifest);
      for (const folder of [documents, templates, 'assets']) await fs.mkdir(path.join(root, folder), { recursive: true });
      for (const [name, content] of Object.entries(PROJECT_DEFAULTS.templates)) await fs.writeFile(path.join(root, templates, name), content);
      const source = `${documents}/旅人.md`, original = '\uFEFF# 旅人\r\n生命：100\r\n';
      await fs.writeFile(path.join(root, source), original);
      await fs.writeFile(path.join(root, documents, '故事.md'), '# 背景故事\n保留角色自己的故事。\n');
      for (const ext of ['png', 'mp4', 'ogg']) await fs.writeFile(path.join(root, 'assets', `素材.${ext}`), Buffer.from([0, 1, 128, 255]));
      await registerWorkspace(root);
      const registry = await readRegistry(root), character = registry.documents.find((r) => r.sourcePath === source);
      const story = registry.documents.find((r) => r !== character);
      character.documentType = 'character'; story.documentType = 'story'; story.parserProfile = 'prose';
      story.relations = [{ kind: 'part-of', targetId: character.id, slot: '背景' }];
      character.assetBindings = registry.assets.map((asset) => ({ assetId: asset.id, role: 'attachment' }));
      for (const record of registry.documents) await writeJson(path.join(root, 'metadata/documents', `${record.id}.json`), record);
      const plan = await planExport(root, { kind: 'workspace' });
      const incoming = path.join(temp, 'desktop.zip'); await writeExportZip(plan, incoming);
      const originals = new Map(await Promise.all(plan.entries.map(async (entry) => [entry.path, entry.buffer || await fs.readFile(entry.absolute)])));
      const call = (action, args = {}) => library.invoke('mobile_storage', { action, ...args });
      const work = await call('importArchive', { path: incoming }); assert.equal(work.id, manifest.id);
      const platform = createMobilePlatform({ invoke: library.invoke, workspaceId: work.id });
      const index = await platform.index(); assert.equal(index.count, 2);
      assert.equal(index.docs.find((d) => d.id === story.id).owners[0].id, character.id);
      const before = await call('read', { workspaceId: work.id, path: source });
      assert.equal(before.content, original);
      const changed = original.replace('100', '175');
      await call('save', { workspaceId: work.id, payload: { path: source, content: changed, expectedVersion: before.version } });
      await assert.rejects(call('importArchive', { path: incoming }), (error) => error.statusCode === 409);
      assert.equal((await call('read', { workspaceId: work.id, path: source })).content, changed);
      const outgoing = path.join(temp, 'mobile.zip'); await call('exportArchive', { workspaceId: work.id, path: outgoing });
      const restoredParent = path.join(temp, 'restored'); await fs.mkdir(restoredParent);
      const restored = JSON.parse((await run(archiveBinary, ['import', outgoing, restoredParent])).stdout).root;
      originals.set(source, Buffer.from(changed));
      for (const [name, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(restored, name)), bytes, name);
      assert.deepEqual(await readRegistry(restored), await readRegistry(root));
    } finally { await library.close(); await fs.rm(temp, { recursive: true, force: true }); }
  });
});
