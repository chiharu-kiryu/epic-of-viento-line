import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import yazl from 'yazl';
import { fixture, write, node } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { readRegistry, registerWorkspace, writeJson } from '../lib/workspace.mjs';
import { planExport, writeExportZip } from '../lib/export-package.mjs';

const nativeBinary = process.env.VIENTO_TEST_ARCHIVE_BINARY;
const run = promisify(execFile);
const native = async (...args) => JSON.parse((await run(nativeBinary, args, { timeout: 15000 })).stdout);
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

// Write a checksum-correct package independently of the production exporter:
// import must validate metadata semantics even when every ZIP digest is valid.
async function uncheckedArchive(output, files, manifest) {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(output));
  const entries = [];
  for (const [name, content] of files) {
    zip.addBuffer(content, name);
    entries.push({ path: name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  zip.addBuffer(bytes({ ...manifest, files: entries }), 'manifest.json');
  zip.end();
  await writing;
}

async function project(t, version) {
  const root = await fixture(t);
  const documents = version === 3 ? 'documents' : 'design-data';
  const templates = version === 3 ? 'templates' : 'data-template';
  await writeJson(path.join(root, 'workspace.json'), { format: 'viento-workspace', version, id: randomUUID(), name: '归档登记测试', createdAt: 0,
    paths: { documents, templates, metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes });
  for (const [name, content] of Object.entries(PROJECT_DEFAULTS.templates)) await write(root, `${templates}/${name}`, content);
  for (const name of ['角色甲', '角色乙', '背景']) await write(root, `${documents}/${name}.md`, `\uFEFF# ${name}\r\n保留正文。  \r\n`);
  await write(root, 'assets/actual.bin', Buffer.from([0, 1, 128, 255]));
  await write(root, 'assets/other.bin', 'another asset');
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  registry.assets[1].legacyPaths.push('assets/café.bin');
  const doc = registry.documents.find((record) => record.sourcePath.endsWith('/背景.md'));
  const parents = registry.documents.filter((record) => record.id !== doc.id);
  doc.relations = parents.map((record) => ({ kind: 'part-of', targetId: record.id, slot: '背景', note: '保留附加备注' }));
  parents[0].relations = [{ kind: 'references', targetId: doc.id }];
  doc.assetBindings = [{ assetId: registry.assets[0].id, role: 'attachment' }];
  for (const [kind, records] of Object.entries(registry)) for (const record of records) await writeJson(path.join(root, `metadata/${kind}/${record.id}.json`), record);
  const plan = await planExport(root, { kind: 'workspace' });
  const originals = new Map(await Promise.all(plan.entries.map(async (entry) => [entry.path, entry.buffer || await fs.readFile(entry.absolute)])));
  const good = path.join(root, 'good.zip');
  await writeExportZip(plan, good);
  const destination = path.join(root, 'backup.zip'), parent = path.join(root, 'restores');
  await fs.mkdir(parent);
  await write(root, 'restores/existing/keep.txt', 'existing project');
  return { root, version, documents, registry, doc, parents, plan, originals, good, destination, parent };
}

const invalidRecords = [
  ['empty document type', 'document', (r) => { r.documentType = '  '; }],
  ['BOM-only document type', 'document', (r) => { r.documentType = '\uFEFF'; }],
  ['overlong UTF-16 document type', 'document', (r) => { r.documentType = '🌱'.repeat(61); }],
  ['unknown parser profile', 'document', (r) => { r.parserProfile = 'unknown'; }],
  ['non-array relations', 'document', (r) => { r.relations = null; }],
  ['null relationship', 'document', (r) => { r.relations = [null]; }],
  ['blank relationship kind', 'document', (r) => { r.relations[0].kind = ' '; }],
  ['BOM-only relationship kind', 'document', (r) => { r.relations[0].kind = '\uFEFF'; }],
  ['missing relationship target', 'document', (r) => { r.relations[0].targetId = randomUUID(); }],
  ['non-string relationship slot', 'document', (r) => { r.relations[0].slot = 7; }],
  ['duplicate relationship', 'document', (r) => { r.relations.push({ ...r.relations[0], slot: '另一个名称' }); }],
  ['self ownership', 'document', (r) => { r.relations[0].targetId = r.id; }],
  ['mutual ownership', 'parent', (r, h) => { r.relations = [{ kind: 'part-of', targetId: h.doc.id }]; }],
  ['non-string asset name', 'asset', (r) => { r.name = 7; }],
  ['unknown asset kind', 'asset', (r) => { r.kind = 'unknown'; }],
  ['non-array asset tags', 'asset', (r) => { r.tags = null; }],
  ['non-string asset tag', 'asset', (r) => { r.tags = ['kept', 7]; }],
  ['missing legacy paths', 'asset', (r) => { delete r.legacyPaths; }],
  ['escaping legacy path', 'asset', (r) => { r.legacyPaths = ['assets/../other.bin']; }],
  ['legacy path outside assets', 'asset', (r) => { r.legacyPaths = ['documents/story.md']; }],
  ['legacy path collides with another asset', 'asset', (r, h) => { r.legacyPaths = [`assets/${h.registry.assets[1].location.path.toUpperCase()}`]; }],
  ['Unicode-equivalent legacy path collision', 'asset', (r) => { r.legacyPaths = ['assets/cafe\u0301.bin']; }],
];

test('native archive metadata stays compatible with the editor reader before backup and restore commit', { skip: !nativeBinary }, async (t) => {
  for (const version of [2, 3]) {
    const h = await project(t, version);
    for (const [label, kind, mutate] of invalidRecords) await t.test(`v${version}: reject ${label} and preserve prior backup and restore directory`, async () => {
      const original = kind === 'asset' ? h.registry.assets[0] : kind === 'parent' ? h.parents[0] : h.doc;
      const changed = structuredClone(original); mutate(changed, h);
      const file = `metadata/${kind === 'asset' ? 'assets' : 'documents'}/${original.id}.json`;
      const files = new Map(h.originals); files.set(file, bytes(changed));
      await fs.writeFile(path.join(h.root, file), files.get(file));
      try {
        await assert.rejects(readRegistry(h.root), undefined, `${label}: editor must reject the same damaged record`);
        const broken = path.join(h.root, 'broken.zip');
        await uncheckedArchive(broken, files, h.plan.archiveManifest);
        const goodBytes = await fs.readFile(h.good);
        await fs.writeFile(h.destination, goodBytes);
        const previousDirectories = (await fs.readdir(h.parent)).sort();
        let backupRejected = false, restoreRejected = false;
        try { await native('export', h.root, h.destination); } catch (error) { assert.match(error.stderr, /登记|关系|归属|类型|解析|素材/); backupRejected = true; }
        try {
          const restored = await native('import', broken, h.parent);
          await assert.rejects(readRegistry(restored.root), undefined, 'accepted archive leaves an unreadable project');
        } catch (error) { assert.match(error.stderr, /登记|关系|归属|类型|解析|素材/); restoreRejected = true; }
        const outcome = { backupRejected, restoreRejected,
          backupPreserved: (await fs.readFile(h.destination)).equals(goodBytes),
          directoryPreserved: JSON.stringify((await fs.readdir(h.parent)).sort()) === JSON.stringify(previousDirectories) };
        assert.deepEqual(outcome, { backupRejected: true, restoreRejected: true, backupPreserved: true, directoryPreserved: true });
        for (const [name, content] of files) assert.deepEqual(await fs.readFile(path.join(h.root, name)), content, name);
      } finally { await fs.writeFile(path.join(h.root, file), h.originals.get(file)); }
    });
    await t.test(`v${version}: retry with valid shared ownership restores exact sources, rules, metadata and attachment references`, async () => {
      await native('export', h.root, h.destination);
      const { root: restored } = await native('import', h.destination, h.parent);
      for (const [file, content] of h.originals) assert.deepEqual(await fs.readFile(path.join(restored, file)), content, file);
      assert.deepEqual(await readRegistry(restored), h.registry);
      // Builders execute from the fixture's application root against only the restored project.
      await node(restored, [path.join(h.root, 'scripts/standardize-docs.mjs')]);
      await node(restored, [path.join(h.root, 'scripts/build-static-doc-site.mjs')]);
      const index = JSON.parse(await fs.readFile(path.join(restored, '.viento/cache/indexes/documents.json')));
      assert.equal(index.docs.find((doc) => doc.id === h.doc.id).owners.length, 2);
      for (const record of h.parents) assert.equal(index.docs.find((doc) => doc.id === record.id).ownedDocuments[0].id, h.doc.id);
    });
    await t.test(`v${version}: optional legacy fields, empty roles, repeated own aliases and unknown fingerprints remain portable`, async () => {
      const compatible = structuredClone(h.registry);
      for (const record of compatible.documents) {
        delete record.documentType; delete record.parserProfile; delete record.relations;
        record.assetBindings.forEach((binding) => { binding.role = ''; });
      }
      compatible.documents[0].documentType = '🌱'.repeat(60);
      compatible.documents[0].parserProfile = 'legacy-hero';
      compatible.documents[1].documentType = '\u0085';
      compatible.documents[1].relations = [{ kind: '\u0085', targetId: compatible.documents[0].id, slot: '' }];
      for (const asset of compatible.assets) { asset.content = null; asset.legacyPaths = [`assets/${asset.location.path}`, `assets/${asset.location.path.toUpperCase()}`]; }
      for (const [kind, records] of Object.entries(compatible)) for (const record of records) await writeJson(path.join(h.root, `metadata/${kind}/${record.id}.json`), record);
      assert.deepEqual(await readRegistry(h.root), compatible);
      await native('export', h.root, h.destination);
      const { root: restored } = await native('import', h.destination, h.parent);
      assert.deepEqual(await readRegistry(restored), compatible);
    });
  }
});
