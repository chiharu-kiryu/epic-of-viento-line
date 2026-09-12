import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node, serve } from './helpers.mjs';
import { PROJECT_DEFAULTS, projectDefinition } from '../lib/project-layout.mjs';
import { readWorkspace, readRegistry, registerWorkspace, verifyWorkspace } from '../lib/workspace.mjs';
import { editorHarness, Element } from './editor-harness.mjs';

const species = { id: 'species', label: '种族', directory: 'species', parserProfile: 'structured', template: 'species.md' };
async function genericProject(t) {
  const root = await fixture(t);
  await fs.rm(path.join(root, 'design-data'), { recursive: true });
  await fs.rm(path.join(root, 'data-template'), { recursive: true });
  const manifest = { format: 'viento-workspace', version: 3, id: randomUUID(), name: '独立世界', createdAt: 1,
    paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: [...PROJECT_DEFAULTS.documentTypes, species] };
  await write(root, 'workspace.json', JSON.stringify(manifest));
  await fs.mkdir(path.join(root, 'documents'));
  for (const [file, content] of Object.entries(PROJECT_DEFAULTS.templates)) await write(root, `templates/${file}`, content);
  await write(root, 'templates/species.md', '# 新建种族\n\n灵魂数量：\n');
  await registerWorkspace(root);
  return { root, manifest };
}
async function rebuild(root) {
  await node(root, ['scripts/standardize-docs.mjs']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  return JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
}
const post = (base, endpoint, value) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('generic registration preserves version, project-owned types and templates without legacy directories', async (t) => {
  const { root, manifest } = await genericProject(t);
  await registerWorkspace(root);
  assert.deepEqual(readWorkspace(root), manifest);
  assert.equal((await fs.readdir(path.join(root, 'documents'))).length, 0);
  assert.equal((await fs.readdir(path.join(root, 'templates'))).length, 7);
  await assert.rejects(fs.stat(path.join(root, 'design-data')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'data-template')), { code: 'ENOENT' });
  const index = await rebuild(root);
  assert.equal(index.count, 0);
  assert.equal(index.workspace.paths.documents, 'documents');
  assert.equal(index.workspace.documentTypes.at(-1).templateSource, 'templates/species.md');
  assert.equal((await verifyWorkspace(root)).ok, true);
});

test('custom type survives a user-selected file location, partial rebuild, save and reload', async (t) => {
  const { root } = await genericProject(t);
  await rebuild(root);
  const base = await serve(t, root);
  const source = 'documents/自定义目录/星裔.md';
  const response = await post(base, '/api/doc', { path: source, content: '# 星裔\n\n灵魂数量：2\n\n## 背景\n这里不是游戏属性。\n', create: true, documentType: 'species' });
  assert.equal(response.status, 200, await response.clone().text());
  const record = (await readRegistry(root)).documents[0];
  assert.equal(record.documentType, 'species');
  assert.equal(record.sourcePath, source);
  assert.equal((await post(base, '/api/rebuild', { source: `docs-standard/${source}` })).status, 200);
  const index = await rebuild(root);
  assert.equal(index.docs[0].category, 'species');
  assert.equal(index.docs[0].group, '种族');
  assert.equal(index.docs[0].id, record.id);
  const editableIndex = (await (await fetch(base + '/api/index')).json()).data;
  assert.equal(editableIndex.workspace.version, 3);
  assert.equal(editableIndex.docs[0].category, 'species');
  assert.equal(editableIndex.docs[0].group, '种族');
  const read = await fetch(`${base}/api/doc?path=${encodeURIComponent(`docs-standard/${source}`)}`);
  assert.equal(read.status, 200);
  const snapshot = (await read.json()).data;
  assert.equal((await post(base, '/api/doc', { path: source, content: snapshot.content + '\n补充设定。', expectedVersion: snapshot.version })).status, 200);
  assert.equal((await readRegistry(root)).documents[0].id, record.id);
  assert.equal((await post(base, '/api/doc', { path: 'design-data/错误.md', content: '不能写入旧目录', create: true })).status, 400);
});

