import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, write } from './helpers.mjs';
import { readRegistry, registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { runCommand } from '../lib/process.mjs';

async function project(t) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '导出准备验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.json', '{"title":"原始角色"}');
  await write(root, 'documents/无关.md', '# 无关正文\r\n');
  await write(root, 'templates/character.md', '\uFEFF# 原始模板\r\n\r\n');
  for (const name of ['a/主题曲.wav', 'b/场景.mp4', 'c/立绘.png']) await write(root, `assets/${name}`, Buffer.from([0, 255, 1, 13, 10, 0]));
  await registerWorkspace(root);
  const { assets } = await readRegistry(root);
  const audio = assets.find(asset => asset.kind === 'audio');
  await write(root, 'documents/角色.json', '\uFEFF' + JSON.stringify({ title: '原始角色', 数值: 2, 配音: { type: 'audio', src: `asset:${audio.id}` } }, null, 2).replaceAll('\n', '\r\n') + '\r\n');
  return root;
}

// These hooks only delay completed operations on a synthetic project. They
// record any subsequent authored-data I/O after cancellation or output failure.
const setup = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import nativeFs from 'node:fs';
  import path from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  import { createHash } from 'node:crypto';
  import { inflateRawSync } from 'node:zlib';
  const root = process.cwd(), cache = path.join(root, '.viento/cache/exports'), source = 'documents/角色.json';
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const gate = { ready: deferred(), resume: deferred(), entered: false }, outputs = [], afterStop = [];
  const originals = Object.fromEntries(['lstat', 'stat', 'readdir', 'readFile'].map(name => [name, fs[name]]));
  const originalWriteStream = nativeFs.createWriteStream;
  let watching = false, stopped = false;
  nativeFs.createWriteStream = (file, ...args) => { const stream = originalWriteStream(file, ...args); outputs.push(stream); return stream; };
  syncBuiltinESMExports();
  const authored = relative => /^(?:documents|templates|metadata|assets)(?:\/|$)/.test(relative) || ['workspace.json', '.viento/workspace.json'].includes(relative);
  function matches(method, relative) {
    const final = outputs.length > 0;
    if (scenario.stage === 'registry-tree') return !final && method === 'readdir' && relative === 'metadata/assets';
    if (scenario.stage === 'registry-read') return !final && method === 'readFile' && relative.startsWith('metadata/assets/');
    if (scenario.stage === 'source-read') return !final && method === 'readFile' && relative === source;
    if (scenario.stage === 'asset-tree') return !final && method === 'readdir' && relative === 'assets';
    if (scenario.stage === 'final-stat') return final && method === 'stat' && relative === source;
    if (scenario.stage === 'final-registry') return final && method === 'readFile' && relative.startsWith('metadata/assets/');
    return false;
  }
  for (const [method, original] of Object.entries(originals)) fs[method] = async (file, ...args) => {
    const relative = path.relative(root, String(file));
    if (watching && stopped && authored(relative)) afterStop.push(method + ':' + relative);
    const result = await original(file, ...args);
    if (watching && !gate.entered && matches(method, relative)) {
      gate.entered = true; gate.ready.resolve(); await gate.resume.promise;
      if (scenario.corrupt) return typeof result === 'string' ? '{broken' : Buffer.from('{broken');
    }
    return result;
  };
  const { createExportService } = await import('./scripts/lib/export-service.mjs');
  const { planExport } = await import('./scripts/lib/export-package.mjs');
  const service = createExportService(root), options = { kind: scenario.kind, format: 'html', path: source };
  const controller = new AbortController(), reason = Object.assign(new Error('stop export preparation'), { code: 'EIO' });
  const watchdog = setTimeout(() => { console.error('export preparation probe timed out: ' + JSON.stringify(scenario)); process.exit(1); }, 8000);
  async function authoredBytes() {
    const files = new Map();
    async function visit(relative) {
      const file = path.join(root, relative), stat = await originals.stat(file);
      if (stat.isDirectory()) for (const name of (await originals.readdir(file)).sort()) await visit(path.join(relative, name));
      else files.set(relative, await originals.readFile(file));
    }
    for (const relative of ['workspace.json', '.viento/workspace.json', 'documents', 'templates', 'metadata', 'assets']) await visit(relative);
    return files;
  }
  const before = await authoredBytes();
  async function emptyCache() {
    const files = await originals.readdir(cache).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    assert.deepEqual(files, []);
  }
  function checkZip(bytes) {
    const files = new Map(), end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(end >= 0);
    let offset = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
      assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
      const length = bytes.readUInt16LE(offset + 28), name = bytes.subarray(offset + 46, offset + 46 + length).toString();
      const local = bytes.readUInt32LE(offset + 42), start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
      const data = bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(compressed) : compressed;
      assert.equal(data.length, bytes.readUInt32LE(offset + 24)); assert.ok(!files.has(name)); files.set(name, data);
      offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
    const manifest = JSON.parse(files.get('manifest.json')); assert.equal(files.size, manifest.files.length + 1);
    for (const file of manifest.files) {
      assert.equal(files.get(file.path).length, file.size);
      assert.equal(createHash('sha256').update(files.get(file.path)).digest('hex'), file.sha256);
    }
    if (scenario.kind === 'workspace') {
      assert.equal(files.size, before.size + 1);
      for (const [file, bytes] of before) assert.deepEqual(files.get(file), bytes, file);
    } else {
      assert.deepEqual(files.get('sources/' + source), before.get(source));
      assert.equal(manifest.assets.length, 1);
      const asset = manifest.assets[0]; assert.deepEqual(files.get(asset.path), before.get(asset.originalPath));
      for (const [file, bytes] of files) if (file.startsWith('metadata/')) assert.deepEqual(bytes, before.get(file));
    }
  }
  async function retry() {
    watching = false;
    const job = await service.create(options);
    try { checkZip(await originals.readFile(service.get(job.id).file)); }
    finally { await service.release(job.id); }
    await emptyCache(); assert.deepEqual(await authoredBytes(), before);
  }
