import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, editorHarness } from './editor-harness.mjs';

const original = '\uFEFF# 原文\r\n\r\n保留格式。  \r\n';
const edited = original.replace('保留格式。', '保存后的正文。');

async function indexHarness() {
  const files = new Map(), writes = [], errors = [], retries = [];
  let index = [], workspace = { name: '原项目' }, pendingWrite = null;
  const h = await editorHarness({
    readDocSource: async ({ pathValue }) => ({ ...files.get(pathValue.replace(/^docs-standard\//, '')) }),
    writeDoc: async (payload) => {
      writes.push(payload);
      if (pendingWrite) await pendingWrite.promise;
      files.set(payload.pathValue.replace(/^docs-standard\//, ''), { content: payload.content, version: '2' });
      return { version: '2' };
    },
    rebuildDocIndex: async () => ({}),
    loadDocIndexPayload: async () => ({ payload: { docs: structuredClone(index), workspace } }),
  });
  files.set(h.doc.sourcePath, { content: original, version: '1' });
  h.state.workspace = workspace;
  // Keep the production index replacement, selection, editor and save paths.
  // Stub only presentation/search inputs unrelated to this unfiltered fixture.
  for (const name of ['setLoadingState', 'setListSkeletonState', 'hideLoadRetry', 'renderTabsNow', 'getSearchIndex',
    'renderHeroBanner', 'renderSectionCards', 'renderGallery', 'markActiveItem', 'updateLeftPanelStatsFromGroups']) h.runtime[name] = () => {};
  h.runtime.getHeroImagesForDisplay = () => [];
  h.runtime.getVisibleDocs = (docs) => docs;
  h.runtime.getHeroDisplayDocs = (docs) => docs;
  h.runtime.getCachedGroupsByFilteredDocs = () => [];
  h.runtime.renderList = () => ({});
  h.runtime.getTabCounts = () => ({});
  h.runtime.formatTime = () => '';
  h.runtime.showLoadRetry = (message) => retries.push(message);
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => { errors.push(error); return error.message; };
  return { ...h, files, writes, errors, retries,
    setIndex(docs, nextWorkspace = workspace) { index = docs; workspace = nextWorkspace; },
    pauseWrite() { pendingWrite = deferred(); return pendingWrite; },
  };
}

function catalogEntry(sourcePath, path = 'rule/重建后的条目') {
  return { path, source: { path: `docs-standard/${sourcePath}` }, category: 'rule', content: '仅供展示的索引摘要', lastModified: '2026-09-23T04:00:00Z' };
}

test('index refresh: reusing a catalog ID for another source cannot redirect a dirty draft or its save', async () => {
  const h = await indexHarness();
  const otherPath = 'design-data/design-rules/另一份.md';
  h.files.set(otherPath, { content: original, version: '1' });
  await h.runtime.enterEditMode();
  h.source.value = edited;
  h.runtime.refreshEditSessionDirtyState();
  const documents = h.state.docs, workspace = h.state.workspace;
  h.setIndex([catalogEntry(otherPath, h.doc.path)], { name: '不应应用的新配置' });
  await h.runtime.loadData();
  h.setIndex([catalogEntry(h.doc.sourcePath)]);
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].pathValue, h.doc.sourcePath);
  assert.equal(h.writes[0].expectedVersion, '1');
  assert.equal(h.files.get(otherPath).content, original);
  assert.equal(h.files.get(h.doc.sourcePath).content, edited);
  assert.equal(h.retries.length, 1);
  assert.match(h.retries[0], /正在编辑/);
  // Repeat with a dirty editor to check rejection is atomic for data/config.
  h.source.value += '还没有保存'; h.runtime.refreshEditSessionDirtyState();
  const currentDocuments = h.state.docs, currentWorkspace = h.state.workspace;
  h.setIndex([catalogEntry(otherPath, h.state.activePath)], { name: '不能替换' });
  await h.runtime.loadData();
  assert.equal(h.state.docs, currentDocuments);
  assert.equal(h.state.workspace, currentWorkspace);
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.ok(documents.includes(h.doc));
  assert.equal(workspace.name, '原项目');
});

for (const missing of ['empty', 'unrelated']) {
  test(`index refresh: a ${missing} rebuild result retains the successfully saved document and allows retry`, async () => {
    const h = await indexHarness();
    await h.runtime.enterEditMode(); h.source.value = edited;
    const documents = h.state.docs, workspace = h.state.workspace;
    h.setIndex(missing === 'empty' ? [] : [catalogEntry('design-data/design-rules/另一份.md')], { name: '不完整目录' });
    await h.runtime.saveCurrentDoc();
    assert.equal(h.files.get(h.doc.sourcePath).content, edited);
    assert.equal(h.state.docs, documents);
    assert.equal(h.state.workspace, workspace);
    assert.equal(h.state.activePath, h.doc.path);
    assert.equal(h.state.isEditing, true);
    assert.equal(h.state.isSaving, false);
    assert.equal(h.state.isRebuilding, false);
    assert.equal(h.state.editHasUnsavedChanges, false);
    assert.equal(h.state.activeEditSourceVersion, '2');
    assert.equal(h.runtime.getCurrentEditContent(), edited);
    assert.match(h.element('docEditStatus').textContent, /失败.*正在编辑/);
    h.setIndex([catalogEntry(h.doc.sourcePath)]);
    await h.runtime.rebuildIndexForDoc(h.doc);
    assert.equal(h.state.activePath, 'rule/重建后的条目');
    assert.match(h.element('docEditStatus').textContent, /重建完成/);
    assert.equal(h.writes.length, 1, 'retrying the index must not resubmit the saved file');
  });
}

for (const overlapping of [false, true]) {
  test(`index refresh: saved source bytes survive reindexing and editor exit (overlapping refresh: ${overlapping})`, async () => {
    const h = await indexHarness();
    await h.runtime.enterEditMode(); h.source.value = edited;
    h.setIndex([catalogEntry(h.doc.sourcePath)]);
    const pending = overlapping ? h.pauseWrite() : null;
    const saving = h.runtime.saveCurrentDoc();
    if (pending) {
      await h.runtime.loadData();
      assert.equal(h.runtime.getCurrentEditContent(), edited);
      pending.resolve();
    }
    await saving;
    assert.equal(h.state.activePath, 'rule/重建后的条目');
    assert.equal(h.state.activeEditSourceVersion, '2');
    h.runtime.exitEditMode();
    const current = h.runtime.getActiveDoc();
    assert.equal(current._sourceCachedText, edited);
    assert.equal(current._sourceVersion, '2');
    assert.equal(h.source.value, edited.replaceAll('\r\n', '\n'));
    await h.runtime.enterEditMode();
    assert.equal(h.runtime.getCurrentEditContent(), edited);
    assert.equal(h.state.editHasUnsavedChanges, false);
    assert.deepEqual(h.errors, []);
  });
}

test('index refresh: a new file keeps its saved source and version when assigned its first catalog ID', async () => {
  const h = await indexHarness();
  const sourcePath = 'design-data/design-rules/首次建立.md';
  h.setIndex([catalogEntry(sourcePath)]);
  await h.runtime.enterCreateMode();
  h.element('docCreatePathInput').value = sourcePath;
  h.runtime.replaceMediaDraftSource(edited);
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes[0].isCreate, true);
  assert.equal(h.state.activePath, 'rule/重建后的条目');
  assert.equal(h.state.isCreating, false);
  h.runtime.exitEditMode();
  assert.equal(h.runtime.getActiveDoc()._sourceCachedText, edited);
  assert.equal(h.runtime.getActiveDoc()._sourceVersion, '2');
  assert.equal(h.source.value, edited.replaceAll('\r\n', '\n'));
  assert.deepEqual(h.errors, []);
});

for (const mode of ['source', 'blocks']) {
  test(`index refresh: remapping a ${mode} draft preserves its dirty state and restores only the read baseline on discard`, async () => {
    const h = await indexHarness();
    await h.runtime.enterEditMode();
    if (mode === 'blocks') h.runtime.setEditInputMode('blocks');
    const input = mode === 'blocks' ? h.element('docBlockEditor').querySelectorAll('textarea')[1] : h.source;
    input.value += '未保存的草稿';
    h.runtime.refreshEditSessionDirtyState();
    const draft = h.runtime.getCurrentEditContent();
    h.setIndex([catalogEntry(h.doc.sourcePath)]);
    await h.runtime.loadData();
    assert.equal(h.state.activeEditPath, 'rule/重建后的条目');
    assert.equal(h.state.editInputMode, mode);
    assert.equal(h.state.editHasUnsavedChanges, true);
    assert.equal(h.state.activeEditSourceVersion, '1');
    assert.equal(h.runtime.getCurrentEditContent(), draft);
    h.runtime.window.confirm = () => true;
    h.runtime.exitEditMode();
    assert.equal(h.source.value, original.replaceAll('\r\n', '\n'));
    assert.equal(h.runtime.getActiveDoc()._sourceCachedText, original);
    assert.equal(h.files.get(h.doc.sourcePath).content, original);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
  });
}