test('invalid types and simultaneous creates never leave orphaned metadata or overwrite a source', async (t) => {
  const { root } = await genericProject(t);
  const base = await serve(t, root);
  const source = 'documents/争用.md';
  assert.equal((await post(base, '/api/doc', { path: source, content: '无效', create: true, documentType: 'hero' })).status, 400);
  assert.equal((await readRegistry(root)).documents.length, 0);
  const results = await Promise.all(['甲', '乙'].map((content) => post(base, '/api/doc', { path: source, content, create: true, documentType: 'document' })));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await readRegistry(root)).documents.length, 1);
  assert.ok(['甲', '乙'].includes(await fs.readFile(path.join(root, source), 'utf8')));
});

test('generic documents, project templates and media IDs survive a different workspace root', async (t) => {
  const { root } = await genericProject(t);
  const base = await serve(t, root);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(base + '/api/assets?name=参考.png', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png });
  assert.equal(upload.status, 200);
  const asset = (await upload.json()).data.asset;
  assert.equal((await post(base, '/api/doc', { path: 'documents/characters/角色.md', content: `# 角色\n\n## 背景与经历\n属于角色自己的故事。\n\n![参考](asset:${asset.id})\n`, create: true, documentType: 'character' })).status, 200);
  const before = await rebuild(root);
  const { root: relocated } = await genericProject(t);
  for (const file of ['workspace.json', '.viento/workspace.json', 'documents', 'templates', 'metadata', 'assets']) {
    await fs.cp(path.join(root, file), path.join(relocated, file), { recursive: true });
  }
  const after = await rebuild(relocated);
  assert.equal(after.docs[0].id, before.docs[0].id);
  assert.deepEqual(after.docs[0].assetRefs, [asset.id]);
  assert.equal(after.workspace.documentTypes.at(-1).id, 'species');
  const restored = await serve(t, relocated);
  assert.deepEqual(Buffer.from(await (await fetch(restored + asset.url)).arrayBuffer()), png);
  assert.match(await (await fetch(restored + '/templates/character.md')).text(), /背景与经历/);
  assert.equal((await verifyWorkspace(relocated)).ok, true);
});

test('generic editor offers only project types, uses local templates and accepts the new document root', async () => {
  let loaded;
  const harness = await editorHarness({ loadTemplateContent: async ({ templatePath }) => { loaded = templatePath; return '# 星裔\n'; } });
  harness.state.workspace = projectDefinition({ version: 3, documentTypes: [...PROJECT_DEFAULTS.documentTypes, { ...species, label: '<种族 & 设定>' }] });
  assert.deepEqual(Array.from(harness.runtime.getCreateTypeDisplayList()), ['document', 'character', 'story', 'place', 'organization', 'concept', 'species']);
  harness.runtime.renderCreateTypeOptions();
  assert.equal(harness.element('docCreateTypeSelect').children.at(-1).textContent, '<种族 & 设定>');
  assert.equal(harness.runtime.getCreateTypeBasePath('species'), 'documents/species/');
  assert.match(harness.runtime.getSuggestedCreatePath('', 'character'), /^documents\/characters\/.*\.md$/);
  assert.equal(await harness.runtime.loadCreateTypeTemplate('species'), '# 星裔\n');
  assert.equal(loaded, '/templates/species.md');
  assert.equal(harness.runtime.isInvalidCreatePath('documents/种族.md'), '');
  assert.notEqual(harness.runtime.isInvalidCreatePath('design-data/种族.md'), '');
  for (const extension of ['json', 'yaml']) {
    harness.state.workspace = projectDefinition({ version: 3, documentTypes: [{ ...species, template: `species.${extension}` }] });
    harness.state.activeCreateType = 'species';
    assert.ok(harness.runtime.getSuggestedCreatePath('', 'species').endsWith(`.${extension}`));
    assert.equal(harness.runtime.ensureMarkdownLikeExtension('documents/星裔'), `documents/星裔.${extension}`);
  }
});

