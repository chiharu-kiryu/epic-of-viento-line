import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { deferred, editorHarness } from './editor-harness.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { API_PATHS } from '../lib/doc-api-contract.mjs';
import { MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup } from '../lib/media-format.mjs';
import { serializeSourceDraft } from '../../web/modules/app-editor-draft.js';

async function exportHarness(overrides = {}) {
  const calls = [], releases = [], alerts = [];
  const current = { path: 'documents/角色.md', title: '角色', busy: false, dirty: false, creating: false };
  const harness = await dialogHarness('app-export', {
    API_PATHS,
    requestExport: (payload, signal) => { const pending = deferred(); calls.push({ ...pending, payload, signal }); return pending.promise; },
    releaseExport: async (id) => { releases.push(id); },
    ...overrides,
  });
  harness.runtime.window.alert = (message) => alerts.push(message);
  harness.runtime.setupExport({ getContext: () => ({ ...current }), setBusy: (busy) => { current.busy = busy; } });
  return { ...harness, calls, releases, alerts, current };
}

test('reopening an aborted export ignores its late failure and allows a fresh export', async () => {
  const { element, calls, current } = await exportHarness();
  element('docExportBtn').click(); element('docExportStartBtn').click();
  element('docExportCloseBtn').click();
  assert.equal(calls[0].signal.aborted, true);
  element('docExportBtn').click();
  calls[0].reject(new DOMException('cancelled', 'AbortError'));
  await flushDialogs();
  assert.equal(current.busy, false);
  assert.equal(element('docExportMessage').textContent, '');
  assert.equal(element('docExportStartBtn').disabled, false);
  element('docExportStartBtn').click();
  calls[1].resolve({ id: 'new', fileName: '角色.zip', bytes: 123, assetCount: 1 });
  await flushDialogs();
  assert.match(element('docExportDownload').href, /id=new/);
  assert.equal(element('docExportDownload').hidden, false);
});

test('an aborted export arriving after reopen is released without blocking the new dialog', async () => {
  const { element, calls, releases } = await exportHarness();
  element('docExportBtn').click(); element('docExportStartBtn').click();
  element('docExportCloseBtn').click(); element('docExportBtn').click();
  calls[0].resolve({ id: 'old', fileName: '旧包.zip', bytes: 123, assetCount: 0 });
  await flushDialogs();
  assert.deepEqual(releases, ['old']);
  assert.equal(element('docExportDownload').hidden, true);
  assert.equal(element('docExportStartBtn').disabled, false);
});

test('opening export during a save cannot leave a permanently busy snapshot', async () => {
  const { element, current, alerts } = await exportHarness();
  current.busy = true;
  element('docExportBtn').click();
  assert.equal(element('docExportDialog').open, false);
  assert.match(alerts[0], /完成后/);
  current.busy = false;
  element('docExportBtn').click();
  assert.equal(element('docExportStartBtn').disabled, false);
});

async function nativeExportHarness() {
  const requests = [];
  const h = await exportHarness({
    location: { href: 'http://127.0.0.1/?desktop=1' },
    fetch: (url, options) => { const pending = deferred(); requests.push({ ...pending, url, options }); return pending.promise; },
  });
  const result = (detail) => h.runtime.window.dispatch('viento-export-result', { detail });
  h.element('docExportBtn').click(); h.element('docExportStartBtn').click();
  h.calls[0].resolve({ id: 'prepared', fileName: '角色.zip', bytes: 123, assetCount: 1 });
  await flushDialogs();
  return { ...h, requests, result };
}

