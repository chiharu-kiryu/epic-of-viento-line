import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry, writeJson } from '../lib/workspace.mjs';

async function project(t, version = 2) {
  const root = await fixture(t);
  if (version === 3) {
    await writeJson(path.join(root, 'workspace.json'), { format: 'viento-workspace', version, id: randomUUID(), name: '归属迁移测试', createdAt: 0,
      paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: PROJECT_DEFAULTS.documentTypes });
    for (const [file, content] of Object.entries(PROJECT_DEFAULTS.templates)) await write(root, `templates/${file}`, content);
  }
  const parents = version === 2 ? ['design-data/design-heros/力量/甲.md', 'design-data/design-heros/力量/乙.md'] : ['documents/characters/甲.md', 'documents/characters/乙.md'];
  const story = version === 2 ? 'design-data/backstory/力量/同行.md' : 'documents/stories/同行.md';
  const originals = new Map([...parents, story].map((file) => [file, Buffer.from(`\uFEFF# ${path.basename(file)}\r\n正文不能改写。  \r\n`)]));
  originals.set('assets/原画.png', Buffer.from([0, 1, 128, 255]));
  for (const [file, bytes] of originals) await write(root, file, bytes);
  await registerWorkspace(root);
  let registry = await readRegistry(root);
  const child = registry.documents.find((record) => record.sourcePath === story);
  child.assetBindings.push({ assetId: registry.assets[0].id, role: 'attachment' });
  await writeJson(path.join(root, 'metadata/documents', `${child.id}.json`), child);
  registry = await readRegistry(root);
  const manifest = await fs.readFile(path.join(root, 'workspace.json'));
  const record = (source) => registry.documents.find((entry) => entry.sourcePath === source);
  const preserve = async () => {
    for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(root, file)), bytes, file);
    assert.deepEqual(await fs.readFile(path.join(root, 'workspace.json')), manifest);
    const after = await readRegistry(root);
    assert.deepEqual(after.assets, registry.assets);
    assert.deepEqual(after.documents.map(({ id, sourcePath, assetBindings, documentType, parserProfile }) => ({ id, sourcePath, assetBindings, documentType, parserProfile })),
      registry.documents.map(({ id, sourcePath, assetBindings, documentType, parserProfile }) => ({ id, sourcePath, assetBindings, documentType, parserProfile })));
  };
  return { root, parents, story, registry, record, preserve };
}

async function migrate(root, { mapping, write: apply = false } = {}) {
  const args = ['scripts/workspace.mjs', 'migrate-documents', '--root', root];
  if (mapping) {
    await write(root, 'owners-test.json', JSON.stringify(mapping));
    args.push('--shared-owners', path.join(root, 'owners-test.json'));
  }
  if (apply) args.push('--write');
  return JSON.parse((await node(root, args)).stdout);
}

async function metadataBytes(root) {
  const directory = path.join(root, 'metadata/documents');
  return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async (file) => [file, await fs.readFile(path.join(directory, file), 'utf8')])));
}

for (const version of [2, 3]) test(`document migration: v${version} can apply explicit owners after an earlier migration and rebuild shared navigation`, async (t) => {
  const h = await project(t, version);
  await migrate(h.root, { write: true });
  const before = await metadataBytes(h.root);
  const mapping = { [h.story]: [...h.parents, h.parents[0]] };
  const preview = await migrate(h.root, { mapping });
  assert.equal(preview.changed, 1, 'an explicit mapping must not be silently ignored after relations were initialized');
  assert.equal(preview.ownershipLinks, 2);
  assert.deepEqual(await metadataBytes(h.root), before, 'preview must not publish descriptors');
  const saved = await migrate(h.root, { mapping, write: true });
  assert.equal(saved.changed, 1);
  assert.ok(saved.journal);
  const journal = JSON.parse(await fs.readFile(path.join(h.root, saved.journal), 'utf8'));
  assert.equal(journal.changes.length, 1);
  assert.deepEqual(journal.changes[0].before.relations, []);
  assert.deepEqual(journal.changes[0].after.relations.map((r) => r.targetId), h.parents.map((file) => h.record(file).id));
  assert.equal((await migrate(h.root, { mapping, write: true })).changed, 0);
  await node(h.root, ['scripts/standardize-docs.mjs']);
  await node(h.root, ['scripts/build-static-doc-site.mjs']);
  const docs = JSON.parse(await fs.readFile(path.join(h.root, '.viento/cache/indexes/documents.json'), 'utf8')).docs;
  const child = docs.find((doc) => doc.id === h.record(h.story).id);
  assert.deepEqual(child.owners.map((owner) => owner.id), h.parents.map((file) => h.record(file).id));
  for (const file of h.parents) assert.equal(docs.find((doc) => doc.id === h.record(file).id).ownedDocuments[0].id, child.id);
  await h.preserve();
});

test('document migration: explicit corrections preserve other relations and retained owner annotations; ordinary reruns do not infer over them', async (t) => {
  const h = await project(t);
  const child = h.record(h.story), a = h.record(h.parents[0]), b = h.record(h.parents[1]);
  const reference = { kind: 'inspired-by', targetId: a.id, slot: '参考资料', note: '保留扩展字段' };
  const existing = { kind: 'part-of', targetId: a.id, slot: '起源', note: '保留归属备注' };
  child.relations = [reference, existing];
  await writeJson(path.join(h.root, 'metadata/documents', `${child.id}.json`), child);
  const before = await metadataBytes(h.root);
  await migrate(h.root, { write: true });
  assert.equal((await metadataBytes(h.root))[`${child.id}.json`], before[`${child.id}.json`]);
  const mapping = { [h.story]: h.parents };
  await migrate(h.root, { mapping, write: true });
  let updated = (await readRegistry(h.root)).documents.find((record) => record.id === child.id);
  assert.deepEqual(updated.relations, [reference, existing, { kind: 'part-of', targetId: b.id, slot: '背景故事' }]);
  assert.equal((await migrate(h.root, { mapping, write: true })).changed, 0);
  await migrate(h.root, { mapping: { [h.story]: [h.parents[1]] }, write: true });
  updated = (await readRegistry(h.root)).documents.find((record) => record.id === child.id);
  assert.deepEqual(updated.relations, [reference, { kind: 'part-of', targetId: b.id, slot: '背景故事' }]);
  await h.preserve();
});

