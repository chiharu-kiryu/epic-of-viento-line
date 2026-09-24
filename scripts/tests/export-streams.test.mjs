import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, write } from './helpers.mjs';
import { readRegistry, registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { runCommand } from '../lib/process.mjs';

async function project(t) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '导出读取验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.md', '\uFEFF# 原始角色\r\n\r\n!audio[主题曲](../assets/主题曲.wav)\r\n');
  await write(root, 'templates/character.md', '\uFEFF# 角色模板\r\n');
  await write(root, 'assets/主题曲.wav', Buffer.alloc(2 * 1024 * 1024, 0x5a));
  await registerWorkspace(root);
  const { assets } = await readRegistry(root);
  await write(root, 'documents/角色.md', `\uFEFF# 原始角色\r\n\r\n!audio[主题曲](asset:${assets[0].id})\r\n`);
  return root;
}

// Every probe runs in its own process. Real file operations and ZIP streams are
// retained; only one selected asynchronous completion is held at a time.
const setup = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import nativeFs from 'node:fs';
  import path from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  import { createHash } from 'node:crypto';
  import { inflateRawSync } from 'node:zlib';
  import { setTimeout as delay } from 'node:timers/promises';
  const root = process.cwd(), cache = path.join(root, '.viento/cache/exports');
  const media = path.join(root, 'assets/主题曲.wav');
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const gate = { ready: deferred(), resume: deferred(), entered: false };
  async function pause(stage) {
    if (stage !== scenario.stage || gate.entered) return;
    gate.entered = true; gate.ready.resolve(); await gate.resume.promise;
  }
  const handles = [], streams = [], outputs = [];
  let readCalls = 0, streamStarts = 0, completed = false, stateAtCompletion;
  const initialOpen = fs.open, initialRealpath = fs.realpath, initialWriteStream = nativeFs.createWriteStream;
  nativeFs.createWriteStream = (file, ...args) => {
    const stream = initialWriteStream(file, ...args);
    const closed = new Promise(resolve => stream.once('close', resolve));
    outputs.push({ stream, closed });
    return stream;
  };
  syncBuiltinESMExports();
  fs.realpath = async (file, ...args) => {
    const result = await initialRealpath(file, ...args);
    if (outputs.length && String(file) === path.dirname(media)) await pause('resolve');
    return result;
  };
  const originalReadError = Object.assign(new Error('source stat failed'), { code: 'EIO' });
  fs.open = async (file, ...args) => {
    const handle = await initialOpen(file, ...args);
    if (String(file) !== media) return handle;
    handles.push(handle);
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle);
    const createReadStream = handle.createReadStream.bind(handle);
    handle.stat = async (...args) => {
      const result = await stat(...args); await pause('stat');
      if (scenario.stop === 'stat-error' && !gate.entered) throw originalReadError;
      return result;
    };
    handle.read = async (...args) => {
      readCalls++;
      const result = await read(...args); await pause('read'); return result;
    };
    handle.close = async (...args) => { await pause('close'); return close(...args); };
    handle.createReadStream = (...args) => {
      streamStarts++;
      const stream = createReadStream(...args); streams.push(stream); return stream;
    };
    await pause('open');
    return handle;
  };
  const { createExportService } = await import('./scripts/lib/export-service.mjs');
  const service = createExportService(root);
  const options = { kind: scenario.kind, format: 'html', path: 'documents/角色.md' };
  async function authoredBytes() {
    const result = new Map();
    async function visit(relative) {
      const file = path.join(root, relative), stat = await fs.stat(file);
      if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      else result.set(relative, await fs.readFile(file));
    }
    for (const relative of ['workspace.json', '.viento/workspace.json', 'documents', 'templates', 'metadata', 'assets']) await visit(relative);
    return result;
  }
  // Decode the finished retry independently of the writer, including its own
  // manifest hashes and the exact original source, metadata and asset bytes.
  function checkArchive(bytes, expected) {
    const files = new Map(), end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0);
    let offset = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
      assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
      const length = bytes.readUInt16LE(offset + 28), name = bytes.subarray(offset + 46, offset + 46 + length).toString();
      const local = bytes.readUInt32LE(offset + 42), start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
      const content = bytes.readUInt16LE(offset + 10) === 8 ? inflateRawSync(compressed) : compressed;
      assert.equal(content.length, bytes.readUInt32LE(offset + 24)); assert.ok(!files.has(name)); files.set(name, content);
      offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
    const manifest = JSON.parse(files.get('manifest.json')); assert.equal(files.size, manifest.files.length + 1);
    for (const file of manifest.files) {
      assert.equal(files.get(file.path).length, file.size);
      assert.equal(createHash('sha256').update(files.get(file.path)).digest('hex'), file.sha256);
    }
    if (scenario.kind === 'workspace') {
      assert.equal(files.size, expected.size + 1);
      for (const [file, bytes] of expected) assert.deepEqual(files.get(file), bytes, file);
    } else {
      assert.deepEqual(files.get('sources/documents/角色.md'), expected.get('documents/角色.md'));
      const asset = manifest.assets.find(asset => asset.originalPath === 'assets/主题曲.wav'); assert.ok(asset);
      assert.deepEqual(files.get(asset.path), expected.get('assets/主题曲.wav'));
      for (const [file, bytes] of expected) if (file.startsWith('metadata/')) assert.deepEqual(files.get(file), bytes);
    }
  }
