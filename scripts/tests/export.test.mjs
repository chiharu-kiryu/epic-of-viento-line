import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, write, node, serve, request } from './helpers.mjs';
import { readRegistry, registerWorkspace, writeJson, assertPortableFileTree } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { exportFileName, planExport, writeExportZip } from '../lib/export-package.mjs';
import { createExportService } from '../lib/export-service.mjs';
import { t as translate } from '../../web/i18n/index.js';
import { deferred } from './editor-harness.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  await write(root, '外置素材/主题曲.m4a', Buffer.from('referenced audio'));
  await write(root, '外置素材/未引用.wav', Buffer.from('unreferenced audio'));
  await write(root, '.viento/local.json', JSON.stringify({ version: 1, assetStores: { main: path.join(root, '外置素材') } }));
  await registerWorkspace(root);
  let registry = await readRegistry(root);
  const image = registry.assets.find((asset) => asset.kind === 'image');
  const video = registry.assets.find((asset) => asset.kind === 'video');
  const audio = registry.assets.find((asset) => asset.location.path === '主题曲.m4a');
  const owner = registry.documents.find((doc) => doc.sourcePath.endsWith('/角色.md'));
  const child = registry.documents.find((doc) => doc.sourcePath.endsWith('/背景.md'));
  owner.assetBindings = [{ assetId: image.id, role: 'portrait' }];
  await writeJson(path.join(root, 'metadata/documents', `${owner.id}.json`), owner);
  child.relations = [{ kind: 'part-of', targetId: owner.id, slot: '背景故事' }];
  await writeJson(path.join(root, 'metadata/documents', `${child.id}.json`), child);
  await write(root, `${documents}/角色.md`, `# 星裔\n\n自定义数值：2\n\n<script>alert("x")</script>\n\n![立绘](asset:${image.id})\n\n| 属性 | 值 |\n| --- | --- |\n| 灵魂 | 2 |\n\n\`\`\`text\n代码中的 ![不是素材](asset:00000000-0000-0000-0000-000000000000)\n\`\`\`\n`);
  await write(root, `${documents}/背景.md`, `# 星裔的背景\n\n原有大纲与故事内容。\n\n!video[片段](asset:${video.id})\n\n!audio[主题曲](asset:${audio.id})\n`);
  await write(root, '.viento/cache/secret.txt', 'cache is not portable');
  return { root, documents, image, video, audio, owner, child };
}

