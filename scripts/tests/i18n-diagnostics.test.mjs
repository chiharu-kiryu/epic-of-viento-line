import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, serve, request } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry } from '../lib/workspace.mjs';
import { userMessage, userMessageText } from '../lib/user-message.mjs';
import { t as tr, applyLanguage, translateMessage, asUiMessage, uiMessage, onLanguageChange } from '../../web/i18n/index.js';
import { translateDiagnostic } from '../../web/i18n/diagnostics.js';
import { fetchJsonApiRequest } from '../../web/modules/app-services.js';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { serializeSourceDraft } from '../../web/modules/app-editor-draft.js';

test('nested interface diagnostics switch language while paths, punctuation and UI-like authored names stay literal', t => {
  t.after(() => applyLanguage('zh-CN'));
  const file = 'documents/保存 {0} Ａ <b>原文</b>.md';
  const descriptor = userMessage`文件或素材缺失，无法完整导出：${file}`;
  assert.equal(userMessageText(descriptor), `文件或素材缺失，无法完整导出：${file}`);
  applyLanguage('en');
  const diagnostic = translateDiagnostic(descriptor);
  const status = tr`导出失败：${asUiMessage(diagnostic)}`;
  assert.equal(status, `Export failed: A file or media item is missing, so the export cannot be completed: ${file}`);
  applyLanguage('ja');
  assert.equal(translateMessage(status), `書き出しに失敗しました：ファイルまたは素材が見つからないため、完全に書き出せません：${file}`);
  // A name that equals an interface message is not itself a nested message.
  assert.equal(tr('已保存到 {0}', '保存'), '保存先：保存');
  assert.equal(tr('已保存到 {0}', uiMessage('保存')), '保存先：保存');
  applyLanguage('en');
  assert.equal(tr('已保存到 {0}', '保存'), 'Saved to 保存');
  assert.equal(tr('已保存到 {0}', uiMessage('保存')), 'Saved to Save');
});

test('message tracking does not confuse fullwidth or whitespace-distinct authored filenames', t => {
  t.after(() => applyLanguage('zh-CN'));
  const names = ['Ａ.md', 'A.md', 'trailing ', 'trailing'];
  const messages = names.map(name => tr('已保存到 {0}', name));
  applyLanguage('en');
  assert.deepEqual(messages.map(translateMessage), names.map(name => `Saved to ${name}`));
});

test('invalid or unknown diagnostic descriptors fall back to literal diagnostics without interpreting parameters', t => {
  t.after(() => applyLanguage('zh-CN')); applyLanguage('en');
  for (const value of [null, { key: 'constructor', values: [] }, { key: '模板文件缺失', values: [{}] },
    { key: '模板文件缺失', values: 'not-an-array' }, { key: 'an unknown key', values: [] }]) {
    assert.equal(translateDiagnostic(value, 'raw: 保存 {0}'), 'raw: 保存 {0}');
  }
  assert.equal(translateDiagnostic(null, '模板文件缺失'), 'Template file is missing');
});

test('HTTP template, field and export failures provide translated reasons without changing project data', async t => {
  t.after(() => applyLanguage('zh-CN'));
  const root = await fixture(t);
  const type = { id: 'document', label: '保存 {0} Ａ', directory: 'records', parserProfile: 'structured', template: 'missing.md' };
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '翻译测试', createdAt: 1,
    paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: [type] }));
  const sourcePath = 'documents/records/原文.md', content = '\uFEFF# 内容\r\n\r\n保存：文字\r\n';
  await write(root, sourcePath, content); await registerWorkspace(root);
  const before = await readRegistry(root), manifest = await fs.readFile(path.join(root, 'workspace.json'));
  const base = await serve(t, root);
  const configuration = (await request(base, '/api/project')).data;
  assert.equal(configuration.warningMessages[0].values[0], type.label);
  const h = await dialogHarness('app-project-settings', { serializeSourceDraft, renderDocumentLayout: () => [], requestProject: async () => configuration,
    onLanguageChange: callback => { const stop = onLanguageChange(callback); t.after(stop); return stop; } });
  h.runtime.setupProjectSettings({ getContext: () => ({ editable: true, workspace: { configurable: true } }), applied() {}, setBusy() {} });
  applyLanguage('en'); h.element('projectSettingsBtn').click(); await flushDialogs();
  assert.equal(h.element('projectSettingsMessage').textContent, `The template for “${type.label}” is unavailable: Template file is missing`);
  const input = h.element('projectTemplateContent'); input.value = '# 我的草稿'; input.selectionStart = 2; input.selectionEnd = 4; input.focus();
  applyLanguage('ja');
  assert.equal(h.element('projectSettingsMessage').textContent, `「${type.label}」のテンプレートを利用できません：テンプレートファイルが見つかりません`);
  assert.equal(input.value, '# 我的草稿'); assert.equal(h.document.activeElement, input); assert.equal(input.selectionStart, 2);
  const failures = [
    ['/api/project/preview', { type: { ...type, fieldGroups: [{ title: '原文', fields: ['hp', 'hp'] }] }, content: 'hp: 1', format: 'yaml' }, '分组字段无效或重复'],
    ['/api/doc/fields', { sourcePath: 'documents/invalid.json', content: '{' }, '请先在源码中修正 JSON 语法，再编辑字段。'],
    ['/api/export', { kind: 'document', format: 'html', path: 'documents/records/保存 {0} Ａ.md' }, '文件或素材缺失，无法完整导出：{0}'],
  ];
  for (const [route, payload, key] of failures) {
    applyLanguage('en');
    let failure;
    try { await fetchJsonApiRequest(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 5000, tr('请求')); }
    catch (error) { failure = error; }
    assert.ok(failure); assert.equal(failure.status, 400); assert.equal(failure.payload.userMessage.key, key);
    assert.equal(failure.message, tr('{0}失败（{1}）', uiMessage('请求'), uiMessage('{0}：{1}', 400,
      uiMessage(key, ...failure.payload.userMessage.values))));
    const english = failure.message;
    applyLanguage('ja');
    assert.equal(translateMessage(english), tr('{0}失败（{1}）', uiMessage('请求'), uiMessage('{0}：{1}', 400,
      uiMessage(key, ...failure.payload.userMessage.values))));
  }
  assert.deepEqual(await readRegistry(root), before);
  assert.deepEqual(await fs.readFile(path.join(root, 'workspace.json')), manifest);
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), content);
});
