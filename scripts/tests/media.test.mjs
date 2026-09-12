import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { fixture, write, serve, node, request } from './helpers.mjs';
import { registerWorkspace, readRegistry, verifyWorkspace } from '../lib/workspace.mjs';
import { importMediaAsset, listMediaAssets } from '../lib/media-assets.mjs';
import { mediaUrl, mediaMarkup } from '../lib/media-format.mjs';
import { insertStructuredMedia, prepareMediaInsertion } from '../lib/media-insertion.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { createBlockDraft, serializeBlockDraft } from '../../web/modules/app-editor-draft.js';
import { Element, editorHarness } from './editor-harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const stream = (bytes) => Readable.from([bytes]);
globalThis.location = { href: 'http://127.0.0.1/web/' };
globalThis.document = { getElementById: () => null, createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element('fragment') };
const { renderDocumentLayout } = await import('../../web/modules/app-document-layout.js');

test('inline images and videos parse at the start, in prose and fields, but never inside code', () => {
  const id = randomUUID();
  const image = mediaMarkup({ id, kind: 'image', name: '绘图 [版本] #1.png' });
  const movie = mediaMarkup({ id, kind: 'video', name: '动作.mp4' });
  const source = `${image}\n\n前文 ${movie} 后文\n\n配图：${image}\n\n\`\`\`md\n${image}\n\`\`\`\n`;
  const parsed = parseSourceContent(source, 'design-data/stories/媒体.md');
  assert.equal(parsed.blocks.filter((b) => b.type === 'image').length, 2);
  assert.equal(parsed.blocks.filter((b) => b.type === 'video').length, 1);
  assert.ok(parsed.blocks.some((b) => b.type === 'code' && b.value.includes(image)));
  const cards = renderDocumentLayout({ layout: buildDocumentLayout(parsed) });
  const pictures = cards.flatMap((card) => card.querySelectorAll('img'));
  const movies = cards.flatMap((card) => card.querySelectorAll('video'));
  assert.equal(pictures.length, 2);
  assert.equal(movies.length, 1);
  assert.equal(movies[0].controls, true);
  assert.equal(movies[0].autoplay, undefined);
  assert.equal(pictures[0].src, `/asset-files/${id}`);
  const draft = createBlockDraft(source.replace(/\n/g, '\r\n'));
  assert.equal(draft.blocks[0].type, 'media');
  assert.equal(serializeBlockDraft(draft), source.replace(/\n/g, '\r\n'));
});

test('media URLs reject executable, remote and escaping sources while preserving local encoded names', () => {
  const id = randomUUID();
  assert.equal(mediaUrl(`asset://${id}`), `/asset-files/${id}`);
  assert.equal(mediaUrl('assets/图 #1.svg'), '/assets/%E5%9B%BE%20%231.svg');
  for (const source of ['javascript:alert(1)', 'file:///etc/passwd', 'https://example.org/a.png', 'assets/%2e%2e/private.png', 'assets/a%2fb.png', '//elsewhere/a.png']) assert.equal(mediaUrl(source), '', source);
});

