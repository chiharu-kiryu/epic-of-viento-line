import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, write } from './helpers.mjs';
import { registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { runCommand } from '../lib/process.mjs';

async function project(t) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '导出清理验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.md', '\uFEFF# 角色\r\n\r\n原始内容。  \r\n\r\n![立绘](../assets/立绘.png)\r\n');
  await write(root, 'templates/character.md', '# 角色模板\n');
  await write(root, 'assets/立绘.png', Buffer.from('original image bytes'));
  await registerWorkspace(root);
  return root;
}

// Faults are confined to one temporary project in a separate process. ZIP
// planning, writing, HTTP streaming and all authoritative file reads stay real.
const setup = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import path from 'node:path';
  import { setTimeout as delay } from 'node:timers/promises';
  import { createExportService } from './scripts/lib/export-service.mjs';
  const root = process.cwd(), cache = path.join(root, '.viento/cache/exports');
  const options = { kind: 'workspace' };
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  async function until(check, message) {
    const deadline = Date.now() + 3000;
    while (!await check()) { assert.ok(Date.now() < deadline, message); await delay(10); }
  }
  async function authoredBytes() {
    const files = {};
    async function visit(relative) {
      const file = path.join(root, relative), stat = await fs.stat(file);
      if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      else files[relative] = (await fs.readFile(file)).toString('base64');
    }
    for (const relative of ['workspace.json', 'documents', 'templates', 'metadata', 'assets']) await visit(relative);
    return files;
  }
  const before = await authoredBytes(), rm = fs.rm;
  const busy = Object.assign(new Error('temporary export file busy'), { code: 'EBUSY' });
  let removal;
  fs.rm = async (file, ...args) => {
    if (removal && String(file) === removal.directory) {
      removal.calls++;
      if (removal.gate) { removal.ready.resolve(); await removal.gate.promise; }
      if (removal.remaining-- > 0) throw busy;
    }
    return rm(file, ...args);
  };
  function failRemoval(directory, remaining = 1) { removal = { directory, remaining, calls: 0 }; return removal; }
