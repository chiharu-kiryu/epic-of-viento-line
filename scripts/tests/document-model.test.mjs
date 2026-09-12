import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, node, serve, request } from './helpers.mjs';
import { parseTextContent, parseJsonContent } from '../standardize-docs/parser.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { legacyDocumentDefaults, planLegacyDocumentModels, validateDocumentModels, attachDocumentHierarchy } from '../lib/document-model.mjs';
import { registerWorkspace, readRegistry, updateDocumentModels } from '../lib/workspace.mjs';
import { Element } from './editor-harness.mjs';

globalThis.location = { href: 'http://127.0.0.1/web/' };
globalThis.document = { getElementById: () => null, createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment') };
const { renderDocumentLayout } = await import('../../web/modules/app-document-layout.js');
const { getHeroDisplayDocs, getTabCounts, getDisplayCategory } = await import('../../web/modules/app-helpers.js');

test('the core parser is independent of paths and game vocabulary; compatibility is explicit', () => {
  const source = '# 角色\n\n技能1：飞行\n描述：离开地面\n灵魂数量：0\n';
  const generic = parseTextContent(source, 'documents/角色.md');
  assert.deepEqual(parseTextContent(source, 'design-data/design-heros/力量/角色'), generic);
  assert.equal(generic.fields.描述, '离开地面');
  assert.equal(generic.fields.灵魂数量, '0');
  assert.deepEqual(parseSourceContent(source, 'design-data/design-heros/力量/角色'), generic);
  const legacy = parseSourceContent(source, 'design-data/design-heros/力量/角色', { parserProfile: 'legacy-hero' });
  assert.match(legacy.fields.技能1, /描述：离开地面/);
  const portable = parseSourceContent(source, 'documents/renamed.md', { parserProfile: 'legacy-hero' });
  assert.deepEqual(portable, legacy);
  assert.deepEqual(parseSourceContent(source, 'design-data/design-heros/力量/角色', { parserProfile: 'structured' }), generic);
  assert.equal(legacyDocumentDefaults('design-data/constructor/角色.md').documentType, 'document');
});

test('arbitrary OC fields and typed nested values render from one layout without category templates', () => {
  const parsed = parseJsonContent('{"灵魂数量":0,"可繁衍":false,"关系":[{"称呼":"朋友","信任":0}],"补充":null}', 'species.json');
  const layout = buildDocumentLayout(parsed);
  const outputs = ['character', 'item', '自定义物种'].map((category) => {
    const doc = { category, layout, fields: parsed.fields };
    const cards = renderDocumentLayout(doc);
    assert.equal(doc._contentRenderMode, 'card-only');
    assert.deepEqual(cards[0].querySelectorAll('.document-field-label').map((node) => node.textContent), ['灵魂数量', '可繁衍', '关系', '称呼', '信任', '补充']);
    assert.deepEqual(cards[0].querySelectorAll('.document-value-text').map((node) => node.textContent), ['0', 'false', '朋友', '0', 'null']);
    return cards.map((card) => card.textContent);
  });
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);
});

test('heading order, repeated prose, tables and multiline bonuses survive the universal layout', () => {
  const parsed = parseSourceContent('# 名称\n\n## 能力\n属性：\n+15% 技能伤害\n+350 魔法上限\n+20 移动速度\n\n## 记录\n\n不。\n\n不。\n\n| A | B |\n| --- | --- |\n| 0 | false |\n', 'documents/test.md');
  const layout = buildDocumentLayout(parsed);
  assert.deepEqual(layout.sections.map((section) => section.title), ['能力', '记录']);
  const cards = renderDocumentLayout({ layout });
  assert.deepEqual(cards[0].querySelectorAll('.document-field-label').map((node) => node.textContent), ['属性', '技能伤害', '魔法上限', '移动速度']);
  assert.deepEqual(cards[1].querySelectorAll('p').map((node) => node.textContent), ['不。', '不。']);
  assert.deepEqual(cards[1].querySelectorAll('td').map((node) => node.textContent), ['0', 'false']);
});

test('ownership supports several parents and custom types; missing owners keep the source visible', () => {
  const parent = { id: randomUUID(), path: 'one', category: '星系', title: '同名' };
  const other = { id: randomUUID(), path: 'two', category: 'character', title: '同名' };
  const child = { id: randomUUID(), path: 'child', category: 'story', relations: [parent, other].map((owner) => ({ kind: 'part-of', targetId: owner.id, slot: '起源' })) };
  attachDocumentHierarchy([parent, other, child]);
  assert.deepEqual(getHeroDisplayDocs([parent, other, child]).map((doc) => doc.path), ['one', 'two']);
  assert.equal(parent.ownedDocuments[0].id, other.ownedDocuments[0].id);
  assert.equal(getTabCounts([parent, other, child]).hero, 1);
  assert.equal(getDisplayCategory(child), 'story');
  attachDocumentHierarchy([child]);
  assert.deepEqual(getHeroDisplayDocs([child]), [child]);
});