test('document migration: invalid or cyclic explicit corrections fail before changing initialized metadata', async (t) => {
  const h = await project(t);
  await migrate(h.root, { write: true });
  const before = await metadataBytes(h.root);
  for (const mapping of [{ [h.story]: [h.story] }, { [h.story]: [h.parents[0]], [h.parents[0]]: [h.story] }, { [h.story]: ['design-data/missing.md'] }]) {
    await assert.rejects(migrate(h.root, { mapping, write: true }), /循环|无效/);
    assert.deepEqual(await metadataBytes(h.root), before);
  }
  await h.preserve();
});

for (const kind of ['private-directory', 'migration-directory', 'lock-file']) test(`document migration: a linked ${kind} is rejected before writing a journal or metadata`, async (t) => {
  const h = await project(t);
  const before = await metadataBytes(h.root);
  const outsideRoot = await fs.mkdtemp(path.join(path.dirname(h.root), 'viento-migration-outside-'));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, 'target');
  const source = path.join(h.root, '.viento', kind === 'migration-directory' ? 'migrations' : kind === 'lock-file' ? 'registry.lock' : '');
  let sentinel;
  if (kind === 'private-directory') {
    await fs.rename(source, outside);
    sentinel = path.join(outside, 'workspace.json');
  } else if (kind === 'migration-directory') {
    await fs.mkdir(outside);
    sentinel = path.join(outside, 'keep.json');
    await fs.writeFile(sentinel, '{ "keep": true }\r\n');
  } else {
    const owner = Number((await node(h.root, ['--input-type=module', '-e', 'console.log(process.pid)'])).stdout);
    assert.throws(() => process.kill(owner, 0), { code: 'ESRCH' });
    await fs.writeFile(outside, JSON.stringify({ pid: owner, nonce: 'preserve-lock-target' }));
    sentinel = outside;
  }
  await fs.symlink(outside, source);
  const original = await fs.readFile(sentinel);
  const outsideFiles = kind === 'lock-file' ? null : await fs.readdir(outside);
  await assert.rejects(migrate(h.root, { write: true }), /链接|实际文件/);
  assert.ok((await fs.lstat(source)).isSymbolicLink());
  assert.deepEqual(await fs.readFile(sentinel), original);
  if (outsideFiles) assert.deepEqual(await fs.readdir(outside), outsideFiles);
  assert.deepEqual(await metadataBytes(h.root), before);
  await h.preserve();
});

test('document migration: repeated operations in the same millisecond retain separate recovery journals', async (t) => {
  const h = await project(t);
  await node(h.root, ['--input-type=module', '-e', String.raw`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { updateDocumentModels } from './scripts/lib/workspace.mjs';
    const root = process.cwd(); Date.now = () => 123456789;
    const change = (parserProfile) => (records) => ({ documents: records.map((record) => ({ ...record, parserProfile })) });
    const first = await updateDocumentModels(root, change('structured'), { write: true });
    const bytes = await fs.readFile(path.join(root, first.journal));
    const second = await updateDocumentModels(root, change('prose'), { write: true });
    assert.notEqual(first.journal, second.journal, 'a later migration must never overwrite the recovery history');
    assert.deepEqual(await fs.readFile(path.join(root, first.journal)), bytes);
    const journal = JSON.parse(await fs.readFile(path.join(root, second.journal), 'utf8'));
    assert.ok(journal.changes.every((entry) => entry.before.parserProfile === 'structured' && entry.after.parserProfile === 'prose'));
    assert.equal((await fs.readdir(path.join(root, '.viento/migrations'))).length, 2);
  `]);
});

test('document migration: a write failure rolls descriptors back, releases the lock and permits a safe retry', async (t) => {
  const h = await project(t);
  await node(h.root, ['--input-type=module', '-e', String.raw`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { readRegistry, updateDocumentModels } from './scripts/lib/workspace.mjs';
    import { planLegacyDocumentModels } from './scripts/lib/document-model.mjs';
    const root = process.cwd(), before = await readRegistry(root);
    const files = before.documents.map((record) => path.join(root, 'metadata/documents', record.id + '.json'));
    const bytes = await Promise.all(files.map((file) => fs.readFile(file)));
    const rename = fs.rename; let failed = false;
    fs.rename = async (from, to) => {
      if (to === files[1] && !failed) { failed = true; throw Object.assign(new Error('controlled write failure'), { code: 'EIO' }); }
      return rename(from, to);
    };
    try { await assert.rejects(updateDocumentModels(root, planLegacyDocumentModels, { write: true }), /controlled write failure/); }
    finally { fs.rename = rename; }
    assert.equal(failed, true);
    assert.deepEqual(await Promise.all(files.map((file) => fs.readFile(file))), bytes);
    assert.deepEqual(await readRegistry(root), before);
    await assert.rejects(fs.access(path.join(root, '.viento/registry.lock')), { code: 'ENOENT' });
    const result = await updateDocumentModels(root, planLegacyDocumentModels, { write: true });
    assert.equal(result.changed, before.documents.length);
    assert.equal((await updateDocumentModels(root, planLegacyDocumentModels, { write: true })).changed, 0);
  `]);
  await h.preserve();
});
