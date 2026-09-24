import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as yaml } from 'yaml';
import { createDocumentFieldDraft, prepareDocumentFields } from '../lib/document-field-draft.mjs';
import { serializeFieldDraft, fieldValueValid } from '../../web/modules/app-field-draft.js';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry } from '../lib/workspace.mjs';

const modelFor = (source, extension = 'md', definition = {}) => createDocumentFieldDraft(source, `design-data/字段.${extension}`, definition);
const update = (source, model, changes) => serializeFieldDraft(source, model, model.fields.map((field, index) => changes[index] ?? field.value));

test('field spans follow the real text parser, preserving duplicates, empty values, prose, code and tables', () => {
  const source = '\uFEFF# 属性\r\n\r\n## 基础\r\n生命： 100  \r\n名称 : 小春\n名称：旅人\r\n空值：   \r\n\r\n```text\r\n不应出现：1\r\n```\r\n\r\n| 键 | 值 |\r\n| --- | --- |\r\n| 不应出现：2 | x |\r\n\r\n这是故事原文。  \r\n';
  const model = modelFor(source, 'txt', { fieldGroups: [{ title: '标识', fields: ['名称'] }] });
  assert.deepEqual(model.fields.map(f => [f.key, f.value, f.group]), [['生命', '100', '基础'], ['名称', '小春', '标识'], ['名称', '旅人', '标识'], ['空值', '', '基础']]);
  assert.equal(update(source, model, {}), source);
  assert.equal(update(source, model, { 0: '125', 2: '旅人・改', 3: '有值' }), source.replace('100', '125').replace('旅人', '旅人・改').replace('空值：   ', '空值：   有值'));
});

test('field extraction respects prose allowlists and legacy multiline boundaries without inventing metadata', () => {
  const source = '# 故事\n\n作者：小春\n\n旅人：你好。\n老师：明天见。\n';
  const descriptor = { parserProfile: 'prose', parserOptions: { allowedFieldKeys: ['作者'] } };
  assert.deepEqual(modelFor(source, 'md', descriptor).fields.map(f => f.key), ['作者']);
  const legacy = '英雄名：测试\r\n技能1：介绍\r\n冷却：10\r\n基础移动速度：300\r\n';
  const model = modelFor(legacy, 'txt', { parserProfile: 'legacy-hero' });
  assert.deepEqual(model.fields.map(f => f.key), ['英雄名', '技能1', '基础移动速度']);
  const result = update(legacy, model, { 1: '更新介绍\n冷却：12' });
  assert.equal(result, legacy.replace('介绍\r\n冷却：10', '更新介绍\r\n冷却：12'));
  assert.equal(parseSourceContent(result, 'hero.txt', { parserProfile: 'legacy-hero' }).fields.技能1, '更新介绍\n冷却：12');
});

test('compound text attributes expose the same individual values as the reader while retaining signs, units and spacing', () => {
  const source = '属性： +15% 技能伤害\r\n  +350 魔法上限\r\n  +20 移动速度\r\n\r\n正文不变。\r\n';
  const model = modelFor(source);
  assert.deepEqual(model.fields.map(f => [f.group, f.label, f.value]), [['属性', '技能伤害', '+15%'], ['属性', '魔法上限', '+350'], ['属性', '移动速度', '+20']]);
  assert.equal(update(source, model, { 1: '+400' }), source.replace('+350', '+400'));
});

test('JSON field edits preserve escaped keys, precision, duplicate keys, nesting and unrelated bytes', () => {
  const source = '\uFEFF{ "na\\u006de": "小春", "hp": 1, "hp": 2, "id": 900719925474099312345, "stats": {"enabled":false}, "list": ["😀",null] }\r\n';
  const model = modelFor(source, 'json');
  assert.equal(update(source, model, {}), source);
  assert.equal(model.fields[3].value, '900719925474099312345');
  assert.equal(model.omitted, 1);
  const result = update(source, model, { 0: '小春 "🌱"\n次行', 2: '3', 4: 'true' });
  assert.equal(result, source.replace('"小春"', JSON.stringify('小春 "🌱"\n次行')).replace('"hp": 2', '"hp": 3').replace('false', 'true'));
  assert.equal(JSON.parse(result.slice(1)).stats.enabled, true);
});