test('ambiguous legacy names remain visible and invalid or cyclic ownership is rejected', () => {
  const record = (sourcePath) => ({ id: randomUUID(), sourcePath, assetBindings: [] });
  const first = record('design-data/design-heros/力量/同名');
  const second = record('design-data/design-heros/力量/同名.md');
  const story = record('design-data/backstory/力量/同名.txt');
  const chapter = record('design-data/backstory/故事/第一幕/001.md');
  const plan = planLegacyDocumentModels([first, second, story, chapter]);
  assert.equal(plan.unresolved[0].reason, 'ambiguous-owner');
  assert.deepEqual(plan.documents[2].relations, []);
  assert.deepEqual(plan.documents[3].relations, []);
  assert.throws(() => validateDocumentModels([{ ...first, relations: [{ kind: 'part-of', targetId: first.id }] }]), /循环/);
  assert.throws(() => validateDocumentModels([{ ...first, relations: [{ kind: 'part-of', targetId: randomUUID() }] }]), /无效/);
});

test('descriptor migration, shared-story editing, partial rebuild and relocation preserve identity and ownership', async (t) => {
  const root = await fixture(t);
  const heroA = 'design-data/design-heros/力量/甲';
  const heroB = 'design-data/design-heros/力量/乙';
  const storyA = 'design-data/backstory/力量/甲.txt';
  const shared = 'design-data/backstory/力量/同行.txt';
  const chapter = 'design-data/backstory/故事/第一幕/001.md';
  const originals = { [heroA]: '甲\n姓名：甲\n', [heroB]: '乙\n姓名：乙\n', [storyA]: '# 甲\n\n甲的经历。\n', [shared]: '# 同行\n\n两人共同的经历。\n', [chapter]: '# 第一章\n\n独立章节。\n' };
  for (const [source, raw] of Object.entries(originals)) await write(root, source, raw);
  await registerWorkspace(root, { scanAssets: false });
  const before = (await readRegistry(root)).documents;
  const transform = (records) => planLegacyDocumentModels(records, { [shared]: [heroA, heroB] });
  const preview = await updateDocumentModels(root, transform);
  assert.equal(preview.ownedDocuments, 2);
  assert.deepEqual((await readRegistry(root)).documents, before);
  const applied = await updateDocumentModels(root, transform, { write: true });
  assert.equal(applied.ownershipLinks, 3);
  assert.equal((await updateDocumentModels(root, transform, { write: true })).changed, 0);
  for (const [source, raw] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(root, source), 'utf8'), raw);
  const build = async (directory, source = 'design-data') => {
    await node(directory, ['scripts/standardize-docs.mjs', source]);
    await node(directory, ['scripts/build-static-doc-site.mjs']);
    return JSON.parse(await fs.readFile(path.join(directory, '.viento/cache/indexes/documents.json'), 'utf8')).docs;
  };
  let docs = await build(root);
  const find = (source) => docs.find((doc) => doc.source.path === `docs-standard/${source}`);
  assert.equal(docs.length, 5);
  assert.equal(getHeroDisplayDocs(docs).length, 3);
  assert.equal(find(shared).owners.length, 2);
  assert.equal(find(chapter).owners.length, 0);
  assert.equal(find(heroA).category, 'character');
  assert.equal(find(heroA).layout.schemaVersion, 'viento-layout-v1');
  const base = await serve(t, root);
  const read = await request(base, `/api/doc?path=${encodeURIComponent(find(shared).source.path)}`);
  const changed = originals[shared] + '\n新的共同经历。\n';
  const saved = await request(base, '/api/doc', { path: find(shared).source.path, content: changed, expectedVersion: read.data.version });
  assert.equal(saved.status, 200);
  docs = await build(root, shared);
  assert.equal(find(shared).content, changed);
  assert.equal(find(shared).owners.length, 2);
  assert.equal(find(heroA).content, originals[heroA]);
  const relocated = await fixture(t);
  for (const entry of ['workspace.json', 'metadata', 'design-data', '.viento/workspace.json']) {
    await fs.mkdir(path.dirname(path.join(relocated, entry)), { recursive: true });
    await fs.cp(path.join(root, entry), path.join(relocated, entry), { recursive: true });
  }
  const restored = await build(relocated);
  assert.deepEqual(restored.map((doc) => [doc.id, doc.relations]).sort(), docs.map((doc) => [doc.id, doc.relations]).sort());
  assert.equal(restored.find((doc) => doc.id === find(shared).id).owners.length, 2);
});
