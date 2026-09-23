import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, editorHarness } from './editor-harness.mjs';

test('new document validation refuses paths that cannot be indexed or migrated before submitting', async () => {
  const writes = [];
  const { runtime, source, state, element } = await editorHarness({ writeDoc: async (payload) => { writes.push(payload); return { version: '2' }; } });
  runtime.rebuildIndexForDoc = async () => {};
  await runtime.enterCreateMode();
  source.value = '草稿始终保留';
  for (const relative of ['wrong.bin', '.hidden.md', '.private/one.md', 'node_modules/one.md', 'CON.md', 'folder./one.md', 'bad\u0001.md']) {
    element('docCreatePathInput').value = `design-data/${relative}`;
    runtime.updateCreatePathValidation();
    assert.equal(element('docSaveBtn').disabled, true, relative);
    await runtime.saveCurrentDoc();
    assert.equal(writes.length, 0, relative);
    assert.equal(state.isCreating, true);
    assert.equal(source.value, '草稿始终保留');
  }
  element('docCreatePathInput').value = 'design-data/正确名字';
  await runtime.saveCurrentDoc();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].pathValue, 'design-data/正确名字.txt');
});

test('save recovery: an auto-completed filename remains the draft and preview path after a rejected creation', async () => {
  const writes = [];
  const { runtime, state, source, element } = await editorHarness({ writeDoc: async (payload) => {
    writes.push(payload);
    if (writes.length === 1) throw Object.assign(new Error('当前目录不可写'), { status: 500 });
    return { version: '2' };
  } });
  state.workspace = { version: 3, projectTypes: true, paths: { documents: 'documents' }, documentTypes: [
    { id: 'character', label: '角色', directory: 'characters', parserProfile: 'structured', template: 'character.yaml' },
  ] };
  runtime.rebuildIndexForDoc = async () => {};
  runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  await runtime.enterCreateMode();
  element('docCreatePathInput').value = 'documents/characters/角色';
  runtime.updateCreatePathValidation();
  runtime.replaceMediaDraftSource('\uFEFFtitle: 第一次草稿\r\n');
  await runtime.saveCurrentDoc();
  assert.equal(writes[0].pathValue, 'documents/characters/角色.yaml');
  assert.equal(state.isCreating, true);
  assert.equal(state.isSaving, false);
  assert.equal(state.editHasUnsavedChanges, true);
  assert.equal(source.readOnly, false);
  assert.equal(element('docSaveBtn').disabled, false);
  assert.match(element('docEditStatus').textContent, /当前目录不可写/);
  assert.equal(state.activeCreatePath, element('docCreatePathInput').value);
  assert.equal(runtime.mediaDraftContext().path, writes[0].pathValue);
  assert.ok(element('docEditPath').textContent.endsWith(writes[0].pathValue));
  source.value = '\uFEFFtitle: 修改后重试\n';
  await runtime.saveCurrentDoc();
  assert.equal(writes[1].pathValue, writes[0].pathValue);
  assert.equal(writes[1].documentType, 'character');
  assert.equal(writes[1].content, '\uFEFFtitle: 修改后重试\r\n');
  assert.equal(state.isCreating, false);
  assert.equal(state.editHasUnsavedChanges, false);
});

