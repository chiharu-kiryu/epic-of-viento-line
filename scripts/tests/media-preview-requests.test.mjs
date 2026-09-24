import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { deferred, editorHarness } from './editor-harness.mjs';
import * as format from '../lib/media-format.mjs';
import { fetchJsonApiRequest } from '../../web/modules/app-services.js';

const id = 'abcdefab-1234-5678-90ab-abcdefabcdef';
const media = [{ type: 'audio', src: `asset:${id}`, caption: '配音' }];
const original = `\uFEFF# 角色\r\n\r\n!audio[配音](asset:${id})\r\n`;
const asset = { id, name: '配音.wav', kind: 'audio', status: 'available', size: 46, url: `/asset-files/${id}` };

async function previewHarness({ prepare, source = original, extension = 'md' } = {}) {
  const requests = [], writes = [];
  const h = await dialogHarness('app-media-editor', {
    ...format,
    loadMediaAssets: async () => ({ assets: [asset] }),
    uploadMediaFile: async () => ({ asset }),
    prepareDraftMedia: (content, path, ids, documentType, signal) => {
      const pending = deferred();
      const request = { ...pending, content, path, ids, documentType, signal };
      requests.push(request);
      return prepare ? prepare(content, path, ids, documentType, signal) : pending.promise;
    },
    renderMedia: item => {
      const player = h.document.createElement(item.type); player.src = item.src; player.paused = true;
      player.pause = () => { player.paused = true; }; player.play = () => { player.paused = false; };
      return player;
    },
  });
  const { runtime, state, doc } = await editorHarness({ document: h.document,
    readDocSource: async () => ({ content: source, version: '1' }),
    writeDoc: async payload => { writes.push(payload); return { version: '2' }; } });
  doc.sourcePath = `design-data/design-rules/角色.${extension}`;
  const controller = h.runtime.setupMediaEditor({
    isEditable: () => runtime.isInEditSession() && runtime.isEditModeActive(), isBusy: runtime.isEditorBusy,
    getContext: runtime.mediaDraftContext,
    setBusy: busy => { state.isImportingMedia = busy; runtime.refreshEditButtons(); },
    replaceSource: runtime.replaceMediaDraftSource, insertText: runtime.insertMediaText,
    changed: runtime.refreshEditSessionDirtyState, status: runtime.setEditorStatus,
  });
  runtime.testMediaController = controller; vm.runInContext('mediaEditorController = testMediaController;', runtime);
  runtime.rebuildIndexForDoc = async () => {};
  runtime.updateEditorForDoc(doc); await runtime.enterEditMode();
  assert.equal(state.isEditing, true); assert.equal(state.activeEditSourceVersion, '1');
  const input = h.element('docSourceEditor');
  const start = () => {
    assert.equal(h.timers.size, 1, 'there should be one debounced preview');
    const [timer, callback] = h.timers.entries().next().value; h.timers.delete(timer); return callback();
  };
  const change = value => { input.value = value; runtime.refreshEditSessionDirtyState(); input.dispatch('input', { bubbles: true }); };
  return { ...h, runtime, state, doc, controller, input, requests, writes, start, change };
}

function assertCancelled(request) {
  assert.ok(request.signal, 'preview requests must have their own cancellation signal');
  assert.equal(request.signal.aborted, true, 'an obsolete preview must stop before another debounce');
}

test('preview requests: new input cancels the pending draft immediately and only the newest result is shown', async () => {
  const h = await previewHarness(), first = h.start(), old = h.requests.at(-1);
  h.change(h.input.value + '\n新的正文');
  assertCancelled(old); assert.equal(h.requests.length, 1);
  const latest = h.start(), next = h.requests.at(-1);
  assert.equal(next.signal.aborted, false); assert.notEqual(next.signal, old.signal);
  next.resolve({ media }); await latest;
  const player = h.element('docMediaPreview').querySelector('audio');
  old.resolve({ media: [] }); await first;
  assert.equal(h.element('docMediaPreview').querySelector('audio'), player);
  assert.equal(h.state.editHasUnsavedChanges, true); assert.deepEqual(h.writes, []);
});

for (const action of ['remove media', 'exit editor', 'change path', 'change type', 'start save']) test(`preview requests: ${action} cancels the old request without reviving its result`, async () => {
  const h = await previewHarness(), pending = h.start(), request = h.requests.at(-1);
  if (action === 'remove media') h.change('# 只保留文字\n');
  else if (action === 'exit editor') h.runtime.setMode('browse');
  else if (action === 'change path') { h.doc.sourcePath = 'design-data/design-rules/另一份.md'; h.controller.refresh(); }
  else if (action === 'change type') { h.doc.category = 'story'; h.controller.refresh(); }
  else { h.state.isSaving = true; h.runtime.refreshEditButtons(); }
  assertCancelled(request);
  request.resolve({ media }); await pending;
  assert.equal(h.element('docMediaPreview').hidden, true); assert.deepEqual(h.writes, []);
  if (['remove media', 'exit editor', 'start save'].includes(action)) assert.equal(h.timers.size, 0);
  else {
    const fresh = h.start(), current = h.requests.at(-1);
    if (action === 'change path') assert.equal(current.path, h.doc.sourcePath);
    else assert.equal(current.documentType, 'story');
    current.resolve({ media }); await fresh;
    assert.equal(h.element('docMediaPreview').hidden, false);
  }
});

