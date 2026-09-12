import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node, serve, request } from './helpers.mjs';
import { PROJECT_DEFAULTS, resolveDocumentDefinition, validateProjectTypes } from '../lib/project-layout.mjs';
import { readRegistry, readWorkspace, registerWorkspace } from '../lib/workspace.mjs';
import { readProjectConfiguration, saveProjectTemplate, previewProjectTemplate } from '../lib/project-service.mjs';
import { applyProjectDefinition } from '../lib/project-definition.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { planExport } from '../lib/export-package.mjs';

const type = { id: 'species', label: '自定义种族', directory: 'species', parserProfile: 'structured', parserOptions: { titleField: '名称' }, fieldGroups: [{ title: '生命特征', fields: ['灵魂', '繁衍'] }] };
async function project(t) {
  const root = await fixture(t);
  const manifest = { format: 'viento-workspace', version: 3, id: randomUUID(), name: '独立设定', createdAt: 1, paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: PROJECT_DEFAULTS.documentTypes };
  await write(root, 'workspace.json', JSON.stringify(manifest));
  await fs.mkdir(path.join(root, 'documents'));
  for (const [file, content] of Object.entries(PROJECT_DEFAULTS.templates)) await write(root, `templates/${file}`, content);
  await registerWorkspace(root);
  return root;
}

test('type/template API applies live to creation, indexing and exports at an arbitrary document location', async (t) => {
  const root = await project(t);
  const base = await serve(t, root);
  const config = (await request(base, '/api/project')).data;
  const content = '名称: 星裔\n灵魂: 0\n繁衍: false\n补充: null\n关系:\n  - 朋友: 旅者\n';
  const payload = { revision: config.revision, type, content, format: 'yaml' };
  const preview = await request(base, '/api/project/preview', payload);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.title, '星裔');
  assert.deepEqual(preview.data.layout.sections[0].blocks.map((block) => block.value), [0, false]);
  const saved = await request(base, '/api/project', payload);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.indexWarning, undefined);
  const definition = saved.data.entries.find((entry) => entry.type.id === type.id).type;
  assert.equal(await fs.readFile(path.join(root, 'templates', definition.template), 'utf8'), content);
  const index = await request(base, '/api/index');
  assert.equal(index.data.workspace.documentTypes.at(-1).id, 'species');
  const source = 'documents/elsewhere/不同文件名.yaml';
  assert.equal((await request(base, '/api/doc', { path: source, content, create: true, documentType: type.id })).status, 200);
  assert.equal((await request(base, '/api/rebuild', { source })).status, 200);
  const built = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'))).docs[0];
  assert.equal(built.title, preview.data.title);
  assert.deepEqual(built.layout, preview.data.layout);
  assert.equal(built.group, type.label);
  const portable = await planExport(root, { kind: 'document', format: 'html', path: source });
  const html = portable.entries.find((entry) => entry.path === 'index.html').buffer.toString();
  assert.match(html, /星裔/); assert.match(html, /生命特征/); assert.match(html, /false/); assert.match(html, /null/);
});

test('template edits preserve source and descriptors, reject stale saves, and prune only their own previous revision', async (t) => {
  const root = await project(t);
  await write(root, 'documents/original.md', '# 已有正文\n\n仍然保留。\n');
  await registerWorkspace(root);
  const before = await readRegistry(root);
  const bytes = await fs.readFile(path.join(root, before.documents[0].sourcePath));
  const original = await readProjectConfiguration(root);
  const first = await saveProjectTemplate(root, { revision: original.revision, type, format: 'md', content: '# 起点\n' });
  const firstPath = first.entries.at(-1).type.template;
  await assert.rejects(saveProjectTemplate(root, { revision: original.revision, type, format: 'md', content: '过时编辑' }), { statusCode: 409 });
  const second = await saveProjectTemplate(root, { revision: first.revision, type, format: 'md', content: '# 下一版\n' });
  await assert.rejects(fs.stat(path.join(root, 'templates', firstPath)), { code: 'ENOENT' });
  assert.deepEqual(await readRegistry(root), before);
  assert.deepEqual(await fs.readFile(path.join(root, before.documents[0].sourcePath)), bytes);
  const character = path.join(root, 'templates/character.md');
  await fs.appendFile(character, '\n外部编辑');
  await assert.rejects(saveProjectTemplate(root, { revision: second.revision, type, format: 'md', content: '不能覆盖' }), { statusCode: 409 });
  assert.match(await fs.readFile(character, 'utf8'), /外部编辑/);
});