for (const [status, code, mode, hint] of [
  [401, 'AUTH_REQUIRED', 'source', /未检测到编辑令牌/],
  [403, 'FORBIDDEN', 'blocks', /编辑令牌无效/],
]) test(`save recovery: HTTP ${status} retains the ${mode} draft and reports a rejected rebuild without losing a successful save`, async () => {
  const failure = () => Object.assign(new Error(`HTTP ${status}`), {
    status, payload: { errorCode: code, requestId: `req_recovery_${status}` },
  });
  const writes = [];
  let rebuilds = 0;
  const { runtime, state, source, doc, begin, element } = await editorHarness({
    writeDoc: async (payload) => {
      writes.push(payload);
      if (writes.length === 1) throw failure();
      return { version: '2' };
    },
    rebuildDocIndex: async () => { if (++rebuilds === 1) throw failure(); },
  });
  runtime.renderRuntimeErrorPanel = () => {};
  runtime.loadData = async () => {};
  const original = '# 标题\r\n\r\n原文\r\n';
  begin(original, '1');
  if (mode === 'blocks') runtime.setEditInputMode('blocks');
  const input = mode === 'blocks' ? element('docBlockEditor').querySelectorAll('textarea')[1] : source;
  input.value = mode === 'blocks' ? '待保存内容' : '# 标题\n\n待保存内容\n';
  const draft = runtime.getCurrentEditContent();
  await runtime.saveCurrentDoc();
  assert.equal(state.isSaving, false);
  assert.equal(state.editHasUnsavedChanges, true);
  assert.equal(state.activeEditSourceVersion, '1');
  assert.equal(runtime.getCurrentEditContent(), draft);
  assert.equal(input.readOnly, false);
  assert.equal(element('docSaveBtn').disabled, false);
  assert.match(element('docEditStatus').textContent, hint);
  assert.match(element('docEditStatus').textContent, new RegExp(`req_recovery_${status}`));
  input.value = mode === 'blocks' ? '修改后重试' : '# 标题\n\n修改后重试\n';
  await runtime.saveCurrentDoc();
  assert.equal(writes[1].content, '# 标题\r\n\r\n修改后重试\r\n');
  assert.equal(writes[1].expectedVersion, '1');
  assert.equal(state.activeEditSourceVersion, '2');
  assert.equal(state.editHasUnsavedChanges, false);
  assert.equal(state.isSaving, false);
  assert.equal(state.isRebuilding, false);
  assert.equal(input.readOnly, false);
  assert.match(element('docEditStatus').textContent, /失败/);
  assert.match(element('docEditStatus').textContent, hint);
  await runtime.rebuildIndexForDoc(doc);
  assert.equal(writes.length, 2, 'retrying the preview must not submit the source again');
  assert.equal(rebuilds, 2);
  assert.equal(state.editHasUnsavedChanges, false);
  assert.equal(runtime.getCurrentEditContent(), writes[1].content);
  assert.doesNotMatch(element('docEditStatus').textContent, /失败/);
});

test('save recovery: adding the default extension cannot submit an overlong filename and shortening it permits retry', async () => {
  const writes = [];
  const { runtime, state, source, element } = await editorHarness({ writeDoc: async (payload) => {
    writes.push(payload); return { version: '2' };
  } });
  runtime.rebuildIndexForDoc = async () => {};
  await runtime.enterCreateMode();
  source.value = '等待保存的草稿';
  // 252 UTF-8 bytes fit without a suffix, but the automatic .txt makes 256.
  element('docCreatePathInput').value = `design-data/${'文'.repeat(84)}`;
  await runtime.saveCurrentDoc();
  assert.equal(writes.length, 0, 'validate the final filename before sending it to the service');
  assert.equal(state.isCreating, true);
  assert.equal(state.isSaving, false);
  assert.equal(state.editHasUnsavedChanges, true);
  assert.equal(source.value, '等待保存的草稿');
  assert.equal(source.readOnly, false);
  assert.equal(element('docSaveBtn').disabled, true);
  assert.match(element('docEditStatus').textContent, /文件名过长/);
  element('docCreatePathInput').value = 'design-data/缩短名称';
  runtime.updateCreatePathValidation();
  assert.equal(element('docSaveBtn').disabled, false);
  await runtime.saveCurrentDoc();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].pathValue, 'design-data/缩短名称.txt');
  assert.equal(writes[0].content, '等待保存的草稿');
  assert.equal(state.isCreating, false);
  assert.equal(state.editHasUnsavedChanges, false);
});

test('suggested filenames sanitize arbitrary type labels and fit filesystem filename limits', async () => {
  const { runtime, state } = await editorHarness();
  for (const label of ['角色 / NPC：主角?', '设定'.repeat(60), '🤔'.repeat(60)]) {
    state.workspace = { version: 3, projectTypes: true, paths: { documents: 'documents' },
      documentTypes: [{ id: 'custom', label, directory: 'custom', parserProfile: 'structured', template: 'custom.md' }],
    };
    const suggested = runtime.getSuggestedCreatePath('', 'custom');
    assert.equal(suggested.split('/').length, 3, suggested);
    assert.equal(runtime.isInvalidCreatePath(suggested), '', suggested);
    assert.ok(Buffer.byteLength(suggested.split('/').at(-1)) <= 255);
    assert.equal(state.workspace.documentTypes[0].label, label);
  }
});

