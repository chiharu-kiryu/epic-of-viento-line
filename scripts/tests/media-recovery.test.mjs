import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup } from '../lib/media-format.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { deferred } from './editor-harness.mjs';

const importedAsset = { id: 'abcdefab-1234-5678-90ab-abcdefabcdef', name: '新配音.wav', kind: 'audio', size: 46, status: 'available', url: '/asset-files/abcdefab-1234-5678-90ab-abcdefabcdef' };
const existingAsset = { ...importedAsset, id: 'abcdefab-1234-5678-90ab-abcdefabcdea', name: '旧立绘.png', kind: 'image' };
const first = { name: importedAsset.name, size: importedAsset.size }, second = { name: '损坏.png', size: 10 };

async function mediaPicker({ sourcePath = 'documents/角色.md', content = '# 角色\n\n保留正文。\n', assets = [existingAsset], services = {}, field = false, mediaReference = false } = {}) {
  const uploads = [], notices = [], preparations = [];
  let busy = false, dirty = false, reads = 0;
  const ui = await dialogHarness('app-media-editor', {
    MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup,
    loadMediaAssets: async () => { reads++; return { assets }; },
    uploadMediaFile: async (file, options) => {
      uploads.push({ file, ...options });
      if (file === second) throw new Error('文件内容与图片、视频或音频格式不符，未导入。');
      return { asset: importedAsset };
    },
    prepareDraftMedia: async (content, path, ids) => { preparations.push({ content, path, ids }); return { content: JSON.stringify({ title: '角色', 媒体: ids }), media: [] }; },
    renderMedia: () => ui.document.createElement('audio'),
    ...services,
  });
  const input = ui.element('docSourceEditor'); input.value = content;
  const original = input.value;
  input.selectionStart = input.selectionEnd = input.value.length; input.focus();
  ui.runtime.setupMediaEditor({
    isEditable: () => true, isBusy: () => busy,
    getContext: () => ({ input, path: sourcePath, content: input.value, start: input.selectionStart, end: input.selectionEnd, documentType: 'document', field, mediaReference }),
    setBusy: value => { busy = value; input.readOnly = value; },
    insertText: (target, text) => target.input.setRangeText(text, target.start, target.end, 'end'),
    replaceSource: content => { input.value = content; },
    changed: () => { dirty = input.value !== original; }, status: text => notices.push(text),
  });
  const open = async () => { ui.element('docMediaInsertBtn').click(); await flushDialogs(); };
  const upload = (files = [first, second]) => {
    const picker = ui.element('docMediaFileInput'); picker.value = 'selected-files'; picker.files = files; picker.dispatch('change');
  };
  const choice = id => ui.element('docMediaList').querySelectorAll('button').find(button => button.dataset.assetId === id);
  return { ...ui, input, original, uploads, notices, preparations, open, upload, choice,
    get busy() { return busy; }, get dirty() { return dirty; }, get reads() { return reads; } };
}

test('a structured text field inserts markup at its caret without appending root media', async () => {
  const h = await mediaPicker({ sourcePath: 'documents/角色.json', content: '前文后文', field: true });
  h.input.selectionStart = h.input.selectionEnd = 2;
  await h.open(); h.choice(existingAsset.id).click(); await flushDialogs();
  assert.equal(h.input.value, `前文${mediaMarkup(existingAsset)}后文`);
  assert.equal(h.dirty, true); assert.equal(h.busy, false); assert.deepEqual(h.preparations, []);
});

