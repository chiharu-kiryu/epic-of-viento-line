import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, write, serve } from './helpers.mjs';
import { runCommand } from '../lib/process.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('desktop workspaces keep sources, cache and installed application files separate through save and rebuild', async (t) => {
  const app = await fixture(t);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-workspace-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'assets'));
  await fs.mkdir(path.join(workspace, 'data-template'));
  const sourcePath = 'design-data/backstory/测试：迁移.md';
  const original = '\uFEFF# 测试\r\n\r\n正文。\r\n';
  await write(workspace, sourcePath, original);
  await write(workspace, 'README.md', '# 工程说明，不是作品正文');
  await write(workspace, 'docs-standard/design-data/backstory/旧缓存.md', '# 不允许回退编辑旧生成文件');
  const applicationIndex = await fs.readFile(path.join(app, 'web/data/index.json'), 'utf8');
  const env = { ...process.env, VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: workspace };
  for (const script of ['standardize-docs.mjs', 'build-static-doc-site.mjs']) {
    await runCommand(process.execPath, [path.join(app, 'scripts', script)], { cwd: os.tmpdir(), env });
  }
  const cache = path.join(workspace, '.viento/cache');
  const index = JSON.parse(await fs.readFile(path.join(cache, 'web/data/index.json'), 'utf8'));
  assert.equal(index.count, 1);
  assert.equal(index.docs[0].source.path, `docs-standard/${sourcePath}`);
  assert.ok(!JSON.stringify(index).includes('.viento/cache'));
  assert.equal(await fs.readFile(path.join(workspace, sourcePath), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(app, 'web/data/index.json'), 'utf8'), applicationIndex);
  await assert.rejects(fs.access(path.join(workspace, 'web')));
  await assert.rejects(fs.access(path.join(workspace, 'scripts')));

  const token = 'a'.repeat(48);
  const base = await serve(t, app, { ...env, VIENTO_SESSION_TOKEN: token });
  assert.equal((await fetch(`${base}/web/data/index.json`)).status, 401);
  assert.equal((await fetch(`${base}/__desktop/session/${token}`, { headers: { Origin: 'https://example.org' }, redirect: 'manual' })).status, 403);
  const handshake = await fetch(`${base}/__desktop/session/${token}`, { redirect: 'manual' });
  assert.equal(handshake.status, 302);
  const cookie = handshake.headers.get('set-cookie').split(';')[0];
  assert.match(handshake.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const options = { headers: { Cookie: cookie } };
  const servedIndex = await (await fetch(`${base}/web/data/index.json`, options)).json();
  assert.equal(servedIndex.count, 1);
  assert.equal((await fetch(`${base}/web/editor-layout.css`, options)).status, 200);
  assert.equal((await fetch(`${base}/scripts/lib/doc-api-contract.mjs`, options)).status, 200);
  const response = await (await fetch(`${base}/api/doc?path=${encodeURIComponent(sourcePath)}`, options)).json();
  const doc = response.data || response;
  assert.equal(doc.content, original);
  assert.equal((await fetch(`${base}/api/doc?path=${encodeURIComponent('docs-standard/design-data/backstory/旧缓存.md')}`, options)).status, 404);
  const updated = `${original}追加内容。\r\n`;
  const saved = await fetch(`${base}/api/doc`, {
    method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sourcePath, content: updated, expectedVersion: doc.version }),
  });
  assert.equal(saved.status, 200);
  const rebuilt = await fetch(`${base}/api/rebuild`, { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rebuilt.status, 200);
  assert.equal(await fs.readFile(path.join(workspace, sourcePath), 'utf8'), updated);
  assert.equal(await fs.readFile(path.join(app, 'web/data/index.json'), 'utf8'), applicationIndex);
  assert.match(await fs.readFile(path.join(cache, 'web/data/index.json'), 'utf8'), /追加内容/);
});

test('an empty desktop workspace starts successfully and its engine exits when the owning app closes stdin', async (t) => {
  const app = await fixture(t);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-empty-workspace-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const folder of ['design-data', 'data-template', 'assets']) await fs.mkdir(path.join(workspace, folder));
  await write(workspace, '.viento/workspace.json', JSON.stringify({ format: 'viento-workspace', version: 1, id: '84ac1b82-c5d5-4b55-b50c-d046347741a7', name: '空作品库', createdAt: 1 }));
  const child = spawn(process.execPath, [path.join(app, 'scripts/desktop-server.mjs')], {
    cwd: workspace,
    env: { ...process.env, VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: workspace, VIENTO_SESSION_TOKEN: 'c'.repeat(32), DOC_API_HOST: '127.0.0.1', DOC_API_REQUIRE_WRITE_AUTH: '0', PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const engineExited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Desktop engine timeout: ${output}`)), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Desktop engine stopped: ${output}`)); });
    child.stderr.on('data', (data) => { output += data; });
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/VIENTO_EVENT (\{"type":"ready",[^\n]+\})/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
  });
  assert.ok(ready.port > 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace, '.viento/cache/web/data/index.json'), 'utf8')).count, 0);
  child.stdin.end();
  assert.equal((await engineExited)[0], 0);
});

for (const phase of ['startup', 'rebuild']) test(`desktop shutdown during ${phase} stops and reaps the running index worker`, async (t) => {
  const app = await fixture(t);
  await write(app, '.viento/workspace.json', JSON.stringify({ format: 'viento-workspace', version: 1, id: '84ac1b82-c5d5-4b55-b50c-d046347741a7', name: '退出验证', createdAt: 1 }));
  const marker = path.join(app, 'worker.pid');
  const blockBuild = () => write(app, 'scripts/standardize-docs.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  if (phase === 'startup') await blockBuild();
  const token = 'd'.repeat(32);
  const child = spawn(process.execPath, [path.join(app, 'scripts/desktop-server.mjs')], {
    cwd: app,
    env: { ...process.env, VIENTO_APP_ROOT: app, VIENTO_WORKSPACE_ROOT: app, VIENTO_SESSION_TOKEN: token, DOC_API_HOST: '127.0.0.1', DOC_API_REQUIRE_WRITE_AUTH: '0', PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', worker;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (worker) { try { process.kill(worker, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  async function waitFor(check) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(20); }
    throw new Error(`Desktop did not reach ${phase}: ${output}`);
  }
  if (phase === 'rebuild') {
    const ready = await waitFor(() => output.match(/VIENTO_EVENT (\{"type":"ready",[^\n]+\})/));
    const base = `http://127.0.0.1:${JSON.parse(ready[1]).port}`;
    const handshake = await fetch(`${base}/__desktop/session/${token}`, { redirect: 'manual' });
    const cookie = handshake.headers.get('set-cookie').split(';')[0];
    await blockBuild();
    void fetch(`${base}/api/rebuild`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  worker = Number(await waitFor(() => fs.readFile(marker, 'utf8').catch(() => '')));
  if (phase === 'startup') child.stdin.end();
  else child.stdin.write('VIENTO_SHUTDOWN\n');
  const result = await Promise.race([exited, delay(2500).then(() => null)]);
  assert.ok(result, 'closing the owner must stop an in-progress build promptly');
  assert.equal(result[0], 0);
  assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' }, 'the index worker must be reaped before its engine exits');
});