`;

async function run(t, scenario) {
  const root = await project(t);
  await runCommand(process.execPath, ['--input-type=module', '-e', `const scenario = ${JSON.stringify(scenario)};\n` + setup + String.raw`
    const watchdog = setTimeout(() => { console.error('export I/O probe timed out: ' + JSON.stringify(scenario)); process.exit(1); }, 8000);
    const before = await authoredBytes(), controller = new AbortController();
    const reason = Object.assign(new Error('stop export while ' + scenario.stage + ' is pending'), { code: 'EIO' });
    let outcome, early, retry;
    const pending = service.create(options, controller.signal).then(value => ({ value }), error => ({ error })).then(result => {
      completed = true;
      stateAtCompletion = { openDescriptors: handles.filter(handle => handle.fd !== -1).length, streamStarts, readCalls };
      return result;
    });
    try {
      await Promise.race([gate.ready.promise, pending.then(result => { throw new Error('export finished before reaching the I/O gate: ' + JSON.stringify(result)); })]);
      assert.equal(completed, false);
      if (scenario.stop === 'abort') controller.abort(reason);
      if (scenario.stop === 'output-error') outputs[0].stream.destroy(reason);
      // Cancellation/failure closes the ZIP writer first. The source operation
      // remains deliberately outstanding until its gate is released below.
      if (scenario.stop !== 'stat-error') await outputs[0].closed;
      early = await Promise.race([pending.then(() => true), delay(40).then(() => false)]);
      gate.resume.resolve(); outcome = await pending;
      assert.equal(stateAtCompletion.openDescriptors, 0, 'all source descriptors must be closed before the export settles');
      assert.equal(early, false, 'export must wait for the outstanding source operation before settling');
      if (['resolve', 'open', 'stat'].includes(scenario.stage)) {
        assert.equal(stateAtCompletion.streamStarts, 0, 'a late open/stat result must not start reading after export stopped');
        assert.equal(stateAtCompletion.readCalls, 0);
      }
      if (scenario.stage === 'resolve') assert.equal(handles.length, 0, 'cancelled resolution must not open a file afterwards');
      if (scenario.stage === 'read') assert.equal(stateAtCompletion.readCalls, 1, 'the interrupted reader must not issue another read');
      if (scenario.stop === 'complete') {
        assert.ok(outcome.value); checkArchive(await fs.readFile(service.get(outcome.value.id).file), before);
        await service.release(outcome.value.id);
      } else {
        assert.equal(outcome.error, scenario.stop === 'stat-error' ? originalReadError : reason, 'keep the original cancellation or I/O error');
        assert.equal(outcome.value, undefined);
      }
      assert.deepEqual(await fs.readdir(cache), []);
      retry = await service.create(options);
      await service.download(retry.id, async job => {
        const bytes = await fs.readFile(job.file); assert.equal(bytes.length, retry.bytes); checkArchive(bytes, before); return true;
      });
      await service.release(retry.id); retry = null;
      assert.deepEqual(await fs.readdir(cache), []);
      assert.deepEqual(await authoredBytes(), before);
    } finally {
      gate.resume.resolve();
      // The old implementation leaks a stalled reader in failing probes. Close
      // test-owned resources explicitly so before-fix evidence never leaks FDs.
      for (const stream of streams) stream.destroy();
      await Promise.all(handles.map(handle => handle.close().catch(() => {})));
      const result = await pending;
      if (result.value) await service.release(result.value.id);
      if (retry) await service.release(retry.id);
      fs.open = initialOpen; fs.realpath = initialRealpath;
      nativeFs.createWriteStream = initialWriteStream; syncBuiltinESMExports();
      clearTimeout(watchdog);
    }
  `], { cwd: root, env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root, VIENTO_SESSION_TOKEN: '', VIENTO_PREFERENCES_PATH: '' } });
}

for (const kind of ['document', 'workspace']) {
  for (const stage of ['resolve', 'open', 'stat']) test(`${kind} cancellation during ${stage} waits for cleanup and cannot start a late reader`, async (t) => {
    await run(t, { kind, stage, stop: 'abort' });
  });
  test(`${kind} cancellation during an active read waits for its descriptor to close`, async (t) => {
    await run(t, { kind, stage: 'read', stop: 'abort' });
  });
  test(`${kind} success waits for an earlier input close before exposing the job`, async (t) => {
    await run(t, { kind, stage: 'close', stop: 'complete' });
  });
}

for (const stage of ['resolve', 'open', 'stat']) test(`ZIP output failure during ${stage} stops pending inputs and preserves the original error`, async (t) => {
  await run(t, { kind: 'workspace', stage, stop: 'output-error' });
});

test('a source stat error still waits for close and leaves a complete export retry available', async (t) => {
  await run(t, { kind: 'workspace', stage: 'close', stop: 'stat-error' });
});
