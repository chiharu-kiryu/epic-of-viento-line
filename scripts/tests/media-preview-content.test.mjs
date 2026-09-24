import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { stringify } from 'yaml';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { planExport } from '../lib/export-package.mjs';
import * as format from '../lib/media-format.mjs';
import { Element } from './editor-harness.mjs';
import { dialogHarness } from './dialog-harness.mjs';
import { fetchJsonApiRequest } from '../../web/modules/app-services.js';

globalThis.location = { href: 'http://127.0.0.1/web/' };
globalThis.document = { getElementById: () => null, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment') };
const { renderDocumentLayout } = await import('../../web/modules/app-document-layout.js');

const formats = ['json', 'yaml', 'yml'];
const image = { type: 'image', src: 'assets/picture.svg', caption: '立绘说明' };
const audio = { type: 'audio', src: 'assets/voice.wav', caption: '配音说明' };
const video = { type: 'video', src: 'assets/movie.mp4', caption: '动作说明' };
// These fixtures verify references and exact bytes, not audio/video decoding.
const assets = new Map([
  ['assets/picture.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="teal"/></svg>')],
  ['assets/voice.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)])],
  ['assets/movie.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)])],
]);
const source = (extension, value) => '\uFEFF' + (extension === 'json' ? JSON.stringify(value, null, 2) + '\n' : stringify(value)).replace(/\n/g, '\r\n');

async function project(t, extension, content) {
  const root = await fixture(t), sourcePath = `design-data/素材语义.${extension}`;
  await write(root, sourcePath, content);
  for (const [file, bytes] of assets) await write(root, file, bytes);
  await registerWorkspace(root);
  const registry = await readRegistry(root), base = await serve(t, root);
  return { root, sourcePath, content, registry, base, preview: (content, assetIds = []) => request(base, '/api/assets/insert', { content, sourcePath, assetIds }) };
}

function view(content, sourcePath) {
  const parsed = parseSourceContent(content, sourcePath);
  assert.equal(parsed.parseError, undefined);
  const root = new Element();
  for (const card of renderDocumentLayout({ layout: buildDocumentLayout(parsed) })) root.appendChild(card);
  return root;
}

function labels(root) {
  return root.querySelectorAll('figcaption').map(node => node.textContent);
}

async function assertExports(p, content, expected) {
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(p.root, { kind: 'document', format, path: p.sourcePath });
    assert.equal(plan.assetCount, new Set(expected.map(item => item.src)).size);
    const body = plan.entries.find(entry => entry.path === (format === 'html' ? 'index.html' : 'document.md')).buffer.toString();
    if (format === 'html') {
      assert.deepEqual([...body.matchAll(/<(img|audio|video)\b[^>]*?(?:alt|aria-label)="([^"]*)"/g)].map(match => [match[1], match[2]]),
        expected.map(item => [item.type === 'image' ? 'img' : item.type, item.caption]));
    } else {
      assert.equal([...body.matchAll(/\]\(<assets\//g)].length, expected.length);
      for (const item of expected) assert.ok(body.includes(item.caption));
    }
    for (const entry of plan.entries.filter(entry => entry.path.startsWith('assets/'))) {
      const record = p.registry.assets.find(asset => entry.path.startsWith(`assets/${asset.id}.`));
      assert.ok(record);
      assert.deepEqual(await fs.readFile(entry.absolute), assets.get(`assets/${record.location.path}`));
    }
    assert.equal(await fs.readFile(plan.entries.find(entry => entry.path === `sources/${p.sourcePath}`).absolute, 'utf8'), content);
    await plan.validateSnapshot();
  }
}

async function assertSaved(p, expected) {
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), p.content, 'preview must not write the document');
  const read = await request(p.base, `/api/doc?path=${encodeURIComponent(p.sourcePath)}`);
  const content = p.content + '\r\n';
  assert.equal((await request(p.base, '/api/doc', { path: p.sourcePath, content, expectedVersion: read.data.version })).status, 200);
  assert.equal((await request(p.base, '/api/rebuild', { source: p.sourcePath })).status, 200);
  assert.equal((await request(p.base, `/api/doc?path=${encodeURIComponent(p.sourcePath)}`)).data.content, content);
  assert.deepEqual((await p.preview(content)).data.media, expected);
  const index = JSON.parse(await fs.readFile(path.join(p.root, '.viento/cache/indexes/documents.json')));
  const doc = index.docs.find(doc => doc.source.path.endsWith(p.sourcePath));
  assert.deepEqual(new Set(doc.assetRefs), new Set(p.registry.assets.filter(asset => expected.some(item => item.src === `assets/${asset.location.path}`)).map(asset => asset.id)));
  assert.deepEqual(labels(view(content, p.sourcePath)), expected.map(item => item.caption));
  await assertExports(p, content, expected);
  assert.deepEqual(await readRegistry(p.root), p.registry);
  for (const [file, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(p.root, file)), bytes);
  assert.equal((await verifyWorkspace(p.root)).ok, true);
}

for (const extension of formats) test(`preview content: ${extension} alt descriptions match reading and export, with caption taking precedence`, async t => {
  const value = { title: '角色', media: [
    { type: image.type, src: image.src, alt: image.caption },
    { type: audio.type, src: audio.src, caption: '', alt: audio.caption },
    { ...video, alt: '备用说明不能覆盖标题' },
  ] };
  const p = await project(t, extension, source(extension, value)), expected = [image, audio, video];
  assert.deepEqual(labels(view(p.content, p.sourcePath)), expected.map(item => item.caption));
  await assertExports(p, p.content, expected);
  const preview = await p.preview(p.content); assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.media, expected, 'draft preview must keep the same effective descriptions as the document');
  await assertSaved(p, expected);
});

for (const extension of formats) test(`preview content: ${extension} nested user type=code fields keep structured and inline media`, async t => {
  const value = { type: 'code', title: '自定义脚本角色', zero: 0, enabled: false, sections: [
    { type: 'code', illustration: image, details: { type: 'code', line: `前文 !audio[${audio.caption}](${audio.src}) 后文`, attachments: [video] } },
  ] };
  const p = await project(t, extension, source(extension, value)), expected = [image, audio, video];
  assert.deepEqual(labels(view(p.content, p.sourcePath)), expected.map(item => item.caption));
  await assertExports(p, p.content, expected);
  const preview = await p.preview(p.content); assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.media, expected, 'authored type fields are data, not parser code blocks');
  // Explicit insertion must preserve nested references and append only the selected asset.
  const asset = p.registry.assets.find(asset => asset.kind === 'image');
  const inserted = await p.preview(p.content, [asset.id]); assert.equal(inserted.status, 200);
  assert.deepEqual(inserted.data.media, [...expected, { type: 'image', src: `asset:${asset.id}`, caption: asset.name }]);
  assert.ok(inserted.data.content.startsWith('\uFEFF')); assert.doesNotMatch(inserted.data.content, /(?<!\r)\n/);
  await assertSaved(p, expected);
});