test('an expired native export can be regenerated in the same dialog after cancelling its save picker', async () => {
  const h = await nativeExportHarness();
  h.requests[0].resolve({ ok: true });
  h.result({ id: 'prepared', ok: true, cancelled: true }); await flushDialogs();
  assert.equal(h.current.busy, false);
  assert.equal(h.element('docExportSaveBtn').hidden, false);
  h.element('docExportSaveBtn').click();
  h.requests[1].resolve({ ok: false, status: 410, json: async () => ({ error: '导出文件已过期，请重新导出' }) });
  await flushDialogs();
  assert.equal(h.current.busy, false);
  assert.equal(h.element('docExportStartBtn').disabled, false, 'expired jobs must not block regeneration');
  assert.equal(h.element('docExportSaveBtn').hidden, true);
  assert.match(h.element('docExportMessage').textContent, /已过期.*重新导出/);
  h.element('docExportStartBtn').click();
  h.calls[1].resolve({ id: 'replacement', fileName: '角色.zip', bytes: 456, assetCount: 1 });
  await flushDialogs();
  h.requests[2].resolve({ ok: true });
  h.result({ id: 'replacement', ok: true, path: '/exports/角色.zip' }); await flushDialogs();
  assert.equal(h.current.busy, false);
  assert.match(h.element('docExportMessage').textContent, /已保存到/);
  assert.deepEqual(h.releases, ['prepared', 'replacement']);
});

test('native save failures retain a retryable package and keep close/options guarded only while the picker is pending', async () => {
  const h = await nativeExportHarness();
  assert.equal(h.current.busy, true);
  assert.equal(h.element('docExportDialog').dispatch('cancel').defaultPrevented, true);
  assert.equal(h.element('docExportDialog').open, true);
  assert.equal(h.element('docExportCloseBtn').disabled, true);
  assert.equal(h.element('docExportOptions').disabled, true);
  h.requests[0].resolve({ ok: true });
  h.result({ id: 'prepared', ok: false, error: '保存位置不可写' }); await flushDialogs();
  assert.equal(h.current.busy, false);
  assert.equal(h.element('docExportSaveBtn').disabled, false);
  assert.equal(h.element('docExportStartBtn').disabled, true);
  assert.equal(h.element('docExportCloseBtn').disabled, false);
  assert.deepEqual(h.releases, []);
  h.element('docExportSaveBtn').click();
  h.requests[1].resolve({ ok: true });
  h.result({ id: 'prepared', ok: true, path: '/exports/角色.zip' }); await flushDialogs();
  assert.equal(h.current.busy, false);
  assert.equal(h.element('docExportStartBtn').disabled, false);
  assert.deepEqual(h.releases, ['prepared']);
});

const asset = { id: 'asset-one', name: '配音.mp3', kind: 'audio', status: 'available', size: 100, url: '/asset-files/main/配音.mp3' };

async function mediaHarness() {
  const preparation = deferred(), preparing = [], uploads = [], replacements = [], notices = [];
  const harness = await dialogHarness('app-media-editor', {
    MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup,
    loadMediaAssets: async () => ({ assets: [asset] }),
    uploadMediaFile: async (file, options) => { uploads.push({ file, ...options }); return { asset }; },
    prepareDraftMedia: (...args) => { preparing.push(args); return preparation.promise; },
    renderMedia: () => harness.document.createElement('audio'),
  });
  let busy = false;
  const source = harness.element('docSourceEditor'); source.value = '{"title":"角色"}'; source.focus();
  const draft = { input: source, content: source.value, path: 'documents/角色.json', documentType: 'character', start: 0, end: 0 };
  const adapter = { isEditable: () => true, isBusy: () => busy, getContext: () => ({ ...draft }),
    setBusy: (value) => { busy = value; }, replaceSource: (content) => replacements.push(content),
    insertText: () => { throw new Error('Expected structured insertion'); }, changed() {}, status: (value) => notices.push(value),
  };
  harness.runtime.setupMediaEditor(adapter);
  return { ...harness, preparation, preparing, uploads, replacements, notices, draft, isBusy: () => busy };
}

