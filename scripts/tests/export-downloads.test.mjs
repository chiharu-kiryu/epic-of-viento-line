import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, write } from './helpers.mjs';
import { registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { runCommand } from '../lib/process.mjs';

async function project(t) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '下载续传验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.md', '\uFEFF# 角色\r\n\r\n原始正文。  \r\n\r\n![立绘](../assets/立绘.png)\r\n\r\n!video[片段](../assets/片段.mp4)\r\n\r\n!audio[声音](../assets/声音.wav)\r\n');
  await write(root, 'templates/character.md', '\uFEFF# 角色模板\r\n');
  await write(root, 'assets/立绘.png', 'original image bytes');
  await write(root, 'assets/片段.mp4', 'original video bytes');
  await write(root, 'assets/声音.wav', randomBytes(192 * 1024));
  await registerWorkspace(root);
  return root;
}

// Each case uses the actual HTTP route, export service and disk files in its
// own process. Request completion includes the server's reader/handle cleanup.
const setup = String.raw`
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
  const service = createExportService(root), jobs = [], completions = new Map();
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  let sequence = 0, onClose;
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    response.on('close', () => onClose?.(requestUrl));
    try { await handleApiRequest({ pathname: requestUrl.pathname, request, response, requestUrl, service: { exports: service } }); }
    finally { completions.get(requestUrl.searchParams.get('testRequest'))?.resolve(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(payload) {
    const response = await fetch(base + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }
  async function create(options = { kind: 'workspace' }) {
    const result = await post(options);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    jobs.push(result.body.data); return result.body.data;
  }
  function begin(job, headers = {}, signal) {
    const id = String(++sequence), done = deferred(); completions.set(id, done);
    return { id, done: done.promise, response: fetch(base + '/api/export?id=' + job.id + '&testRequest=' + id, { headers, signal }) };
  }
  async function download(job, headers = {}) {
    const request = begin(job, headers);
    try {
      const response = await request.response;
      return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
    } finally { await request.done; completions.delete(request.id); }
  }
  async function blocked() { assert.equal((await post({ kind: 'workspace' })).status, 409, 'unfinished downloads must retain their quota'); }
  async function fill(options) { return [await create(options), await create(options), await create(options)]; }
  async function range(job, value, expected) {
    const response = await download(job, { Range: value });
    assert.equal(response.status, 206); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.bytes, expected); return response;
  }
  function checkZip(bytes) {
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
  }
  async function authoredBytes() {
    const entries = {};
    async function visit(relative) {
      const file = path.join(root, relative), stat = await fs.stat(file);
      if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      else entries[relative] = (await fs.readFile(file)).toString('base64');
    }
    for (const relative of ['workspace.json', 'documents', 'templates', 'metadata', 'assets']) await visit(relative);
    return entries;
  }
  const original = await authoredBytes();
  const watchdog = setTimeout(() => { console.error('download test stalled'); process.exit(1); }, 20000); watchdog.unref();
  try {
`;
const teardown = String.raw`
    assert.deepEqual(await authoredBytes(), original);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await Promise.all(jobs.map(job => service.release(job.id)));
    assert.deepEqual(await fs.readdir(cache), []);
    clearTimeout(watchdog);
  }
`;
async function run(t, source) {
  const root = await project(t);
  await runCommand(process.execPath, ['--input-type=module', '-e', setup + source + teardown], { cwd: root,
    env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root, VIENTO_SESSION_TOKEN: '', VIENTO_PREFERENCES_PATH: '',
      DOC_API_REQUIRE_WRITE_AUTH: '0', DOC_API_TOKEN: '', DOC_API_WRITE_TOKEN: '', DOC_API_RATE_LIMIT_MAX_REQUESTS: '1000', DOC_API_SECURITY_AUDIT: '0' } });
}