test('malformed templates and escaping configuration cannot publish changes', async (t) => {
  const root = await project(t);
  const config = await readProjectConfiguration(root);
  const manifest = await fs.readFile(path.join(root, 'workspace.json'));
  for (const patch of [{ content: '{bad', format: 'json' }, { type: { ...type, template: '../outside.md' } },
    { type: { ...type, parserOptions: { arbitraryCode: 'exec' } } },
    { type: { ...type, fieldGroups: [{ title: 'A', fields: ['x'] }, { title: 'B', fields: ['x'] }] } }]) {
    await assert.rejects(saveProjectTemplate(root, { revision: config.revision, type, content: '# 起点', format: 'md', ...patch }));
    assert.deepEqual(await fs.readFile(path.join(root, 'workspace.json')), manifest);
  }
  await fs.symlink(path.join(root, 'documents'), path.join(root, 'templates/types'));
  await assert.rejects(saveProjectTemplate(root, { revision: config.revision, type, content: '# 起点', format: 'md' }));
  assert.deepEqual(await fs.readdir(path.join(root, 'documents')), []);
});

test('project rules replace historical notation and path guesses in the same parser', () => {
  const rules = { ...type, parserProfile: 'prose', parserOptions: { allowedFieldKeys: ['称呼'], multilineFieldKeys: [], boundaryFieldKeys: [] }, fieldGroups: [] };
  const manifest = { version: 3, documentTypes: [rules] };
  const source = '# 相遇\n\n他问：你是谁？\n\n称呼：旅者\n';
  const record = { documentType: type.id, parserProfile: 'legacy-hero' };
  const parsed = ['documents/elsewhere/a.md', 'design-data/design-heros/力量/a.md'].map((file) => parseSourceContent(source, file, resolveDocumentDefinition(manifest, file, record)));
  assert.deepEqual(parsed[0], parsed[1]);
  assert.equal(parsed[0].fields.他问, undefined);
  assert.equal(parsed[0].fields.称呼, '旅者');
  assert.match(JSON.stringify(parsed[0].blocks), /他问：你是谁？/);
  assert.deepEqual(buildDocumentLayout(parseSourceContent('{"名称":0,"灵魂":false,"额外":null}', 'a.json', type)).sections.flatMap((section) => section.blocks).map((block) => block.value), [false, 0, null]);
});

test('official example is an independent definition; adoption preserves IDs, sources, ownership and original templates', async (t) => {
  const root = await fixture(t);
  await write(root, 'design-data/design-heros/力量/旅者.md', '# 旅者\n\n技能1：光\n描述：照亮\n');
  await write(root, 'design-data/backstory/力量/旅者.md', '# 过去\n\n他说：你好。');
  await registerWorkspace(root);
  const definition = JSON.parse(await fs.readFile(new URL('../../docs/examples/epic-of-viento-line.project.json', import.meta.url)));
  const before = await readRegistry(root);
  const template = await fs.readFile(path.join(root, 'data-template/design-heros/模板-英雄'));
  assert.equal((await applyProjectDefinition(root, definition)).write, false);
  assert.equal(readWorkspace(root).documentTypes, undefined);
  const result = await applyProjectDefinition(root, definition, { write: true });
  assert.equal(result.changed, true);
  assert.ok(result.journal);
  assert.deepEqual(await readRegistry(root), before);
  assert.deepEqual(await fs.readFile(path.join(root, 'data-template/design-heros/模板-英雄')), template);
  assert.equal((await applyProjectDefinition(root, definition, { write: true })).changed, false);
  await node(root, ['scripts/standardize-docs.mjs']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json')));
  assert.equal(index.workspace.projectTypes, true);
  assert.equal(index.workspace.example.id, 'epic-of-viento-line');
  assert.equal(index.workspace.documentTypes.find((type) => type.id === 'character').templateSource, 'data-template/design-heros/模板-英雄');
  const incomplete = { ...definition, documentTypes: definition.documentTypes.filter((type) => type.id !== 'character') };
  await assert.rejects(applyProjectDefinition(root, incomplete, { write: true }), /缺少现有文档类型/);
});
