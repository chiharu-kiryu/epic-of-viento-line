import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStorage } from '../../mobile/drafts.mjs';
import { editorHarness } from './editor-harness.mjs';

function storage() {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}

test('mobile recovery isolates works, keeps the last good copy on quota failures and retries', () => {
  const disk = storage(), one = createDraftStorage(disk, 'one'), two = createDraftStorage(disk, 'two');
  one.save({ content: 'first' }); two.save({ content: 'other' });
  const write = disk.setItem;
  disk.setItem = () => { throw new Error('quota'); };
  assert.throws(() => one.save({ content: 'next' }), /quota/);
  assert.deepEqual(createDraftStorage(disk, 'one').load(), { content: 'first' });
  disk.setItem = write;
  one.save({ content: 'next' });
  assert.deepEqual(createDraftStorage(disk, 'one').load(), { content: 'next' });
  one.save(null);
  assert.equal(createDraftStorage(disk, 'one').load(), null);
  assert.deepEqual(two.load(), { content: 'other' });
  disk.setItem('viento-mobile-draft-v1:broken', '{invalid');
  assert.throws(() => createDraftStorage(disk, 'broken').load());
  assert.equal(disk.getItem('viento-mobile-draft-v1:broken'), '{invalid');
});

test('editor recovery preserves original bytes and revision after the saved file changes', async () => {
  const first = await editorHarness();
  const original = '\uFEFF# 角色\r\n生命：100\r\n\r\n不变的故事。\r\n';
  first.begin(original, '1');
  first.state.activeEditSource = first.doc.sourcePath;
  first.source.value = original.replace('100', '175');
  first.runtime.refreshEditSessionDirtyState();
  const recovered = JSON.parse(JSON.stringify(first.runtime.captureEditorDraft()));
  assert.equal(recovered.content, original.replace('100', '175'));
  const writes = [];
  const second = await editorHarness({
    readDocSource: async () => ({ content: original.replace('100', '200'), version: '2' }),
    writeDoc: async (payload) => { writes.push(payload); throw Object.assign(new Error('conflict'), { status: 409, payload: { currentVersion: '2' } }); },
  });
  second.runtime.renderDocList = () => {};
  second.runtime.selectDoc = (path) => { second.state.activePath = path; };
  assert.equal(await second.runtime.restoreEditorDraft(recovered), true);
  assert.equal(second.runtime.getCurrentEditContent(), recovered.content);
  assert.equal(second.state.editHasUnsavedChanges, true);
  await second.runtime.saveCurrentDoc();
  assert.equal(writes[0].expectedVersion, '1', 'recovery must not rebase onto a newer file silently');
  assert.equal(second.runtime.captureEditorDraft().content, recovered.content);
  assert.equal(second.state.editHasUnsavedChanges, true);
});

test('incomplete new filenames and their text survive recovery while saving stays disabled', async () => {
  const first = await editorHarness();
  await first.runtime.enterCreateMode();
  first.element('docCreatePathInput').value = 'design-data/.unfinished.md';
  first.runtime.updateCreatePathValidation();
  first.source.value = '还没有取好文件名的正文';
  first.runtime.refreshEditSessionDirtyState();
  const draft = JSON.parse(JSON.stringify(first.runtime.captureEditorDraft()));
  const second = await editorHarness();
  assert.equal(await second.runtime.restoreEditorDraft(draft), true);
  assert.equal(second.source.value, draft.content);
  assert.equal(second.element('docCreatePathInput').value, draft.path);
  assert.equal(second.element('docSaveBtn').disabled, true);
  assert.equal(second.state.isCreating, true);
});

test('a completed native creation with a lost reply reopens cleanly instead of duplicating its draft', async () => {
  const content = '# 已创建\r\n生命：100\r\n';
  const h = await editorHarness({ readDocSource: async () => ({ content, version: '2' }) });
  h.runtime.selectDoc = (path) => { h.state.activePath = path; };
  const recovered = { format: 'viento-editor-draft', version: 1, creating: true, path: h.doc.sourcePath,
    content, documentType: 'rule', baselineContent: '', baselinePath: h.doc.sourcePath, expectedVersion: '' };
  assert.equal(await h.runtime.restoreEditorDraft(recovered), true);
  assert.equal(h.state.isCreating, false);
  assert.equal(h.state.activeEditSourceVersion, '2');
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.equal(h.runtime.captureEditorDraft(), null);
});
