import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node, serve, request } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry, writeJson } from '../lib/workspace.mjs';
import { readProjectConfiguration } from '../lib/project-service.mjs';
import { applyProjectDefinition } from '../lib/project-definition.mjs';
import { planExport } from '../lib/export-package.mjs';

const species = { id: 'species', label: '种族', directory: 'species', parserProfile: 'structured',
  parserOptions: { titleField: '名称' }, fieldGroups: [{ title: '生命特征', fields: ['灵魂', '繁衍'] }] };

async function project(t, version = 3) {
  const root = await fixture(t);
  const documents = version === 3 ? 'documents' : 'design-data';
  const templates = version === 3 ? 'templates' : 'data-template';
  const types = [
    { id: 'document', label: '档案', directory: '', parserProfile: 'structured' },
    { id: 'character', label: '角色', directory: version === 3 ? 'characters' : 'design-heros', parserProfile: 'structured' },
    { id: 'story', label: '故事', directory: version === 3 ? 'stories' : 'backstory', parserProfile: 'prose' },
  ];
  if (version === 3) await writeJson(path.join(root, 'workspace.json'), { format: 'viento-workspace', version,
    id: randomUUID(), name: '项目定义测试', createdAt: 0, paths: PROJECT_DEFAULTS.paths,
    assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: types });
  const originals = new Map([
    [`${documents}/${types[1].directory}/旅者.md`, Buffer.from('\uFEFF# 旅者\r\n正文必须保留。  \r\n')],
    [`${documents}/${types[2].directory}/过去.md`, Buffer.from('# 过去\r\n故事仍属于旅者。\r\n')],
    [`${templates}/preserved.md`, Buffer.from('\uFEFF# 私有模板\r\n')],
    ['assets/原画.png', Buffer.from([0, 1, 128, 255])],
  ]);
  for (const [file, bytes] of originals) await write(root, file, bytes);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const parent = registry.documents.find((record) => record.documentType === 'character');
  const child = registry.documents.find((record) => record.documentType === 'story');
  child.relations = [{ kind: 'part-of', targetId: parent.id, slot: '经历', note: '保留备注' }];
  child.assetBindings.push({ assetId: registry.assets[0].id, role: 'attachment' });
  await writeJson(path.join(root, 'metadata/documents', `${child.id}.json`), child);
  for (const [kind, records] of [['documents', registry.documents], ['assets', registry.assets]]) {
    for (const record of records) {
      const file = `metadata/${kind}/${record.id}.json`;
      originals.set(file, await fs.readFile(path.join(root, file)));
    }
  }
  const manifest = await fs.readFile(path.join(root, 'workspace.json'));
  return { root, documents, templates, types, manifest, registry,
    definition: (type = species) => ({ format: 'viento-project-definition', version: 1, documentTypes: [...types, type] }),
    preserve: async () => {
      for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(path.join(root, file)), bytes, file);
    },
  };
}

async function apply(root, definition, writeChanges = false) {
  await write(root, 'definition-test.json', JSON.stringify(definition));
  const args = ['scripts/workspace.mjs', 'apply-definition', '--root', root, '--definition', path.join(root, 'definition-test.json')];
  if (writeChanges) args.push('--write');
  return JSON.parse((await node(root, args)).stdout);
}

for (const [label, directory] of [
  ['hidden', '.private'], ['nested hidden', 'species/.private'],
  ['reserved', 'node_modules'], ['nested reserved', 'species/node_modules'],
  ['overlong UTF-8', '种'.repeat(86)],
]) test(`definition adoption: generated templates reject an unusable ${label} directory in preview and apply`, async (t) => {
  const h = await project(t);
  const rejected = [];
  for (const writeChanges of [false, true]) {
    try { await apply(h.root, h.definition({ ...species, directory }), writeChanges); rejected.push(false); }
    catch (error) { assert.match(error.message, /隐藏|node_modules|文件名过长/); rejected.push(true); }
  }
  assert.deepEqual(rejected, [true, true], 'both entry points must validate the default location even without a template file');
  assert.deepEqual(await fs.readFile(path.join(h.root, 'workspace.json')), h.manifest);
  await assert.rejects(fs.access(path.join(h.root, '.viento/migrations')), { code: 'ENOENT' });
  await h.preserve();
});

