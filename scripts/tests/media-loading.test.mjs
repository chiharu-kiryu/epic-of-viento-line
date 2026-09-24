import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry } from '../lib/workspace.mjs';
import { importMediaAsset } from '../lib/media-assets.mjs';
import * as format from '../lib/media-format.mjs';
import { dialogHarness } from './dialog-harness.mjs';
import { editorHarness } from './editor-harness.mjs';
import { applyLanguage, translatePage } from '../../web/i18n/index.js';

const id = 'abcdefab-1234-5678-90ab-abcdefabcdef';
const types = ['image', 'audio', 'video'];
const loaded = type => type === 'image' ? 'load' : 'loadeddata';

async function renderer(type, src = `asset:${id}`, caption = '角色原素材') {
  const h = await dialogHarness('app-media-render', format);
  const figure = h.runtime.renderMedia({ type, src, caption });
  h.document.body.appendChild(figure);
  return { ...h, figure, media: figure.querySelector(type === 'image' ? 'img' : type),
    status: figure.querySelector('.doc-media-status'), retry: () => figure.querySelector('button') };
}

for (const type of types) test(`media loading: ${type} clears a stale error after successful resource loading`, async () => {
  const h = await renderer(type);
  h.media.dispatch('error');
  assert.equal(h.status.hidden, false);
  h.media.dispatch(loaded(type));
  assert.equal(h.status.hidden, true, 'success must clear the previous error');
  h.media.dispatch('error');
  assert.equal(h.status.hidden, false, 'a later independent error remains visible');
});

for (const type of types) test(`media loading: ${type} retries only the failed element without replacing controls or autoplay`, async () => {
  const h = await renderer(type), url = h.media.src;
  const requests = []; let plays = 0;
  h.media.play = () => { plays++; };
  if (type === 'image') Object.defineProperty(h.media, 'src', { get: () => url, set: value => requests.push(value) });
  else h.media.load = () => requests.push(h.media.src);
  h.media.dispatch('error'); h.media.dispatch('error');
  assert.deepEqual(requests, [], 'errors must not trigger an automatic retry loop');
  const retry = h.retry();
  assert.ok(retry, 'a failed resource needs an explicit recovery action');
  assert.equal(retry.type, 'button'); assert.equal(retry.hidden, false);
  retry.click();
  assert.deepEqual(requests, [url]);
  assert.equal(h.status.hidden, false, 'starting a request does not prove that recovery succeeded');
  h.media.dispatch('error');
  assert.equal(retry.hidden, false);
  retry.click(); h.media.dispatch(loaded(type));
  assert.deepEqual(requests, [url, url]);
  assert.equal(retry.hidden, true); assert.equal(h.status.hidden, true);
  assert.equal(h.figure.querySelector(type === 'image' ? 'img' : type), h.media);
  assert.equal(h.figure.querySelector('figcaption').textContent, '角色原素材');
  if (type !== 'image') { assert.equal(h.figure.querySelector('a').href, url); assert.equal(h.media.controls, true); }
  assert.equal(plays, 0); assert.notEqual(h.media.autoplay, true);
});

test('media loading: invalid or external references never create a retryable resource', async () => {
  for (const src of ['https://example.org/a.png', 'javascript:alert(1)', 'assets/../private.png', 'asset:invalid']) {
    const h = await renderer('image', src);
    assert.equal(h.media, null); assert.equal(h.retry(), null);
    assert.equal(h.figure.textContent, '素材引用无效');
  }
});

test('media loading: retry and failure text follow the interface language while captions and sources stay authored', async t => {
  t.after(() => applyLanguage('zh-CN'));
  const h = await renderer('audio', `asset:${id}`, '场景');
  h.media.dispatch('error');
  assert.ok(h.retry());
  applyLanguage('en'); translatePage(h.figure);
  assert.equal(h.retry().textContent, 'Retry');
  assert.match(h.status.textContent, /audio/i);
  assert.equal(h.figure.querySelector('figcaption').textContent, '场景');
  assert.equal(h.media.src, `/asset-files/${id}`);
  h.media.dispatch('loadeddata');
  applyLanguage('zh-CN'); translatePage(h.figure);
  assert.equal(h.retry().hidden, true); assert.equal(h.status.hidden, true);
});