for (const kind of ['document', 'workspace']) test(`three segmented ${kind} downloads release capacity for a fourth complete export`, async (t) => {
  await run(t, `
    const options = ${JSON.stringify({ kind, format: 'html', path: 'documents/角色.md' })};
    const prepared = await fill(options);
    for (const job of prepared) {
      const expected = await fs.readFile(service.get(job.id).file), split = Math.floor(job.bytes / 2);
      const first = await range(job, 'bytes=0-' + (split - 1), expected.subarray(0, split));
      const rest = await range(job, 'bytes=' + split + '-', expected.subarray(split));
      const complete = Buffer.concat([first.bytes, rest.bytes]); assert.deepEqual(complete, expected); checkZip(complete);
    }
    const next = await create(options);
    assert.throws(() => service.get(prepared[0].id), { statusCode: 410 });
    const response = await download(next); assert.equal(response.status, 200); checkZip(response.bytes);
  `);
});

for (const kind of ['document', 'workspace']) test(`a complete ${kind} download releases capacity without waiting for an extra EOF read`, async (t) => {
  await run(t, `
    const options = ${JSON.stringify({ kind, format: 'html', path: 'documents/角色.md' })};
    const [job] = await fill(options), file = service.get(job.id).file, expected = await fs.readFile(file);
    const gate = deferred(), closed = deferred(), open = fs.open;
    // A client may close after receiving Content-Length bytes. Hold only an
    // extra EOF read so this ordering is reproducible without timing sleeps.
    fs.open = async (name, ...args) => {
      const handle = await open(name, ...args);
      if (String(name) === file) {
        const read = handle.read.bind(handle); let received = 0;
        handle.read = async (...args) => {
          if (received >= expected.length) await gate.promise;
          const result = await read(...args); received += result.bytesRead; return result;
        };
      }
      return handle;
    };
    const pending = begin(job, { Connection: 'close' });
    onClose = url => { if (url.searchParams.get('testRequest') === pending.id) closed.resolve(); };
    try {
      const response = await pending.response; assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual(bytes, expected); checkZip(bytes);
      await closed.promise;
    } finally { gate.resolve(); fs.open = open; await pending.done; onClose = null; }
    await create(options);
    assert.throws(() => service.get(job.id), { statusCode: 410 });
  `);
});

test('overlapping repeated and out-of-order ranges only free a slot after the final gap is filled', async (t) => {
  await run(t, String.raw`
    const [job] = await fill(), expected = await fs.readFile(service.get(job.id).file), split = Math.floor(job.bytes / 2);
    await range(job, 'bytes=' + (split + 1) + '-', expected.subarray(split + 1));
    for (let i = 0; i < 3; i++) await range(job, 'bytes=0-' + (split - 1), expected.subarray(0, split));
    await range(job, 'bytes=10-' + (split - 2), expected.subarray(10, split - 1));
    await blocked(); assert.deepEqual(await fs.readFile(service.get(job.id).file), expected);
    await range(job, 'bytes=' + split + '-' + split, expected.subarray(split, split + 1));
    await create(); assert.throws(() => service.get(job.id), { statusCode: 410 });
  `);
});

test('suffix and clamped ranges use their actual returned bounds when completing a download', async (t) => {
  await run(t, String.raw`
    const [job] = await fill(), expected = await fs.readFile(service.get(job.id).file), split = Math.floor(job.bytes / 2);
    await range(job, 'bytes=0-' + (split - 1), expected.subarray(0, split));
    await blocked();
    await range(job, 'bytes=-' + (job.bytes - split), expected.subarray(split));
    const next = await create(), nextBytes = await fs.readFile(service.get(next.id).file);
    await range(next, 'bytes=0-' + (next.bytes + 1000), nextBytes);
    await create(); assert.throws(() => service.get(next.id), { statusCode: 410 });
  `);
});

test('partial, not-modified, unsatisfiable and HEAD responses do not claim a complete download', async (t) => {
  await run(t, String.raw`
    const [job] = await fill(), expected = await fs.readFile(service.get(job.id).file);
    const part = await range(job, 'bytes=0-7', expected.subarray(0, 8));
    const cached = await download(job, { 'If-None-Match': part.headers.get('etag') });
    assert.equal(cached.status, 304); assert.equal(cached.bytes.length, 0);
    const invalid = await download(job, { Range: 'bytes=' + job.bytes + '-' });
    assert.equal(invalid.status, 416); assert.equal(invalid.bytes.length, 0);
    const head = await fetch(base + '/api/export?id=' + job.id, { method: 'HEAD' }); assert.equal(head.status, 405);
    await blocked();
    const retry = await download(job); assert.equal(retry.status, 200); assert.deepEqual(retry.bytes, expected); checkZip(retry.bytes);
    await create();
  `);
});