for (const version of [2, 3]) test(`definition adoption: v${version} generated templates support preview, repair, creation, rebuilding and export without rewriting old data`, async (t) => {
  const h = await project(t, version);
  // Previously accepted bad locations must remain readable so adoption can repair them.
  const legacy = { ...JSON.parse(h.manifest), documentTypes: h.definition({ ...species, directory: '.old' }).documentTypes };
  await writeJson(path.join(h.root, 'workspace.json'), legacy);
  const before = await fs.readFile(path.join(h.root, 'workspace.json'));
  assert.equal((await readProjectConfiguration(h.root)).entries.at(-1).type.directory, '.old');
  const definition = h.definition({ ...species, directory: `世界/种族/${'种'.repeat(85)}` });
  definition.example = { id: 'fixture-example', title: '测试示范' };
  const preview = await apply(h.root, definition);
  assert.equal(preview.changed, true);
  assert.equal(preview.journal, null);
  assert.deepEqual(await fs.readFile(path.join(h.root, 'workspace.json')), before);
  const result = await apply(h.root, definition, true);
  assert.equal(result.changed, true);
  const journal = JSON.parse(await fs.readFile(path.join(h.root, result.journal), 'utf8'));
  assert.deepEqual(journal.before, legacy);
  assert.deepEqual(journal.after.documentTypes, definition.documentTypes);
  assert.equal((await apply(h.root, definition, true)).changed, false);
  assert.equal((await fs.readdir(path.join(h.root, '.viento/migrations'))).length, 1);
  assert.deepEqual(await readRegistry(h.root), h.registry);
  const check = JSON.parse((await node(h.root, ['scripts/workspace.mjs', 'check-project', '--root', h.root])).stdout);
  assert.equal(check.ok, true, JSON.stringify(check));
  const base = await serve(t, h.root);
  const config = (await request(base, '/api/project')).data;
  assert.deepEqual(config.warnings, []);
  const entry = config.entries.find((item) => item.type.id === species.id);
  assert.equal(entry.format, 'md');
  assert.equal(entry.content, '# 新建种族\n\n');
  assert.equal(entry.type.template, undefined);
  const source = `${h.documents}/${entry.type.directory}/星裔.md`;
  const content = `${entry.content}名称：星裔\n灵魂：星光\n繁衍：种子\n`;
  const created = await request(base, '/api/doc', { path: source, content, create: true, documentType: species.id });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal((await request(base, '/api/rebuild', { source })).status, 200);
  assert.equal((await request(base, `/api/doc?path=${encodeURIComponent(source)}`)).data.content, content);
  const index = (await request(base, '/api/index')).data;
  assert.equal(index.workspace.example.id, 'fixture-example');
  const record = (await readRegistry(h.root)).documents.find((doc) => doc.sourcePath === source);
  const built = index.docs.find((doc) => doc.id === record.id);
  assert.equal(built.title, '星裔');
  assert.equal(built.group, '种族');
  const details = JSON.parse(await fs.readFile(path.join(h.root, '.viento/cache/indexes/documents.json'))).docs.find((doc) => doc.id === record.id);
  assert.ok(details.layout.sections.some((section) => section.title === '生命特征'));
  const portable = await planExport(h.root, { kind: 'document', format: 'html', path: source });
  const html = portable.entries.find((file) => file.path === 'index.html').buffer.toString();
  for (const value of ['星裔', '生命特征', '星光', '种子']) assert.ok(html.includes(value), value);
  await h.preserve();
});

test('definition adoption: missing, malformed and oversized template files fail before changing the manifest or originals', async (t) => {
  const h = await project(t);
  await write(h.root, `${h.templates}/invalid.json`, '{invalid');
  await write(h.root, `${h.templates}/large.md`, 'x'.repeat(1024 * 1024 + 1));
  for (const template of ['missing.md', 'invalid.json', 'large.md']) {
    await assert.rejects(apply(h.root, h.definition({ ...species, template }), true), /ENOENT|模板解析失败|1 MB/);
    assert.deepEqual(await fs.readFile(path.join(h.root, 'workspace.json')), h.manifest);
    await assert.rejects(fs.access(path.join(h.root, '.viento/migrations')), { code: 'ENOENT' });
  }
  await h.preserve();
});

test('definition adoption: changes in the same millisecond retain independent recovery journals', async (t) => {
  const h = await project(t);
  await write(h.root, 'definition-test.json', JSON.stringify(h.definition()));
  await node(h.root, ['--input-type=module', '-e', String.raw`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { applyProjectDefinition } from './scripts/lib/project-definition.mjs';
    const root = process.cwd(), definition = JSON.parse(await fs.readFile('definition-test.json'));
    Date.now = () => 123456789;
    const first = await applyProjectDefinition(root, definition, { write: true });
    const bytes = await fs.readFile(path.join(root, first.journal));
    definition.documentTypes.at(-1).label = '新种族';
    const second = await applyProjectDefinition(root, definition, { write: true });
    assert.notEqual(first.journal, second.journal);
    assert.deepEqual(await fs.readFile(path.join(root, first.journal)), bytes);
    const journal = JSON.parse(await fs.readFile(path.join(root, second.journal), 'utf8'));
    assert.equal(journal.before.documentTypes.at(-1).label, '种族');
    assert.equal(journal.after.documentTypes.at(-1).label, '新种族');
    assert.equal((await fs.readdir(path.join(root, '.viento/migrations'))).length, 2);
  `]);
  await h.preserve();
});

test('definition adoption: manifest write failure preserves the previous project, releases the lock and permits an immediate retry', async (t) => {
  const h = await project(t);
  await write(h.root, 'definition-test.json', JSON.stringify(h.definition()));
  await node(h.root, ['--input-type=module', '-e', String.raw`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { applyProjectDefinition } from './scripts/lib/project-definition.mjs';
    const root = process.cwd(), manifest = path.join(root, 'workspace.json');
    const definition = JSON.parse(await fs.readFile('definition-test.json'));
    const before = await fs.readFile(manifest), rename = fs.rename;
    Date.now = () => 123456789; let failed = false;
    fs.rename = async (from, to) => {
      if (to === manifest && !failed) { failed = true; throw Object.assign(new Error('controlled manifest failure'), { code: 'EIO' }); }
      return rename(from, to);
    };
    try { await assert.rejects(applyProjectDefinition(root, definition, { write: true }), /controlled manifest failure/); }
    finally { fs.rename = rename; }
    assert.equal(failed, true);
    assert.deepEqual(await fs.readFile(manifest), before);
    await assert.rejects(fs.access(path.join(root, '.viento/registry.lock')), { code: 'ENOENT' });
    const directory = path.join(root, '.viento/migrations');
    const [failedJournal] = await fs.readdir(directory);
    const bytes = await fs.readFile(path.join(directory, failedJournal));
    const result = await applyProjectDefinition(root, definition, { write: true });
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await fs.readFile(manifest)).documentTypes, definition.documentTypes);
    assert.deepEqual(await fs.readFile(path.join(directory, failedJournal)), bytes);
    assert.equal((await fs.readdir(directory)).length, 2);
  `]);
  await h.preserve();
  assert.equal((await applyProjectDefinition(h.root, h.definition(), { write: true })).changed, false);
});
