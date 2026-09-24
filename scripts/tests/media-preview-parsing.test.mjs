import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import * as format from '../lib/media-format.mjs';
import { dialogHarness } from './dialog-harness.mjs';
import { editorHarness } from './editor-harness.mjs';
import { fetchJsonApiRequest } from '../../web/modules/app-services.js';

const formats = ['json', 'yaml', 'yml'];
const picture = { type: 'image', src: 'assets/picture.svg', caption: '立绘' };
const audio = { type: 'audio', src: 'assets/voice.wav', caption: '配音' };
const source = '\uFEFF{ "title": "角色", "number": 0, "media": ' + JSON.stringify([picture, audio]) + ' }\r\n';
const malformed = source.replace(' }\r\n', '\r\n');
const escaped = '\uFEFF{ "title": "角色", "art": { "type": "image", "s\\u0072c": "assets/picture.svg", "caption": "立绘" } }\r\n';
const imageBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="teal"/></svg>');
// Route/byte fixture only; audio playback is deliberately modeled in the DOM.
const audioBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]);

async function project(t, extension, content = source) {
  const root = await fixture(t), sourcePath = `design-data/角色.${extension}`;
  await write(root, sourcePath, content);
  await write(root, 'assets/picture.svg', imageBytes); await write(root, 'assets/voice.wav', audioBytes);
  await registerWorkspace(root);
  const registry = await readRegistry(root), base = await serve(t, root);
  const preview = content => request(base, '/api/assets/insert', { content, sourcePath, assetIds: [] });
  return { root, sourcePath, registry, base, preview };
}

async function editor(p) {
  const client = await dialogHarness('app-doc-service', {
    API_PATHS: { MEDIA_INSERT: p.base + '/api/assets/insert' }, fetchJsonApiRequest,
  });
  const calls = [], writes = [];
  const h = await dialogHarness('app-media-editor', { ...format,
    prepareDraftMedia: (...args) => { calls.push(args); return client.runtime.prepareDraftMedia(...args); },
  });
  const renderer = (await fs.readFile(new URL('../../web/modules/app-media-render.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]+\n/gm, '').replaceAll('export ', '');
  vm.runInContext(renderer, h.runtime);
  const { runtime, state, doc } = await editorHarness({ document: h.document,
    readDocSource: async () => {
      const read = await request(p.base, `/api/doc?path=${encodeURIComponent(p.sourcePath)}`);
      assert.equal(read.status, 200); return read.data;
    },
    writeDoc: async payload => {
      const saved = await request(p.base, '/api/doc', { path: payload.pathValue, content: payload.content, expectedVersion: payload.expectedVersion });
      assert.equal(saved.status, 200, JSON.stringify(saved)); writes.push(payload); return saved.data;
    },
  });
  doc.sourcePath = p.sourcePath;
  const controller = h.runtime.setupMediaEditor({
    isEditable: () => runtime.isInEditSession() && runtime.isEditModeActive(), isBusy: runtime.isEditorBusy,
    getContext: runtime.mediaDraftContext,
    setBusy: busy => { state.isImportingMedia = busy; runtime.refreshEditButtons(); },
    replaceSource: runtime.replaceMediaDraftSource, insertText: runtime.insertMediaText,
    changed: runtime.refreshEditSessionDirtyState, status: runtime.setEditorStatus,
  });
  runtime.testMediaController = controller; vm.runInContext('mediaEditorController = testMediaController;', runtime);
  runtime.rebuildIndexForDoc = async () => assert.equal((await request(p.base, '/api/rebuild', { source: p.sourcePath })).status, 200);
  runtime.updateEditorForDoc(doc); await runtime.enterEditMode(); assert.equal(state.isEditing, true);
  const input = h.element('docSourceEditor'), preview = h.element('docMediaPreview');
  const run = async () => {
    assert.equal(h.timers.size, 1, 'the current structured draft must reach its parser');
    const [id, callback] = h.timers.entries().next().value; h.timers.delete(id); await callback();
  };
  const change = content => { input.value = content; runtime.refreshEditSessionDirtyState(); input.dispatch('input', { bubbles: true }); };
  return { ...h, runtime, state, doc, controller, input, preview, calls, writes, run, change };
}

for (const extension of formats) test(`preview parsing: ${extension} HTTP distinguishes an incomplete draft from a valid empty media result`, async t => {
  const p = await project(t, extension);
  const good = await p.preview(source); assert.equal(good.status, 200); assert.deepEqual(good.data.media, [picture, audio]);
  for (const content of [malformed, '{']) {
    const invalid = await p.preview(content);
    assert.equal(invalid.status, 400, 'parse failure must not be reported as an empty successful preview');
    assert.match(JSON.stringify(invalid.payload), /media_insertion_invalid/);
  }
  const empty = await p.preview('{"title":"只有文字","media":[]}'); assert.equal(empty.status, 200); assert.deepEqual(empty.data.media, []);
  const repaired = await p.preview(source); assert.equal(repaired.status, 200); assert.deepEqual(repaired.data.media, good.data.media);
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), source);
  assert.deepEqual(await readRegistry(p.root), p.registry);
  assert.deepEqual(await fs.readFile(path.join(p.root, 'assets/picture.svg')), imageBytes);
  assert.deepEqual(await fs.readFile(path.join(p.root, 'assets/voice.wav')), audioBytes);
});

for (const extension of formats) test(`preview parsing: ${extension} keeps existing players and dirty text through real parser failures, repair, save and reload`, async t => {
  const p = await project(t, extension), h = await editor(p); await h.run();
  const player = h.preview.querySelector('audio'), image = h.preview.querySelector('img');
  assert.ok(player); assert.ok(image); let pauses = 0; player.pause = () => { pauses++; };
  for (const content of [malformed, '{']) {
    h.change(content); h.input.selectionStart = 1; h.input.selectionEnd = 2;
    const draft = h.runtime.getCurrentEditContent(); await h.run();
    assert.ok(h.preview.querySelector('audio') === player, 'incomplete syntax must keep the previous player');
    assert.ok(h.preview.querySelector('img') === image); assert.equal(h.preview.hidden, false); assert.equal(pauses, 0);
    assert.equal(h.runtime.getCurrentEditContent(), draft); assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [1, 2]);
    assert.equal(h.state.editHasUnsavedChanges, true); assert.deepEqual(h.writes, []); assert.equal(h.runtime.isEditorBusy(), false);
  }
  const repaired = source.replace('"number": 0', '"number": 2'); h.change(repaired); await h.run();
  assert.ok(h.preview.querySelector('audio') === player); assert.equal(pauses, 0);
  await h.runtime.saveCurrentDoc(); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].content, repaired);
  const reopened = await request(p.base, `/api/doc?path=${encodeURIComponent(p.sourcePath)}`); assert.equal(reopened.data.content, repaired);
  const index = JSON.parse(await fs.readFile(path.join(p.root, '.viento/cache/indexes/documents.json')));
  assert.deepEqual(new Set(index.docs.find(doc => doc.source.path.endsWith(p.sourcePath)).assetRefs), new Set(p.registry.assets.map(asset => asset.id)));
  h.runtime.window.confirm = () => true; h.runtime.setMode('browse'); assert.equal(h.preview.hidden, true); assert.ok(pauses > 0);
  h.runtime.setMode('edit'); await h.runtime.enterEditMode(); await h.run(); assert.equal(h.runtime.getCurrentEditContent(), repaired); assert.ok(h.preview.querySelector('audio'));
  h.change('{"title":"不再引用素材"}'); await h.run(); assert.equal(h.preview.hidden, true); assert.equal(h.preview.querySelector('audio'), null);
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), repaired, 'removing a draft reference must not implicitly save');
  assert.deepEqual(await readRegistry(p.root), p.registry); assert.equal((await verifyWorkspace(p.root)).ok, true);
});

