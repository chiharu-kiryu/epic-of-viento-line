import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, editorHarness } from './editor-harness.mjs';

test('source/block switches retain new edits and do not duplicate display-only headings', async () => {
  const { runtime, state, source, begin, element } = await editorHarness();
  begin('# 标题\n\n原文\n');
  source.value = '# 标题\n\n新增草稿\n';
  runtime.refreshEditSessionDirtyState();
  runtime.setEditInputMode('blocks');
  const blocks = element('docBlockEditor').querySelectorAll('textarea');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].value, '新增草稿');
  blocks[1].value = '区块修改';
  runtime.refreshEditSessionDirtyState();
  runtime.setEditInputMode('source');
  assert.equal(source.value, '# 标题\n\n区块修改\n');
  assert.equal(state.editHasUnsavedChanges, true);
  runtime.setEditInputMode('blocks');
  runtime.setEditInputMode('source');
  assert.equal(source.value, '# 标题\n\n区块修改\n');
  source.value = '';
  runtime.refreshEditSessionDirtyState();
  runtime.setEditInputMode('blocks');
  runtime.setEditInputMode('source');
  assert.equal(source.value, '');
});

test('an unchanged source stays clean across modes and index refresh preserves a dirty editor', async () => {
  const { runtime, state, source, doc, begin, element } = await editorHarness();
  const original = '# 标题\n\n| 列 |\n| --- |\n| 值 |\n';
  begin(original);
  runtime.setEditInputMode('blocks');
  assert.equal(state.editHasUnsavedChanges, false);
  runtime.setEditInputMode('source');
  assert.equal(source.value, original);
  source.value += '\n刷新时还在编辑\n';
  runtime.refreshEditSessionDirtyState();
  runtime.updateEditorForDoc({ ...doc, _sourceCachedText: '旧缓存' });
  assert.match(source.value, /刷新时还在编辑/);
  assert.equal(state.editHasUnsavedChanges, true);
  runtime.setEditInputMode('blocks');
  runtime.refreshEditButtons();
  assert.equal(element('docEditorWrap').hidden, true);
  assert.equal(element('docBlockEditor').classList.contains('is-hidden'), false);
});

test('late source responses cannot reopen a cancelled session; empty sources stay empty', async () => {
  const pending = deferred();
  const { runtime, state, source, doc } = await editorHarness({ readDocSource: () => pending.promise });
  const entering = runtime.enterEditMode();
  assert.equal(state.isLoadingSource, true);
  runtime.applyEditMode(doc, false);
  pending.resolve({ content: '迟到的旧请求', version: '2' });
  await entering;
  assert.equal(state.isEditing, false);
  assert.equal(source.value, '');
  runtime.readDocSource = async () => ({ content: '', version: '3.25' });
  await runtime.enterEditMode();
  assert.equal(source.value, '');
  assert.equal(state.activeEditSourceVersion, '3.25');
  assert.equal(state.editHasUnsavedChanges, false);
});

test('saving serializes shortcut requests and locks editing until rebuilding finishes', async () => {
  const write = deferred();
  const rebuild = deferred();
  let writes = 0;
  const { runtime, state, source, begin, element } = await editorHarness({ writeDoc: () => { writes += 1; return write.promise; } });
  runtime.rebuildIndexForDoc = () => rebuild.promise;
  begin();
  source.value = '要保存的草稿';
  runtime.refreshEditSessionDirtyState();
  const saving = runtime.saveCurrentDoc();
  await runtime.saveCurrentDoc();
  assert.equal(writes, 1);
  assert.equal(source.readOnly, true);
  assert.equal(element('docEditBlockModeBtn').disabled, true);
  runtime.exitEditMode();
  assert.equal(state.isEditing, true);
  write.resolve({ version: '2' });
  await new Promise(setImmediate);
  assert.equal(state.isSaving, true);
  assert.equal(source.readOnly, true);
  rebuild.resolve();
  await saving;
  assert.equal(source.readOnly, false);
  assert.equal(state.isSaving, false);
  assert.equal(state.editHasUnsavedChanges, false);
  assert.equal(state.activeEditSourceVersion, '2');
});

