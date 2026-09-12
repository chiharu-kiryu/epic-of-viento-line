import test from 'node:test';
import assert from 'node:assert/strict';
import { Element, editorHarness } from './editor-harness.mjs';
import { parseTextContent } from '../standardize-docs/parser.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';

globalThis.location = { href: 'http://127.0.0.1/web/', origin: 'http://127.0.0.1' };
globalThis.document = {
  getElementById: () => null,
  createElement: (tag) => new Element(tag),
  createDocumentFragment: () => new Element('fragment'),
};
const { normalizeValue, toDisplayValue, createDocButton, getDocListButtonMeta, resolveImageUrl } = await import('../../web/modules/app-helpers.js');
const { renderStructuredBlocks, hasRenderableToken } = await import('../../web/modules/app-structured.js');
const { readOrderedPairs, createNarrativeSection, getHeroCardsByCategory, renderItemTemplate } = await import('../../web/modules/app-render.js');

function itemMetrics(fields) {
  const doc = { category: 'item', fields, sections: [] };
  const cards = renderItemTemplate(doc);
  const card = cards.find((node) => node.classList.contains('metrics-card'));
  const rows = card.querySelectorAll('.metric-item').map((row) => [
    row.querySelector('.metric-item-label').textContent,
    row.querySelector('.metric-item-value').textContent,
  ]);
  return { rows, card, cards, doc };
}

test('item cards split source attribute lines into named values without changing the source fields', () => {
  const source = '邪魔匕首\n\n属性：\n+15% 技能伤害\n+350 魔法上限\n+20 移动速度\n\n价格：4000\n';
  const parsed = parseTextContent(source, 'design-data/design-item/邪魔匕首');
  const original = JSON.stringify(parsed.fields);
  const { rows, card, cards, doc } = itemMetrics(parsed.fields);
  assert.deepEqual(rows, [['价格', '4000'], ['技能伤害', '+15%'], ['魔法上限', '+350'], ['移动速度', '+20']]);
  assert.equal(card.querySelectorAll('.metric-item-meter').length, 0, 'unrelated units are not compared as progress');
  assert.ok(!cards.filter((node) => node !== card).some((node) => node.textContent.includes('+350')));
  assert.ok(doc._contentDedupeKeys.has('属性'));
  assert.equal(JSON.stringify(parsed.fields), original);
});

test('item attribute aliases preserve reductions, formulas, qualifiers and unstructured notes', () => {
  for (const key of ['属性', '属性加成', '属性加值', '加成']) {
    const { rows } = itemMetrics({ [key]: '-15% 冷却时间\r\n+55 移动速度（不可叠加）\n+10%+向下取整(等级/3)% 经验获取\n多个格挡装备仅取最高数值' });
    assert.deepEqual(rows, [['冷却时间', '-15%'], ['移动速度（不可叠加）', '+55'], ['经验获取', '+10%+向下取整(等级/3)%'], ['属性加成', '多个格挡装备仅取最高数值']]);
  }
});

test('item attributes support structured fields and complementary alias blocks without losing zero', () => {
  const { rows } = itemMetrics({
    属性: ['- 技能伤害：+15%', '+350 魔法上限', '移动速度 +20'],
    属性加值: { 护甲: 0, 魔抗: '-5%' },
    属性加成: '+350 魔法上限\n+15 攻击力',
  });
  assert.equal(rows.filter(([key, value]) => key === '魔法上限' && value === '+350').length, 1);
  for (const expected of [['技能伤害', '+15%'], ['移动速度', '+20'], ['护甲', '0'], ['魔抗', '-5%'], ['攻击力', '+15']]) {
    assert.ok(rows.some((row) => row[0] === expected[0] && row[1] === expected[1]), JSON.stringify(expected));
  }
});

test('table display keeps empty and placeholder cells in their original columns', () => {
  const rendered = renderStructuredBlocks([{ type: 'table', header: ['名称', '', '值'], rows: [['A', '-', 0], ['B', null, false]], align: ['left', 'center', 'right'] }]);
  assert.deepEqual(rendered.querySelectorAll('th').map((cell) => cell.textContent), ['名称', '', '值']);
  assert.deepEqual(rendered.querySelectorAll('td').map((cell) => cell.textContent), ['A', '-', '0', 'B', '', 'false']);
  assert.equal(rendered.querySelectorAll('td')[2].style.textAlign, 'right');
});

test('document and image path conversion preserves full-width filename characters and local images resolve', () => {
  const path = 'backstory/故事/第一幕分章/032-第一势力：天界与月律团.md';
  const doc = { path, category: 'backstory', name: '第一势力：天界与月律团', source: { path, extension: '.md' } };
  const button = createDocButton(doc);
  assert.equal(button.dataset.pathKey, path);
  assert.equal(getDocListButtonMeta(path).normalizedPath, path);
  const image = 'assets/images/scene/场景：Ⅰ.png';
  assert.equal(decodeURIComponent(new URL(resolveImageUrl(image)).pathname), `/${image}`);
  for (const unsafe of ['https://example.com/a.png', 'javascript:alert(1)', 'assets/../secret.png']) assert.equal(resolveImageUrl(unsafe), '');
});