test('JSON and YAML insertion preserves existing source bytes, comments and structured values', () => {
  const image = { type: 'image', src: `asset:${randomUUID()}`, caption: '星空' };
  const video = { type: 'video', src: `asset:${randomUUID()}`, caption: '动作' };
  const json = '\ufeff{ "名字" : "原始引号", "数值":0, "媒体": [] }\r\n';
  let inserted = insertStructuredMedia(json, '.json', [image]);
  inserted = insertStructuredMedia(inserted, '.json', [video]);
  assert.ok(inserted.startsWith('\ufeff{ "名字" : "原始引号", "数值":0, "媒体": ['));
  assert.deepEqual(JSON.parse(inserted.slice(1)), { 名字: '原始引号', 数值: 0, 媒体: [image, video] });
  const yaml = '---\r\n名字: "保留引号" # 保留注释\r\n经历: |\r\n  不能重写的正文。\r\n# 尾注\r\n...\r\n';
  const withImage = insertStructuredMedia(yaml, '.yaml', [image]);
  const withVideo = insertStructuredMedia(withImage, '.yaml', [video]);
  assert.ok(withVideo.startsWith(yaml.slice(0, yaml.indexOf('# 尾注'))));
  assert.ok(withVideo.endsWith('# 尾注\r\n...\r\n'));
  assert.deepEqual(parseDocument(withVideo).toJS(), { 名字: '保留引号', 经历: '不能重写的正文。\n', 媒体: [image, video] });
  for (const [source, extension] of [['[]', '.json'], ['- 原内容\n', '.yaml'], ['{name: role}', '.yaml']]) {
    const out = insertStructuredMedia(source, extension, [image]);
    assert.equal(parseDocument(out).errors.length, 0, out);
  }
  assert.throws(() => insertStructuredMedia('{broken', '.json', [image]), /语法/);
  for (const source of ['{name: role,}', '{name: role # comment\n}', '[one, # first\n two # last\n]', '{ # empty\n}', '媒体: [ # empty list\n]\n']) {
    const output = insertStructuredMedia(source, '.yaml', [image]);
    const parsed = parseDocument(output);
    assert.deepEqual(parsed.errors, [], output);
    const value = parsed.toJS();
    assert.deepEqual(Array.isArray(value) ? value.at(-1) : value.媒体[0], image);
  }
});

test('preview tolerates cyclic YAML aliases and interrupted imports leave no partial files', async (t) => {
  const root = await fixture(t);
  await registerWorkspace(root);
  const result = await prepareMediaInsertion(root, { content: '角色: &self\n  自己: *self\n', sourcePath: 'design-data/角色.yaml' });
  assert.deepEqual(result.media, []);
  const interrupted = Readable.from((async function* () { yield png; throw new Error('connection closed'); })());
  await assert.rejects(importMediaAsset(root, interrupted, '中断.png'), /connection closed/);
  assert.equal((await fs.readdir(path.join(root, '.viento/uploads'))).length, 0);
  assert.equal((await readRegistry(root)).assets.length, 0);
});

test('concurrent imports reuse identical bytes, keep names independent of paths and clean rejected uploads', async (t) => {
  const root = await fixture(t);
  await registerWorkspace(root);
  const imports = await Promise.all(['同名.png', '../同名.png'].map((name) => importMediaAsset(root, stream(png), name)));
  assert.equal(imports[0].asset.id, imports[1].asset.id);
  assert.equal(imports.filter((r) => r.reused).length, 1);
  const other = await importMediaAsset(root, stream(Buffer.concat([png, Buffer.from('another')])), '同名.png');
  assert.notEqual(other.asset.id, imports[0].asset.id);
  const registry = await readRegistry(root);
  assert.equal(registry.assets.length, 2);
  assert.ok(registry.assets.every((asset) => asset.location.path.startsWith('media/images/')));
  await assert.rejects(importMediaAsset(root, stream(Buffer.from('<html>wrong</html>')), 'wrong.png'), { statusCode: 415 });
  await assert.rejects(importMediaAsset(root, stream(png), 'large.png', { maxBytes: 10 }), { statusCode: 413 });
  assert.equal((await fs.readdir(path.join(root, '.viento/uploads'))).length, 0);
  assert.equal((await verifyWorkspace(root)).ok, true);
});

test('imports respect an external asset store and reject linked destination directories', async (t) => {
  const root = await fixture(t), external = await fixture(t);
  await registerWorkspace(root);
  const store = path.join(external, 'assets');
  await write(root, '.viento/local.json', JSON.stringify({ version: 1, assetStores: { main: store } }));
  const result = await importMediaAsset(root, stream(video), '动作.mp4');
  const record = (await readRegistry(root)).assets[0];
  assert.equal(record.id, result.asset.id);
  assert.deepEqual(await fs.readFile(path.join(store, record.location.path)), video);
  assert.equal((await fs.readdir(path.join(root, 'assets'))).length, 0);
  const outside = path.join(external, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(store, 'media/images'));
  await assert.rejects(importMediaAsset(root, stream(png), 'outside.png'), { statusCode: 403 });
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await listMediaAssets(root)).assets.length, 1);
});