`;

const probe = String.raw`
  watching = true;
  const pending = service.create(options, controller.signal).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([gate.ready.promise, pending.then(result => { throw new Error('export finished before the I/O gate: ' + JSON.stringify(result)); })]);
    await assert.rejects(service.create(options), { statusCode: 409 });
    stopped = true;
    if (scenario.outputError) outputs[0].destroy(reason);
    else controller.abort(reason);
    // Deliver the output error to the real ZIP pipeline before releasing its
    // final registry read. The external cancellation signal remains untouched.
    if (scenario.outputError) await new Promise(resolve => outputs[0].once('close', resolve));
    gate.resume.resolve(); const outcome = await pending; watching = false;
    assert.equal(outcome.error, reason, 'cancellation or the first write error must survive late source/registry data');
    assert.deepEqual(afterStop, [], 'stopped preparation must not keep scanning or reading authored files');
    await emptyCache(); await retry();
  } finally {
    gate.resume.resolve(); watching = false;
    const outcome = await pending; if (outcome.value) await service.release(outcome.value.id);
  }
`;

async function run(t, scenario, body = probe) {
  const root = await project(t);
  await runCommand(process.execPath, ['--input-type=module', '-e', `const scenario = ${JSON.stringify(scenario)};\n` + setup + '\ntry {\n' + body + String.raw`
  } finally {
    gate.resume.resolve(); watching = false;
    for (const [method, original] of Object.entries(originals)) fs[method] = original;
    nativeFs.createWriteStream = originalWriteStream; syncBuiltinESMExports(); clearTimeout(watchdog);
  }
  `], { cwd: root, env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root, VIENTO_SESSION_TOKEN: '', VIENTO_PREFERENCES_PATH: '',
    DOC_API_REQUIRE_WRITE_AUTH: '0', DOC_API_TOKEN: '', DOC_API_WRITE_TOKEN: '', DOC_API_RATE_LIMIT_MAX_REQUESTS: '1000', DOC_API_SECURITY_AUDIT: '0' } });
}

for (const kind of ['document', 'workspace']) {
  for (const stage of ['registry-tree', 'registry-read']) test(`${kind} preparation cancellation stops the remaining ${stage} work`, async (t) => {
    await run(t, { kind, stage });
  });
  test(`${kind} final snapshot cancellation stops after the current file stat`, async (t) => {
    await run(t, { kind, stage: 'final-stat' });
  });
  test(`${kind} output failure cancels its final registry scan without an external abort`, async (t) => {
    await run(t, { kind, stage: 'final-registry', outputError: true });
  });
}

for (const corrupt of [false, true]) test(`cancelled source preparation preserves cancellation for ${corrupt ? 'malformed' : 'valid'} returned bytes`, async (t) => {
  await run(t, { kind: 'document', stage: 'source-read', corrupt });
});

test('workspace cancellation stops recursive asset enumeration before scanning more folders', async (t) => {
  await run(t, { kind: 'workspace', stage: 'asset-tree' });
});

test('already cancelled planning performs no metadata reads', async (t) => {
  await run(t, { kind: 'workspace' }, String.raw`
    controller.abort(reason); stopped = watching = true;
    await assert.rejects(planExport(root, options, controller.signal), error => error === reason);
    watching = false; assert.deepEqual(afterStop, []); await emptyCache(); await retry();
  `);
});

test('an already cancelled creation preserves all three existing completed jobs', async (t) => {
  await run(t, { kind: 'workspace' }, String.raw`
    const jobs = [];
    try {
      for (let i = 0; i < 3; i++) {
        const job = await service.create(options); jobs.push(job);
        await service.download(job.id, async current => { checkZip(await originals.readFile(current.file)); return true; });
      }
      controller.abort(reason); stopped = watching = true;
      await assert.rejects(service.create(options, controller.signal), error => error === reason);
      watching = false;
      for (const job of jobs) checkZip(await originals.readFile(service.get(job.id).file));
      assert.deepEqual(afterStop, []);
    } finally { watching = false; await Promise.all(jobs.map(job => service.release(job.id))); }
    await emptyCache(); await retry();
  `);
});

for (const damaged of ['metadata', 'source']) test(`uncancelled malformed ${damaged} is still rejected and can be repaired for export`, async (t) => {
  await run(t, { kind: 'document' }, `
    const file = ${damaged === 'source' ? 'source' : "[...before.keys()].find(file => file.startsWith('metadata/assets/'))"};
    try {
      await fs.writeFile(path.join(root, file), '{broken');
      await assert.rejects(service.create(options), error => ${damaged === 'source' ? "error.statusCode === 400 && /正文解析失败/.test(error.message)" : "error instanceof SyntaxError"});
      await emptyCache();
    } finally { await fs.writeFile(path.join(root, file), before.get(file)); }
    await retry();
  `);
});

test('HTTP disconnect during registry preparation stops scanning and permits a complete retry download', async (t) => {
  await run(t, { kind: 'workspace', stage: 'registry-read' }, String.raw`
    const { createServer } = await import('node:http'), { once } = await import('node:events');
    const { handleApiRequest } = await import('./scripts/lib/doc-server-routes.mjs');
    const closed = deferred(), finished = deferred(), downloadFinished = deferred(); let first = true;
    const server = createServer(async (request, response) => {
      const tracked = first; first = false;
      if (tracked) response.once('close', () => closed.resolve());
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      await handleApiRequest({ pathname: requestUrl.pathname, request, response, requestUrl, service: { exports: service } });
      if (tracked) finished.resolve();
      if (request.method === 'GET') downloadFinished.resolve();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (payload, signal) => fetch(base + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
    try {
      watching = true;
      const pending = post(options, controller.signal); pending.catch(() => {});
      await gate.ready.promise; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
      await closed.promise; stopped = true; gate.resume.resolve(); await finished.promise; watching = false;
      assert.deepEqual(afterStop, []); await emptyCache();
      const response = await post(options); assert.equal(response.status, 200);
      const { data: job } = await response.json();
      try {
        const downloaded = await fetch(base + '/api/export?id=' + job.id); assert.equal(downloaded.status, 200);
        const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.equal(bytes.length, job.bytes); checkZip(bytes);
        await downloadFinished.promise;
        const released = await post({ action: 'release', id: job.id }); assert.equal(released.status, 200); await released.json();
      } finally { await service.release(job.id); }
      await emptyCache(); assert.deepEqual(await authoredBytes(), before);
    } finally {
      gate.resume.resolve(); watching = false;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  `);
});
