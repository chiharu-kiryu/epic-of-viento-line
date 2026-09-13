import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './editor-harness.mjs';
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

async function projectHarness(content, apply = async () => {}) {
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