for (const extension of formats) test(`preview parsing: ${extension} escaped property names preview through the actual parser without literal media hints`, async t => {
  const p = await project(t, extension, escaped);
  const expected = await p.preview(escaped); assert.equal(expected.status, 200); assert.deepEqual(expected.data.media, [picture]);
  const h = await editor(p); await h.run();
  assert.equal(h.preview.hidden, false); assert.equal(h.preview.querySelector('img').src, '/assets/picture.svg');
  assert.equal(h.runtime.getCurrentEditContent(), escaped); assert.equal(h.state.editHasUnsavedChanges, false); assert.deepEqual(h.writes, []);
  assert.deepEqual(await readRegistry(p.root), p.registry);
});

test('preview parsing: an initially invalid structured draft remains editable and recovers after correcting its syntax', async t => {
  const p = await project(t, 'json', '{'), h = await editor(p); await h.run();
  assert.equal(h.preview.hidden, true); assert.equal(h.runtime.getCurrentEditContent(), '{'); assert.equal(h.runtime.isEditorBusy(), false);
  h.change(source); await h.run(); assert.equal(h.preview.hidden, false); assert.ok(h.preview.querySelector('audio'));
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), '{'); assert.deepEqual(h.writes, []);
});

test('preview parsing: plain text stays local and fenced examples never become draft players', async t => {
  const p = await project(t, 'md', '# 角色\n\n只有文字。\n'), h = await editor(p);
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 0); assert.equal(h.preview.hidden, true);
  const content = '# 角色\n\n```md\n!audio[示例](assets/voice.wav)\n```\n'; h.change(content); await h.run();
  assert.equal(h.preview.hidden, true); assert.equal(h.preview.querySelector('audio'), null);
  assert.equal(h.runtime.getCurrentEditContent(), content); assert.deepEqual(h.writes, []);
});