test('new manifest layout and template paths are validated while legacy projects keep their original layout', async (t) => {
  const { root, manifest } = await genericProject(t);
  for (const documentTypes of [[{ ...species, template: '../outside.md' }], [{ ...species, directory: '../outside' }], [species, species], [{ ...species, parserProfile: 'legacy-hero' }]]) {
    await write(root, 'workspace.json', JSON.stringify({ ...manifest, documentTypes }));
    assert.throws(() => readWorkspace(root));
  }
  await write(root, 'workspace.json', JSON.stringify({ ...manifest, paths: { ...manifest.paths, documents: 'design-data' } }));
  assert.throws(() => readWorkspace(root), /目录声明/);
  const legacy = await fixture(t);
  await write(legacy, 'design-data/design-heros/力量/角色.md', '# 角色\n');
  const result = await registerWorkspace(legacy);
  assert.equal(result.workspace.version, 2);
  assert.equal(result.workspace.paths.documents, 'design-data');
  assert.equal((await readRegistry(legacy)).documents[0].parserProfile, 'legacy-hero');
});

test('an empty project exposes creation in edit mode and recovers after cancelling its first draft', async () => {
  const harness = await editorHarness();
  harness.state.workspace = { ...projectDefinition({ version: 3 }), name: '新的世界' };
  harness.state.docs = [];
  harness.state.activePath = '';
  harness.runtime.updateEmptyProject();
  assert.equal(harness.element('docEditPanel').classList.contains('is-hidden'), false);
  assert.equal(harness.element('docCreateBtn').hidden, false);
  assert.equal(harness.element('docCreateBtn').disabled, false);
  assert.equal(harness.element('docTitle').textContent, '新的世界');
  assert.match(harness.element('docContent').textContent, /新建文档/);
  await harness.runtime.enterCreateMode();
  assert.equal(harness.state.isCreating, true);
  harness.runtime.exitEditMode({ skipUnsavedConfirm: true });
  assert.equal(harness.state.isCreating, false);
  assert.equal(harness.element('docCreateBtn').hidden, false);
  harness.state.mode = 'browse';
  harness.runtime.updateEmptyProject();
  assert.equal(harness.element('docEditPanel').classList.contains('is-hidden'), true);
});

test('project category tabs, counts and searches follow custom types without old game categories', async () => {
  const tabs = new Element();
  globalThis.location = { href: 'http://127.0.0.1/web/' };
  globalThis.document = { getElementById: (id) => id === 'categoryTabs' ? tabs : null, createElement: (tag) => new Element(tag) };
  const { appState } = await import('../../web/modules/app-state.js');
  const { renderTabs, getTabCounts, getVisibleDocs } = await import('../../web/modules/app-helpers.js');
  appState.workspace = projectDefinition({ version: 3, documentTypes: [...PROJECT_DEFAULTS.documentTypes, species] });
  appState.docs = ['character', 'story', 'species'].map((category) => ({ category, path: category, id: category, owners: [], _searchText: '相遇' }));
  const counts = getTabCounts();
  assert.equal(counts.all, 3);
  assert.equal(counts['type:species'], 1);
  assert.equal(counts['type:character'], 1);
  assert.equal(counts.item, undefined);
  renderTabs();
  assert.deepEqual(tabs.children.map((node) => node.textContent), ['全部（3）', '档案（0）', '角色（1）', '故事（1）', '地点（0）', '组织（0）', '设定（0）', '种族（1）']);
  for (const keyword of ['', '相遇']) assert.deepEqual(getVisibleDocs(appState.docs, keyword, 'type:species').map((doc) => doc.category), ['species']);
});
