import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write } from './helpers.mjs';
import { registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { runCommand } from '../lib/process.mjs';

async function project(t) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '取消导出验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.md', '\uFEFF# 角色\r\n\r\n原始内容。  \r\n\r\n![立绘](../assets/立绘.png)\r\n');
  await write(root, 'templates/character.md', '# 角色模板\n');
  await write(root, 'assets/立绘.png', Buffer.from('original image bytes'));
  await registerWorkspace(root);
  return root;
}

const childSetup = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import path from 'node:path';
  import { createExportService } from './scripts/lib/export-service.mjs';
  const root = process.cwd(), cache = path.join(root, '.viento/cache/exports');
  const service = createExportService(root);
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
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
  const before = await authoredBytes();
  const stat = fs.stat;
  // Pause the real service after ZIP completion, while its final asynchronous
  // size lookup is outstanding. All source reads and ZIP writing stay real.
  let gate = null;
  fs.stat = async (file, ...args) => {
    const result = await stat(file, ...args);
    if (gate && path.dirname(String(file)).startsWith(cache + path.sep) && path.basename(String(file)) === 'payload.zip') {
      const current = gate; gate = null;
      const bytes = await fs.readFile(file);
      assert.equal(bytes.length, result.size);
      assert.ok(bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0, 'the ZIP is already complete');
      current.ready.resolve(); await current.resume.promise;
    }
    return result;
  };
`;

async function run(root, source) {
  return runCommand(process.execPath, ['--input-type=module', '-e', childSetup + source], { cwd: root,
    env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root, VIENTO_SESSION_TOKEN: '', VIENTO_PREFERENCES_PATH: '',
      DOC_API_REQUIRE_WRITE_AUTH: '0', DOC_API_TOKEN: '', DOC_API_WRITE_TOKEN: '', DOC_API_RATE_LIMIT_MAX_REQUESTS: '1000', DOC_API_SECURITY_AUDIT: '0' } });
}

for (const kind of ['document', 'workspace']) test(`late export cancellation removes the completed ${kind} ZIP and leaves all three job slots available`, async (t) => {
  const root = await project(t);
  await run(root, `
    const options = ${JSON.stringify({ kind, format: 'html', path: 'documents/角色.md' })};
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = { ready: deferred(), resume: deferred() }; gate = current;
      const controller = new AbortController(), reason = new Error('cancel at publication');
      const pending = service.create(options, controller.signal).then(value => ({ value }), error => ({ error }));
      await current.ready.promise;
      await assert.rejects(service.create(options), { statusCode: 409 });
      controller.abort(reason); current.resume.resolve();
      const outcome = await pending;
      assert.equal(outcome.error, reason, 'a cancelled result must never be registered as a successful job');
      assert.deepEqual(await fs.readdir(cache), [], 'the cancelled ZIP must be removed immediately');
    }
    const jobs = [];
    try {
      for (let i = 0; i < 3; i++) jobs.push(await service.create(options));
      await assert.rejects(service.create(options), { statusCode: 409 }, 'unclaimed exports still retain their quota protection');
      for (const job of jobs) assert.equal((await fs.stat(service.get(job.id).file)).size, job.bytes);
      assert.deepEqual(await authoredBytes(), before);
    } finally { await Promise.all(jobs.map(job => service.release(job.id))); }
    assert.deepEqual(await fs.readdir(cache), []);
    fs.stat = stat;
  `);
});

test('disconnecting HTTP after ZIP completion cancels publication and permits a fresh download and release', async (t) => {
  const root = await project(t);
  await run(root, String.raw`
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { handleApiRequest } from './scripts/lib/doc-server-routes.mjs';
    const current = { ready: deferred(), resume: deferred() }; gate = current;
    const closed = deferred(), finished = deferred(); let first = true;
    const server = createServer(async (request, response) => {
      const tracked = first; first = false;
      if (tracked) response.on('close', () => closed.resolve());
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      await handleApiRequest({ pathname: requestUrl.pathname, request, response, requestUrl, service: { exports: service } });
      if (tracked) finished.resolve();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const options = { kind: 'workspace' };
    const post = (payload, signal) => fetch(base + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
    try {
      const controller = new AbortController();
      const pending = post(options, controller.signal); pending.catch(() => {});
      await current.ready.promise;
      controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
      await closed.promise; current.resume.resolve(); await finished.promise;
      assert.deepEqual(await fs.readdir(cache), [], 'disconnect must not leave an unclaimed job or ZIP behind');
      const response = await post(options); assert.equal(response.status, 200);
      const { data: job } = await response.json();
      try {
        const expected = await fs.readFile(service.get(job.id).file);
        const downloaded = await fetch(base + '/api/export?id=' + job.id);
        assert.equal(downloaded.status, 200);
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected);
        const released = await post({ action: 'release', id: job.id });
        assert.equal(released.status, 200); await released.json();
        assert.equal((await fetch(base + '/api/export?id=' + job.id)).status, 410);
      } finally { await service.release(job.id); }
      assert.deepEqual(await fs.readdir(cache), []);
      assert.deepEqual(await authoredBytes(), before);
    } finally {
      current.resume.resolve(); fs.stat = stat;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  `);
  assert.equal((await fs.readFile(path.join(root, 'documents/角色.md')))[0], 0xef);
});
