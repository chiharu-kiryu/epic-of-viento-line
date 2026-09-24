import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup } from '../lib/media-format.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { deferred, editorHarness } from './editor-harness.mjs';

const original = '\uFEFF# 角色\r\n\r\n保留这一段。\r\n\r\n插在这里：之后\r\n';
const asset = { id: 'abcdefab-1234-5678-90ab-abcdefabcdef', name: '立绘.png', kind: 'image', status: 'available', size: 68, url: '/asset-files/abcdefab-1234-5678-90ab-abcdefabcdef' };
const file = { name: asset.name, size: asset.size };

// The real media and editor controllers share the event-capable DOM. Browser
// focus deliberately remains on another block when a drop reaches its target.
async function mediaEditor({ media = {}, editor = {}, blocks = true } = {}) {
  const uploads = [], writes = [];
  const ui = await dialogHarness('app-media-editor', {
    MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup,
    loadMediaAssets: async () => ({ assets: [asset] }),
    uploadMediaFile: async (file, options) => { uploads.push({ file, ...options }); return { asset }; },
    prepareDraftMedia: async content => ({ content, media: [] }),
    renderMedia: () => ui.document.createElement('img'),
    ...media,
  });
  const h = await editorHarness({
    document: ui.document,
    readDocSource: async () => ({ content: original, version: '1' }),
    writeDoc: async payload => { writes.push(payload); return { version: '2' }; },
    ...editor,
  });
  const { runtime, state, doc } = h;
  state.workspace = { paths: PROJECT_DEFAULTS.paths, documentTypes: PROJECT_DEFAULTS.documentTypes };
  doc.sourcePath = 'documents/角色.md'; doc.category = 'document';
  const controller = ui.runtime.setupMediaEditor({
    isEditable: () => runtime.isInEditSession() && runtime.isEditModeActive(),
    isBusy: runtime.isEditorBusy, getContext: runtime.mediaDraftContext,
    setBusy: busy => { state.isImportingMedia = busy; runtime.refreshEditButtons(); },
    insertText: runtime.insertMediaText, replaceSource: runtime.replaceMediaDraftSource,
    changed: runtime.refreshEditSessionDirtyState, status: runtime.setEditorStatus,
  });
  runtime.testMediaController = controller;
  vm.runInContext('mediaEditorController = testMediaController;', runtime);
  runtime.rebuildIndexForDoc = async () => {};
  runtime.updateEditorForDoc(doc); await runtime.enterEditMode();
  assert.equal(state.isEditing, true, 'the fixture must enter an editable project document');
  if (blocks) runtime.setEditInputMode('blocks');
  const inputs = () => blocks ? ui.element('docBlockEditor').querySelectorAll('textarea') : [ui.element('docSourceEditor')];
  const drop = (target, files = [file]) => target.dispatch('drop', { bubbles: true, dataTransfer: { files, types: ['Files'] } });
  return { ...ui, ...h, document: ui.document, element: ui.element, uploads, writes, inputs, drop };
}

function select(input, start, end = start, focus = false) {
  input.selectionStart = start; input.selectionEnd = end;
  if (focus) { input.focus(); input.dispatch('focusin', { bubbles: true }); }
}

function added(selected = asset) { return `\n\n${mediaMarkup(selected)}\n\n`; }

for (const focus of ['another block', 'the drop target', 'toolbar']) test(`dropping on a block uses that block while focus remains on ${focus}`, async () => {
  const h = await mediaEditor();
  const [heading, untouched, target] = h.inputs();
  const saved = h.inputs().map(input => input.value);
  select(untouched, 0, 4, true);
  if (focus === 'toolbar') h.element('docMediaInsertBtn').focus();
  select(target, 5, 5, focus === 'the drop target');
  assert.equal(h.drop(target).defaultPrevented, true);
  await flushDialogs();
  assert.equal(untouched.value, saved[1], 'the previous block selection must not be replaced');
  assert.equal(heading.value, saved[0], 'falling back to the first block also inserts into the wrong place');
  assert.equal(target.value, saved[2].slice(0, 5) + added() + saved[2].slice(5));
  assert.equal(h.document.activeElement, target);
  assert.equal(h.state.editHasUnsavedChanges, true); assert.equal(h.runtime.isEditorBusy(), false);
  assert.deepEqual(h.writes, [], 'importing must only change the draft');
});