test('cancelling media import during structured insertion keeps the draft and uploaded assets', async () => {
  const { element, preparation, preparing, replacements, notices, isBusy } = await mediaHarness();
  element('docMediaInsertBtn').click(); await flushDialogs();
  const picker = element('docMediaFileInput'); picker.files = [{ name: asset.name, size: asset.size }]; picker.dispatch('change');
  await flushDialogs();
  assert.equal(preparing.length, 1);
  assert.equal(isBusy(), true);
  element('docMediaAbortBtn').click();
  preparation.resolve({ content: '{"title":"角色","media":["asset:asset-one"]}', media: [] });
  await flushDialogs();
  assert.deepEqual(replacements, []);
  assert.equal(isBusy(), false);
  assert.equal(element('docMediaDialog').open, true);
  assert.match(notices.at(-1), /已取消导入.*已导入的 1 份素材/);
  assert.equal(element('docMediaList').querySelector('button').disabled, false);
  assert.equal(preparing[0][4].aborted, true, 'cancellation also reaches the preparation request');
});

test('late media preparation cannot overwrite a draft whose content changed', async () => {
  const { element, preparation, draft, replacements, isBusy } = await mediaHarness();
  element('docMediaInsertBtn').click(); await flushDialogs();
  element('docMediaList').querySelector('button').click();
  draft.content = '{"title":"新草稿"}';
  preparation.resolve({ content: '{"title":"旧草稿","media":[]}', media: [] });
  await flushDialogs();
  assert.deepEqual(replacements, []);
  assert.equal(isBusy(), false);
  assert.match(element('docMediaMessage').textContent, /文档已变化/);
});

test('existing media still inserts into an unchanged structured draft and releases the editor', async () => {
  const { element, preparation, replacements, isBusy } = await mediaHarness();
  element('docMediaInsertBtn').click(); await flushDialogs();
  element('docMediaList').querySelector('button').click();
  const content = '{"title":"角色","media":["asset:asset-one"]}';
  preparation.resolve({ content, media: [] });
  await flushDialogs();
  assert.deepEqual(replacements, [content]);
  assert.equal(isBusy(), false);
  assert.equal(element('docMediaDialog').open, false);
});

const previewMedia = [
  { type: 'audio', src: 'asset:abcdefab-1234-5678-90ab-abcdefabcdef', caption: '配音' },
  { type: 'video', src: 'asset:abcdefab-1234-5678-90ab-abcdefabcdea', caption: '片段' },
];
const previewSource = `\uFEFF# 角色\r\n\r\n${previewMedia.map((media) => `!${media.type}[${media.caption}](${media.src})`).join('\r\n\r\n')}\r\n`;

// Connect the actual editor and media controllers to the same DOM. Only the
// network and playback are simulated so delayed responses can be ordered.
async function mediaPreviewHarness(overrides = {}) {
  const requests = [], writes = [];
  const ui = await dialogHarness('app-media-editor', {
    MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup,
    prepareDraftMedia: (content, path, ids, documentType) => {
      const pending = deferred(); requests.push({ ...pending, content, path, ids, documentType }); return pending.promise;
    },
    renderMedia: (media) => {
      const player = ui.document.createElement(media.type);
      player.src = media.src; player.paused = true;
      player.play = () => { player.paused = false; };
      player.pause = () => { player.paused = true; };
      return player;
    },
  });
  const { runtime, state, doc } = await editorHarness({
    document: ui.document,
    readDocSource: async () => ({ content: previewSource, version: '1' }),
    writeDoc: async (payload) => { writes.push(payload); return { version: '2' }; },
    ...overrides,
  });
  const controller = ui.runtime.setupMediaEditor({
    isEditable: () => runtime.isInEditSession() && runtime.isEditModeActive(), isBusy: runtime.isEditorBusy,
    getContext: runtime.mediaDraftContext,
    setBusy: (busy) => { state.isImportingMedia = busy; runtime.refreshEditButtons(); },
    replaceSource: runtime.replaceMediaDraftSource, insertText: runtime.insertMediaText,
    changed: runtime.refreshEditSessionDirtyState, status: runtime.setEditorStatus,
  });
  runtime.testMediaController = controller;
  vm.runInContext('mediaEditorController = testMediaController;', runtime);
  runtime.rebuildIndexForDoc = async () => {};
  runtime.updateEditorForDoc(doc);
  await runtime.enterEditMode();
  const startPreview = () => {
    assert.equal(ui.timers.size, 1, 'one debounced preview should be scheduled');
    const [id, callback] = ui.timers.entries().next().value;
    ui.timers.delete(id);
    return callback();
  };
  const showMedia = async () => {
    controller.refresh();
    const pending = startPreview(); requests.at(-1).resolve({ media: previewMedia }); await pending;
    const player = ui.element('docMediaPreview').querySelector('audio');
    assert.ok(player);
    ui.element('docMediaPreview').querySelectorAll('audio, video').forEach((item) => item.play());
    return player;
  };
  return { ...ui, runtime, state, doc, controller, requests, writes, startPreview, showMedia };
}