test('a media source field filters compatible assets and replaces its reference only', async () => {
  const h = await mediaPicker({ sourcePath: 'documents/角色.json', content: 'assets/voice.wav', field: true,
    mediaReference: 'audio', assets: [existingAsset, importedAsset] });
  await h.open();
  assert.equal(h.element('docMediaKind').value, 'audio'); assert.equal(h.element('docMediaKind').disabled, true);
  assert.equal(h.choice(existingAsset.id), undefined);
  h.upload([{ name: existingAsset.name, size: existingAsset.size }]); await flushDialogs();
  assert.match(h.element('docMediaMessage').textContent, /类型一致/);
  h.upload([first, first]); await flushDialogs();
  assert.match(h.element('docMediaMessage').textContent, /只能引用一份/);
  assert.equal(h.uploads.length, 0); assert.equal(h.input.value, h.original); assert.equal(h.dirty, false);
  h.choice(importedAsset.id).click(); await flushDialogs();
  assert.equal(h.input.value, `asset:${importedAsset.id}`);
  assert.equal(h.dirty, true); assert.deepEqual(h.preparations, []); assert.equal(h.busy, false);
});

function assertRecovered(h, asset = importedAsset) {
  assert.equal(h.busy, false, 'a secondary catalogue read must not keep the editor locked');
  assert.equal(h.element('docMediaDialog').open, true);
  assert.equal(h.element('docMediaCloseBtn').disabled, false);
  assert.equal(h.element('docMediaFileInput').disabled, false);
  assert.equal(h.element('docMediaFileInput').value, '');
  assert.equal(h.input.value, h.original, 'partial imports do not apply a partial source edit');
  assert.equal(h.dirty, false);
  assert.ok(h.choice(asset.id), 'the confirmed imported asset must remain selectable');
  assert.equal(h.choice(asset.id).disabled, false);
}

test('a catalogue failure after a partial import preserves a selectable asset and the original error', async () => {
  let reads = 0;
  const h = await mediaPicker({ services: { loadMediaAssets: async () => {
    if (++reads > 1) throw new Error('catalogue unavailable');
    return { assets: [existingAsset] };
  } } });
  await h.open(); h.upload(); await flushDialogs();
  assertRecovered(h);
  assert.match(h.element('docMediaMessage').textContent, /格式不符.*已导入的 1 份素材/);
  assert.ok(h.choice(existingAsset.id));
  h.choice(importedAsset.id).click(); await flushDialogs();
  assert.equal(h.input.value, h.original + `\n\n${mediaMarkup(importedAsset)}\n\n`);
  assert.equal(h.uploads.length, 2, 'recovery reuses the known asset instead of uploading it again');
  assert.equal(h.dirty, true);
});

test('cancelling the second upload releases the editor even if catalogue refresh would never finish', async t => {
  const loading = deferred(), uploading = deferred(); let reads = 0, attempts = 0, signal;
  t.after(() => loading.resolve({ assets: [existingAsset, importedAsset] }));
  const h = await mediaPicker({ services: {
    loadMediaAssets: () => ++reads === 1 ? Promise.resolve({ assets: [existingAsset] }) : loading.promise,
    uploadMediaFile: (_file, options) => {
      if (++attempts === 1) return Promise.resolve({ asset: importedAsset });
      signal = options.signal;
      signal.addEventListener('abort', () => uploading.reject(new DOMException('cancelled', 'AbortError')), { once: true });
      return uploading.promise;
    },
  } });
  await h.open(); h.upload(); await flushDialogs();
  assert.equal(h.busy, true); h.element('docMediaAbortBtn').click(); await flushDialogs();
  assert.equal(signal.aborted, true); assertRecovered(h);
  assert.match(h.element('docMediaMessage').textContent, /已取消导入.*已导入的 1 份素材/);
  assert.equal(h.element('docMediaAbortBtn').hidden, true);
  h.element('docMediaCloseBtn').click(); await flushDialogs();
  assert.equal(h.element('docMediaDialog').open, false);
});

