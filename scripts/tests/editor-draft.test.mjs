import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlockDraft, serializeBlockDraft, serializeSourceDraft } from '../../web/modules/app-editor-draft.js';

const markdown = '# 标题\n\n说明：原文\n\n保留两个空格。  \n换行。\n\n```js\nconst x = 1;\n\nconsole.log(x);\n```\n\n| 项 | 值 |\n| :--- | ---: |\n| A | 1 |\n';

test('source drafting restores browser-normalized newlines and preserves untouched mixed-ending lines', () => {
  for (const original of ['', '\uFEFF标题\r\n\r\n正文  \r\n', '首行\r\n次行\n末行\r', '无末尾换行']) {
    assert.equal(serializeSourceDraft(original, original.replace(/\r\n|\r/g, '\n')), original);
  }
  assert.equal(serializeSourceDraft('首行\r\n次行\n末行\r', '首行\n改动\n末行\n'), '首行\r\n改动\r\n末行\r');
  assert.equal(serializeSourceDraft('首行\r\n末行\r\n', '首行\n新增\n末行\n'), '首行\r\n新增\r\n末行\r\n');
  assert.equal(serializeSourceDraft('删除\r\n', ''), '');
  assert.equal(serializeSourceDraft('', '新增\n'), '新增\n');
});

test('block mode round trips source exactly, including whitespace, fences and table alignment', () => {
  for (const source of [markdown, markdown.replaceAll('\n', '\r\n'), '', '\n\n', ' \r\n\t\r\n', '无末尾换行', '{\n  "value": 0\n}\n']) {
    assert.equal(serializeBlockDraft(createBlockDraft(source)), source);
  }
  const draft = createBlockDraft(markdown);
  assert.equal(draft.blocks.filter((block) => block.type === 'code').length, 1);
  assert.match(draft.blocks.find((block) => block.type === 'code').value, /\n\nconsole/);
});

test('editing a block changes only that source span and preserves original line endings', () => {
  const source = markdown.replaceAll('\n', '\r\n');
  const draft = createBlockDraft(source);
  const values = draft.blocks.map((block) => block.value);
  const index = values.indexOf('说明：原文');
  assert.ok(index >= 0);
  values[index] = '说明：改动\n追加一行';
  assert.equal(serializeBlockDraft(draft, values), source.replace('说明：原文', '说明：改动\r\n追加一行'));
});

test('tilde and nested backtick fences keep blank lines inside one editable block', () => {
  for (const source of ['~~~text\n\nabc\n\n~~~\n', '````md\n```js\n\ncode\n```\n````\n']) {
    const draft = createBlockDraft(source);
    assert.equal(draft.blocks.length, 1);
    assert.equal(serializeBlockDraft(draft), source);
  }
});
