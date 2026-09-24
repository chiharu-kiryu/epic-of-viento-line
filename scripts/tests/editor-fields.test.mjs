import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentFieldDraft } from '../lib/document-field-draft.mjs';
import { editorHarness, deferred } from './editor-harness.mjs';
import { dialogHarness } from './dialog-harness.mjs';
import { applyLanguage } from '../../web/i18n/index.js';
import { createFieldEditor } from '../../web/modules/app-field-editor.js';

const original = '\uFEFF# 属性\r\n\r\n## 基础\r\n生命： 100  \r\n开关：true\r\n姓名：小春\r\n\r\n故事原文。  \r\n';
async function setup(overrides = {}) {
  const ui = await dialogHarness('app-services'), writes = [];
  const h = await editorHarness({ document: ui.document, window: ui.runtime.window,
    readDocSource: async () => ({ content: original, version: '1' }),
    loadDocumentFields: async (content, sourcePath) => createDocumentFieldDraft(content, sourcePath),
    writeDoc: async request => { writes.push(request); return { version: '2' }; }, ...overrides });
  h.doc._sourceCachedText = original; h.runtime.rebuildIndexForDoc = async () => {};
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  const source = ui.element('docSourceEditor');
  await h.runtime.enterEditMode();
  return { ...h, document: ui.document, element: ui.element, source, writes, fields: () => ui.element('docFieldEditor').querySelectorAll('.doc-field-input') };
}

test('fields, blocks and source share a lossless draft; saving twice retains only intended changes and advances the lock', async () => {
  const h = await setup();
  await h.runtime.enterFieldEditMode();
  assert.equal(h.state.editInputMode, 'fields'); assert.equal(h.runtime.getCurrentEditContent(), original);
  h.fields()[0].value = '150'; h.fields()[0].dispatch('input');
  h.fields()[1].value = 'false'; h.fields()[1].dispatch('change');
  const expected = original.replace('100', '150').replace('true', 'false');
  assert.equal(h.state.editHasUnsavedChanges, true);
  h.runtime.setEditInputMode('blocks'); assert.equal(h.runtime.getCurrentEditContent(), expected);
  h.runtime.setEditInputMode('source'); assert.equal(h.runtime.getCurrentEditContent(), expected);
  await h.runtime.enterFieldEditMode(); await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].content, expected); assert.equal(h.writes[0].expectedVersion, '1');
  assert.equal(h.state.editInputMode, 'fields'); assert.equal(h.state.editHasUnsavedChanges, false);
  h.fields()[0].value = '200'; h.fields()[0].dispatch('input');
  await h.runtime.saveCurrentDoc(); assert.equal(h.writes[1].content, expected.replace('150', '200')); assert.equal(h.writes[1].expectedVersion, '2');
});

test('invalid numeric input stays editable, blocks saving and is focused without losing other field changes', async () => {
  const h = await setup(); await h.runtime.enterFieldEditMode();
  h.fields()[0].value = '-'; h.fields()[0].dispatch('input');
  h.fields()[2].value = '変更'; h.fields()[2].dispatch('input');
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes.length, 0); assert.equal(h.document.activeElement, h.fields()[0]);
  assert.equal(h.fields()[0].getAttribute('aria-invalid'), 'true'); assert.equal(h.fields()[2].value, '変更');
  h.fields()[0].value = '-2'; h.fields()[0].dispatch('input'); await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].content, original.replace('100', '-2').replace('小春', '変更'));
});

test('a failed or cancelled field load leaves the source draft and can be retried; late replies cannot reopen a closed session', async () => {
  const h = await setup({ loadDocumentFields: async () => { throw new Error('离线'); } });
  h.source.value += '未保存'; h.runtime.refreshEditSessionDirtyState(); const draft = h.runtime.getCurrentEditContent();
  await h.runtime.enterFieldEditMode(); assert.equal(h.state.editInputMode, 'source'); assert.equal(h.state.isLoadingFields, false);
  assert.equal(h.runtime.getCurrentEditContent(), draft); assert.match(h.element('docEditStatus').textContent, /离线/);
  const result = deferred(); let signal;
  h.runtime.loadDocumentFields = (...args) => { signal = args[3]; return result.promise; };
  const loading = h.runtime.enterFieldEditMode(); assert.equal(h.state.isLoadingFields, true); assert.equal(h.source.readOnly, true);
  h.runtime.resetDocEditorState(); assert.equal(signal.aborted, true);
  result.resolve(createDocumentFieldDraft(draft, 'design-data/doc.md')); await loading;
  assert.equal(h.state.isEditing, false); assert.equal(h.state.isLoadingFields, false); assert.equal(h.state.editInputMode, 'source');
});