test('a failed structured insertion retains its uploaded asset for retry without changing the draft', async () => {
  let preparation = 0, reads = 0;
  const h = await mediaPicker({ sourcePath: 'documents/角色.json', content: '{"title":"角色","number":0}\n', services: {
    loadMediaAssets: async () => { if (++reads > 1) throw new Error('catalogue unavailable'); return { assets: [] }; },
    prepareDraftMedia: async (content, _path, ids) => {
      if (++preparation === 1) throw new Error('素材准备暂时失败');
      return { content: JSON.stringify({ ...JSON.parse(content), 媒体: ids }), media: [] };
    },
  } });
  await h.open(); h.upload([first]); await flushDialogs();
  assertRecovered(h); assert.match(h.element('docMediaMessage').textContent, /素材准备暂时失败/);
  h.choice(importedAsset.id).click(); await flushDialogs();
  assert.deepEqual(JSON.parse(h.input.value), { title: '角色', number: 0, 媒体: [importedAsset.id] });
  assert.equal(h.uploads.length, 1); assert.equal(h.busy, false);
});

test('the stale list requested before importing cannot hide the recovered asset', async t => {
  const loading = deferred(); t.after(() => loading.resolve({ assets: [existingAsset] }));
  const h = await mediaPicker({ services: { loadMediaAssets: () => loading.promise } });
  await h.open(); h.upload(); await flushDialogs();
  assertRecovered(h);
  const message = h.element('docMediaMessage').textContent;
  loading.resolve({ assets: [existingAsset] }); await flushDialogs();
  assertRecovered(h); assert.equal(h.element('docMediaMessage').textContent, message);
});

test('recovered assets are visible despite old search, type and pagination filters', async () => {
  const old = Array.from({ length: 65 }, (_, i) => ({ ...existingAsset, id: `old-${i}`, name: `旧立绘-${i}.png` }));
  let reads = 0;
  const h = await mediaPicker({ services: { loadMediaAssets: async () => ({ assets: ++reads === 1 ? old : [...old, importedAsset] }) } });
  await h.open();
  h.element('docMediaSearch').value = '旧立绘'; h.element('docMediaSearch').dispatch('input');
  h.element('docMediaKind').value = 'image'; h.element('docMediaKind').dispatch('change');
  h.upload(); await flushDialogs();
  assertRecovered(h);
  assert.equal(h.element('docMediaSearch').value, ''); assert.equal(h.element('docMediaKind').value, '');
  assert.equal(h.element('docMediaList').querySelector('button').dataset.assetId, importedAsset.id);
  assert.equal(h.element('docMediaList').querySelectorAll('button').length, 60);
  h.element('docMediaMoreBtn').click();
  assert.equal(h.element('docMediaList').querySelectorAll('button').length, 66, 'prior assets remain available');
});

test('duplicate import responses refresh a cached missing asset once and retain unrelated missing assets', async () => {
  const missing = { ...importedAsset, status: 'missing' }, unrelated = { ...existingAsset, status: 'missing' };
  const h = await mediaPicker({ assets: [missing, unrelated] });
  await h.open(); h.upload([first, first, second]); await flushDialogs();
  assertRecovered(h);
  assert.equal(h.element('docMediaList').querySelectorAll('button').filter(button => button.dataset.assetId === importedAsset.id).length, 1);
  assert.equal(h.choice(unrelated.id).disabled, true);
});

test('a failure before any successful import keeps existing filters and offers a normal retry', async () => {
  const h = await mediaPicker(); await h.open();
  h.element('docMediaSearch').value = '旧立绘'; h.element('docMediaSearch').dispatch('input');
  h.element('docMediaKind').value = 'image'; h.element('docMediaKind').dispatch('change');
  h.upload([second]); await flushDialogs();
  assert.equal(h.busy, false); assert.equal(h.input.value, h.original); assert.equal(h.dirty, false);
  assert.equal(h.element('docMediaSearch').value, '旧立绘'); assert.equal(h.element('docMediaKind').value, 'image');
  assert.equal(h.choice(importedAsset.id), undefined); assert.doesNotMatch(h.element('docMediaMessage').textContent, /已导入的/);
  h.upload([first]); await flushDialogs();
  assert.equal(h.input.value, h.original + `\n\n${mediaMarkup(importedAsset)}\n\n`);
  assert.equal(h.busy, false); assert.equal(h.element('docMediaDialog').open, false);
});

