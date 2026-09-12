import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextContent, parseYamlContent, parseJsonContent } from '../standardize-docs/parser.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { collectHeroSkillsFromSections } from '../build-static-hero-skills.mjs';

const text = (raw, file = 'design-data/design-rules/规则.md') => parseTextContent(raw, file);

test('Markdown titles, skipped heading levels and repeated headings retain a consistent outline', () => {
  const parsed = text('\uFEFF# 标题 #\r\n### 三级\r\n### 三级\r\n## 二级\r\n#### 四级\r\n## 二级');
  assert.equal(parsed.title, '标题');
  assert.equal(parsed.fields._header, '标题');
  assert.equal(parsed.blocks.filter((block) => block.type === 'heading').length, 6);
  const root = parsed.outline[0];
  assert.deepEqual(root.children.map((node) => node.level), [3, 3, 2, 2]);
  assert.equal(root.children[2].children[0].level, 4);
  const nodes = (items) => items.flatMap((item) => [item, ...nodes(item.children)]);
  assert.equal(new Set(nodes(parsed.outline).map((node) => node.id)).size, 6);
  assert.deepEqual(parsed.blocks.map((block) => block.anchor), nodes(parsed.outline).map((node) => node.anchor));
});

test('fenced code stays verbatim and cannot create metadata, tables or outline headings', () => {
  for (const fence of ['```', '~~~~']) {
    const code = '价格: 50\n\n# 注释\n| A | B |\n| --- | --- |';
    const parsed = text(`# 标题\n\n${fence}yaml\n${code}\n${fence}\n\n正文。`);
    assert.deepEqual(parsed.fields, { _header: '标题' });
    assert.deepEqual(parsed.blocks.map((block) => block.type), ['heading', 'code', 'paragraph']);
    assert.equal(parsed.blocks[1].value, code);
  }
  assert.equal(text('标题\n\n```\n未关闭\n\n后续').blocks[1].value, '未关闭\n\n后续');
  assert.equal(text('```\n# 仅为注释\n```').profile, 'structured-block');
});

test('tables preserve escaped pipes, empty columns and alignment without repeating their header', () => {
  const parsed = text('# 表\n\n| 名称 | 说明 | 值 |\n| :--- | :---: | ---: |\n| A\\|B | | 0 |\n\n普通 A|B 选项。');
  const table = parsed.blocks.find((block) => block.type === 'table');
  assert.deepEqual(table.header, ['名称', '说明', '值']);
  assert.deepEqual(table.rows, [['A|B', '', '0']]);
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.equal(parsed.blocks.at(-1).text, '普通 A|B 选项。');
  assert.equal(text('标题\n\nhttps://example.com/a#part').fields.https, undefined);
});

test('inline and multiline hero skills retain their description without swallowing hero metadata', () => {
  const parsed = parseSourceContent('英雄\n技能1：烈焰\n描述：灼烧目标\n伤害：10\n技能2：\n名称：冰霜\n伤害：20\n主属性：智力\n\n铸魔：\n描述：增加范围\n施法距离：800', 'design-data/design-heros/智力/英雄');
  assert.equal(parsed.fields.技能1, '烈焰\n描述：灼烧目标\n伤害：10');
  assert.equal(parsed.fields.技能2, '名称：冰霜\n伤害：20');
  assert.equal(parsed.fields.主属性, '智力');
  assert.equal(parsed.fields.伤害, undefined);
  const skills = collectHeroSkillsFromSections(parsed.sections, []);
  assert.equal(skills.find((skill) => skill.key === '技能1').name, '烈焰');
  const rune = skills.find((skill) => skill.key === '铸魔');
  assert.equal(rune.name, '铸魔');
  assert.equal(rune.description, '增加范围\n施法距离：800');
});

test('story dialogue and repeated paragraphs remain body content in their original order', () => {
  const lines = ['他问：“你是谁？”', '她答：“我不知道。”', '不。', '不？', '不。'];
  const parsed = parseSourceContent('# 章节\n\n' + lines.join('\n\n'), 'design-data/backstory/故事/第一幕分章/001.md');
  assert.deepEqual(parsed.fields, { _header: '章节' });
  assert.deepEqual(parsed.blocks.filter((block) => block.type === 'paragraph').map((block) => block.text), lines);
});

test('CR-only sources and metadata labels that resemble object properties are preserved', () => {
  const parsed = text('标题\r价格：0\r备注：第一条\r备注：第二条\r__proto__：原文');
  assert.equal(parsed.fields.价格, '0');
  assert.deepEqual(parsed.fields.备注, ['第一条', '第二条']);
  assert.ok(Object.hasOwn(parsed.fields, '__proto__'));
  assert.equal(JSON.parse(JSON.stringify(parsed.fields)).__proto__, '原文');
  assert.doesNotThrow(() => text('_header：一\n_header：二'));
  const explicitTitle = text('_header：文档名称\n价格：0');
  assert.equal(explicitTitle.title, explicitTitle.blocks[0].title);
  assert.equal(explicitTitle.title, explicitTitle.outline[0].title);
});

test('YAML retains typed values, quotes, hash fragments, nested maps and block scalars consistently', () => {
  const parsed = parseYamlContent('name: "a#b"\nurl: https://example.com/#part\nactive: false\nprice: 0\nitems:\n- one\n- two\nmeta:\n  name: nested\ntext: |\n  第一行\n  第二行\n', 'example.yaml');
  assert.equal(parsed.fields.name, 'a#b');
  assert.equal(parsed.fields.url, 'https://example.com/#part');
  assert.equal(parsed.fields.active, false);
  assert.equal(parsed.fields.price, 0);
  assert.deepEqual(parsed.fields.items, ['one', 'two']);
  assert.deepEqual(parsed.fields.meta, { name: 'nested' });
  assert.equal(parsed.fields.text, '第一行\n第二行\n');
  for (const [key, value] of Object.entries(parsed.fields)) assert.deepEqual(parsed.sections.find((section) => section.key === key).value, value);
  assert.deepEqual(parsed.blocks[0].value, parsed.fields);
});

test('JSON/YAML scalar and array documents keep values and accurate metadata counts', () => {
  for (const raw of ['false', '0', 'null', '[{"value":0},false]']) {
    for (const parse of [parseJsonContent, parseYamlContent]) {
      const parsed = parse(raw, 'data.json');
      assert.deepEqual(parsed.blocks[0].value, JSON.parse(raw));
      assert.equal(parsed.fieldCount, Object.keys(parsed.fields).length);
      assert.equal(parsed.lineCount, 1);
      assert.equal(parsed.blockStats.blockCount, parsed.blocks.length);
    }
  }
  assert.equal(parseJsonContent('\uFEFF{"price":0}', 'data.json').fields.price, 0);
});

test('invalid structured input is clearly marked and retains the entire raw text', () => {
  for (const [parse, raw] of [[parseYamlContent, 'price: 1\nprice: 2'], [parseJsonContent, '{"price":1,}']]) {
    const parsed = parse(raw, 'data.json');
    assert.match(parsed.type, /^invalid-/);
    assert.ok(parsed.parseError);
    assert.equal(parsed.fields.price, undefined);
    assert.equal(parsed.blocks[0].value, raw);
    assert.equal(parsed.blockStats.blockCount, parsed.blocks.length);
  }
});