test('the initial creation hint cannot hide a failed template load', async () => {
  const { runtime, source, state, element } = await editorHarness({ loadTemplateContent: async () => { throw new Error('模板读取连接中断'); } });
  runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  await runtime.enterCreateMode();
  assert.equal(state.isCreating, true);
  assert.equal(state.isLoadingTemplate, false);
  assert.equal(source.value, '');
  assert.match(element('docEditStatus').textContent, /模板加载失败.*模板读取连接中断/);
  runtime.loadTemplateContent = async () => '重新读取的模板';
  await runtime.setCreateTypeState(state.activeCreateType);
  assert.equal(source.value, '重新读取的模板');
  assert.doesNotMatch(element('docEditStatus').textContent, /模板加载失败/);
});

test('a failed index reload after saving is reported as a rebuild failure while the saved editor survives', async () => {
  const { runtime, state, source, doc, element, begin } = await editorHarness({
    rebuildDocIndex: async () => ({}), loadDocIndexPayload: async () => { throw new Error('索引读取连接中断'); },
  });
  for (const name of ['setLoadingState', 'setListSkeletonState', 'hideLoadRetry', 'showLoadRetry']) runtime[name] = () => {};
  runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  begin('原文', '1'); source.value = '已保存的内容';
  await runtime.saveCurrentDoc();
  assert.equal(state.isEditing, true);
  assert.equal(state.isSaving, false);
  assert.equal(state.isRebuilding, false);
  assert.equal(state.editHasUnsavedChanges, false);
  assert.equal(source.value, '已保存的内容');
  assert.equal(state.activeEditSourceVersion, '2');
  assert.equal(state.docs[0], doc);
  assert.match(element('docEditStatus').textContent, /失败.*索引读取连接中断/);
});

test('an invalid replacement index preserves the current document list and project types', async () => {
  const { runtime, state, doc, begin } = await editorHarness({ loadDocIndexPayload: async () => ({ payload: { workspace: { name: '不能应用' }, docs: {} } }) });
  for (const name of ['setLoadingState', 'setListSkeletonState', 'hideLoadRetry', 'showLoadRetry', 'logRuntimeErrorOrMessage']) runtime[name] = () => {};
  state.workspace = { name: '原项目' };
  const workspace = state.workspace, documents = state.docs;
  begin('未保存的正文');
  await runtime.loadData();
  assert.equal(state.docs, documents);
  assert.equal(state.docs[0], doc);
  assert.equal(state.workspace, workspace);
});

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

async function sourceLoadingHarness() {
  const requests = [], writes = [], errors = [];
  const h = await editorHarness({
    readDocSource: ({ pathValue }) => {
      const pending = deferred(); requests.push({ ...pending, path: pathValue }); return pending.promise;
    },
    writeDoc: async (payload) => { writes.push(payload); return { version: '3' }; },
  });
  for (const name of ['renderHeroBanner', 'renderSectionCards', 'renderGallery', 'markActiveItem']) h.runtime[name] = () => {};
  h.runtime.getHeroImagesForDisplay = () => [];
  h.runtime.rebuildIndexForDoc = async () => {};
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => { errors.push(error); return h.runtime.getFriendlyRequestError(error); };
  h.runtime.updateEditorForDoc(h.doc);
  return { ...h, requests, writes, errors };
}

async function replaceSourceIndex(h, replacement) {
  h.runtime.loadDocIndexPayload = async () => ({ payload: { docs: [replacement] } });
  for (const name of ['setLoadingState', 'setListSkeletonState', 'hideLoadRetry', 'renderTabsNow', 'getSearchIndex']) h.runtime[name] = () => {};
  h.runtime.getTabCounts = () => ({}); h.runtime.formatTime = () => '';
  h.runtime.renderFilteredDocs = () => h.runtime.selectDoc(replacement.path);
  await h.runtime.loadData();
}

test('source loading: a cancelled read cannot replace the cache or revision of a reopened and saved document', async () => {
  const h = await sourceLoadingHarness();
  const abandoned = h.runtime.enterEditMode();
  h.runtime.setMode('browse'); h.runtime.setMode('edit');
  const current = h.runtime.enterEditMode();
  h.requests[1].resolve({ content: '\uFEFF# 最新原文\r\n', version: '2' }); await current;
  h.source.value = '\uFEFF# 修改后保存\n';
  await h.runtime.saveCurrentDoc();
  const saved = h.writes[0].content;
  assert.equal(saved, '\uFEFF# 修改后保存\r\n');
  h.requests[0].resolve({ content: '迟到的旧正文', version: '1' }); await abandoned;
  assert.equal(h.doc._sourceCachedText, saved);
  assert.equal(h.doc._sourceVersion, '3');
  assert.equal(h.state.activeEditSourceVersion, '3');
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.equal(h.runtime.getCurrentEditContent(), saved);
  h.runtime.exitEditMode();
  assert.equal(h.source.value, saved.replaceAll('\r\n', '\n'));
  assert.deepEqual(h.errors, []);
});