test('a partial drop import can recover without having opened or fetched the project media list', async () => {
  const h = await mediaPicker({ services: { loadMediaAssets: async () => { throw new Error('catalogue unavailable'); } } });
  h.input.dispatch('drop', { bubbles: true, dataTransfer: { files: [first, second], types: ['Files'] } });
  await flushDialogs(); assertRecovered(h);
  h.choice(importedAsset.id).click(); await flushDialogs();
  assert.equal(h.input.value, h.original + `\n\n${mediaMarkup(importedAsset)}\n\n`);
});

for (const extension of ['md', 'json']) test(`${extension}: actual partial upload recovery, reuse, save, reopen and indexing preserve source and media bytes`, async t => {
  const root = await fixture(t), sourcePath = `documents/角色.${extension}`;
  const original = extension === 'md' ? '# 角色\n\n保留正文。\n' : '{ "title": "角色", "number": 0 }\n';
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '恢复测试', createdAt: 1,
    paths: PROJECT_DEFAULTS.paths, assetStores: PROJECT_DEFAULTS.assetStores, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, sourcePath, original); await registerWorkspace(root);
  const base = await serve(t, root), statuses = [], successes = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const files = [{ name: '立绘.png', size: png.length, bytes: png }, { name: '损坏.png', size: 10, bytes: Buffer.from('not an image') }];
  let catalogueAvailable = true;
  const h = await mediaPicker({ sourcePath, content: original, services: {
    loadMediaAssets: async () => { if (!catalogueAvailable) throw new Error('catalogue unavailable'); return (await request(base, '/api/assets')).data; },
    uploadMediaFile: async (file, { signal }) => {
      const response = await fetch(`${base}/api/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file.bytes, signal });
      statuses.push(response.status); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      successes.push(payload.data); return payload.data;
    },
    prepareDraftMedia: async (content, sourcePath, assetIds, documentType, signal) => {
      const response = await fetch(`${base}/api/assets/insert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, sourcePath, assetIds, documentType }), signal });
      assert.equal(response.status, 200); return (await response.json()).data;
    },
  } });
  const settle = async () => {
    const deadline = Date.now() + 10000;
    while (h.busy && Date.now() < deadline) await delay(10);
    assert.equal(h.busy, false);
  };
  await h.open(); catalogueAvailable = false; h.upload(files); await settle();
  assert.deepEqual(statuses, [200, 415]); assert.equal(successes.length, 1);
  const asset = successes[0].asset; assertRecovered(h, asset);
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), original);
  h.choice(asset.id).click(); await settle();
  assert.equal(h.dirty, true); assert.deepEqual(statuses, [200, 415]);
  const beforeSave = await request(base, `/api/doc?path=${encodeURIComponent(sourcePath)}`);
  assert.equal((await request(base, '/api/doc', { path: sourcePath, content: h.input.value, expectedVersion: beforeSave.data.version })).status, 200);
  const reopened = await request(base, `/api/doc?path=${encodeURIComponent(sourcePath)}`);
  assert.equal(reopened.data.content, h.input.value); assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), h.input.value);
  if (extension === 'md') assert.equal(reopened.data.content, original + `\n\n${mediaMarkup(asset)}\n\n`);
  else { assert.equal(JSON.parse(reopened.data.content).title, '角色'); assert.equal(JSON.parse(reopened.data.content).number, 0); }
  assert.equal((await request(base, '/api/rebuild', { source: sourcePath })).status, 200);
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json')));
  assert.deepEqual(index.docs.find(doc => doc.source.path.endsWith(sourcePath)).assetRefs, [asset.id]);
  const registry = await readRegistry(root); assert.equal(registry.assets.length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'assets', registry.assets[0].location.path)), png);
  assert.deepEqual(await fs.readdir(path.join(root, '.viento/uploads')), []);
  assert.equal((await verifyWorkspace(root)).ok, true);
});
