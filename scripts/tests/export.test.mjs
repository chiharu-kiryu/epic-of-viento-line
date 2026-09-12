import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, write, serve, request } from './helpers.mjs';
import { readRegistry, registerWorkspace, writeJson } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { exportFileName, planExport, writeExportZip } from '../lib/export-package.mjs';
import { createExportService } from '../lib/export-service.mjs';
import { t as translate } from '../../web/i18n/index.js';

// Read the ZIP central directory independently of the writer, including entries
// whose local headers use data descriptors. Also verify every manifest digest.
function unzip(bytes) {
  const files = new Map();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString();
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
    const content = bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(content.length, bytes.readUInt32LE(offset + 24));
    assert.ok(!files.has(name)); files.set(name, content);
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(files.size, manifest.files.length + 1);
  for (const file of manifest.files) {
    assert.equal(files.get(file.path).length, file.size);
    assert.equal(createHash('sha256').update(files.get(file.path)).digest('hex'), file.sha256);
  }
  return { files, manifest };
}

async function project(t, version = 3) {
  const root = await fixture(t);
  const documents = version === 3 ? 'documents' : 'design-data';
  const templates = version === 3 ? 'templates' : 'data-template';
  const manifest = { format: 'viento-workspace', version, id: randomUUID(), name: '导出验证', createdAt: 0,
    paths: { documents, templates, metadata: 'metadata' }, assetStores: { main: { path: 'assets' } },
    ...(version === 3 ? { documentTypes: PROJECT_DEFAULTS.documentTypes } : {}) };
  await write(root, 'workspace.json', JSON.stringify(manifest));
  await write(root, `${templates}/character.md`, '# 角色模板\n姓名：\n');
  await write(root, `${documents}/角色.md`, '# 星裔\n\n自定义数值：2\n\n<script>alert("x")</script>\n');
  await write(root, `${documents}/背景.md`, '# 星裔的背景\n\n原有大纲与故事内容。\n');
  await write(root, `${documents}/无关.md`, '# 另一位角色\n');
  await write(root, '外置素材/立绘.png', Buffer.from('binary image'));
  await write(root, '外置素材/片段.mp4', Buffer.from('binary video'));
  await write(root, '外置素材/未引用.wav', Buffer.from('unreferenced audio'));
  await write(root, '.viento/local.json', JSON.stringify({ version: 1, assetStores: { main: path.join(root, '外置素材') } }));
  await registerWorkspace(root);
  let registry = await readRegistry(root);
  const image = registry.assets.find((asset) => asset.kind === 'image');
  const video = registry.assets.find((asset) => asset.kind === 'video');
  const owner = registry.documents.find((doc) => doc.sourcePath.endsWith('/角色.md'));
  const child = registry.documents.find((doc) => doc.sourcePath.endsWith('/背景.md'));
  owner.assetBindings = [{ assetId: image.id, role: 'portrait' }];
  await writeJson(path.join(root, 'metadata/documents', `${owner.id}.json`), owner);
  child.relations = [{ kind: 'part-of', targetId: owner.id, slot: '背景故事' }];
  await writeJson(path.join(root, 'metadata/documents', `${child.id}.json`), child);
  await write(root, `${documents}/角色.md`, `# 星裔\n\n自定义数值：2\n\n<script>alert("x")</script>\n\n![立绘](asset:${image.id})\n\n| 属性 | 值 |\n| --- | --- |\n| 灵魂 | 2 |\n\n\`\`\`text\n代码中的 ![不是素材](asset:00000000-0000-0000-0000-000000000000)\n\`\`\`\n`);
  await write(root, `${documents}/背景.md`, `# 星裔的背景\n\n原有大纲与故事内容。\n\n!video[片段](asset:${video.id})\n`);
  await write(root, '.viento/cache/secret.txt', 'cache is not portable');
  return { root, documents, image, video, owner, child };
}