test('a changed creation path is an unsaved draft and cancel restores the current document path', async () => {
  const { runtime, state, source, element, doc } = await editorHarness();
  await runtime.enterCreateMode();
  assert.equal(source.value, '');
  assert.equal(state.editHasUnsavedChanges, false);
  element('docCreatePathInput').value = 'design-data/design-rules/用户输入的名称.md';
  runtime.updateCreatePathValidation();
  assert.equal(state.editHasUnsavedChanges, true);
  assert.match(element('docEditPath').textContent, /用户输入的名称/);
  runtime.exitEditMode();
  assert.equal(state.isCreating, true);
  runtime.window.confirm = () => true;
  runtime.exitEditMode();
  assert.equal(state.isCreating, false);
  assert.match(element('docEditPath').textContent, new RegExp(doc.sourcePath));
});

test('suggested creation paths reuse same-type directories and never treat a filename as a folder', async () => {
  const { runtime } = await editorHarness();
  assert.equal(runtime.getCreateTypeBasePath('item', 'design-data/design-rules/魔抗公式'), 'design-data/design-item/基础/通用/');
  assert.equal(runtime.getCreateTypeBasePath('hero', 'design-data/design-rules/规则.md'), 'design-data/design-heros/力量/');
  assert.equal(runtime.getCreateTypeBasePath('item', 'design-data/design-item/消耗品/红花果'), 'design-data/design-item/消耗品/');
  assert.equal(runtime.getCreateTypeBasePath('unit', 'docs-standard/design-data/design-units/中立/史诗/飓风剑皇'), 'design-data/design-units/中立/史诗/');
});

test('an older template response cannot replace a newer type or reopen a cancelled creation', async () => {
  const old = deferred();
  const latest = deferred();
  let calls = 0;
  const { runtime, state, source } = await editorHarness({ loadTemplateContent: () => (++calls === 1 ? old : latest).promise });
  const creating = runtime.enterCreateMode();
  const changing = runtime.setCreateTypeState('item');
  latest.resolve('物品模板');
  await changing;
  old.resolve('过期规则模板');
  await creating;
  assert.equal(state.activeCreateType, 'item');
  assert.equal(source.value, '物品模板');
  const later = deferred();
  runtime.loadTemplateContent = () => later.promise;
  const pending = runtime.setCreateTypeState('unit');
  runtime.exitEditMode({ skipUnsavedConfirm: true });
  later.resolve('取消后到达的模板');
  await pending;
  assert.equal(state.isCreating, false);
  assert.notEqual(source.value, '取消后到达的模板');
});

test('conflict reload uses the newly read version, even if the server changed again after the conflict', async () => {
  const { runtime, state, source, doc, begin } = await editorHarness({ readDocSource: async () => ({ content: '版本三内容', version: '3' }) });
  begin('本地草稿', '1');
  runtime.openSaveConflictDialog = async () => '1';
  assert.equal(await runtime.handleSaveConflict(doc, { currentVersion: '2' }), 'reload');
  assert.equal(source.value, '版本三内容');
  assert.equal(state.activeEditSourceVersion, '3');
  assert.equal(state.editHasUnsavedChanges, false);
});

test('switching from the editor to browse makes the document content visible again', async () => {
  const { runtime, state, element, begin } = await editorHarness();
  begin();
  assert.equal(element('docContent').hidden, true);
  runtime.setMode('browse');
  assert.equal(state.isEditing, false);
  assert.equal(state.mode, 'browse');
  assert.equal(element('docContent').hidden, false);
  assert.equal(element('docContent').classList.contains('is-hidden'), false);
});

test('a successful creation stays editable as an existing file if rebuilding fails', async () => {
  const writes = [];
  const { runtime, state, source, element } = await editorHarness({
    writeDoc: async (payload) => { writes.push(payload); return { version: '5' }; },
  });
  runtime.rebuildIndexForDoc = async () => { runtime.setEditorStatus('重建失败'); };
  await runtime.enterCreateMode();
  element('docCreatePathInput').value = 'design-data/design-rules/新文件.md';
  source.value = '已保存的内容';
  await runtime.saveCurrentDoc();
  assert.equal(state.isCreating, false);
  assert.equal(state.isEditing, true);
  assert.equal(state.activeEditSource, 'design-data/design-rules/新文件.md');
  assert.equal(state.activeEditSourceVersion, '5');
  assert.equal(state.editHasUnsavedChanges, false);
  assert.equal(source.value, '已保存的内容');
  source.value = '继续修改';
  runtime.refreshEditSessionDirtyState();
  await runtime.saveCurrentDoc();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].isCreate, true);
  assert.equal(writes[1].isCreate, undefined);
  assert.equal(writes[1].pathValue, 'design-data/design-rules/新文件.md');
  assert.equal(writes[1].expectedVersion, '5');
});