test('media preview loads immediately after reading a document without requiring another input event', async () => {
  const h = await mediaPreviewHarness();
  const pending = h.startPreview();
  assert.equal(h.requests.at(-1).content, previewSource);
  h.requests.at(-1).resolve({ media: previewMedia }); await pending;
  assert.equal(h.element('docMediaPreview').hidden, false);
  assert.equal(h.element('docMediaPreview').querySelector('audio').paused, true);
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.deepEqual(h.writes, []);
});

for (const empty of [false, true]) test(`media preview stops when switching to browse: ${empty ? 'first unsaved document' : 'existing document'}`, async () => {
  const h = await mediaPreviewHarness({ loadTemplateContent: async () => previewSource });
  if (empty) {
    h.runtime.exitEditMode();
    h.state.docs = []; h.state.activePath = '';
    h.state.workspace = { name: '空作品', documentTypes: [{ id: 'document', label: '档案', directory: 'notes', templateSource: 'templates/document.md' }] };
    await h.runtime.enterCreateMode();
  }
  const player = await h.showMedia();
  const video = h.element('docMediaPreview').querySelector('video');
  h.runtime.setMode('browse');
  assert.equal(player.paused, true, 'a hidden editor must not keep playing');
  assert.equal(video.paused, true);
  assert.equal(h.element('docMediaPreview').hidden, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.element('docContent').hidden, false);
  assert.equal(h.state.isEditing, false);
  assert.equal(h.state.isCreating, false);
  assert.deepEqual(h.writes, []);
});

test('media preview clears the previous template immediately while a different type is loading', async () => {
  const template = deferred(); let loads = 0;
  const h = await mediaPreviewHarness({ loadTemplateContent: () => ++loads === 1 ? Promise.resolve(previewSource) : template.promise });
  h.runtime.exitEditMode();
  await h.runtime.enterCreateMode();
  const player = await h.showMedia();
  const loading = h.runtime.setCreateTypeState('item');
  assert.equal(h.state.isLoadingTemplate, true);
  assert.equal(player.paused, true);
  assert.equal(h.element('docMediaPreview').hidden, true);
  assert.equal(h.timers.size, 0, 'do not preview the old source under the new type');
  template.resolve('# 道具\n'); await loading;
  assert.equal(h.element('docSourceEditor').value, '# 道具\n');
  assert.equal(h.element('docMediaPreview').hidden, true);
  assert.deepEqual(h.writes, []);
});

