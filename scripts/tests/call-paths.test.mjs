import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { fixture, serve, request, write } from './helpers.mjs';
import { runCommand } from '../lib/process.mjs';

test('document GET/save/create cannot follow links out of the selected workspace', async (t) => {
  const root = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await write(outside, 'keep.md', '库外原文');
  await fs.symlink(outside, path.join(root, 'design-data/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const base = await serve(t, root);
  const read = await request(base, '/api/doc?path=design-data/linked/keep.md');
  const save = await request(base, '/api/doc', { path: 'design-data/linked/keep.md', content: '不得写入库外', force: true });
  const create = await request(base, '/api/doc', { path: 'design-data/linked/new.md', content: '不得新建到库外', create: true });
  assert.deepEqual([read.status, save.status, create.status], [403, 403, 403]);
  assert.equal(await fs.readFile(path.join(outside, 'keep.md'), 'utf8'), '库外原文');
  assert.deepEqual(await fs.readdir(outside), ['keep.md']);
  const ordinary = await request(base, '/api/doc', { path: 'design-data/nested/new.md', content: '正常新建', create: true });
  assert.equal(ordinary.status, 200);
  assert.equal((await request(base, '/api/doc?path=design-data/nested/new.md')).data.content, '正常新建');
});

test('static document URLs cannot expose server modules through a directory link', async (t) => {
  const root = await fixture(t);
  await fs.symlink(path.join(root, 'scripts/lib'), path.join(root, 'design-data/server'), process.platform === 'win32' ? 'junction' : 'dir');
  const base = await serve(t, root);
  const response = await fetch(base + '/design-data/server/doc-api-service.mjs');
  await response.arrayBuffer();
  assert.equal(response.status, 403);
  assert.equal((await fetch(base + '/scripts/lib/doc-api-contract.mjs')).status, 200);
});

test('a malformed request target is rejected without terminating the edit server', async (t) => {
  const root = await fixture(t);
  const base = await serve(t, root);
  const response = await new Promise((resolve) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: new URL(base).port, path: '//[', method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
  const health = await request(base, '/api/health').catch(() => ({ status: 0 }));
  assert.equal(response, 400);
  assert.equal(health.status, 200);
});

test('a failed page read leaves the API available and the page can be recovered', async (t) => {
  const root = await fixture(t);
  const base = await serve(t, root);
  const page = await fs.readFile(path.join(root, 'web/index.html'));
  await fs.rm(path.join(root, 'web/index.html'));
  const status = await fetch(base + '/').then((response) => response.status, () => 0);
  const health = await request(base, '/api/health').catch(() => ({ status: 0 }));
  assert.equal(status, 500);
  assert.equal(health.status, 200);
  await write(root, 'web/index.html', page);
  assert.equal((await fetch(base + '/')).status, 200);
});

test('invalid partial rebuild requests never fall back to pruning the entire catalog', async (t) => {
  const root = await fixture(t);
  await write(root, 'docs-standard/keep.json', '{"sentinel":true}');
  const base = await serve(t, root);
  for (const source of ['../outside.md', 'assets/image.png', 42]) {
    const result = await request(base, '/api/rebuild', { source });
    assert.equal(result.status, 400, String(source));
    assert.equal(await fs.readFile(path.join(root, 'docs-standard/keep.json'), 'utf8'), '{"sentinel":true}');
  }
});

test('an explicit rebuild workspace overrides the parent workspace environment in both child scripts', async (t) => {
  const app = await fixture(t);
  const selected = await fixture(t);
  await write(app, 'design-data/a.md', '# A 工作区');
  await write(app, '.viento/cache/web/data/index.json', '{"sentinel":true}');
  await write(selected, 'design-data/b.md', '# B 工作区');
  await runCommand(process.execPath, ['--input-type=module', '-e', `
    import { rebuildIndex } from './scripts/lib/rebuild-workflow.mjs';
    await rebuildIndex({ projectRoot: ${JSON.stringify(selected)} });
  `], { cwd: app, env: { ...process.env, VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: app } });
  assert.equal(await fs.readFile(path.join(app, '.viento/cache/web/data/index.json'), 'utf8'), '{"sentinel":true}');
  const index = JSON.parse(await fs.readFile(path.join(selected, '.viento/cache/web/data/index.json'), 'utf8'));
  assert.equal(index.count, 1);
  assert.equal(index.docs[0].source.path, 'docs-standard/design-data/b.md');
  assert.match(JSON.stringify(index), /B 工作区/);
});

test('an index build already in flight cannot reinsert a stale catalog after a successful save', async (t) => {
  const root = await fixture(t);
  await write(root, 'design-data/existing.md', '# 原有文档');
  // Pause the real filesystem scan after it captured the old file list, then
  // create a document through the same service used by the HTTP write route.
  await runCommand(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createDocumentService } from './scripts/lib/doc-api-service.mjs';
    const service = createDocumentService();
    const stat = fs.stat;
    let release, captured, paused = false;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { captured = resolve; });
    fs.stat = async (file, ...args) => {
      if (String(file) === path.join(process.cwd(), 'design-data/existing.md') && !paused) {
        paused = true; captured(); await gate;
      }
      return stat(file, ...args);
    };
    const oldIndex = service.getDocIndex();
    await ready;
    try {
      await service.writeDoc({ path: 'design-data/new.md', content: '# 新文档', create: true });
      const refreshed = service.getDocIndex();
      release();
      const index = await refreshed;
      assert.ok(index.docs.some(doc => doc.path === 'design-data/new.md'), 'a read after the save must include the new document');
      await oldIndex;
      assert.ok((await service.getDocIndex()).docs.some(doc => doc.path === 'design-data/new.md'), 'late results must not overwrite the fresh cache');
    } finally { release(); fs.stat = stat; }
  `], { cwd: root, env: { ...process.env, VIENTO_APP_ROOT: root, VIENTO_WORKSPACE_ROOT: root } });
});