test('media loading: retry within the actual editor preserves dirty source, selection and other players through a mode exit', async () => {
  const h = await dialogHarness('app-media-editor', format);
  const otherId = 'abcdefab-1234-5678-90ab-abcdefabcdea';
  const source = `\uFEFF# 角色\r\n\r\n!audio[配音](asset:${id})\r\n!video[片段](asset:${otherId})\r\n`;
  const media = [{ type: 'audio', src: `asset:${id}`, caption: '配音' }, { type: 'video', src: `asset:${otherId}`, caption: '片段' }];
  const rendererSource = (await fs.readFile(new URL('../../web/modules/app-media-render.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '').replaceAll('export ', '');
  vm.runInContext(rendererSource, h.runtime);
  h.runtime.prepareDraftMedia = async () => ({ media });
  const writes = [];
  const { runtime, state, doc } = await editorHarness({ document: h.document,
    readDocSource: async () => ({ content: source, version: 'one' }),
    writeDoc: async payload => { writes.push(payload); return { version: 'two' }; } });
  const controller = h.runtime.setupMediaEditor({
    isEditable: () => runtime.isInEditSession() && runtime.isEditModeActive(), isBusy: runtime.isEditorBusy,
    getContext: runtime.mediaDraftContext,
    setBusy: busy => { state.isImportingMedia = busy; runtime.refreshEditButtons(); },
    replaceSource: runtime.replaceMediaDraftSource, insertText: runtime.insertMediaText,
    changed: runtime.refreshEditSessionDirtyState, status: runtime.setEditorStatus,
  });
  runtime.testMediaController = controller; vm.runInContext('mediaEditorController = testMediaController;', runtime);
  runtime.updateEditorForDoc(doc); await runtime.enterEditMode();
  const input = h.element('docSourceEditor');
  input.value += '\r\n未保存的正文'; input.selectionStart = 5; input.selectionEnd = 7;
  runtime.refreshEditSessionDirtyState();
  const draft = runtime.getCurrentEditContent();
  assert.equal(state.editHasUnsavedChanges, true);
  controller.refresh();
  assert.equal(h.timers.size, 1);
  const [timer, callback] = h.timers.entries().next().value; h.timers.delete(timer); await callback();
  const figure = h.element('docMediaPreview').querySelector('figure'), player = figure.querySelector('audio');
  let loads = 0, plays = 0, pauses = 0;
  player.load = () => { loads++; }; player.play = () => { plays++; }; player.pause = () => { pauses++; };
  const otherPlayer = h.element('docMediaPreview').querySelector('video');
  let otherLoads = 0, otherPauses = 0;
  otherPlayer.load = () => { otherLoads++; }; otherPlayer.pause = () => { otherPauses++; };
  player.dispatch('error');
  const retry = figure.querySelector('button'); assert.ok(retry); retry.click();
  assert.equal(loads, 1); assert.equal(plays, 0);
  assert.equal(otherLoads, 0); assert.equal(otherPauses, 0);
  assert.equal(runtime.getCurrentEditContent(), draft); assert.equal(state.editHasUnsavedChanges, true);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [5, 7]); assert.deepEqual(writes, []);
  // Cancelling a dirty-mode exit keeps the same failed/retrying player.
  runtime.window.confirm = () => false; runtime.setMode('browse');
  assert.equal(state.mode, 'edit'); assert.equal(h.element('docMediaPreview').hidden, false);
  player.dispatch('loadeddata'); assert.equal(retry.hidden, true);
  runtime.window.confirm = () => true; runtime.setMode('browse');
  assert.equal(h.element('docMediaPreview').hidden, true); assert.ok(pauses > 0);
  player.dispatch('loadeddata');
  assert.equal(h.element('docMediaPreview').hidden, true); assert.equal(plays, 0); assert.deepEqual(writes, []);
});

for (const type of types) test(`media loading: ${type} recovers a temporarily missing registered file through its original HTTP URL`, async t => {
  const root = await fixture(t), sourcePath = 'design-data/角色.md';
  await write(root, sourcePath, '\uFEFF# 角色\r\n'); await registerWorkspace(root);
  const bytes = type === 'image'
    ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64')
    : type === 'video' ? Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)])
      : Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]);
  const extension = { image: 'png', audio: 'wav', video: 'mp4' }[type];
  const imported = await importMediaAsset(root, Readable.from([bytes]), `角色.${extension}`);
  const source = `\uFEFF# 角色\r\n\r\n${format.mediaMarkup(imported.asset)}\r\n`;
  await write(root, sourcePath, source);
  const record = (await readRegistry(root)).assets.find(asset => asset.id === imported.asset.id);
  const assetPath = path.join(root, 'assets', record.location.path), offlinePath = assetPath + '.offline';
  const base = await serve(t, root);
  assert.equal((await request(base, '/api/rebuild', { source: sourcePath })).status, 200);
  const registry = await readRegistry(root);
  const indexPath = path.join(root, '.viento/cache/indexes/documents.json');
  const indexesBefore = await fs.readFile(indexPath);
  const h = await renderer(type, imported.asset.src, imported.asset.name);
  const url = h.media.src, responses = [], requests = [];
  const load = () => {
    const pending = (async () => {
      const response = await fetch(base + url); responses.push(response.status);
      if (response.ok) { assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); h.media.dispatch(loaded(type)); }
      else { await response.arrayBuffer(); h.media.dispatch('error'); }
    })();
    requests.push(pending); return pending;
  };
  if (type === 'image') Object.defineProperty(h.media, 'src', { get: () => url, set: value => { assert.equal(value, url); void load(); } });
  else h.media.load = load;
  await fs.rename(assetPath, offlinePath); await load();
  assert.equal(h.status.hidden, false);
  assert.ok(h.retry()); h.retry().click(); await requests.at(-1);
  assert.deepEqual(responses, [404, 404]); assert.equal(h.retry().hidden, false);
  await fs.rename(offlinePath, assetPath); h.retry().click(); await requests.at(-1);
  assert.deepEqual(responses, [404, 404, 200]); assert.equal(h.status.hidden, true); assert.equal(h.retry().hidden, true);
  assert.deepEqual(await readRegistry(root), registry); assert.deepEqual(await fs.readFile(assetPath), bytes);
  assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), source);
  assert.deepEqual(await fs.readFile(indexPath), indexesBefore);
});