test('completed ranges belong to one export and cannot fill gaps in another export', async (t) => {
  await run(t, String.raw`
    const [first, second] = await fill();
    const a = await fs.readFile(service.get(first.id).file), b = await fs.readFile(service.get(second.id).file);
    const split = Math.floor(Math.min(first.bytes, second.bytes) / 2);
    await range(first, 'bytes=0-' + (split - 1), a.subarray(0, split));
    await range(second, 'bytes=' + split + '-', b.subarray(split));
    await blocked();
    await range(first, 'bytes=' + split + '-', a.subarray(split));
    await create(); assert.throws(() => service.get(first.id), { statusCode: 410 });
    assert.deepEqual(await fs.readFile(service.get(second.id).file), b);
    await blocked();
  `);
});

test('an interrupted HTTP range does not cover its missing bytes and remains retryable', async (t) => {
  await run(t, String.raw`
    const [job] = await fill(), file = service.get(job.id).file, expected = await fs.readFile(file), split = Math.floor(job.bytes / 2);
    const ready = deferred(), gate = deferred(), closed = deferred(), open = fs.open;
    let reads = 0;
    fs.open = async (name, ...args) => {
      const handle = await open(name, ...args);
      if (String(name) === file) {
        fs.open = open;
        const read = handle.read.bind(handle), stream = handle.createReadStream.bind(handle);
        handle.createReadStream = options => stream({ ...options, highWaterMark: 1024 });
        handle.read = async (...args) => {
          if (++reads === 2) { ready.resolve(); await gate.promise; }
          return read(...args);
        };
      }
      return handle;
    };
    const controller = new AbortController(), pending = begin(job, { Range: 'bytes=0-' + (split - 1) }, controller.signal);
    onClose = url => { if (url.searchParams.get('testRequest') === pending.id) closed.resolve(); };
    try {
      const response = await pending.response; assert.equal(response.status, 206);
      const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
      await ready.promise; controller.abort(); await closed.promise;
    } finally { gate.resolve(); fs.open = open; await pending.done; onClose = null; }
    await range(job, 'bytes=' + split + '-', expected.subarray(split)); await blocked();
    await range(job, 'bytes=0-' + (split - 1), expected.subarray(0, split));
    await create(); assert.throws(() => service.get(job.id), { statusCode: 410 });
  `);
});

test('concurrent ranges can finish out of order while active readers remain protected from eviction', async (t) => {
  await run(t, String.raw`
    const [job] = await fill(), expected = await fs.readFile(service.get(job.id).file), split = Math.floor(job.bytes / 3);
    const gates = [deferred(), deferred(), deferred()], ready = gates.map(() => deferred());
    const originalDownload = service.download; let reader = 0;
    service.download = (id, consume) => originalDownload(id, async current => {
      const index = reader++, result = await consume(current);
      ready[index].resolve(); await gates[index].promise; return result;
    });
    const spans = [[0, split - 1], [split, split * 2 - 1], [split * 2, job.bytes - 1]], pending = [];
    try {
      for (const [start, end] of spans) {
        const request = begin(job, { Range: 'bytes=' + start + '-' + end }); pending.push(request);
        const response = await request.response; assert.equal(response.status, 206);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected.subarray(start, end + 1));
      }
      await Promise.all(ready.map(gate => gate.promise)); await blocked();
      for (const index of [2, 0]) { gates[index].resolve(); await pending[index].done; }
      await blocked(); assert.deepEqual(await fs.readFile(service.get(job.id).file), expected);
      gates[1].resolve(); await pending[1].done;
      await create(); assert.throws(() => service.get(job.id), { statusCode: 410 });
    } finally { gates.forEach(gate => gate.resolve()); await Promise.all(pending.map(request => request.done)); service.download = originalDownload; }
  `);
});