test('source loading: returning to browse discards an unfinished selection read instead of refilling the cleared editor', async () => {
  const h = await sourceLoadingHarness();
  h.doc._sourceCachedText = undefined;
  h.runtime.selectDoc(h.doc.path);
  assert.equal(h.requests.length, 1);
  h.runtime.setMode('browse');
  assert.equal(h.source.value, '');
  h.requests[0].resolve({ content: '浏览模式中不应写回的旧原文', version: '2' });
  await new Promise(setImmediate);
  assert.equal(h.source.value, '');
  assert.equal(h.doc._sourceCachedText, undefined);
  assert.equal(h.state.isEditing, false);
  assert.equal(h.state.isLoadingSource, false);
  assert.deepEqual(h.errors, []);
});

test('source loading: a failed abandoned read cannot add diagnostics after selecting another document', async () => {
  const h = await sourceLoadingHarness();
  h.doc._sourceCachedText = undefined;
  const other = { ...h.doc, path: 'rule/另一篇', sourcePath: 'design-data/design-rules/另一篇.md', _sourceCachedText: '另一篇正文' };
  h.state.docs.push(other); h.runtime.rebuildDocPathCaches(h.state.docs);
  h.runtime.selectDoc(h.doc.path);
  h.runtime.selectDoc(other.path);
  h.runtime.setEditorStatus('当前文档已就绪');
  h.requests[0].reject(Object.assign(new Error('旧请求被拒绝'), { status: 403, payload: { errorCode: 'forbidden' } }));
  await new Promise(setImmediate);
  assert.deepEqual(h.errors, []);
  assert.equal(h.state.activePath, other.path);
  assert.equal(h.source.value, '另一篇正文');
  assert.equal(h.element('docEditStatus').textContent, '当前文档已就绪');
  assert.equal(h.doc._sourceCachedText, undefined);
});

test('source loading: an index refresh cannot attach an old source response to a replacement catalog entry', async () => {
  const h = await sourceLoadingHarness();
  const entering = h.runtime.enterEditMode();
  const replacement = { ...h.doc, sourcePath: 'design-data/design-rules/迁移后的原文.md', _sourceCachedText: undefined, _sourceVersion: undefined };
  await replaceSourceIndex(h, replacement);
  assert.equal(h.requests[1].path, replacement.sourcePath);
  h.requests[1].resolve({ content: '新路径正文', version: '20' }); await new Promise(setImmediate);
  h.requests[0].resolve({ content: '旧路径正文', version: '10' }); await entering;
  assert.equal(h.state.isEditing, false);
  assert.equal(h.state.isLoadingSource, false);
  assert.equal(h.source.value, '新路径正文');
  assert.equal(h.element('docEditBtn').disabled, false);
  const retry = h.runtime.enterEditMode();
  assert.equal(h.requests[2].path, replacement.sourcePath);
  h.requests[2].resolve({ content: '新路径正文', version: '20' }); await retry;
  assert.equal(h.state.activeEditSource, replacement.sourcePath);
  h.source.value = '新路径修改后的正文'; await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].pathValue, replacement.sourcePath);
  assert.equal(h.writes[0].expectedVersion, '20');
  assert.equal(h.writes[0].content, '新路径修改后的正文');
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.equal(h.doc._sourceCachedText, '原文\n');
});