test('preview requests: a late cancelled completion cannot erase the newer cancellation owner', async () => {
  const h = await previewHarness(), first = h.start(), old = h.requests.at(-1);
  h.change(h.input.value + '\n第一次变化');
  const second = h.start(), newer = h.requests.at(-1);
  assertCancelled(old);
  old.resolve({ media }); await first;
  assert.equal(newer.signal.aborted, false);
  h.change(h.input.value + '\n第二次变化'); assertCancelled(newer);
  newer.reject(new DOMException('cancelled', 'AbortError')); await second;
  const last = h.start(); h.requests.at(-1).resolve({ media }); await last;
  assert.equal(h.element('docMediaPreview').hidden, false);
});

test('preview requests: cancellation and failed parsing preserve the last player, draft and selection until a valid retry', async () => {
  const h = await previewHarness(), initial = h.start(); h.requests.at(-1).resolve({ media }); await initial;
  const player = h.element('docMediaPreview').querySelector('audio'); player.play();
  h.controller.refresh(); const obsolete = h.start(), old = h.requests.at(-1);
  h.change(h.input.value + '\n未完成的内容'); h.input.selectionStart = 3; h.input.selectionEnd = 6;
  const draft = h.runtime.getCurrentEditContent(); assertCancelled(old);
  old.reject(new DOMException('cancelled', 'AbortError')); await obsolete;
  const invalid = h.start(); h.requests.at(-1).reject(new Error('暂时无法解析')); await invalid;
  assert.equal(h.element('docMediaPreview').querySelector('audio'), player); assert.equal(player.paused, false);
  assert.equal(h.runtime.getCurrentEditContent(), draft); assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [3, 6]);
  h.controller.refresh(); const retry = h.start(); h.requests.at(-1).resolve({ media }); await retry;
  assert.equal(h.element('docMediaPreview').querySelector('audio'), player); assert.equal(player.paused, false);
  await h.runtime.saveCurrentDoc(); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].content, draft);
});

for (const importing of [false, true]) test(`preview requests: cancelling a preview does not cancel structured ${importing ? 'upload' : 'reuse'} insertion`, async () => {
  const source = `\uFEFF{ "title": "角色", "number": 0, "media": ${JSON.stringify(media)} }\r\n`;
  const h = await previewHarness({ source, extension: 'json' }), pending = h.start(), preview = h.requests.at(-1);
  h.element('docMediaInsertBtn').click(); await flushDialogs();
  if (importing) {
    const picker = h.element('docMediaFileInput'); picker.files = [{ name: '配音.wav', size: 46 }]; picker.dispatch('change'); await flushDialogs();
  } else h.element('docMediaList').querySelector('button').click();
  assertCancelled(preview);
  const insertion = h.requests.at(-1);
  assert.equal(insertion.ids.length, 1); assert.equal(insertion.ids[0], id);
  if (importing) { assert.equal(insertion.signal.aborted, false); assert.notEqual(insertion.signal, preview.signal); }
  h.controller.refresh();
  if (importing) assert.equal(insertion.signal.aborted, false, 'preview refresh must not abort an explicit import');
  preview.resolve({ media: [] }); await pending;
  const nextSource = source.replace('"number": 0', '"number": 0, "附件": []');
  insertion.resolve({ content: nextSource, media }); await flushDialogs();
  assert.equal(h.runtime.getCurrentEditContent(), nextSource);
  assert.equal(h.state.isImportingMedia, false); assert.equal(h.state.editHasUnsavedChanges, true); assert.deepEqual(h.writes, []);
});

test('preview requests: debounce still sends only the final draft without locking or changing it', async () => {
  const h = await previewHarness();
  for (let i = 0; i < 8; i++) h.change(h.input.value + `\n内容 ${i}`);
  assert.equal(h.requests.length, 0); assert.equal(h.runtime.isEditorBusy(), false);
  const content = h.runtime.getCurrentEditContent(), pending = h.start();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].content, content);
  h.requests[0].resolve({ media }); await pending;
  assert.equal(h.runtime.getCurrentEditContent(), content); assert.deepEqual(h.writes, []);
});

async function deadline(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 3000); })]); }
  finally { clearTimeout(timer); }
}

for (const headers of [false, true]) test(`preview requests: real HTTP cancellation closes a held ${headers ? 'response body' : 'pre-header connection'} and permits a fresh preview`, async t => {
  const arrived = deferred(), closed = deferred(), requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    if (requests.length === 1) {
      res.on('close', () => closed.resolve({ ended: res.writableEnded }));
      if (headers) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"ok":true,'); }
      arrived.resolve();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { media } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/assets/insert`;
  const client = await dialogHarness('app-doc-service', { API_PATHS: { MEDIA_INSERT: url }, fetchJsonApiRequest });
  const h = await previewHarness({ prepare: client.runtime.prepareDraftMedia });
  const pending = h.start(); await deadline(arrived.promise, 'first request never reached the server');
  h.change(h.input.value + '\n新的内容');
  assert.deepEqual(await deadline(closed.promise, 'obsolete connection did not close'), { ended: false });
  assertCancelled(h.requests[0]);
  await pending;
  const latest = h.start(); await deadline(latest, 'fresh preview did not finish');
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].assetIds, []); assert.deepEqual(requests[1].assetIds, []);
  assert.equal(requests[1].content, h.runtime.getCurrentEditContent());
  assert.equal(h.element('docMediaPreview').hidden, false); assert.equal(h.runtime.isEditorBusy(), false); assert.deepEqual(h.writes, []);
});