test('media source fields carry their declared kind without treating unrelated source properties as assets', () => {
  const model = modelFor(JSON.stringify({ audio: { type: 'audio', src: 'asset:voice' },
    gallery: [{ type: 'image', src: 'asset:portrait' }], notes: { type: 'text', src: '原文' } }), 'json');
  assert.deepEqual(model.fields.filter(field => field.label.endsWith('src')).map(field => field.mediaReference), ['audio', 'image', false]);
});

for (const extension of ['yaml', 'yml']) test(`${extension} edits retain comments and untouched scalar syntax; multiline strings cannot swallow following keys`, () => {
  const source = '\uFEFF# 注释\r\nname: 小春 # 原名\r\ncount: 0xFF # 数值\r\ntext: |\r\n  首行\r\n  次行\r\nnext: false\r\nbase: &base { speed: 4 }\r\ncopy: *base\r\nempty: null\r\n';
  const model = modelFor(source, extension);
  assert.equal(update(source, model, {}), source);
  assert.deepEqual(model.fields.map(f => f.key), ['name', 'count', 'text', 'next']);
  assert.equal(model.omitted, 3);
  const result = update(source, model, { 0: 'false: # 仍是文字', 2: '新段落\n\n另一行\n', 3: 'true' });
  assert.match(result, /count: 0xFF # 数值\r\n/);
  assert.ok(result.endsWith('base: &base { speed: 4 }\r\ncopy: *base\r\nempty: null\r\n'));
  const parsed = yaml(result);
  assert.equal(parsed.name, 'false: # 仍是文字'); assert.equal(parsed.text, '新段落\n\n另一行\n'); assert.equal(parsed.next, true);
});

test('multiline text edits use document line endings even when the original value was a single line', () => {
  const source = '# 标题\r\n\r\n说明：原值\r\n\r\n备注：保留\n';
  assert.equal(update(source, modelFor(source), { 0: '改动\n第二行' }), source.replace('原值', '改动\r\n第二行'));
});

test('invalid structured syntax is refused; numeric editing keeps partial values available but invalid', () => {
  for (const [format, content] of [['json', '{"x":'], ['json', '{x: 1}'], ['yaml', 'x: ['], ['yaml', 'x: 1\nx: 2']]) {
    assert.throws(() => modelFor(content, format), error => error.statusCode === 400);
  }
  for (const value of ['-', '', '1x', 'NaN', '0x1', '01']) assert.equal(fieldValueValid({ kind: 'number', value: '1' }, value), false);
  for (const value of ['-2', '0', '0.5', '1e3', '900719925474099312345']) assert.equal(fieldValueValid({ kind: 'number', value: '1' }, value), true);
});

test('field API parses the current unsaved draft with registered type rules and never writes files or metadata', async t => {
  const root = await fixture(t), sourcePath = 'design-data/字段.md', original = '# 角色\n\n生命：100\n';
  await write(root, sourcePath, original); await registerWorkspace(root);
  const registry = await readRegistry(root), base = await serve(t, root);
  const result = await request(base, '/api/doc/fields', { sourcePath, content: original.replace('100', '175') });
  assert.equal(result.status, 200); assert.equal(result.data.fields[0].value, '175');
  for (const payload of [null, {}, { sourcePath: '../private.md', content: original }, { sourcePath: 'design-data/x.json', content: '{' }]) {
    assert.equal((await request(base, '/api/doc/fields', payload)).status, 400);
  }
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), original);
  assert.deepEqual(await readRegistry(root), registry);
  await assert.rejects(prepareDocumentFields(root, null), error => error.statusCode === 400);
});

test('field API requires the same authorization as other draft-processing endpoints', async t => {
  const root = await fixture(t); await registerWorkspace(root);
  const base = await serve(t, root, { DOC_API_REQUIRE_WRITE_AUTH: '1', DOC_API_TOKEN: 'field-test-token' });
  const body = { sourcePath: 'design-data/new.md', content: '生命：10' };
  assert.equal((await request(base, '/api/doc/fields', body)).status, 401);
  const response = await fetch(base + '/api/doc/fields', { method: 'POST', headers: { Authorization: 'Bearer field-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
});
