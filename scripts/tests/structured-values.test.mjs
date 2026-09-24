import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { planExport } from '../lib/export-package.mjs';
import { renderExport } from '../lib/export-render.mjs';
import { Element } from './editor-harness.mjs';

globalThis.location = { href: 'http://127.0.0.1/web/' };
globalThis.document = { getElementById: () => null, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment') };
const { renderDocumentLayout } = await import('../../web/modules/app-document-layout.js');

const extensions = ['json', 'yaml', 'yml'];
const image = { type: 'image', src: 'assets/picture.svg', caption: '列表立绘' };
const audio = { type: 'audio', src: 'assets/voice.wav', caption: '列表声音' };
const video = { type: 'video', src: 'assets/movie.mp4', caption: '列表片段' };
const inline = `前文 !video[${video.caption}](${video.src}) 后文`;
const assets = new Map([
  ['picture.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="teal"/></svg>')],
  // Byte/reference fixtures only, without audio/video playback claims.
  ['voice.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)])],
  ['movie.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)])],
]);
const source = (extension, value) => '\uFEFF' + (extension === 'json' ? JSON.stringify(value, null, 2) + '\n' : stringify(value)).replace(/\n/g, '\r\n');
const layout = (content, sourcePath) => buildDocumentLayout(parseSourceContent(content, sourcePath));
const labels = root => root.querySelectorAll('figcaption').map(node => node.textContent);

function view(layout) {
  const root = new Element();
  for (const card of renderDocumentLayout({ layout })) root.appendChild(card);
  return root;
}

async function project(t, extension, value) {
  const root = await fixture(t), sourcePath = `design-data/通用值.${extension}`, content = source(extension, value);
  await write(root, sourcePath, content);
  for (const [file, bytes] of assets) await write(root, `assets/${file}`, bytes);
  await registerWorkspace(root);
  return { root, sourcePath, content, base: await serve(t, root), registry: await readRegistry(root) };
}

async function indexed(p) {
  assert.equal((await request(p.base, '/api/rebuild', { source: p.sourcePath })).status, 200);
  const index = JSON.parse(await fs.readFile(path.join(p.root, '.viento/cache/indexes/documents.json')));
  return index.docs.find(doc => doc.source.path.endsWith(p.sourcePath));
}

async function exports(p, content, expected) {
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(p.root, { kind: 'document', format, path: p.sourcePath });
    const body = plan.entries.find(entry => entry.path === (format === 'html' ? 'index.html' : 'document.md')).buffer.toString();
    if (format === 'html') assert.deepEqual([...body.matchAll(/<figcaption>(.*?)<\/figcaption>/g)].map(match => match[1]), expected);
    else { assert.equal([...body.matchAll(/\]\(<assets\//g)].length, expected.length); for (const label of expected) assert.ok(body.includes(label)); }
    assert.equal(plan.assetCount, expected.length ? 3 : 0);
    for (const entry of plan.entries.filter(entry => entry.path.startsWith('assets/'))) {
      const asset = p.registry.assets.find(asset => entry.path.startsWith(`assets/${asset.id}.`));
      assert.ok(asset); assert.deepEqual(await fs.readFile(entry.absolute), assets.get(asset.location.path));
    }
    assert.equal(await fs.readFile(plan.entries.find(entry => entry.path === `sources/${p.sourcePath}`).absolute, 'utf8'), content);
    await plan.validateSnapshot();
  }
}

for (const extension of extensions) test(`structured values: ${extension} root lists render media through template preview, insert, save, index and export`, async t => {
  const value = [0, false, null, { name: '节点', attachments: [image, audio] }, inline];
  const p = await project(t, extension, value), expected = [image.caption, audio.caption, video.caption];
  const draft = await request(p.base, '/api/assets/insert', { sourcePath: p.sourcePath, content: p.content });
  assert.equal(draft.status, 200); assert.deepEqual(draft.data.media.map(item => item.caption), expected);
  await exports(p, p.content, expected);
  const initial = await indexed(p);
  assert.deepEqual(labels(view(initial.layout)), expected, 'saved root lists must render the same media as their draft and export');
  assert.deepEqual(view(initial.layout).querySelector('ol').children.slice(0, 3).map(node => node.textContent), ['0', 'false', 'null']);
  const preview = await request(p.base, '/api/project/preview', { type: { id: 'custom', label: '任意档案', directory: 'custom', parserProfile: 'structured' }, format: extension, content: p.content });
  assert.equal(preview.status, 200); assert.deepEqual(labels(view(preview.data.layout)), expected);
  const asset = p.registry.assets.find(asset => asset.kind === 'image');
  const inserted = await request(p.base, '/api/assets/insert', { sourcePath: p.sourcePath, content: p.content, assetIds: [asset.id] });
  assert.equal(inserted.status, 200); assert.deepEqual(inserted.data.media.map(item => item.caption), [...expected, asset.name]);
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), p.content);
  const read = await request(p.base, `/api/doc?path=${encodeURIComponent(p.sourcePath)}`);
  assert.equal((await request(p.base, '/api/doc', { path: p.sourcePath, content: inserted.data.content, expectedVersion: read.data.version })).status, 200);
  const reopened = await request(p.base, `/api/doc?path=${encodeURIComponent(p.sourcePath)}`);
  assert.equal(reopened.data.content, inserted.data.content); assert.ok(reopened.data.content.startsWith('\uFEFF')); assert.doesNotMatch(reopened.data.content, /(?<!\r)\n/);
  const rebuilt = await indexed(p);
  assert.deepEqual(labels(view(rebuilt.layout)), [...expected, asset.name]);
  assert.deepEqual(new Set(rebuilt.assetRefs), new Set(p.registry.assets.map(asset => asset.id)));
  await exports(p, reopened.data.content, [...expected, asset.name]);
  assert.deepEqual(await readRegistry(p.root), p.registry);
  assert.equal((await verifyWorkspace(p.root)).ok, true);
});

for (const extension of extensions) test(`structured values: ${extension} root strings render inline media as nested strings do`, async t => {
  const value = `前文 ![${image.caption}](${image.src}) !audio[${audio.caption}](${audio.src}) ${inline}`;
  const p = await project(t, extension, value), expected = [image.caption, audio.caption, video.caption];
  const rendered = view(layout(p.content, p.sourcePath));
  assert.deepEqual(labels(rendered), expected);
  assert.equal(rendered.querySelector('pre'), null, 'root strings are content, not a JSON code dump');
  assert.match(rendered.textContent, /前文/); assert.match(rendered.textContent, /后文/);
  assert.deepEqual(labels(view(layout(source(extension, { value }), p.sourcePath))), expected);
  const draft = await request(p.base, '/api/assets/insert', { sourcePath: p.sourcePath, content: p.content });
  assert.equal(draft.status, 200); assert.deepEqual(draft.data.media.map(item => item.caption), expected);
  await exports(p, p.content, expected);
  assert.deepEqual(await readRegistry(p.root), p.registry);
  assert.equal(await fs.readFile(path.join(p.root, p.sourcePath), 'utf8'), p.content);
});

for (const extension of extensions) test(`structured values: ${extension} empty containers remain visible at root, in fields and inside lists in reading and both exports`, () => {
  const sourcePath = `values.${extension}`;
  for (const [value, expected] of [[{}, ['{}']], [[], ['[]']], [{ emptyMap: {}, emptyList: [], items: [{}, [], 0, false, null] }, ['{}', '[]', '{}', '[]', '0', 'false', 'null']]]) {
    const content = source(extension, value), parsedLayout = layout(content, sourcePath);
    const original = JSON.stringify(parsedLayout);
    assert.deepEqual(view(parsedLayout).querySelectorAll('.document-value-text').map(node => node.textContent), expected);
    assert.equal(JSON.stringify(parsedLayout), original, 'rendering must not change parsed data');
    for (const format of ['html', 'markdown']) {
      const output = renderExport([{ title: '空值', layout: parsedLayout }], format, () => { throw new Error('empty containers must not resolve assets'); });
      assert.equal((output.match(/\{\}/g) || []).length, expected.filter(value => value === '{}').length);
      assert.equal((output.match(format === 'html' ? /\[\]/g : /\\\[\\\]/g) || []).length, expected.filter(value => value === '[]').length);
      for (const value of expected.filter(value => !['{}', '[]'].includes(value))) assert.ok(output.includes(value));
    }
  }
});

test('structured values: ordinary false, zero, null, media objects and fenced code retain meaning without executing source HTML', () => {
  for (const value of [false, 0, null]) assert.equal(view(layout(JSON.stringify(value), 'values.json')).textContent, `内容${value}`);
  const rich = view(layout(JSON.stringify(image), 'values.json'));
  assert.deepEqual(labels(rich), [image.caption]);
  const text = '<script>danger()</script>';
  const plain = view(layout(JSON.stringify({ note: text }), 'values.json'));
  assert.ok(plain.textContent.includes(text)); assert.equal(plain.querySelector('script'), null);
  const fenced = view(layout('# 示例\n\n```json\n' + JSON.stringify([image]) + '\n```\n', 'example.md'));
  assert.equal(fenced.querySelector('img'), null); assert.equal(fenced.querySelector('pre').textContent, JSON.stringify([image]));
});