`;

async function run(t, source) {
  const root = await project(t);
  await runCommand(process.execPath, ['--input-type=module', '-e', setup + source + '\nassert.deepEqual(await authoredBytes(), before);'], { cwd: root,
    env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root, VIENTO_SESSION_TOKEN: '', VIENTO_PREFERENCES_PATH: '',
      DOC_API_REQUIRE_WRITE_AUTH: '0', DOC_API_TOKEN: '', DOC_API_WRITE_TOKEN: '', DOC_API_RATE_LIMIT_MAX_REQUESTS: '1000', DOC_API_SECURITY_AUDIT: '0' } });
}

test('HTTP release can retry a failed removal without reviving the download or leaking its ZIP', async (t) => {
  await run(t, String.raw`
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { handleApiRequest } from './scripts/lib/doc-server-routes.mjs';
    const service = createExportService(root);
    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      await handleApiRequest({ pathname: requestUrl.pathname, request, response, requestUrl, service: { exports: service } });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = payload => fetch(base + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    try {
      const created = await post(options); assert.equal(created.status, 200);
      const { data: job } = await created.json(), file = service.get(job.id).file;
      const expected = await fs.readFile(file);
      const downloaded = await fetch(base + '/api/export?id=' + job.id);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected);
      failRemoval(path.dirname(file));
      const failed = await post({ action: 'release', id: job.id });
      assert.equal(failed.status, 500); await failed.json();
      assert.equal((await fetch(base + '/api/export?id=' + job.id)).status, 410);
      assert.equal(await exists(file), true);
      const retry = await post({ action: 'release', id: job.id });
      assert.equal(retry.status, 200); assert.equal((await retry.json()).data.released, true);
      assert.equal(await exists(path.dirname(file)), false, 'a successful retry must really remove the old staging directory');
      const next = await service.create(options);
      await service.release(next.id);
      assert.deepEqual(await fs.readdir(cache), []);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  `);
});

test('concurrent releases wait for the same removal and both report its failure before a successful retry', async (t) => {
  await run(t, String.raw`
    const service = createExportService(root), job = await service.create(options);
    const directory = service.get(job.id).directory;
    const fault = failRemoval(directory); fault.ready = deferred(); fault.gate = deferred();
    const first = service.release(job.id).then(() => null, error => error);
    await fault.ready.promise;
    let secondDone = false;
    const second = service.release(job.id).then(() => { secondDone = true; return null; }, error => { secondDone = true; return error; });
    try {
      await delay(20);
      assert.equal(secondDone, false, 'another caller must not receive success while deletion is still pending');
      assert.equal(fault.calls, 1, 'concurrent callers share one physical deletion');
      assert.throws(() => service.get(job.id), { statusCode: 410 });
    } finally { fault.gate.resolve(); }
    assert.equal(await first, busy); assert.equal(await second, busy);
    await service.release(job.id);
    assert.equal(await exists(directory), false);
  `);
});

test('expired exports automatically retry transient cleanup failures without another user request', async (t) => {
  await run(t, String.raw`
    const service = createExportService(root, { ttlMs: 35 }), job = await service.create(options);
    const directory = service.get(job.id).directory, fault = failRemoval(directory, 2);
    await until(() => fault.calls > 0, 'expiry must attempt cleanup');
    assert.throws(() => service.get(job.id), { statusCode: 410 });
    await until(async () => !await exists(directory), 'expiry cleanup must recover automatically from temporary EBUSY');
    assert.equal(fault.calls, 3);
    await delay(100); assert.equal(fault.calls, 3, 'successful cleanup stops retries');
  `);
});

test('two active downloads retain exact ZIP bytes until both finish and cleanup failure cannot fail the completed download', async (t) => {
  await run(t, String.raw`
    const service = createExportService(root, { ttlMs: 35 }), job = await service.create(options);
    const file = service.get(job.id).file, expected = await fs.readFile(file);
    const readers = [deferred(), deferred()], ready = [deferred(), deferred()];
    const downloads = readers.map((gate, index) => service.download(job.id, async held => {
      ready[index].resolve(); await gate.promise;
      assert.deepEqual(await fs.readFile(held.file), expected); return true;
    }).then(() => null, error => error));
    await Promise.all(ready.map(value => value.promise));
    const fault = failRemoval(path.dirname(file));
    await service.release(job.id); await delay(80);
    assert.throws(() => service.get(job.id), { statusCode: 410 });
    assert.equal(fault.calls, 0); assert.equal(await exists(file), true);
    readers[0].resolve(); assert.equal(await downloads[0], null);
    assert.equal(fault.calls, 0);
    readers[1].resolve(); assert.equal(await downloads[1], null, 'a finished download must not become a cleanup error');
    await until(async () => !await exists(path.dirname(file)), 'cleanup retries after the final reader exits');
    assert.equal(fault.calls, 2);
  `);
});

test('an interrupted download keeps its original failure when releasing the last reader also fails', async (t) => {
  await run(t, String.raw`
    const service = createExportService(root, { ttlMs: 35 }), job = await service.create(options);
    const directory = service.get(job.id).directory, gate = deferred(), ready = deferred();
    const interrupted = new Error('reader disconnected');
    const pending = service.download(job.id, async () => { ready.resolve(); await gate.promise; throw interrupted; }).then(() => null, error => error);
    await ready.promise; failRemoval(directory);
    await service.release(job.id); gate.resolve();
    assert.equal(await pending, interrupted, 'cleanup must not replace the actual download failure');
    await until(async () => !await exists(directory), 'interrupted download cleanup retries automatically');
  `);
});

for (const kind of ['document', 'workspace']) test(`cancelled ${kind} generation preserves cancellation and retries failed staging cleanup`, async (t) => {
  await run(t, `
    const service = createExportService(root, { ttlMs: 35 });
    const controller = new AbortController(), cancelled = new Error('cancel after writing the ZIP'), stat = fs.stat;
    let directory;
    fs.stat = async (file, ...args) => {
      const result = await stat(file, ...args);
      if (path.basename(String(file)) === 'payload.zip' && path.dirname(String(file)).startsWith(cache + path.sep)) {
        fs.stat = stat; directory = path.dirname(file); failRemoval(directory);
        controller.abort(cancelled);
      }
      return result;
    };
    const outcome = await service.create(${JSON.stringify({ kind, format: 'html', path: 'documents/角色.md' })}, controller.signal).then(() => null, error => error);
    assert.equal(outcome, cancelled, 'the cancellation outcome must survive a cleanup failure');
    assert.throws(() => service.get(path.basename(directory)), { statusCode: 410 });
    await until(async () => !await exists(directory), 'failed creation cleanup must remain tracked and retry');
    const retry = await service.create(options);
    await service.release(retry.id); assert.deepEqual(await fs.readdir(cache), []);
  `);
});

test('generation I/O failure survives a cleanup failure and the next successful export starts cleanly', async (t) => {
  await run(t, String.raw`
    const service = createExportService(root, { ttlMs: 35 }), stat = fs.stat;
    const failedRead = Object.assign(new Error('final ZIP stat failed'), { code: 'EIO' });
    let directory;
    fs.stat = async (file, ...args) => {
      if (path.basename(String(file)) === 'payload.zip' && path.dirname(String(file)).startsWith(cache + path.sep)) {
        fs.stat = stat; directory = path.dirname(file); failRemoval(directory); throw failedRead;
      }
      return stat(file, ...args);
    };
    const outcome = await service.create(options).then(() => null, error => error);
    assert.equal(outcome, failedRead, 'the original I/O failure must not be replaced by EBUSY during cleanup');
    await until(async () => !await exists(directory), 'failed generation staging is still eligible for cleanup');
    const retry = await service.create(options);
    await service.release(retry.id); assert.deepEqual(await fs.readdir(cache), []);
  `);
});

test('failed quota eviction retains the pending cleanup and protects all unfinished exports until recovery', async (t) => {
  await run(t, String.raw`
    const service = createExportService(root), jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await service.create(options));
    const files = jobs.map(job => service.get(job.id).file);
    const expected = await Promise.all(files.map(file => fs.readFile(file)));
    await service.download(jobs[0].id, async () => true);
    const fault = failRemoval(path.dirname(files[0]), Infinity);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(service.create(options), error => error === busy);
      assert.equal((await fs.readdir(cache)).length, 3);
      for (let i = 1; i < jobs.length; i++) assert.deepEqual(await fs.readFile(service.get(jobs[i].id).file), expected[i]);
    }
    fault.remaining = 0;
    const retry = await service.create(options);
    assert.equal(await exists(path.dirname(files[0])), false);
    assert.equal((await fs.readdir(cache)).length, 3);
    await assert.rejects(service.create(options), { statusCode: 409 });
    await Promise.all([...jobs, retry].map(job => service.release(job.id)));
    assert.deepEqual(await fs.readdir(cache), []);
  `);
});