test('document exports include owned stories, exact sources and referenced external media in both formats', async (t) => {
  const { root, documents, image, video } = await project(t);
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(root, { kind: 'document', format, path: `${documents}/角色.md` });
    const output = path.join(root, `${format}.zip`);
    await writeExportZip(plan, output);
    const { files, manifest } = unzip(await fs.readFile(output));
    assert.equal(manifest.format, 'viento-document-export');
    assert.equal(manifest.documents.length, 2);
    assert.equal(manifest.documents[1].depth, 1);
    assert.equal(plan.assetCount, 2);
    assert.deepEqual(files.get(`sources/${documents}/角色.md`), await fs.readFile(path.join(root, `${documents}/角色.md`)));
    const body = files.get(format === 'html' ? 'index.html' : 'document.md').toString();
    assert.match(body, /星裔的背景/); assert.match(body, /原有大纲与故事内容/);
    assert.match(body, new RegExp(`assets/${image.id}.png`));
    assert.match(body, new RegExp(`assets/${video.id}.mp4`));
    assert.match(body, /灵魂/); assert.match(body, /代码中的/);
    assert.ok(![...files.keys()].some((name) => /无关|local\.json|cache|未引用/.test(name)));
    if (format === 'html') {
      assert.match(body, /<video controls/); assert.doesNotMatch(body, /<script>/);
      assert.equal((body.match(/<img /g) || []).length, 1, 'An embedded image must not also be appended as a duplicate gallery');
      assert.match(body, /&lt;script&gt;/); assert.match(body, /<th>属性<\/th>/);
    } else { assert.match(body, /\[视频：片段\]/); assert.match(body, /```text/); }
  }
  const only = await planExport(root, { kind: 'document', format: 'html', path: `${documents}/角色.md`, includeChildren: false });
  assert.equal(only.documentCount, 1); assert.equal(only.assetCount, 1);
});

test('JSON and YAML typed fields export using the generic layout and media bindings', async (t) => {
  const { root, documents, image } = await project(t);
  const value = { title: '自定义物种', 身体: { 灵魂: 2, 可飞行: false, 别名: ['甲', '乙'], 空值: null }, 属性: '+15% 技能伤害\n+350 魔法上限', 插图: { type: 'image', src: `asset:${image.id}`, caption: '结构化插图' } };
  for (const [extension, content] of [['json', JSON.stringify(value)], ['yaml', `title: 自定义物种\n灵魂: 2\n可飞行: false\n别名: [甲, 乙]\n插图:\n  type: image\n  src: asset:${image.id}\n`]]) {
    await write(root, `${documents}/物种.${extension}`, content);
    const plan = await planExport(root, { kind: 'document', format: 'html', path: `${documents}/物种.${extension}` });
    const body = plan.entries.find((entry) => entry.path === 'index.html').buffer.toString();
    assert.match(body, /自定义物种/); assert.match(body, /false/); assert.match(body, /<li>甲<\/li>/); assert.match(body, /<img /);
    assert.equal(plan.assetCount, 1);
    if (extension === 'json') assert.match(body, /<dt>技能伤害<\/dt><dd>\+15%<\/dd>/);
  }
});

for (const version of [2, 3]) test(`v${version} complete project packages preserve migration contract, metadata and all external media`, async (t) => {
  const { root, documents, owner } = await project(t, version);
  const service = createExportService(root);
  const job = await service.create({ kind: 'workspace' });
  const { files, manifest } = unzip(await fs.readFile(service.get(job.id).file));
  assert.equal(manifest.format, 'viento-archive'); assert.equal(manifest.version, version);
  assert.equal(manifest.workspace.version, version);
  assert.deepEqual(files.get(`${documents}/角色.md`), await fs.readFile(path.join(root, documents, '角色.md')));
  assert.ok(files.has(`metadata/documents/${owner.id}.json`));
  assert.ok(files.has('assets/未引用.wav')); assert.ok(files.has('.viento/workspace.json'));
  assert.ok(![...files.keys()].some((name) => /local\.json|cache|外置素材/.test(name)));
  assert.equal(job.assetCount, 3);
  const directory = service.get(job.id).directory;
  await service.release(job.id);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.throws(() => service.get(job.id), { statusCode: 410 });
});

test('missing assets, traversal, symlinks and changed source snapshots cannot produce a successful export', async (t) => {
  const { root, documents, image } = await project(t);
  const service = createExportService(root);
  await assert.rejects(service.create({ kind: 'document', format: 'html', path: '../private.md' }), { statusCode: 400 });
  const plan = await planExport(root, { kind: 'document', format: 'markdown', path: `${documents}/角色.md` });
  await fs.appendFile(path.join(root, documents, '角色.md'), '\nchanged');
  await assert.rejects(writeExportZip(plan, path.join(root, 'changed.zip')), /发生变化/);
  await fs.rm(path.join(root, '外置素材', image.location.path));
  await assert.rejects(service.create({ kind: 'document', format: 'html', path: `${documents}/角色.md` }), /缺失/);
  await assert.rejects(service.create({ kind: 'workspace' }), /缺失/);
  await write(root, `外置素材/${image.location.path}`, Buffer.from('tampered asset'));
  await assert.rejects(service.create({ kind: 'workspace' }), /内容与登记不一致/);
  await fs.symlink(path.join(root, 'package.json'), path.join(root, documents, 'link.md'));
  await assert.rejects(service.create({ kind: 'document', format: 'html', path: `${documents}/link.md` }), { statusCode: 403 });
  const controller = new AbortController(); controller.abort(new Error('cancelled by user'));
  await assert.rejects(service.create({ kind: 'document', format: 'html', path: `${documents}/背景.md` }, controller.signal), /cancelled by user/);
});

test('HTTP export supports edit and browse modes, authenticated creation, binary download and cleanup', async (t) => {
  const { root, documents } = await project(t);
  for (const script of ['doc-site-server.mjs', 'browse-server.mjs']) {
    const base = await serve(t, root, {}, script);
    const created = await request(base, '/api/export', { kind: 'document', format: 'html', path: `${documents}/角色.md` });
    assert.equal(created.status, 200, JSON.stringify(created.payload));
    const response = await fetch(`${base}/api/export?id=${created.data.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(unzip(Buffer.from(await response.arrayBuffer())).manifest.documents.length, 2);
    assert.equal((await request(base, '/api/export', { action: 'release', id: created.data.id })).status, 200);
    assert.equal((await fetch(`${base}/api/export?id=${created.data.id}`)).status, 410);
    assert.equal((await request(base, '/api/export', { kind: 'document', format: 'pdf', path: `${documents}/角色.md` })).status, 400);
  }
  const protectedBase = await serve(t, root, { DOC_API_REQUIRE_WRITE_AUTH: '1', DOC_API_TOKEN: 'export-test-token' });
  assert.equal((await request(protectedBase, '/api/export', { kind: 'workspace' })).status, 401);
  const protectedResponse = await fetch(`${protectedBase}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer export-test-token' }, body: JSON.stringify({ kind: 'workspace' }) });
  assert.equal(protectedResponse.status, 200);
});

test('export entry blocks unsaved and new drafts without changing editor state', async () => {
  const filename = exportFileName('角色'.repeat(34) + '🤔🤔', '.zip');
  assert.equal(Buffer.from(filename).toString(), filename);
  assert.doesNotThrow(() => encodeURIComponent(filename));
  assert.equal(exportFileName('CON', '.zip'), '作品.zip');
  const code = (await fs.readFile(new URL('../../web/modules/app-export.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '').replaceAll('export ', '');
  const context = vm.createContext({ t: translate }); vm.runInContext(code, context);
  const saved = { path: 'documents/角色.md' };
  assert.equal(context.exportAvailability(saved, 'document'), '');
  assert.match(context.exportAvailability({ ...saved, dirty: true }, 'workspace'), /先保存/);
  assert.match(context.exportAvailability({ creating: true }, 'document'), /先保存/);
  assert.match(context.exportAvailability({ busy: true }, 'workspace'), /完成后/);
  assert.match(context.exportAvailability({}, 'document'), /选择/);
  assert.equal(context.exportAvailability({}, 'workspace'), '');
});

test('expired and interrupted jobs release temporary disk space while retaining source files', async (t) => {
  const { root, documents } = await project(t);
  const service = createExportService(root, { ttlMs: 30 });
  const job = await service.create({ kind: 'document', format: 'html', path: `${documents}/角色.md` });
  const directory = service.get(job.id).directory;
  await delay(80);
  assert.throws(() => service.get(job.id), { statusCode: 410 });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await write(root, '外置素材/large.bin', Buffer.alloc(16 * 1024 ** 2, 7));
  const controller = new AbortController();
  const exporting = service.create({ kind: 'workspace' }, controller.signal);
  exporting.catch(() => {});
  const cache = path.join(root, '.viento/cache/exports');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fs.readdir(cache)).length) break;
    await delay(2);
  }
  controller.abort(new Error('cancel during packaging'));
  await assert.rejects(exporting, /cancel during packaging/);
  assert.deepEqual(await fs.readdir(cache), []);
  assert.ok((await fs.readFile(path.join(root, documents, '角色.md'), 'utf8')).startsWith('# 星裔'));
});