test('browser textarea normalization preserves source line endings through switches, edits and saves', async () => {
  const original = '\uFEFF# 标题\r\n\r\n规则名：原文\r\n\r\n结尾有空格。  \r\n';
  const writes = [];
  const { runtime, state, source, element } = await editorHarness({
    readDocSource: async () => ({ content: original, version: '1' }),
    writeDoc: async (payload) => { writes.push(payload); return { version: String(writes.length + 1) }; },
  });
  runtime.rebuildIndexForDoc = async () => {};
  await runtime.enterEditMode();
  assert.equal(source.value, original.replaceAll('\r\n', '\n'));
  assert.equal(runtime.getCurrentEditContent(), original);
  runtime.setEditInputMode('blocks');
  assert.equal(state.editHasUnsavedChanges, false);
  await runtime.saveCurrentDoc();
  assert.equal(writes[0].content, original);
  element('docBlockEditor').querySelectorAll('textarea')[1].value = '规则名：区块修改\n追加一行';
  runtime.refreshEditSessionDirtyState();
  runtime.setEditInputMode('source');
  source.value = source.value.replace('结尾有空格。', '修改结尾。');
  runtime.refreshEditSessionDirtyState();
  const expected = original.replace('规则名：原文', '规则名：区块修改\r\n追加一行').replace('结尾有空格。', '修改结尾。');
  assert.equal(runtime.getCurrentEditContent(), expected);
  await runtime.saveCurrentDoc();
  assert.equal(writes[1].content, expected);
  assert.equal(state.editHasUnsavedChanges, false);
});

test('first index refresh maps a created source to its catalog ID without closing its editor', async () => {
  const { runtime, state, source, element } = await editorHarness();
  const sourcePath = 'design-data/design-rules/新建：规则.md';
  const catalogDoc = { path: 'rule/新建：规则', source: { path: `docs-standard/${sourcePath}` }, category: 'rule', content: '新建正文' };
  runtime.loadDocIndexPayload = async () => ({ payload: { docs: [catalogDoc] } });
  for (const name of ['setLoadingState', 'setListSkeletonState', 'hideLoadRetry', 'renderTabsNow', 'getSearchIndex', 'renderHeroBanner', 'renderSectionCards', 'renderGallery', 'markActiveItem']) runtime[name] = () => {};
  runtime.getTabCounts = () => ({});
  runtime.formatTime = () => '';
  runtime.getHeroImagesForDisplay = () => [];
  runtime.renderFilteredDocs = () => runtime.selectDoc(catalogDoc.path, { allowDuringWrite: true });
  runtime.rebuildIndexForDoc = async () => runtime.loadData(sourcePath, { preferredSourcePath: sourcePath, allowDuringWrite: true });
  await runtime.enterCreateMode();
  element('docCreatePathInput').value = sourcePath;
  source.value = '新建正文';
  await runtime.saveCurrentDoc();
  assert.equal(state.activePath, catalogDoc.path);
  assert.equal(state.activeEditPath, catalogDoc.path);
  assert.equal(state.isEditing, true);
  assert.equal(state.isCreating, false);
  assert.equal(source.value, '新建正文');
  assert.equal(state.activeEditSourceVersion, '2');
  assert.equal(element('docSaveBtn').hidden, false);
  runtime.setEditInputMode('blocks');
  assert.equal(element('docBlockEditor').querySelectorAll('textarea')[0].value, '新建正文');
});

test('discard cancellation protects dirty drafts on document, mode and editor exit', async () => {
  const { runtime, state, source, doc, begin } = await editorHarness();
  const other = { ...doc, path: 'rule/另一份', sourcePath: 'design-data/design-rules/另一份.md' };
  state.docs.push(other);
  runtime.rebuildDocPathCaches(state.docs);
  begin();
  source.value = '未保存的修改';
  runtime.refreshEditSessionDirtyState();
  const messages = [];
  runtime.window.confirm = (message) => { messages.push(message); return false; };
  runtime.selectDoc(other.path);
  runtime.setMode('browse');
  runtime.exitEditMode();
  assert.equal(messages.length, 3);
  assert.equal(state.activePath, doc.path);
  assert.equal(state.mode, 'edit');
  assert.equal(state.isEditing, true);
  assert.equal(state.editHasUnsavedChanges, true);
  assert.equal(source.value, '未保存的修改');
  runtime.window.confirm = () => true;
  runtime.exitEditMode();
  assert.equal(state.isEditing, false);
  assert.equal(state.editHasUnsavedChanges, false);
});