test('media preview clears when types share a source path and ignores the old pending response', async () => {
  const template = deferred(); let loads = 0;
  const h = await mediaPreviewHarness({
    Date: class extends Date { constructor() { super('2026-09-23T00:00:00Z'); } },
    loadTemplateContent: () => ++loads === 1 ? Promise.resolve(previewSource) : template.promise,
  });
  h.runtime.exitEditMode();
  h.state.workspace = { version: 3, paths: { documents: 'documents' }, documentTypes: ['character', 'story'].map((id) => ({
    id, label: '档案', directory: 'notes', template: `${id}.md`, templateSource: `.viento/templates/${id}.md`,
  })) };
  await h.runtime.enterCreateMode();
  assert.equal(h.state.activeCreateType, 'character');
  const previousPath = h.state.activeCreatePath;
  const player = await h.showMedia();
  h.controller.refresh(); const pending = h.startPreview();
  const loading = h.runtime.setCreateTypeState('story');
  assert.equal(h.state.isLoadingTemplate, true);
  assert.equal(h.state.activeCreatePath, previousPath);
  assert.equal(player.paused, true);
  assert.equal(h.element('docMediaPreview').hidden, true);
  h.requests.at(-1).resolve({ media: previewMedia }); await pending;
  assert.equal(h.element('docMediaPreview').hidden, true);
  template.resolve(previewSource); await loading;
  const next = h.startPreview();
  assert.equal(h.requests.at(-1).documentType, 'story');
  h.requests.at(-1).resolve({ media: [] }); await next;
  assert.equal(h.element('docMediaPreview').hidden, true);
});

test('media preview and a first dirty draft survive a cancelled mode switch, then close together after confirmation', async () => {
  const h = await mediaPreviewHarness({ loadTemplateContent: async () => previewSource });
  h.runtime.exitEditMode();
  h.state.docs = []; h.state.activePath = '';
  h.state.workspace = { name: '空作品', documentTypes: [{ id: 'document', label: '档案', directory: 'notes', templateSource: 'templates/document.md' }] };
  await h.runtime.enterCreateMode();
  const player = await h.showMedia();
  h.element('docSourceEditor').value += '\n尚未保存';
  h.runtime.refreshEditSessionDirtyState();
  h.runtime.setMode('browse');
  assert.equal(h.state.mode, 'edit');
  assert.equal(h.state.isCreating, true);
  assert.equal(player.paused, false);
  h.runtime.window.confirm = () => true;
  h.runtime.setMode('browse');
  assert.equal(h.state.isCreating, false);
  assert.equal(h.state.isEditing, false);
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.equal(player.paused, true);
  assert.equal(h.element('docContent').hidden, false);
  assert.deepEqual(h.writes, []);
});

test('media preview keeps unchanged playback through source/block switches and saving without altering source bytes', async () => {
  const h = await mediaPreviewHarness();
  const player = await h.showMedia();
  h.runtime.setEditInputMode('blocks');
  h.runtime.setEditInputMode('source');
  await h.runtime.saveCurrentDoc();
  const pending = h.startPreview();
  assert.equal(h.requests.at(-1).content, previewSource);
  h.requests.at(-1).resolve({ media: previewMedia }); await pending;
  assert.equal(h.element('docMediaPreview').querySelector('audio'), player);
  assert.equal(player.paused, false);
  assert.equal(h.element('docMediaPreview').querySelector('video').paused, false);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].content, previewSource);
  assert.equal(h.state.editHasUnsavedChanges, false);
});

test('media preview discards a late result after removing media or leaving and reopening the editor', async () => {
  const h = await mediaPreviewHarness();
  const player = await h.showMedia();
  h.controller.refresh(); const removed = h.startPreview();
  h.element('docSourceEditor').value = '# 只保留文字\n';
  h.element('docSourceEditor').dispatch('input', { bubbles: true });
  assert.equal(player.paused, true);
  assert.equal(h.element('docMediaPreview').hidden, true);
  h.requests.at(-1).resolve({ media: previewMedia }); await removed;
  assert.equal(h.element('docMediaPreview').hidden, true);
  h.runtime.window.confirm = () => true;
  h.runtime.exitEditMode(); await h.runtime.enterEditMode();
  const old = h.startPreview(), request = h.requests.at(-1);
  h.runtime.setMode('browse'); h.runtime.setMode('edit'); await h.runtime.enterEditMode();
  request.resolve({ media: previewMedia }); await old;
  assert.equal(h.element('docMediaPreview').hidden, true);
  await h.showMedia();
  assert.equal(h.element('docMediaPreview').hidden, false);
  assert.deepEqual(h.writes, []);
});