test('new template fields save through the normal create workflow and remain editable after registration', async () => {
  const h = await setup(); h.runtime.loadTemplateContent = async () => original;
  await h.runtime.enterCreateMode();
  h.runtime.replaceMediaDraftSource(original);
  await h.runtime.enterFieldEditMode(); h.fields()[0].value = '220'; h.fields()[0].dispatch('input');
  const path = h.element('docCreatePathInput').value;
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].isCreate, true); assert.equal(h.writes[0].pathValue, path);
  assert.equal(h.writes[0].content, original.replace('100', '220'));
  assert.equal(h.state.isCreating, false); assert.equal(h.state.editInputMode, 'fields');
});

test('field keyboard save ignores IME confirmation and sends one correctly versioned write afterwards', async () => {
  const h = await setup(); await h.runtime.enterFieldEditMode();
  const input = h.fields()[2]; input.value = '日本語'; input.dispatch('input');
  const event = extra => ({ target: input, key: 'Enter', ctrlKey: true, preventDefault() { this.defaultPrevented = true; }, ...extra });
  for (const composing of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) h.runtime.handleWindowKeydown(event(composing));
  assert.equal(h.writes.length, 0);
  h.runtime.handleWindowKeydown(event({})); await new Promise(setImmediate);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].content, original.replace('小春', '日本語'));
});

test('field save conflicts retain dirty values and reloading the latest source does not restore stale field spans', async () => {
  const h = await setup({ writeDoc: async () => { throw Object.assign(new Error('conflict'), { status: 409, payload: { error: 'document was modified by another client', currentVersion: '2' } }); } });
  await h.runtime.enterFieldEditMode(); h.fields()[0].value = '160'; h.fields()[0].dispatch('input');
  h.runtime.openSaveConflictDialog = async () => '2';
  await h.runtime.saveCurrentDoc(); assert.equal(h.fields()[0].value, '160'); assert.equal(h.state.editHasUnsavedChanges, true);
  const latest = original.replace('100', '175');
  h.runtime.openSaveConflictDialog = async () => '1';
  h.runtime.readDocSource = async () => ({ content: latest, version: '2' });
  await h.runtime.saveCurrentDoc();
  assert.equal(h.state.editInputMode, 'source'); assert.equal(h.runtime.getCurrentEditContent(), latest); assert.equal(h.state.editHasUnsavedChanges, false);
});

test('grouped JSON rows retain source identities despite a different visual order', async () => {
  const source = '{"title":"原标题", "stats":{"hp":1}, "notes":"原文"}\n';
  const h = await setup({ readDocSource: async () => ({ content: source, version: '1' }) });
  h.doc.sourcePath = 'design-data/角色.json';
  await h.runtime.enterFieldEditMode();
  assert.deepEqual(h.fields().map(input => input.id), ['docFieldValue-0', 'docFieldValue-2', 'docFieldValue-1']);
  h.element('docFieldValue-1').value = '25'; h.element('docFieldValue-1').dispatch('input');
  h.element('docFieldValue-2').value = '修改后的说明'; h.element('docFieldValue-2').dispatch('input');
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].content, source.replace('"hp":1', '"hp":25').replace('原文', '修改后的说明'));
});

test('field table filters, resets, collapses and switches language without replacing inputs or authored labels', async t => {
  t.after(() => applyLanguage('zh-CN'));
  const ui = await dialogHarness('app-services'); let changes = 0;
  const editor = createFieldEditor({ document: ui.document, element: ui.element('docFieldEditor'), changed: () => changes++ });
  editor.load(original, createDocumentFieldDraft(original, 'design-data/doc.md'));
  const pane = ui.element('docFieldEditor'), input = pane.querySelectorAll('.doc-field-input')[2], search = pane.querySelector('.doc-field-search');
  input.value = '未保存'; input.selectionStart = 1; input.selectionEnd = 2; input.dispatch('input');
  const group = pane.querySelector('details'); group.open = false;
  for (const locale of ['en', 'ja', 'zh-CN']) {
    applyLanguage(locale); editor.refreshLanguage();
    assert.equal(pane.querySelectorAll('.doc-field-input')[2], input); assert.equal(input.value, '未保存'); assert.equal(input.selectionStart, 1);
    assert.equal(group.open, false); assert.match(input.getAttribute('aria-label'), /姓名/);
  }
  search.value = '姓名'; search.dispatch('input');
  assert.equal(pane.querySelectorAll('.doc-field-row').filter(row => !row.hidden).length, 1);
  pane.querySelectorAll('.doc-field-reset')[2].click(); assert.equal(input.value, '小春'); assert.equal(editor.content(), original);
  assert.equal(changes, 2);
});