test('document exports include owned stories, exact sources and referenced external media in both formats', async (t) => {
  const { root, documents, image, video, audio } = await project(t);
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(root, { kind: 'document', format, path: `${documents}/角色.md` });
    const output = path.join(root, `${format}.zip`);
    await writeExportZip(plan, output);
    const { files, manifest } = unzip(await fs.readFile(output));
    assert.equal(manifest.format, 'viento-document-export');
    assert.equal(manifest.documents.length, 2);
    assert.equal(manifest.documents[1].depth, 1);
    assert.equal(plan.assetCount, 3);
    assert.deepEqual(files.get(`sources/${documents}/角色.md`), await fs.readFile(path.join(root, `${documents}/角色.md`)));
    const body = files.get(format === 'html' ? 'index.html' : 'document.md').toString();
    assert.match(body, /星裔的背景/); assert.match(body, /原有大纲与故事内容/);
    assert.match(body, new RegExp(`assets/${image.id}.png`));
    assert.match(body, new RegExp(`assets/${video.id}.mp4`));
    assert.match(body, new RegExp(`assets/${audio.id}.m4a`));
    assert.deepEqual(files.get(`assets/${audio.id}.m4a`), await fs.readFile(path.join(root, '外置素材/主题曲.m4a')));
    assert.match(body, /灵魂/); assert.match(body, /代码中的/);
    assert.ok(![...files.keys()].some((name) => /无关|local\.json|cache|未引用/.test(name)));
    if (format === 'html') {
      assert.match(body, /<video controls/); assert.match(body, /<audio controls preload="auto"/);
      assert.doesNotMatch(body, /<script>|autoplay/);
      assert.equal((body.match(/<img /g) || []).length, 1, 'An embedded image must not also be appended as a duplicate gallery');
      assert.match(body, /&lt;script&gt;/); assert.match(body, /<th>属性<\/th>/);
    } else { assert.match(body, /\[视频：片段\]/); assert.match(body, /\[音频：主题曲\]/); assert.match(body, /```text/); }
  }
  const only = await planExport(root, { kind: 'document', format: 'html', path: `${documents}/角色.md`, includeChildren: false });
  assert.equal(only.documentCount, 1); assert.equal(only.assetCount, 1);
});

test('JSON and YAML typed fields export using the generic layout and media bindings', async (t) => {
  const { root, documents, image, audio } = await project(t);
  const value = { title: '自定义物种', 身体: { 灵魂: 2, 可飞行: false, 别名: ['甲', '乙'], 空值: null }, 属性: '+15% 技能伤害\n+350 魔法上限', 插图: { type: 'image', src: `asset:${image.id}`, caption: '结构化插图' }, 配音: { type: 'audio', src: `asset:${audio.id}`, caption: '结构化音频' } };
  for (const [extension, content] of [['json', JSON.stringify(value)], ['yaml', `title: 自定义物种\n灵魂: 2\n可飞行: false\n别名: [甲, 乙]\n插图:\n  type: image\n  src: asset:${image.id}\n配音:\n  type: audio\n  src: asset:${audio.id}\n`]]) {
    await write(root, `${documents}/物种.${extension}`, content);
    const plan = await planExport(root, { kind: 'document', format: 'html', path: `${documents}/物种.${extension}` });
    const body = plan.entries.find((entry) => entry.path === 'index.html').buffer.toString();
    assert.match(body, /自定义物种/); assert.match(body, /false/); assert.match(body, /<li>甲<\/li>/); assert.match(body, /<img /);
    assert.match(body, /<audio controls/);
    assert.equal(plan.assetCount, 2);
    if (extension === 'json') assert.match(body, /<dt>技能伤害<\/dt><dd>\+15%<\/dd>/);
  }
});

test('concurrent Chinese, English and Japanese exports localize instructions while preserving authored bytes', async (t) => {
  const { root, documents, owner, audio } = await project(t);
  owner.assetBindings.push({ assetId: audio.id, role: 'theme' });
  await writeJson(path.join(root, 'metadata/documents', `${owner.id}.json`), owner);
  const expected = {
    'zh-CN': { toc: '文档导航', media: '关联素材', audio: '下载原音频', video: '下载原视频', readme: '请先解压整个 ZIP 文件', markdown: '音频：主题曲' },
    en: { toc: 'Table of contents', media: 'Linked media', audio: 'Download original audio', video: 'Download original video', readme: 'Extract the entire ZIP archive', markdown: 'Audio: 主题曲' },
    ja: { toc: '目次', media: '関連素材', audio: '元の音声をダウンロード', video: '元の動画をダウンロード', readme: 'ZIP ファイル全体を展開', markdown: '音声：主题曲' },
  };
  await Promise.all(Object.entries(expected).flatMap(([language, labels]) => ['html', 'markdown'].map(async (format) => {
    const plan = await planExport(root, { kind: 'document', format, path: `${documents}/角色.md`, language });
    const output = path.join(root, `${language}-${format}.zip`);
    await writeExportZip(plan, output);
    const { files, manifest } = unzip(await fs.readFile(output));
    const body = files.get(format === 'html' ? 'index.html' : 'document.md').toString();
    assert.ok(body.includes(labels.media));
    assert.ok(body.includes('星裔的背景')); assert.ok(body.includes('原有大纲与故事内容。'));
    assert.ok(body.includes('自定义数值')); assert.ok(body.includes('灵魂'));
    assert.ok(files.get('README.txt').toString().includes(labels.readme));
    assert.ok(plan.fileName.startsWith('星裔-'));
    if (format === 'html') {
      assert.ok(body.includes(`<html lang="${language}">`));
      assert.ok(body.includes(`aria-label="${labels.toc}"`));
      assert.ok(body.includes(labels.audio)); assert.ok(body.includes(labels.video));
      assert.doesNotMatch(body, /<script>|autoplay/);
    } else assert.ok(body.includes(labels.markdown));
    for (const { sourcePath } of manifest.documents) assert.deepEqual(files.get(`sources/${sourcePath}`), await fs.readFile(path.join(root, sourcePath)));
    for (const asset of manifest.assets) assert.deepEqual(files.get(asset.path), await fs.readFile(path.join(root, '外置素材', asset.originalPath.slice('assets/'.length))));
    for (const [name, bytes] of files) if (name.startsWith('metadata/')) assert.deepEqual(bytes, await fs.readFile(path.join(root, name)));
  })));
  for (const language of Object.keys(expected)) {
    const plan = await planExport(root, { kind: 'workspace', language });
    assert.ok(!plan.entries.some(({ path: name }) => /preferences|README\.txt/.test(name)));
    assert.deepEqual(plan.archiveManifest.workspace, JSON.parse(await fs.readFile(path.join(root, 'workspace.json'))));
  }
  for (const language of ['ja-JP', 'fr', '__proto__', null, { id: 'ja' }]) {
    await assert.rejects(planExport(root, { kind: 'document', format: 'html', path: `${documents}/角色.md`, language }), { statusCode: 400 });
  }
});

test('explicit audio bindings export a player even when the source does not embed the audio', async (t) => {
  const { root, documents, owner, audio } = await project(t);
  owner.assetBindings.push({ assetId: audio.id, role: 'theme' });
  await writeJson(path.join(root, 'metadata/documents', `${owner.id}.json`), owner);
  const plan = await planExport(root, { kind: 'document', format: 'html', path: `${documents}/角色.md`, includeChildren: false });
  const html = plan.entries.find((entry) => entry.path === 'index.html').buffer.toString();
  assert.equal(plan.assetCount, 2);
  assert.equal((html.match(/<audio controls/g) || []).length, 1);
  assert.match(html, /关联素材/);
  assert.match(html, new RegExp(`assets/${audio.id}.m4a`));
});

for (const extension of ['md', 'txt', 'json', 'yaml']) test(`sharing carries declared asset IDs recognized by the ${extension} reference index`, async (t) => {
  const { root, documents, image, audio } = await project(t);
  const missingExample = `asset:${randomUUID()}`;
  const fields = { title: '声明引用', 引用: [`asset:${image.id}`, { 配音: `asset://${audio.id.toUpperCase()}` }] };
  const content = extension === 'json' ? JSON.stringify(fields, null, 2)
    : extension === 'yaml' ? `title: 声明引用\n引用:\n  - asset:${image.id}\n  - 配音: asset://${audio.id.toUpperCase()}\n# ${missingExample}\n`
      : `${extension === 'md' ? '# ' : ''}声明引用\n\nasset:${image.id}\n\n配音：asset://${audio.id.toUpperCase()}\n\n\`\`\`text\n${missingExample}\n\`\`\`\n`;
  const source = `${documents}/声明.${extension}`;
  await write(root, source, content);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const registered = registry.documents.find((record) => record.sourcePath === source);
  await node(root, ['scripts/standardize-docs.mjs']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
  assert.deepEqual(index.docs.find((doc) => doc.id === registered.id).assetRefs.sort(), [image.id, audio.id].sort());
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(root, { kind: 'document', format, path: source });
    assert.equal(plan.assetCount, 2, 'Every indexed declaration must survive sharing');
    const output = path.join(root, `declarations-${extension}-${format}.zip`);
    await writeExportZip(plan, output);
    const { files, manifest } = unzip(await fs.readFile(output));
    assert.deepEqual(manifest.assets.map((asset) => asset.id).sort(), [image.id, audio.id].sort());
    assert.equal(files.get(`sources/${source}`).toString(), content);
    for (const asset of [image, audio]) {
      assert.deepEqual(files.get(`assets/${asset.id}${path.extname(asset.location.path)}`), await fs.readFile(path.join(root, '外置素材', asset.location.path)));
      assert.deepEqual(files.get(`metadata/assets/${asset.id}.json`), await fs.readFile(path.join(root, 'metadata/assets', `${asset.id}.json`)));
    }
    const body = files.get(format === 'html' ? 'index.html' : 'document.md').toString();
    assert.match(body, new RegExp(`assets/${image.id}.png`));
    assert.match(body, new RegExp(`assets/${audio.id}.m4a`));
    if (format === 'html') {
      assert.equal((body.match(/<img /g) || []).length, 1);
      assert.equal((body.match(/<audio controls/g) || []).length, 1);
    }
    assert.ok(![...files.keys()].some((name) => name.includes('未引用')));
  }
  assert.deepEqual(await readRegistry(root), registry);
});

test('multiple attachment roles share one player per document while keeping each owned story complete', async (t) => {
  const { root, documents, owner, image, audio } = await project(t);
  owner.assetBindings = [
    { assetId: image.id, role: 'portrait' }, { assetId: image.id, role: 'cover' },
    { assetId: audio.id, role: 'theme' }, { assetId: audio.id, role: 'voice' },
  ];
  await writeJson(path.join(root, 'metadata/documents', `${owner.id}.json`), owner);
  const registry = await readRegistry(root);
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(root, { kind: 'document', format, path: `${documents}/角色.md` });
    assert.equal(plan.documentCount, 2);
    assert.equal(plan.assetCount, 3);
    const body = plan.entries.find((entry) => entry.path === (format === 'html' ? 'index.html' : 'document.md')).buffer.toString();
    if (format === 'html') {
      assert.equal((body.match(/<img /g) || []).length, 1);
      for (const article of body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)) assert.equal((article[1].match(/<audio controls/g) || []).length, 1);
    } else assert.equal((body.match(/\[音频：/g) || []).length, 2);
  }
  assert.deepEqual(await readRegistry(root), registry, 'Roles and original attachments stay intact');
});

test('declared missing assets reject sharing, then retry succeeds after the reference is repaired', async (t) => {
  const { root, documents, image } = await project(t);
  const source = `${documents}/缺失引用.md`;
  await write(root, source, `# 声明引用\n\nasset:${randomUUID()}\n`);
  const service = createExportService(root);
  const options = { kind: 'document', format: 'html', path: source };
  await assert.rejects(service.create(options), /未登记/);
  await write(root, source, `# 声明引用\n\nasset:${image.id}\n`);
  await fs.rename(path.join(root, '外置素材', image.location.path), path.join(root, 'held-image.png'));
  await assert.rejects(service.create(options), /缺失/);
  await fs.rename(path.join(root, 'held-image.png'), path.join(root, '外置素材', image.location.path));
  const job = await service.create(options);
  assert.equal(job.assetCount, 1);
  const { manifest } = unzip(await fs.readFile(service.get(job.id).file));
  assert.deepEqual(manifest.assets.map((asset) => asset.id), [image.id]);
  await service.release(job.id);
  assert.deepEqual(await fs.readdir(path.join(root, '.viento/cache/exports')), []);
});

test('sharing retains indexed legacy image paths, relative links and unregistered local images', async (t) => {
  const { root, documents, image } = await project(t);
  const source = `${documents}/chapters/引用.md`;
  const raw = '# 旧图片引用\n\n[封面](../../assets/立绘.png)\n\n封面：assets/立绘.png\n\n原图：assets/未登记%2520.png\n\n```text\nassets/示例缺失.png\n```\n';
  await write(root, source, raw);
  await registerWorkspace(root);
  await fs.rename(path.join(root, '外置素材', image.location.path), path.join(root, '外置素材', `${image.id}.png`));
  image.location.path = `${image.id}.png`;
  await writeJson(path.join(root, 'metadata/assets', `${image.id}.json`), image);
  await write(root, '外置素材/未登记%20.png', 'unregistered image bytes');
  const registry = await readRegistry(root);
  const doc = registry.documents.find((record) => record.sourcePath === source);
  await node(root, ['scripts/standardize-docs.mjs']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
  const indexed = index.docs.find((item) => item.id === doc.id);
  assert.deepEqual(indexed.assetRefs, [image.id]);
  assert.deepEqual(indexed.unresolvedAssetPaths, ['assets/未登记%20.png']);
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(root, { kind: 'document', format, path: source });
    assert.equal(plan.assetCount, 2);
    const output = path.join(root, `legacy-images-${format}.zip`);
    await writeExportZip(plan, output);
    const { files, manifest } = unzip(await fs.readFile(output));
    assert.equal(manifest.assets.length, 2);
    assert.equal(files.get(`sources/${source}`).toString(), raw);
    assert.equal(files.get(`assets/${image.id}.png`).toString(), 'binary image');
    const unregistered = manifest.assets.find((asset) => asset.originalPath === 'assets/未登记%20.png');
    assert.ok(unregistered);
    assert.equal(files.get(unregistered.path).toString(), 'unregistered image bytes');
    const body = files.get(format === 'html' ? 'index.html' : 'document.md').toString();
    if (format === 'html') assert.equal((body.match(/<img /g) || []).length, 2);
    else assert.equal((body.match(/!\[/g) || []).length, 2);
  }
  assert.deepEqual(await readRegistry(root), registry);
});

for (const version of [2, 3]) test(`v${version} relative image references resolve against the original document directory`, async (t) => {
  const { root, documents, image } = await project(t, version);
  const source = `${documents}/chapters/相对引用.md`;
  await write(root, source, '# 相对引用\n\n[立绘](../../assets/立绘.png)\n\n[缺失](../../assets/缺失.png)\n');
  await registerWorkspace(root);
  const registered = (await readRegistry(root)).documents.find((doc) => doc.sourcePath === source);
  await node(root, ['scripts/standardize-docs.mjs']);
  await node(root, ['scripts/build-static-doc-site.mjs']);
  const index = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/documents.json'), 'utf8'));
  const doc = index.docs.find((item) => item.id === registered.id);
  assert.deepEqual(doc.assetRefs, [image.id]);
  assert.deepEqual(doc.heroImages, [`assets/${image.location.path}`, 'assets/缺失.png']);
  assert.deepEqual(doc.unresolvedAssetPaths, ['assets/缺失.png']);
  const references = JSON.parse(await fs.readFile(path.join(root, '.viento/cache/indexes/references.json'), 'utf8')).references.filter((link) => link.documentId === registered.id);
  assert.equal(references.length, 2);
  assert.ok(references.some((link) => link.assetId === image.id && link.resolved));
  assert.ok(references.some((link) => link.legacyPath === 'assets/缺失.png' && !link.resolved));
});

test('sharing preserves distinct percent and space filenames, registered identities and renamed aliases', async (t) => {
  const { root, documents, owner } = await project(t);
  owner.assetBindings = [];
  await writeJson(path.join(root, 'metadata/documents', `${owner.id}.json`), owner);
  const names = ['take one.wav', 'take%20one.wav', '100%.wav'];
  for (const name of names) await write(root, `外置素材/${name}`, `original bytes: ${name}`);
  await registerWorkspace(root);
  const registry = await readRegistry(root);
  const assets = names.map((name) => registry.assets.find((asset) => asset.location.path === name));
  const source = `# 素材引用\n\n${names.map((name) => `!audio[${name}](assets/${encodeURIComponent(name)})`).join('\n\n')}\n`;
  await write(root, `${documents}/角色.md`, source);
  for (const renamed of [false, true]) {
    if (renamed) for (const asset of assets) {
      await fs.rename(path.join(root, '外置素材', asset.location.path), path.join(root, '外置素材', `${asset.id}.wav`));
      asset.location.path = `${asset.id}.wav`;
      await writeJson(path.join(root, 'metadata/assets', `${asset.id}.json`), asset);
    }
    const plan = await planExport(root, { kind: 'document', format: 'html', path: `${documents}/角色.md`, includeChildren: false });
    const output = path.join(root, `aliases-${renamed}.zip`);
    await writeExportZip(plan, output);
    const { files, manifest } = unzip(await fs.readFile(output));
    assert.deepEqual(manifest.assets.map((asset) => asset.id).sort(), assets.map((asset) => asset.id).sort());
    for (const [index, asset] of assets.entries()) {
      assert.equal(files.get(`assets/${asset.id}.wav`).toString(), `original bytes: ${names[index]}`);
      assert.ok(files.has(`metadata/assets/${asset.id}.json`));
    }
    assert.equal(files.get(`sources/${documents}/角色.md`).toString(), source);
  }
});

test('owned stories retain nested heading levels in HTML and Markdown shares', async (t) => {
  const { root, documents } = await project(t);
  await write(root, `${documents}/背景.md`, '# 背景故事\n\n## 第一幕\n\n### 初遇\n\n#### 细节\n\n故事正文。\n');
  for (const format of ['html', 'markdown']) {
    const plan = await planExport(root, { kind: 'document', format, path: `${documents}/角色.md` });
    const body = plan.entries.find((entry) => entry.path === (format === 'html' ? 'index.html' : 'document.md')).buffer.toString();
    if (format === 'html') {
      assert.match(body, /<h2>背景故事<\/h2>/);
      assert.match(body, /<h3>第一幕<\/h3>/);
      assert.match(body, /<h4>初遇<\/h4>/);
      assert.match(body, /<h5>细节<\/h5>/);
    } else {
      assert.match(body, /^## 背景故事$/m);
      assert.match(body, /^### 第一幕$/m);
      assert.match(body, /^#### 初遇$/m);
      assert.match(body, /^##### 细节$/m);
    }
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
  assert.equal(job.assetCount, 4);
  assert.equal(files.get('assets/主题曲.m4a').toString(), 'referenced audio');
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

test('complete exports reject directory aliases and file-directory conflicts without changing project bytes', async (t) => {
  for (const [first, second] of [['Book/a.bin', 'book/b.bin'], ['Book', 'book/b.bin'], ['café/a.bin', 'cafe\u0301/b.bin']]) {
    assert.throws(() => assertPortableFileTree([first, second]), /冲突/);
    assert.throws(() => assertPortableFileTree([second, first]), /冲突/);
    // These physically distinct names cannot be created on every filesystem;
    // the virtual archive-tree checks above run on all supported platforms.
    if (process.platform !== 'linux') continue;
    const { root } = await project(t);
    await write(root, `外置素材/${first}`, 'first'); await write(root, `外置素材/${second}`, 'second');
    await assert.rejects(planExport(root, { kind: 'workspace' }), /冲突/);
    assert.equal(await fs.readFile(path.join(root, '外置素材', first), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(root, '外置素材', second), 'utf8'), 'second');
  }
});

test('editor and native v2/v3 archives round-trip with exact sources, metadata and external media', { skip: !process.env.VIENTO_TEST_ARCHIVE_BINARY }, async (t) => {
  const run = promisify(execFile);
  const native = async (...args) => JSON.parse((await run(process.env.VIENTO_TEST_ARCHIVE_BINARY, args, { timeout: 15000 })).stdout);
  for (const version of [2, 3]) {
    const { root } = await project(t, version);
    const nodeArchive = path.join(root, 'node.viento.zip');
    await writeExportZip(await planExport(root, { kind: 'workspace' }), nodeArchive);
    const original = unzip(await fs.readFile(nodeArchive));
    const parent = path.join(root, 'restores'); await fs.mkdir(parent);
    const { root: restored } = await native('import', nodeArchive, parent);
    for (const entry of original.manifest.files) assert.deepEqual(await fs.readFile(path.join(restored, entry.path)), original.files.get(entry.path), entry.path);
    assert.deepEqual(await readRegistry(restored), await readRegistry(root));
    await assert.rejects(fs.access(path.join(restored, '.viento/local.json')), { code: 'ENOENT' });
    const nativeArchive = path.join(root, 'native.viento.zip');
    await native('export', restored, nativeArchive);
    const exported = unzip(await fs.readFile(nativeArchive));
    for (const entry of original.manifest.files) assert.deepEqual(exported.files.get(entry.path), original.files.get(entry.path), entry.path);
    const { root: roundTrip } = await native('import', nativeArchive, parent);
    const next = path.join(root, 'next.viento.zip');
    await writeExportZip(await planExport(roundTrip, { kind: 'workspace' }), next);
    const final = unzip(await fs.readFile(next));
    for (const entry of original.manifest.files) assert.deepEqual(final.files.get(entry.path), original.files.get(entry.path), entry.path);
    assert.equal(final.manifest.workspace.id, original.manifest.workspace.id);
    assert.ok(![...final.files.keys()].some((name) => name.includes('cache/') || name.endsWith('local.json')));
  }
});

test('HTTP export supports edit and browse modes, authenticated creation, binary download and cleanup', async (t) => {
  const { root, documents } = await project(t);
  for (const script of ['doc-site-server.mjs', 'browse-server.mjs']) {
    const base = await serve(t, root, {}, script);
    const created = await request(base, '/api/export', { kind: 'document', format: 'html', path: `${documents}/角色.md`, language: 'ja' });
    assert.equal(created.status, 200, JSON.stringify(created.payload));
    const response = await fetch(`${base}/api/export?id=${created.data.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const downloaded = unzip(Buffer.from(await response.arrayBuffer()));
    assert.equal(downloaded.manifest.documents.length, 2);
    assert.match(downloaded.files.get('index.html').toString(), /<html lang="ja">/);
    assert.match(downloaded.files.get('README.txt').toString(), /展開/);
    assert.equal((await request(base, '/api/export', { action: 'release', id: created.data.id })).status, 200);
    assert.equal((await fetch(`${base}/api/export?id=${created.data.id}`)).status, 410);
    assert.equal((await request(base, '/api/export', { kind: 'document', format: 'pdf', path: `${documents}/角色.md` })).status, 400);
    assert.equal((await request(base, '/api/export', { kind: 'workspace', language: 'fr' })).status, 400);
  }
  const protectedBase = await serve(t, root, { DOC_API_REQUIRE_WRITE_AUTH: '1', DOC_API_TOKEN: 'export-test-token' });
  assert.equal((await request(protectedBase, '/api/export', { kind: 'workspace' })).status, 401);
  const protectedResponse = await fetch(`${protectedBase}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer export-test-token' }, body: JSON.stringify({ kind: 'workspace' }) });
  assert.equal(protectedResponse.status, 200);
});

test('consecutive browser exports recycle completed downloads instead of exhausting the three-job limit', async (t) => {
  const { root, documents } = await project(t);
  const base = await serve(t, root, {}, 'browse-server.mjs');
  for (let i = 0; i < 5; i += 1) {
    const created = await request(base, '/api/export', { kind: 'document', format: 'html', path: `${documents}/角色.md` });
    assert.equal(created.status, 200, `export ${i + 1}: ${JSON.stringify(created.payload)}`);
    const response = await fetch(`${base}/api/export?id=${created.data.id}`);
    assert.equal(response.status, 200);
    assert.equal(unzip(Buffer.from(await response.arrayBuffer())).manifest.documents.length, 2);
  }
});

test('releasing or expiring an export cannot remove a file being downloaded', async (t) => {
  const { root, documents } = await project(t);
  const service = createExportService(root, { ttlMs: 30 });
  const job = await service.create({ kind: 'document', format: 'html', path: `${documents}/角色.md` });
  const file = service.get(job.id).file;
  const ready = deferred(), finish = deferred();
  const downloading = service.download(job.id, async () => { ready.resolve(); await finish.promise; return true; });
  await ready.promise;
  try {
    await delay(80);
    assert.equal(unzip(await fs.readFile(file)).manifest.documents.length, 2);
    await service.release(job.id);
    assert.throws(() => service.get(job.id), { statusCode: 410 });
    await fs.access(file);
  } finally { finish.resolve(); await downloading; }
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('export range requests keep their real status in diagnostics and remain retryable', async (t) => {
  const { root, documents } = await project(t);
  const base = await serve(t, root);
  const created = await request(base, '/api/export', { kind: 'document', format: 'html', path: `${documents}/角色.md` });
  const url = `${base}/api/export?id=${created.data.id}`;
  for (const [range, expected] of [['bytes=0-7', 206], ['bytes=999999999-', 416]]) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, expected);
    await response.arrayBuffer();
    const metrics = (await request(base, '/api/metrics')).data;
    assert.equal(metrics.routes['GET /api/export'].lastStatusCode, expected);
  }
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(unzip(Buffer.from(await response.arrayBuffer())).manifest.documents.length, 2);
});

test('pending and interrupted exports remain protected from automatic quota eviction', async (t) => {
  const { root, documents } = await project(t);
  const service = createExportService(root);
  const options = { kind: 'document', format: 'html', path: `${documents}/角色.md` };
  const jobs = [];
  for (let i = 0; i < 3; i += 1) jobs.push(await service.create(options));
  t.after(() => Promise.all(jobs.map(job => service.release(job.id))));
  await service.download(jobs[0].id, async () => false);
  await assert.rejects(service.create(options), { statusCode: 409 });
  assert.ok(service.get(jobs[0].id));
  await service.download(jobs[0].id, async () => true);
  jobs.push(await service.create(options));
  assert.throws(() => service.get(jobs[0].id), { statusCode: 410 });
  assert.ok(service.get(jobs[1].id));
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
