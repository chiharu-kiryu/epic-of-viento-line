import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fixture, write } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { V2_GUARD } from '../lib/workspace.mjs';
import { planExport, writeExportZip } from '../lib/export-package.mjs';
import { createExportService } from '../lib/export-service.mjs';
import { runCommand } from '../lib/process.mjs';

// Inspect the actual ZIP central directory independently of the writer, and
// check every digest and byte against the authored fixture inventory.
function checkArchive(bytes, expected) {
  const files = new Map();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
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
  for (const [file, bytes] of expected) assert.deepEqual(files.get(file), bytes, file);
  return { files, manifest };
}

async function project(t, version = 3, { privateManifest = false, copyApp = false } = {}) {
  const root = copyApp ? await fixture(t) : await fs.mkdtemp(path.join(os.tmpdir(), 'viento-export-snapshot-'));
  if (copyApp) {
    for (const folder of ['assets', 'data-template']) await fs.rm(path.join(root, folder), { recursive: true, force: true });
  } else t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documents = version === 3 ? 'documents' : 'design-data';
  const templates = version === 3 ? 'templates' : 'data-template';
  const manifest = { format: 'viento-workspace', version, id: randomUUID(), name: '导出快照验证', createdAt: 0,
    paths: { documents, templates, metadata: 'metadata' }, assetStores: { main: { path: 'assets' } },
    ...(version === 3 ? { documentTypes: PROJECT_DEFAULTS.documentTypes } : {}) };
  const source = `${documents}/角色.md`;
  const expected = new Map([
    [privateManifest ? '.viento/workspace.json' : 'workspace.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\r\n')],
    [source, Buffer.from('\uFEFF# 原始角色\r\n\r\n保留原文和行尾。  \r\n')],
  ]);
  for (const [file, bytes] of expected) await write(root, file, bytes);
  return { root, documents, templates, source, manifest, expected };
}

async function retryAndCheck(root, expected) {
  const service = createExportService(root), job = await service.create({ kind: 'workspace' });
  try {
    const bytes = await fs.readFile(service.get(job.id).file);
    assert.equal(bytes.length, job.bytes);
    const archive = checkArchive(bytes, expected);
    assert.equal(archive.files.size, expected.size + 1, 'the package contains exactly the authored inventory and its manifest');
    for (const [file, content] of expected) assert.deepEqual(await fs.readFile(path.join(root, file)), content);
    return archive;
  } finally {
    await service.release(job.id);
    assert.deepEqual(await fs.readdir(path.join(root, '.viento/cache/exports')), []);
  }
}

for (const version of [2, 3]) {
  for (const addition of ['assets', 'templates', 'metadata', 'guard', 'public manifest']) {
    test(`v${version} export rejects a newly appearing ${addition} and retries with its exact bytes`, async (t) => {
      const { root, templates, manifest, expected } = await project(t, version, { privateManifest: addition === 'public manifest' });
      const plan = await planExport(root, { kind: 'workspace' });
      const [file, bytes] = {
        assets: ['assets/初次导入.m4a', Buffer.from([0, 1, 255, 13, 10, 0, 42])],
        templates: [`${templates}/新增模板.md`, Buffer.from('\uFEFF# 新模板\r\n\r\n属性：  \r\n')],
        metadata: ['metadata/custom.json', Buffer.from('{ "自定义信息": true }\r\n')],
        guard: ['.viento/workspace.json', Buffer.from(JSON.stringify(V2_GUARD, null, 4) + '\r\n')],
        'public manifest': ['workspace.json', Buffer.from(JSON.stringify(manifest, null, 4) + '\n')],
      }[addition];
      await write(root, file, bytes); expected.set(file, bytes);
      await assert.rejects(writeExportZip(plan, path.join(root, 'obsolete.zip')), { statusCode: 409, errorCode: 'export_failed' });
      const { manifest: archived } = await retryAndCheck(root, expected);
      assert.equal(archived.version, version);
    });
  }

  test(`v${version} export still accepts unchanged missing optional directories and guards`, async (t) => {
    const { root, expected } = await project(t, version);
    await retryAndCheck(root, expected);
    for (const folder of ['assets', version === 3 ? 'templates' : 'data-template', 'metadata']) {
      await assert.rejects(fs.lstat(path.join(root, folder)), { code: 'ENOENT' });
    }
    await assert.rejects(fs.lstat(path.join(root, '.viento/workspace.json')), { code: 'ENOENT' });
  });
}

test('legacy export can synthesize a manifest without writing one into the project', async (t) => {
  const { root, expected } = await project(t, 2);
  await fs.unlink(path.join(root, 'workspace.json')); expected.delete('workspace.json');
  const plan = await planExport(root, { kind: 'workspace' }), output = path.join(root, 'legacy.zip');
  await writeExportZip(plan, output);
  const { files, manifest } = checkArchive(await fs.readFile(output), expected);
  assert.equal(manifest.workspace.version, 1);
  assert.deepEqual(JSON.parse(files.get('workspace.json')), manifest.workspace);
  await assert.rejects(fs.lstat(path.join(root, 'workspace.json')), { code: 'ENOENT' });
});