test('pasting into the active block and choosing existing media still respect the captured selection', async () => {
  const h = await mediaEditor();
  const [, untouched, target] = h.inputs();
  const before = untouched.value, targetBefore = target.value;
  select(target, 5, 6, true);
  target.dispatch('paste', { bubbles: true, clipboardData: { files: [file] } });
  await flushDialogs();
  assert.equal(target.value, targetBefore.slice(0, 5) + added() + targetBefore.slice(6));
  assert.equal(untouched.value, before);
  const afterPaste = target.value;
  select(target, target.value.length, target.value.length, true);
  h.element('docMediaInsertBtn').click(); await flushDialogs();
  h.element('docMediaList').querySelector('button').click(); await flushDialogs();
  assert.equal(target.value, afterPaste + added()); assert.equal(untouched.value, before);
  assert.equal(h.uploads.length, 1, 'existing media is reused without another upload');
});

test('a queued close cannot clear the target or pending list of a reopened media dialog', async () => {
  const requests = [];
  const h = await mediaEditor({ media: { loadMediaAssets: () => { const pending = deferred(); requests.push(pending); return pending.promise; } } });
  const [, untouched, target] = h.inputs(), before = target.value;
  select(untouched, 0, 4, true);
  h.element('docMediaInsertBtn').click();
  h.element('docMediaCloseBtn').click();
  select(target, 5, 5, true);
  h.element('docMediaInsertBtn').click();
  await flushDialogs(); // Deliver the old close only after the new window opens.
  requests[0].resolve({ assets: [{ ...asset, name: '旧列表.png' }] });
  await flushDialogs();
  assert.equal(h.element('docMediaList').querySelector('button'), null);
  requests[1].resolve({ assets: [asset] }); await flushDialogs();
  const choice = h.element('docMediaList').querySelector('button');
  assert.ok(choice, 'the new list response must not be invalidated by the old close event');
  choice.click(); await flushDialogs();
  assert.equal(target.value, before.slice(0, 5) + added() + before.slice(5));
  assert.equal(untouched.value, '保留这一段。');
});

test('dropping outside an input uses the active editor and source mode preserves its selection', async () => {
  const h = await mediaEditor({ blocks: false });
  const [input] = h.inputs(), before = input.value;
  select(input, 3, 5, true);
  h.drop(h.document.querySelector('.doc-editor-surface')); await flushDialogs();
  assert.equal(input.value, before.slice(0, 3) + added() + before.slice(5));
  assert.equal(h.runtime.getCurrentEditContent(), input.value.replace(/\n/g, '\r\n'));
});

test('cancelled and late uploads leave both the focused block and drop target intact', async () => {
  const pending = deferred(); let signal;
  const h = await mediaEditor({ media: { uploadMediaFile: (_file, options) => { signal = options.signal; return pending.promise; } } });
  const [, untouched, target] = h.inputs(), before = h.inputs().map(input => input.value);
  select(untouched, 0, 4, true); select(target, 5);
  h.drop(target);
  assert.equal(h.runtime.isEditorBusy(), true);
  h.element('docMediaAbortBtn').click(); assert.equal(signal.aborted, true);
  pending.resolve({ asset }); await flushDialogs();
  assert.deepEqual(h.inputs().map(input => input.value), before);
  assert.equal(h.runtime.isEditorBusy(), false); assert.equal(h.state.editHasUnsavedChanges, false);
  assert.match(h.element('docMediaMessage').textContent, /已取消导入.*已导入的 1 份素材/);
  // Retry with the already imported asset; the original drop target is retained.
  h.element('docMediaList').querySelector('button').click(); await flushDialogs();
  assert.equal(untouched.value, before[1]);
  assert.equal(target.value, before[2].slice(0, 5) + added() + before[2].slice(5));
});