for (const extension of ['yaml', 'yml']) test(`preview content: ${extension} repeated aliases retain authored occurrences, order and unique asset packaging`, async t => {
  const content = '\uFEFFtitle: 角色\r\nfirst: &shared\r\n  illustration: ' + JSON.stringify(image) + '\r\n  line: "!audio[配音说明](assets/voice.wav)"\r\nsecond: *shared\r\nthird: [*shared]\r\n';
  const p = await project(t, extension, content), expected = [image, audio, image, audio, image, audio];
  assert.deepEqual(labels(view(p.content, p.sourcePath)), expected.map(item => item.caption));
  await assertExports(p, p.content, expected);
  const preview = await p.preview(content); assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.media, expected, 'alias reuse should not collapse repeated placements');
  await assertSaved(p, expected);
});

test('preview content: actual editor refreshes changed alt descriptions, accessible labels and download names without changing source', async t => {
  const content = source('json', { illustration: { type: image.type, src: image.src, alt: image.caption }, voice: { type: audio.type, src: audio.src, alt: audio.caption } });
  const p = await project(t, 'json', content);
  const client = await dialogHarness('app-doc-service', { API_PATHS: { MEDIA_INSERT: p.base + '/api/assets/insert' }, fetchJsonApiRequest });
  const h = await dialogHarness('app-media-editor', { ...format, prepareDraftMedia: client.runtime.prepareDraftMedia });
  const renderer = (await fs.readFile(new URL('../../web/modules/app-media-render.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/gm, '').replaceAll('export ', '');
  vm.runInContext(renderer, h.runtime);
  let draft = content;
  const controller = h.runtime.setupMediaEditor({ isEditable: () => true, isBusy: () => false, getContext: () => ({ content: draft, path: p.sourcePath }) });
  const refresh = async () => {
    controller.refresh(); assert.equal(h.timers.size, 1);
    const [id, callback] = h.timers.entries().next().value; h.timers.delete(id); await callback();
  };
  const preview = h.element('docMediaPreview'); await refresh();
  assert.deepEqual(labels(preview), [image.caption, audio.caption]);
  assert.equal(preview.querySelector('img').alt, image.caption);
  assert.equal(preview.querySelector('audio').getAttribute('aria-label'), audio.caption);
  assert.equal(preview.querySelector('a').download, audio.caption);
  draft = content.replaceAll('说明', '说明已修改'); await refresh();
  assert.deepEqual(labels(preview), ['立绘说明已修改', '配音说明已修改']);
  assert.equal(preview.querySelector('img').alt, '立绘说明已修改');
  assert.equal(preview.querySelector('audio').getAttribute('aria-label'), '配音说明已修改');
  assert.equal(preview.querySelector('a').download, '配音说明已修改');
  const player = preview.querySelector('audio'); await refresh();
  assert.ok(preview.querySelector('audio') === player, 'unchanged descriptions keep the current player');
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), content);
  assert.deepEqual(await readRegistry(p.root), p.registry);
});

test('preview content: parser code fences stay excluded while repeated inline references stay in source order', async t => {
  const content = '# 示例\n\n```json\n' + JSON.stringify(image) + '\n```\n\n```md\n!audio[仅示例](assets/voice.wav)\n```\n\n![立绘说明](assets/picture.svg)\n\n![立绘说明](assets/picture.svg)\n';
  const p = await project(t, 'md', content), preview = await p.preview(content);
  assert.equal(preview.status, 200); assert.deepEqual(preview.data.media, [image, image]);
  assert.deepEqual(labels(view(content, p.sourcePath)), [image.caption, image.caption]);
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), content);
});

test('preview content: recursive aliases terminate and the 100 occurrence limit preserves the leading source order', async t => {
  const p = await project(t, 'yaml', 'title: 角色\n');
  const cyclic = `first: &self\n  again: *self\n  illustration: ${JSON.stringify(image)}\nsecond: *self\n`;
  const preview = await p.preview(cyclic); assert.equal(preview.status, 200);
  // A recursion edge is skipped; both acyclic occurrences still count.
  assert.deepEqual(preview.data.media, [image, image]);
  for (const value of [Array.from({ length: 105 }, (_, index) => ({ ...image, caption: `立绘 ${index}` })),
    Array.from({ length: 105 }, (_, index) => `![立绘 ${index}](assets/picture.svg)`).join(' ')]) {
    const limited = await p.preview(source('yaml', { media: value }));
    assert.equal(limited.status, 200); assert.equal(limited.data.media.length, 100);
    assert.deepEqual(limited.data.media.map(item => item.caption), Array.from({ length: 100 }, (_, index) => `立绘 ${index}`));
  }
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), p.content);
  assert.deepEqual(await readRegistry(p.root), p.registry);
});