test('source loading: a superseded conflict reload keeps the dirty draft until reloading the current entry succeeds', async () => {
  const h = await sourceLoadingHarness();
  h.begin('原文\n', '1'); h.source.value = '未保存的合并草稿'; h.runtime.refreshEditSessionDirtyState();
  h.runtime.openSaveConflictDialog = async () => '1';
  const oldReload = h.runtime.handleSaveConflict(h.doc, { currentVersion: '2' });
  await new Promise(setImmediate);
  const replacement = { ...h.doc };
  await replaceSourceIndex(h, replacement);
  h.requests[0].resolve({ content: '旧读取的正文', version: '2' });
  assert.equal(await oldReload, 'keep');
  assert.equal(h.source.value, '未保存的合并草稿');
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.equal(h.state.activeEditSourceVersion, '1');
  const retry = h.runtime.handleSaveConflict(replacement, { currentVersion: '2' });
  await new Promise(setImmediate);
  h.requests[1].resolve({ content: '重新读取的正文', version: '2' });
  assert.equal(await retry, 'reload');
  assert.equal(h.source.value, '重新读取的正文');
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.equal(h.state.activeEditSourceVersion, '2');
});

for (const scenario of ['unauthorized', 'missing', 'malformed']) {
  test(`source loading: ${scenario} responses preserve the last source and permit an empty-source retry`, async () => {
    const h = await sourceLoadingHarness();
    const entering = h.runtime.enterEditMode();
    if (scenario === 'malformed') h.requests[0].resolve({ version: '2' });
    else h.requests[0].reject(Object.assign(new Error(scenario), {
      status: scenario === 'unauthorized' ? 401 : 404,
      payload: { errorCode: scenario === 'unauthorized' ? 'auth_required' : 'document not found' },
    }));
    await entering;
    assert.equal(h.state.isEditing, false);
    assert.equal(h.state.isLoadingSource, false);
    assert.equal(h.doc._sourceCachedText, '原文\n');
    assert.equal(h.doc._sourceVersion, '1');
    assert.equal(h.source.value, '原文\n');
    assert.ok(h.element('docEditStatus').textContent);
    assert.equal(h.element('docEditBtn').disabled, false);
    const retry = h.runtime.enterEditMode();
    h.requests[1].resolve({ content: '', version: '2' }); await retry;
    assert.equal(h.source.value, '');
    assert.equal(h.state.isEditing, true);
    assert.equal(h.state.editHasUnsavedChanges, false);
    assert.equal(h.state.activeEditSourceVersion, '2');
    assert.equal(h.element('docEditStatus').textContent, '');
  });
}

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

async function templateLoadingHarness() {
  const requests = [], errors = [], writes = [];
  const h = await editorHarness({
    loadTemplateContent: (options) => { const pending = deferred(); requests.push({ ...pending, ...options }); return pending.promise; },
    writeDoc: async (payload) => { writes.push(payload); return { version: '2' }; },
  });
  h.state.workspace = { version: 3, projectTypes: true, paths: { documents: 'documents' }, documentTypes: [{
    id: 'character', label: '角色', directory: 'characters', template: 'character.yaml', templateSource: 'templates/character.yaml',
  }] };
  h.doc.category = 'character'; h.doc.sourcePath = 'documents/characters/已有角色.md';
  h.runtime.rebuildDocPathCaches(h.state.docs);
  h.runtime.rebuildIndexForDoc = async () => {};
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => { errors.push(error.message); return error.message; };
  return { ...h, requests, errors, writes };
}

test('template loading: a cancelled response cannot replace the fresh cache used by the next creation and save', async () => {
  const h = await templateLoadingHarness();
  const old = h.runtime.enterCreateMode();
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  const current = h.runtime.enterCreateMode();
  const fresh = '\uFEFFtitle: 最新模板\r\n';
  h.requests[1].resolve(fresh); await current;
  h.requests[0].resolve('title: 过期模板\n'); await old;
  assert.equal(h.runtime.getCurrentEditContent(), fresh);
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  await h.runtime.enterCreateMode();
  assert.equal(h.runtime.getCurrentEditContent(), fresh);
  assert.equal(h.requests.length, 2, 'the accepted fresh template should remain reusable');
  h.element('docCreatePathInput').value = 'documents/characters/确认稿.yaml';
  h.source.value += 'note: 完成\n';
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].documentType, 'character');
  assert.equal(h.writes[0].pathValue, 'documents/characters/确认稿.yaml');
  assert.equal(h.writes[0].content, `${fresh}note: 完成\r\n`);
  assert.equal(h.state.isCreating, false);
  assert.equal(h.state.editHasUnsavedChanges, false);
});