test('image URLs treat registered filenames as literal paths, including hashes and percent signs', () => {
  for (const image of ['assets/portrait#1.png', 'assets/images/100%20.png', 'assets/concept/空 格.png']) {
    const url = new URL(resolveImageUrl(image));
    assert.equal(url.hash, '');
    assert.equal(decodeURIComponent(url.pathname), `/${image}`);
  }
  const id = '13a00de1-4aa0-4b4e-81be-08b9a1045346';
  assert.equal(new URL(resolveImageUrl(`/asset-files/${id}`)).pathname, `/asset-files/${id}`);
});

test('metadata conversion preserves zero, false and nested object arrays and finds nonempty aliases', () => {
  assert.equal(normalizeValue(0), '0');
  assert.equal(normalizeValue(false), 'false');
  const value = toDisplayValue([{ name: '节点', enabled: false }, 0]);
  assert.match(value, /"name": "节点"/);
  assert.match(value, /"enabled": false/);
  assert.ok(!value.includes('[object Object]'));
  const rows = readOrderedPairs({ 价格: '', 售价: 0 }, [{ label: '价格', keys: ['价格', '售价'] }]);
  assert.deepEqual(rows, [['价格', 0]]);
  for (const value of [false, 0, null, [0, false, { x: 1 }]]) {
    const rendered = renderStructuredBlocks([{ type: 'json', value }]);
    assert.equal(rendered.querySelector('pre').textContent, JSON.stringify(value, null, 2));
  }
});

test('prose punctuation, repeated paragraphs, list entries and headings survive rendering in order', () => {
  const paragraphs = ['不。', '不？', '不。', '无'];
  const blocks = paragraphs.map((text) => ({ type: 'paragraph', text }));
  blocks.push({ type: 'list', items: ['A', 'A', '-'] }, { type: 'heading', title: '第二节', anchor: '#second' }, { type: 'heading', title: '第二节', anchor: '#second-2' });
  const rendered = renderStructuredBlocks(blocks);
  assert.deepEqual(rendered.querySelectorAll('p').map((node) => node.textContent), paragraphs);
  assert.deepEqual(rendered.querySelectorAll('li').map((node) => node.textContent), ['A', 'A', '-']);
  assert.deepEqual(rendered.querySelectorAll('h1').map((node) => node.id), ['second', 'second-2']);
  assert.deepEqual(createNarrativeSection('正文', paragraphs).querySelectorAll('li').map((node) => node.textContent), paragraphs);
});

test('story previews include dialogue and rules retain tables outside metadata cards', () => {
  const story = parseSourceContent('# 章节\n\n他问：“你是谁？”\n\n她答：“不知道。”', 'design-data/backstory/故事/第一幕分章/001.md');
  const doc = { ...story, category: 'backstory', meta: {} };
  getHeroCardsByCategory(doc);
  assert.equal(doc._contentRenderMode, 'hybrid');
  const rendered = renderStructuredBlocks(doc.blocks, { dedupeKeys: doc._contentDedupeKeys, renderMode: doc._contentRenderMode });
  assert.match(rendered.textContent, /他问：“你是谁？”/);
  assert.match(rendered.textContent, /她答：“不知道。”/);
  for (const category of ['rule', 'scene']) {
    const rowDoc = { category, fields: {}, sections: [], blocks: [{ type: 'table', header: ['A', 'B'], rows: [['1', '2']] }] };
    getHeroCardsByCategory(rowDoc);
    assert.ok(renderStructuredBlocks(rowDoc.blocks, { renderMode: rowDoc._contentRenderMode }).querySelector('table'));
  }
});

test('the editor uses the complete JSON source path and preserves empty source and real fallback newlines', async () => {
  const { runtime } = await editorHarness({ toDisplayValue });
  assert.equal(runtime.getSourcePath({ meta: { source: 'design-data/table' }, source: { path: 'design-data/table.json' } }), 'design-data/table.json');
  assert.equal(runtime.getEditableFallbackContent({ content: '', sections: [{ key: '价格', value: 2 }] }), '');
  assert.equal(runtime.getEditableFallbackContent({ sections: [{ key: '价格', value: 0 }, { key: '可用', value: false }] }), '价格: 0\n\n可用: false');
  const skill = runtime.parseHeroSkillHeaderFromLines('铸魔', ['描述：增加范围', '施法距离：800']);
  assert.equal(skill.name, '铸魔');
  assert.equal(skill.description, '增加范围\n施法距离：800');
});

test('runtime content rendering suppresses only fields that were actually displayed in cards', async () => {
  const { runtime, element } = await editorHarness({ toDisplayValue, renderStructuredBlocks, hasRenderableToken });
  const doc = {
    path: 'unit/例子', category: 'unit', fields: { _header: '例子', 已显示: '1', 补充: '2' },
    blocks: [{ type: 'kv', key: '已显示', value: '1' }, { type: 'kv', key: '补充', value: '2' }],
    _contentDedupeKeys: new Set(['已显示']),
  };
  runtime.renderActualContent(doc);
  const content = element('docContent');
  assert.match(content.textContent, /补充2/);
  assert.ok(!content.textContent.includes('已显示'));
});