test('authenticated upload, structured insertion, save, rebuild and relocation keep working asset IDs', async (t) => {
  const root = await fixture(t);
  const original = '{"名字":"角色","数值":0}\n';
  const source = 'design-data/characters/角色.json';
  await write(root, source, original);
  await registerWorkspace(root);
  const base = await serve(t, root, { DOC_API_REQUIRE_WRITE_AUTH: '1', DOC_API_TOKEN: 'media-test-token' });
  const upload = (name, body, auth = true, type = 'application/octet-stream') => fetch(`${base}/api/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': type, ...(auth ? { Authorization: 'Bearer media-test-token' } : {}) }, body,
  });
  assert.equal((await upload('图.png', png, false)).status, 401);
  assert.equal((await upload('图.png', png, true, 'text/plain')).status, 415);
  const response = await upload('图#1.png', png);
  assert.equal(response.status, 200);
  const asset = (await response.json()).data.asset;
  const bytes = await fetch(`${base}${asset.url}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(bytes.status, 206);
  assert.equal(bytes.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png.subarray(0, 8));
  const svg = await upload('安全.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svgUrl = (await svg.json()).data.asset.url;
  assert.match((await fetch(base + svgUrl)).headers.get('content-security-policy'), /sandbox/);
  const jsonPost = async (url, payload) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer media-test-token' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  };
  const inserted = await jsonPost('/api/assets/insert', { content: original, sourcePath: source, assetIds: [asset.id] });
  assert.equal(inserted.media[0].type, 'image');
  assert.equal(await fs.readFile(path.join(root, source), 'utf8'), original);
  const read = await request(base, `/api/doc?path=${encodeURIComponent(source)}`);
  await jsonPost('/api/doc', { path: source, content: inserted.content, expectedVersion: read.data.version });
  await jsonPost('/api/rebuild', { source });
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
  assert.ok(index.docs.find((doc) => doc.source.path.endsWith(source)).assetRefs.includes(asset.id));
  const relocated = await fixture(t);
  for (const entry of ['workspace.json', '.viento/workspace.json', 'design-data', 'metadata', 'assets']) {
    await fs.mkdir(path.dirname(path.join(relocated, entry)), { recursive: true });
    await fs.cp(path.join(root, entry), path.join(relocated, entry), { recursive: true });
  }
  await node(relocated, ['scripts/standardize-docs.mjs', 'design-data']);
  await node(relocated, ['scripts/build-static-doc-site.mjs']);
  const restoredServer = await serve(t, relocated);
  assert.deepEqual(Buffer.from(await (await fetch(restoredServer + asset.url)).arrayBuffer()), png);
  assert.equal((await verifyWorkspace(relocated)).ok, true);
});

test('media import locks editing navigation without discarding the source draft', async () => {
  const harness = await editorHarness();
  harness.begin('角色\n\n未保存的正文。\n');
  harness.state.isImportingMedia = true;
  assert.equal(harness.runtime.isEditorWriteBusy(), true);
  harness.runtime.exitEditMode();
  assert.equal(harness.state.isEditing, true);
  assert.equal(harness.runtime.getCurrentEditContent(), '角色\n\n未保存的正文。\n');
});

test('draft preview requests cannot consume the allowance for document reads and writes', async (t) => {
  const root = await fixture(t);
  await registerWorkspace(root);
  const base = await serve(t, root, { DOC_API_RATE_LIMIT_MAX_REQUESTS: '2' });
  const preview = () => fetch(base + '/api/assets/insert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '正文', sourcePath: 'design-data/角色.md' }) });
  assert.equal((await preview()).status, 200);
  assert.equal((await preview()).status, 200);
  assert.equal((await preview()).status, 429);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/api/assets')).status, 200);
});