test('template loading: changing a new draft extension refreshes media parsing and ignores the previous path response', async () => {
  const h = await mediaPreviewHarness({ loadTemplateContent: async () => previewSource });
  h.runtime.exitEditMode();
  h.state.workspace = { version: 3, paths: { documents: 'documents' }, documentTypes: [{
    id: 'character', label: '角色', directory: 'characters', template: 'character.md', templateSource: 'templates/character.md',
  }] };
  await h.runtime.enterCreateMode();
  const player = await h.showMedia();
  h.controller.refresh(); const old = h.startPreview();
  const file = 'documents/characters/新的格式.json';
  h.element('docCreatePathInput').value = file;
  h.runtime.updateCreatePathValidation(true);
  assert.equal(player.paused, true);
  assert.equal(h.element('docMediaPreview').hidden, true);
  h.requests.at(-1).resolve({ media: previewMedia }); await old;
  assert.equal(h.element('docMediaPreview').hidden, true);
  const updated = h.startPreview();
  assert.equal(h.requests.at(-1).path, file);
  assert.equal(h.requests.at(-1).documentType, 'character');
  assert.equal(h.requests.at(-1).content, previewSource);
  h.requests.at(-1).resolve({ media: [] }); await updated;
  assert.equal(h.element('docMediaPreview').hidden, true);
  assert.equal(h.runtime.getCurrentEditContent(), previewSource, 'changing paths must not rewrite the draft');
  const content = '\uFEFF' + JSON.stringify({ title: '新角色', 媒体: previewMedia });
  h.element('docSourceEditor').value = content;
  h.element('docSourceEditor').dispatch('input', { bubbles: true });
  const valid = h.startPreview();
  h.requests.at(-1).resolve({ media: previewMedia }); await valid;
  assert.equal(h.element('docMediaPreview').hidden, false);
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].pathValue, file);
  assert.equal(h.writes[0].documentType, 'character');
  assert.equal(h.writes[0].content, content);
});

async function projectHarness(content, apply = async () => {}, save = async () => {}) {
  let configuration = { workspace: { name: '测试作品' }, revision: 'one', warnings: [], entries: [{
    type: { id: 'character', label: '角色', directory: 'characters', parserProfile: 'structured' }, format: 'md', content,
  }] };
  const writes = [];
  let busy = false;
  const harness = await dialogHarness('app-project-settings', {
    serializeSourceDraft, renderDocumentLayout: () => [],
    requestProject: async (action = 'read', payload) => {
      if (action === 'read') return configuration;
      writes.push({ action, ...payload });
      if (action === 'preview') return {};
      await save(payload);
      configuration = { ...configuration, revision: 'next', entries: [{ type: payload.type, format: payload.format, content: payload.content }], preview: {} };
      return configuration;
    },
  });
  harness.runtime.setupProjectSettings({ getContext: () => ({ editable: true, workspace: { configurable: true }, busy }),
    setBusy: (value) => { busy = value; }, applied: apply,
  });
  harness.element('projectSettingsBtn').click(); await flushDialogs();
  return { ...harness, writes, isBusy: () => busy };
}