test('template loading: cancelling a first draft does not cache its late response before reopening', async () => {
  const h = await templateLoadingHarness();
  h.state.docs = []; h.state.activePath = '';
  const old = h.runtime.enterCreateMode();
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  h.requests[0].resolve('title: 已取消的模板\n'); await old;
  assert.equal(h.state.isCreating, false);
  const retry = h.runtime.enterCreateMode();
  assert.equal(h.requests.length, 2, 'reopening must read the current template, not the cancelled response');
  h.requests[1].resolve('title: 重新读取\n'); await retry;
  assert.equal(h.source.value, 'title: 重新读取\n');
  assert.equal(h.state.isLoadingTemplate, false);
  assert.deepEqual(h.writes, []);
});

test('template loading: an old failure cannot poison a valid empty template or report an error in the new session', async () => {
  const h = await templateLoadingHarness();
  const old = h.runtime.enterCreateMode();
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  const current = h.runtime.enterCreateMode();
  h.requests[1].resolve(''); await current;
  const status = h.element('docEditStatus').textContent;
  h.requests[0].reject(new Error('过期模板请求失败')); await old;
  assert.deepEqual(h.errors, []);
  assert.equal(h.element('docEditStatus').textContent, status);
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  await h.runtime.enterCreateMode();
  assert.equal(h.requests.length, 2);
  assert.equal(h.source.value, '');
  assert.doesNotMatch(h.element('docEditStatus').textContent, /加载失败|过期模板/);
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.deepEqual(h.writes, []);
});