test('a late upload cannot insert into a changed document or a replaced block', async () => {
  const pending = deferred();
  const h = await mediaEditor({ media: { uploadMediaFile: () => pending.promise } });
  const [, untouched, target] = h.inputs();
  select(untouched, 0, 4, true); select(target, 5); h.drop(target);
  h.runtime.replaceMediaDraftSource(original.replace('插在这里', '另一份草稿'));
  const changed = h.runtime.getCurrentEditContent();
  pending.resolve({ asset }); await flushDialogs();
  assert.equal(h.runtime.getCurrentEditContent(), changed);
  assert.equal(h.runtime.isEditorBusy(), false);
  assert.match(h.element('docMediaMessage').textContent, /文档已变化/);
});

test('dropped image, audio and video survive actual HTTP import, save, reopen and reference indexing in the target block', async t => {
  const root = await fixture(t), sourcePath = 'documents/角色.md';
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '拖放测试', createdAt: 1,
    paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, sourcePath, original); await registerWorkspace(root);
  const base = await serve(t, root), imported = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
  const files = [['立绘.png', png], ['配音.wav', wav], ['片段.mp4', mp4]].map(([name, bytes]) => ({ name, bytes, size: bytes.length }));
  const h = await mediaEditor({
    editor: {
      readDocSource: async ({ pathValue }) => { const result = await request(base, `/api/doc?path=${encodeURIComponent(pathValue)}`); assert.equal(result.status, 200); return result.data; },
      writeDoc: async ({ pathValue, content, expectedVersion }) => { const result = await request(base, '/api/doc', { path: pathValue, content, expectedVersion }); assert.equal(result.status, 200); return result.data; },
    },
    media: {
      loadMediaAssets: async () => (await request(base, '/api/assets')).data,
      uploadMediaFile: async (file, { signal }) => {
        const response = await fetch(`${base}/api/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file.bytes, signal });
        assert.equal(response.status, 200); const payload = (await response.json()).data; imported.push(payload.asset); return payload;
      },
    },
  });
  const [, untouched, target] = h.inputs(), before = h.inputs().map(input => input.value);
  select(untouched, 0, 4, true); select(target, 5); h.drop(target, files);
  const deadline = Date.now() + 10000;
  while (h.runtime.isEditorBusy() && Date.now() < deadline) await delay(10);
  assert.equal(h.runtime.isEditorBusy(), false); assert.equal(imported.length, 3);
  assert.equal(untouched.value, before[1]);
  assert.equal(target.value, before[2].slice(0, 5) + `\n\n${imported.map(mediaMarkup).join('\n\n')}\n\n` + before[2].slice(5));
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), original);
  const expected = h.runtime.getCurrentEditContent();
  assert.ok(expected.startsWith('\uFEFF')); assert.equal(expected.replace(/\r\n/g, '').includes('\n'), false);
  await h.runtime.saveCurrentDoc();
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), expected);
  h.runtime.resetDocEditorState(); await h.runtime.enterEditMode();
  assert.equal(h.runtime.getCurrentEditContent(), expected);
  assert.equal(h.state.editHasUnsavedChanges, false);
  const reopened = await request(base, `/api/doc?path=${encodeURIComponent(sourcePath)}`); assert.equal(reopened.data.content, expected);
  assert.equal((await request(base, '/api/rebuild', { source: sourcePath })).status, 200);
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json')));
  assert.deepEqual(new Set(index.docs.find(doc => doc.source.path.endsWith(sourcePath)).assetRefs), new Set(imported.map(asset => asset.id)));
  const registry = await readRegistry(root);
  for (let i = 0; i < files.length; i++) {
    const record = registry.assets.find(asset => asset.id === imported[i].id);
    assert.deepEqual(await fs.readFile(path.join(root, 'assets', record.location.path)), files[i].bytes);
  }
  assert.deepEqual(await fs.readdir(path.join(root, '.viento/uploads')), []);
  assert.equal((await verifyWorkspace(root)).ok, true);
});