test('type settings distinguish creation from editing and retain a rejected new draft for retry or cancel', async () => {
  let attempts = 0;
  const { element, writes, isBusy } = await projectHarness('# 角色\n', async () => {}, async () => {
    if (++attempts === 1) throw new Error('类型标识已存在，请使用其他标识。');
  });
  element('projectTypeAdd').click();
  element('projectTypeId').value = 'character';
  element('projectTypeLabel').value = '自定义角色';
  element('projectTypeDirectory').value = 'custom';
  element('projectTemplateContent').value = '# 我的模板\n';
  element('projectTypeForm').dispatch('input');
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  assert.equal(writes.at(-1).create, true);
  assert.equal(isBusy(), false);
  assert.equal(element('projectSettingsDialog').open, true);
  assert.equal(element('projectSettingsDialog').dataset.dirty, 'true');
  assert.equal(element('projectTypeId').readOnly, false);
  assert.equal(element('projectTemplateContent').value, '# 我的模板\n');
  assert.match(element('projectSettingsMessage').textContent, /类型标识已存在/);
  assert.equal(element('projectTypeCancel').hidden, false);
  element('projectTypeId').value = 'custom';
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  assert.equal(writes.at(-1).create, true);
  assert.equal(element('projectTypeId').readOnly, true);
  assert.equal(element('projectSettingsDialog').dataset.dirty, 'false');
  element('projectTypeLabel').value = '新名称';
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  assert.equal(writes.at(-1).create, false);
  element('projectTypeAdd').click();
  element('projectTypeCancel').click();
  assert.equal(element('projectTypeId').value, 'custom');
  assert.equal(writes.length, 3);
});

test('template preview and save retain original BOM and line endings when only its label changes', async () => {
  const original = '\uFEFF# 角色\r\n\r\n姓名：\r\n背景：\r尾行\n';
  const { element, writes } = await projectHarness(original);
  element('projectTypeLabel').value = '人物';
  element('projectTypeForm').dispatch('input');
  element('projectTemplatePreview').click(); await flushDialogs();
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  assert.equal(writes.length, 2);
  for (const request of writes) assert.equal(request.content, original);
  element('projectTemplateContent').value = element('projectTemplateContent').value.replace('姓名：', '姓名：风');
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  assert.equal(writes.at(-1).content, original.replace('姓名：', '姓名：风'));
});

test('returning from saved project settings keeps editing locked until the new index applies', async () => {
  const pending = deferred();
  const { element, isBusy } = await projectHarness('# 角色\n', () => pending.promise);
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  element('projectSettingsClose').click();
  assert.equal(isBusy(), true);
  assert.equal(element('projectSettingsDialog').open, true);
  pending.resolve(); await flushDialogs();
  assert.equal(isBusy(), false);
  assert.equal(element('projectSettingsDialog').open, false);
});

test('discarding edits after a template save cannot leave a closed dialog marked dirty', async () => {
  const { element, writes } = await projectHarness('# 角色\n');
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  element('projectTemplateContent').value = '# 放弃这次修改\n';
  element('projectTypeForm').dispatch('input');
  assert.equal(element('projectSettingsDialog').dataset.dirty, 'true');
  element('projectSettingsClose').click(); await flushDialogs();
  assert.equal(element('projectSettingsDialog').open, false);
  assert.equal(element('projectSettingsDialog').dataset.dirty, 'false');
  assert.equal(writes.length, 1);
  element('projectSettingsBtn').click(); await flushDialogs();
  assert.equal(element('projectTemplateContent').value, '# 角色\n');
});

test('a failed project index application keeps the settings available for retry without another save', async () => {
  const pending = deferred();
  let attempts = 0;
  const { element, writes, isBusy } = await projectHarness('# 角色\n', () => ++attempts === 1 ? pending.promise : Promise.resolve());
  element('projectTypeForm').requestSubmit(); await flushDialogs();
  element('projectSettingsClose').click();
  pending.reject(new Error('刷新失败')); await flushDialogs();
  assert.equal(isBusy(), false);
  assert.equal(element('projectSettingsDialog').open, true);
  assert.equal(element('projectSettingsMessage').textContent, '刷新失败');
  element('projectSettingsClose').click(); await flushDialogs();
  assert.equal(element('projectSettingsDialog').open, false);
  assert.equal(writes.length, 1);
  assert.equal(attempts, 2);
});