test('template loading: a cancelled creation cannot move the caret or scroll of a newer draft of the same type', async () => {
  const h = await templateLoadingHarness();
  h.source.setSelectionRange = (start, end) => { h.source.selectionStart = start; h.source.selectionEnd = end; };
  const old = h.runtime.enterCreateMode();
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  const current = h.runtime.enterCreateMode();
  h.requests[1].resolve('title: 新角色\n'); await current;
  h.source.value += 'notes: 尚未保存的写作\n';
  const content = h.source.value, file = 'documents/characters/我的草稿.yaml';
  h.element('docCreatePathInput').value = file;
  h.runtime.updateCreatePathValidation();
  h.source.setSelectionRange(7, 9); h.source.scrollTop = 240;
  h.requests[0].resolve('title: 旧角色\n'); await old;
  assert.deepEqual([h.source.selectionStart, h.source.selectionEnd, h.source.scrollTop], [7, 9, 240]);
  assert.equal(h.source.value, content);
  assert.equal(h.state.activeCreatePath, file);
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.equal(h.state.isLoadingTemplate, false);
  assert.equal(h.source.readOnly, false);
  assert.deepEqual(h.writes, []);
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

test('failed forced saves keep the original baseline so a normal retry asks about the conflict again', async () => {
  const writes = [], actions = ['3', '3', '2'];
  let stored = '另一位作者的更新';
  const { runtime, state, source, begin } = await editorHarness({
    writeDoc: async (payload) => {
      writes.push(payload);
      if (payload.force) throw Object.assign(new Error('保存连接中断'), { status: 503 });
      if (payload.expectedVersion !== '2') throw Object.assign(new Error('document was modified by another client'), {
        status: 409, payload: { error: 'document was modified by another client', currentVersion: '2' },
      });
      stored = payload.content;
      return { version: '3' };
    },
  });
  runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  runtime.rebuildIndexForDoc = async () => {};
  runtime.openSaveConflictDialog = async () => actions.shift();
  begin('最初读取的内容', '1');
  source.value = '我的未保存草稿';
  await runtime.saveCurrentDoc();
  const versionAfterFailure = state.activeEditSourceVersion;
  await runtime.saveCurrentDoc();
  assert.equal(stored, '另一位作者的更新', 'ordinary retry must not silently overwrite the remote content');
  assert.equal(versionAfterFailure, '1');
  assert.deepEqual(writes.map(({ expectedVersion, force }) => [expectedVersion, force]), [['1', false], ['1', true], ['1', false]]);
  assert.equal(actions.length, 0);
  assert.equal(source.value, '我的未保存草稿');
  assert.equal(state.editHasUnsavedChanges, true);
  assert.equal(state.isSaving, false);
});

test('a failed conflict reload retains the block draft and its error until a successful retry', async () => {
  let reads = 0;
  const { runtime, state, source, element, begin } = await editorHarness({
    readDocSource: async () => {
      if (++reads === 1) throw new Error('最新正文读取超时');
      return { content: '服务器的最新正文', version: '3' };
    },
    writeDoc: async () => { throw Object.assign(new Error('document was modified by another client'), {
      status: 409, payload: { error: 'document was modified by another client', currentVersion: '2' },
    }); },
  });
  runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  runtime.openSaveConflictDialog = async () => '1';
  begin('原文', '1');
  runtime.setEditInputMode('blocks');
  element('docBlockEditor').querySelectorAll('textarea')[0].value = '未保存的区块草稿';
  await runtime.saveCurrentDoc();
  assert.match(element('docEditStatus').textContent, /读取最新内容失败.*最新正文读取超时/);
  assert.equal(runtime.getCurrentEditContent(), '未保存的区块草稿');
  assert.equal(state.editInputMode, 'blocks');
  assert.equal(state.activeEditSourceVersion, '1');
  assert.equal(state.editHasUnsavedChanges, true);
  assert.equal(state.isSaving, false);
  await runtime.saveCurrentDoc();
  assert.equal(source.value, '服务器的最新正文');
  assert.equal(state.activeEditSourceVersion, '3');
  assert.equal(state.editHasUnsavedChanges, false);
  assert.equal(state.isSaving, false);
});

for (const [label, choices, approved] of [
  ['keep draft', ['2'], false],
  ['cancel conflict', ['cancel'], false],
  ['cancel force confirmation', ['3', 'cancel'], false],
  ['confirm force save', ['3', '3'], true],
]) {
  test(`save conflict: ${label} only changes the baseline after an approved successful write`, async () => {
    const actions = [...choices], modes = [], writes = [];
    const original = '\uFEFF原文\r\n', draft = '\uFEFF未保存的修改\r\n';
    const { runtime, state, source, begin, element } = await editorHarness({
      writeDoc: async (payload) => {
        writes.push(payload);
        if (!payload.force) throw Object.assign(new Error('document was modified by another client'), {
          status: 409, payload: { error: 'document was modified by another client', currentVersion: '2' },
        });
        return { version: '3' };
      },
    });
    runtime.rebuildIndexForDoc = async () => {};
    runtime.openSaveConflictDialog = async (_payload, options) => {
      modes.push(options?.mode || 'default');
      assert.equal(source.readOnly, true);
      assert.equal(element('docSaveBtn').disabled, true);
      return actions.shift();
    };
    begin(original, '1');
    source.value = draft;
    await runtime.saveCurrentDoc();
    assert.deepEqual(modes, choices.length === 2 ? ['default', 'force'] : ['default']);
    assert.equal(writes.length, approved ? 2 : 1);
    assert.equal(writes.at(-1).force, approved);
    assert.equal(runtime.getCurrentEditContent(), draft);
    assert.equal(state.activeEditSourceVersion, approved ? '3' : '1');
    assert.equal(state.editHasUnsavedChanges, !approved);
    assert.equal(state.isSaving, false);
    assert.equal(source.readOnly, false);
  });
}

test('content revision tokens survive reading, conflict reload and subsequent ordinary saving', async () => {
  const first = `sha256:${'a'.repeat(64)}`, latest = `sha256:${'b'.repeat(64)}`, saved = `sha256:${'c'.repeat(64)}`;
  const writes = [];
  let reads = 0;
  const { runtime, state, source } = await editorHarness({
    readDocSource: async () => ({ content: ++reads === 1 ? '原文' : '更新后的正文', version: reads === 1 ? first : latest }),
    writeDoc: async (payload) => {
      writes.push(payload);
      if (writes.length === 1) throw Object.assign(new Error('document was modified by another client'), {
        status: 409, payload: { error: 'document was modified by another client', currentVersion: latest },
      });
      return { version: saved };
    },
  });
  runtime.rebuildIndexForDoc = async () => {};
  runtime.openSaveConflictDialog = async () => '1';
  await runtime.enterEditMode();
  assert.equal(state.activeEditSourceVersion, first);
  source.value = '第一份草稿';
  await runtime.saveCurrentDoc();
  assert.equal(source.value, '更新后的正文');
  assert.equal(state.activeEditSourceVersion, latest);
  source.value = '重新编辑后的内容';
  await runtime.saveCurrentDoc();
  assert.deepEqual(writes.map(({ expectedVersion }) => expectedVersion), [first, latest]);
  assert.equal(state.activeEditSourceVersion, saved);
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