test('document sharing ignores unrelated new directories and preserves the selected source', async (t) => {
  const { root, source, expected } = await project(t);
  const plans = await Promise.all(['html', 'markdown'].map(format => planExport(root, { kind: 'document', format, path: source })));
  await write(root, 'assets/unrelated.mp4', Buffer.from('unrelated video'));
  await write(root, 'templates/unrelated.md', '# 其他类型\n');
  await write(root, 'metadata/custom.json', '{"note":"unrelated"}');
  for (const [index, plan] of plans.entries()) {
    const output = path.join(root, `share-${index}.zip`);
    await writeExportZip(plan, output);
    const { files } = checkArchive(await fs.readFile(output), new Map([[`sources/${source}`, expected.get(source)]]));
    assert.ok(![...files.keys()].some(file => /unrelated|custom\.json/.test(file)));
  }
  assert.deepEqual(await fs.readFile(path.join(root, source)), expected.get(source));
});

test('workspace snapshots exclude ordinary cache activity and non-project root files', async (t) => {
  const { root, expected } = await project(t);
  const plan = await planExport(root, { kind: 'workspace' }), output = path.join(root, 'snapshot.zip');
  await write(root, '.viento/cache/indexes/documents.json', '{"cache":true}');
  await write(root, 'unrelated.txt', 'outside the portable project');
  await writeExportZip(plan, output);
  const { files } = checkArchive(await fs.readFile(output), expected);
  assert.equal(files.size, expected.size + 1);
});

test('new files inside an already existing empty asset folder remain protected', async (t) => {
  const { root, expected } = await project(t);
  await fs.mkdir(path.join(root, 'assets'));
  const plan = await planExport(root, { kind: 'workspace' });
  const file = 'assets/新增.png', bytes = Buffer.from('new image');
  await write(root, file, bytes); expected.set(file, bytes);
  await assert.rejects(writeExportZip(plan, path.join(root, 'obsolete.zip')), { statusCode: 409 });
  await retryAndCheck(root, expected);
});

test('a dangling link replacing an absent asset root is detected without following it', async (t) => {
  const { root, expected } = await project(t);
  const plan = await planExport(root, { kind: 'workspace' });
  const target = path.join(root, 'missing-target'), link = path.join(root, 'assets');
  await fs.symlink(target, link, 'dir');
  await assert.rejects(writeExportZip(plan, path.join(root, 'obsolete.zip')), { statusCode: 409 });
  assert.equal(await fs.readlink(link), target);
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  await fs.unlink(link);
  await retryAndCheck(root, expected);
});

test('HTTP export rejects late first media import, cleans its staging job and downloads a complete retry', async (t) => {
  const { root, expected } = await project(t, 3, { copyApp: true });
  const encoded = [...expected].map(([file, bytes]) => [file, bytes.toString('base64')]);
  await runCommand(process.execPath, ['--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    import { inflateRawSync } from 'node:zlib';
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { createExportService } from './scripts/lib/export-service.mjs';
    import { handleApiRequest } from './scripts/lib/doc-server-routes.mjs';
    const root = process.cwd(), cache = path.join(root, '.viento/cache/exports');
    const expected = new Map(${JSON.stringify(encoded)}.map(([file, base64]) => [file, Buffer.from(base64, 'base64')]));
    const checkArchive = ${checkArchive.toString()};
    const media = Buffer.from([0, 255, 13, 10, 5, 0]), relative = 'assets/first.m4a';
    const service = createExportService(root), mkdir = fs.mkdir;
    // The real service creates its staging directory only after planning.
    // Introduce one actual media file at that boundary, in an isolated process.
    let injected = false;
    fs.mkdir = async (file, ...args) => {
      const result = await mkdir(file, ...args);
      if (!injected && path.dirname(String(file)) === cache) {
        injected = true;
        await mkdir(path.join(root, 'assets'));
        await fs.writeFile(path.join(root, relative), media);
        expected.set(relative, media);
      }
      return result;
    };
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      await handleApiRequest({ pathname: requestUrl.pathname, request, response, requestUrl, service: { exports: service } });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = payload => fetch(base + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    try {
      const rejected = await post({ kind: 'workspace' });
      assert.equal(injected, true);
      assert.equal(rejected.status, 409);
      assert.match(JSON.stringify(await rejected.json()), /发生变化/);
      assert.deepEqual(await fs.readdir(cache), []);
      const response = await post({ kind: 'workspace' }); assert.equal(response.status, 200);
      const { data: job } = await response.json();
      try {
        const download = await fetch(base + '/api/export?id=' + job.id); assert.equal(download.status, 200);
        const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(bytes.length, job.bytes);
        const { files } = checkArchive(bytes, expected); assert.equal(files.size, expected.size + 1);
        for (const [file, content] of expected) assert.deepEqual(await fs.readFile(path.join(root, file)), content);
        const released = await post({ action: 'release', id: job.id }); assert.equal(released.status, 200); await released.json();
        assert.equal((await fetch(base + '/api/export?id=' + job.id)).status, 410);
      } finally { await service.release(job.id); }
      assert.deepEqual(await fs.readdir(cache), []);
    } finally {
      fs.mkdir = mkdir;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  `], { cwd: root, env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root, VIENTO_SESSION_TOKEN: '', VIENTO_PREFERENCES_PATH: '',
    DOC_API_REQUIRE_WRITE_AUTH: '0', DOC_API_TOKEN: '', DOC_API_WRITE_TOKEN: '', DOC_API_RATE_LIMIT_MAX_REQUESTS: '1000', DOC_API_SECURITY_AUDIT: '0' } });
});
