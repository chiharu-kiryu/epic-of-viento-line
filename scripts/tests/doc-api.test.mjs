import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, serve, request, write } from './helpers.mjs';
import { writeDocumentAtomically } from '../lib/doc-file-store.mjs';
import { API_PATHS } from '../lib/doc-api-contract.mjs';
import { readRegistry, registerWorkspace } from '../lib/workspace.mjs';

test('capability discovery includes the live project configuration and preview routes', async (t) => {
  const root = await fixture(t);
  const base = await serve(t, root);
  const capabilities = (await request(base, '/api/capabilities')).data;
  assert.deepEqual(new Set(capabilities.endpoints), new Set(Object.values(API_PATHS)));
  assert.equal(capabilities.capabilities.project, true);
  for (const endpoint of ['/api/project', '/api/project/preview']) {
    const response = await request(base, endpoint, {});
    assert.notEqual(response.status, 404, endpoint);
    assert.notEqual(response.status, 405, endpoint);
  }
});

test('browser module graph is served as JavaScript; server-only modules stay private', async (t) => {
  const root = await fixture(t);
  const base = await serve(t, root);
  assert.equal((await fetch(`${base}/web/`)).status, 200);
  const pending = ['/web/app.js'];
  const visited = new Set();
  while (pending.length) {
    const pathname = pending.pop();
    if (visited.has(pathname)) continue;
    visited.add(pathname);
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('Content-Type'), /javascript/, pathname);
    assert.match(response.headers.get('Cache-Control'), /no-cache/, pathname);
    const source = await response.text();
    for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      pending.push(new URL(match[1], `${base}${pathname}`).pathname);
    }
  }
  assert.ok(visited.has('/scripts/lib/doc-api-contract.mjs'));
  for (const module of ['document-contract', 'source-draft', 'field-changes', 'media-format', 'document-values']) {
    assert.ok(visited.has(`/engine/${module}.mjs`), module);
  }
  assert.equal((await fetch(`${base}/scripts/lib/doc-api-service.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/scripts/adapters/node-document-storage.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/engine/missing.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/engine/README.md`)).status, 404);
  assert.equal((await request(base, '/api/health')).status, 200);
  assert.equal((await request(base, '/api/doc?path=../README.md')).status, 400);
});

test('same-version concurrent edits accept one writer, including source-path aliases', async (t) => {
  const root = await fixture(t);
  const file = 'design-data/concurrent.txt';
  await write(root, file, 'Initial');
  const base = await serve(t, root);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = (await request(base, `/api/doc?path=${file}`)).data;
    const contents = [`A ${attempt}`, `B ${attempt}`];
    const results = await Promise.all(contents.map((content, i) => request(base, '/api/doc', {
      path: i ? `docs-standard/${file}` : file,
      content,
      expectedVersion: before.version,
    })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const winner = results.findIndex((result) => result.status === 200);
    const after = (await request(base, `/api/doc?path=${file}`)).data;
    assert.equal(after.content, contents[winner]);
    assert.notEqual(after.version, before.version);
    assert.equal(after.version, results[winner].data.version);
  }
});

test('concurrent creation is exclusive and a rejected write does not block subsequent saves', async (t) => {
  const root = await fixture(t);
  const base = await serve(t, root);
  const file = 'design-data/new/doc.txt';
  const results = await Promise.all(['First', 'Second'].map((content) => request(base, '/api/doc', {
    path: file, content, create: true,
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await request(base, '/api/doc', { path: file, content: 'Stale', expectedVersion: '1' })).status, 409);
  assert.equal((await request(base, '/api/doc', { path: file, content: 'Missing version' })).status, 409);
  const forced = await request(base, '/api/doc', { path: file, content: 'Forced', force: true });
  assert.equal(forced.status, 200);
  const latest = await request(base, `/api/doc?path=${file}`);
  assert.equal(latest.data.content, 'Forced');
  assert.equal(latest.data.version, forced.data.version);
  assert.deepEqual(await fs.readdir(path.join(root, 'design-data/new')), ['doc.txt']);
});

test('preserving the modification time cannot hide an external edit from the save conflict check', async (t) => {
  const root = await fixture(t);
  const file = 'design-data/preserved-time.md', absolute = path.join(root, file);
  await write(root, file, '原始正文');
  const timestamp = 1700000000;
  await fs.utimes(absolute, timestamp, timestamp);
  const base = await serve(t, root);
  const original = (await request(base, `/api/doc?path=${file}`)).data;
  await fs.writeFile(absolute, '外部修改');
  await fs.utimes(absolute, timestamp, timestamp);
  const response = await request(base, '/api/doc', { path: file, content: '旧草稿', expectedVersion: original.version });
  assert.equal(response.status, 409, 'equal-size edits with preserved timestamps must still conflict');
  assert.equal(await fs.readFile(absolute, 'utf8'), '外部修改');
  const latest = (await request(base, `/api/doc?path=${file}`)).data;
  assert.equal(latest.lastModified, original.lastModified);
  assert.notEqual(latest.version, original.version);
  assert.equal(response.data.currentVersion, latest.version);
  const saved = await request(base, '/api/doc', { path: `docs-standard/${file}`, content: '合并后的正文', expectedLastModified: latest.version });
  assert.equal(saved.status, 200);
  const reread = (await request(base, `/api/doc?path=${file}`)).data;
  assert.equal(reread.version, saved.data.version);
  assert.equal(reread.content, '合并后的正文');
  // An old client must reload; a timestamp alone can never authorize a silent overwrite.
  const legacy = await request(base, '/api/doc', { path: file, content: '旧版请求', expectedLastModified: String((await fs.stat(absolute)).mtimeMs) });
  assert.equal(legacy.status, 409);
  assert.equal(await fs.readFile(absolute, 'utf8'), '合并后的正文');
});

test('atomic saves preserve permissions and advance modification times on coarse clocks', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'design-data/version.txt');
  for (const mode of [0o640, 0o666]) {
    await fs.writeFile(file, 'Old');
    await fs.chmod(file, mode);
    const future = (Date.now() + 5000) / 1000;
    await fs.utimes(file, future, future);
    const previousStats = await fs.stat(file);
    const stats = await writeDocumentAtomically(file, 'New', { previousStats });
    assert.ok(stats.mtimeMs > previousStats.mtimeMs);
    assert.equal(stats.mode & 0o777, previousStats.mode & 0o777);
    assert.equal((await fs.stat(file)).mode & 0o777, previousStats.mode & 0o777);
    assert.equal(await fs.readFile(file, 'utf8'), 'New');
  }
});

test('static resources do not consume the API rate limit or leak active request counts', async (t) => {
  const root = await fixture(t);
  const base = await serve(t, root, { DOC_API_RATE_LIMIT_MAX_REQUESTS: '2' });
  for (let i = 0; i < 5; i += 1) {
    const response = await fetch(`${base}/web/app.js`);
    assert.equal(response.status, 200);
    await response.text();
  }
  const health = await request(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.requestMetrics.activeRequests, 1);
  assert.equal((await request(base, '/api/health')).status, 200);
  assert.equal((await request(base, '/api/health')).status, 429);
});

test('mutable workspace files revalidate and If-None-Match takes precedence over dates', async (t) => {
  const root = await fixture(t);
  await write(root, 'assets/image.png', 'image');
  const base = await serve(t, root);
  const first = await fetch(base + '/assets/image.png');
  assert.match(first.headers.get('cache-control'), /no-cache/);
  await first.arrayBuffer();
  const changed = await fetch(base + '/assets/image.png', { headers: {
    'If-None-Match': '"different-version"', 'If-Modified-Since': 'Wed, 01 Jan 2098 00:00:00 GMT',
  } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), 'image');
  const same = await fetch(base + '/assets/image.png', { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(same.status, 304);
});

test('media responses identify their format and support bounded seeking without downloading the whole file', async (t) => {
  const root = await fixture(t);
  const contents = Buffer.from('0123456789');
  const cases = [['clip.mp4', 'video/mp4'], ['sound.ogg', 'audio/ogg'], ['sound.opus', 'audio/ogg'], ['sound.oga', 'audio/ogg'], ['sound.m4a', 'audio/mp4'], ['sound.aac', 'audio/aac'], ['font.woff2', 'font/woff2'], ['icon.svg', 'image/svg+xml']];
  for (const [name] of cases) await write(root, 'assets/' + name, contents);
  const base = await serve(t, root);
  for (const [name, mime] of cases) {
    const response = await fetch(base + '/assets/' + name);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), mime);
    await response.arrayBuffer();
  }
  for (const [range, expected, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-', '89', 'bytes 8-9/10']]) {
    const response = await fetch(base + '/assets/clip.mp4', { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(await response.text(), expected);
  }
  const invalid = await fetch(base + '/assets/clip.mp4', { headers: { Range: 'bytes=20-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  const changed = await fetch(base + '/assets/clip.mp4', { headers: { Range: 'bytes=2-5', 'If-Range': '"old-version"' } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), contents.toString());
  const head = await fetch(base + '/assets/clip.mp4', { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});

for (const external of [false, true])
test(`local media avoids persistent HTTP copies with ${external ? 'external' : 'internal'} storage`, async (t) => {
  const root = await fixture(t);
  const store = external ? path.join(await fixture(t), 'assets') : path.join(root, 'assets');
  if (external) await write(root, '.viento/local.json', JSON.stringify({ version: 1, assetStores: { main: store } }));
  const content = Buffer.from('0123456789');
  for (const name of ['图片 #1.png', 'video.mp4', 'audio.wav']) await write(store, name, content);
  await registerWorkspace(root);
  const { assets } = await readRegistry(root);
  assert.equal(assets.length, 3);
  const base = await serve(t, root);
  for (const asset of assets) {
    for (const url of [`/assets/${encodeURIComponent(asset.location.path)}`, `/asset-files/${asset.id}`]) {
      const first = await fetch(base + url);
      assert.equal(first.status, 200);
      assert.match(first.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/, url);
      assert.deepEqual(Buffer.from(await first.arrayBuffer()), content);
      for (const [options, status, expected] of [
        [{ method: 'HEAD' }, 200, ''],
        [{ headers: { Range: 'bytes=2-5' } }, 206, '2345'],
        [{ headers: { 'If-None-Match': first.headers.get('etag') } }, 304, ''],
        [{ headers: { Range: 'bytes=99-' } }, 416, ''],
      ]) {
        const response = await fetch(base + url, options);
        assert.equal(response.status, status, url);
        assert.match(response.headers.get('cache-control'), /(?:^|,\s*)no-store(?:,|$)/, url);
        assert.equal(await response.text(), expected);
      }
      assert.deepEqual(await fs.readFile(path.join(store, asset.location.path)), content);
    }
  }
  const script = await fetch(base + '/web/app.js');
  assert.equal(script.headers.get('cache-control'), 'no-cache, must-revalidate');
  await script.arrayBuffer();
});

test('an unreadable asset cannot terminate the editing service', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const root = await fixture(t);
  const image = path.join(root, 'assets/unreadable.png');
  await write(root, 'assets/unreadable.png', 'image');
  await fs.chmod(image, 0);
  t.after(() => fs.chmod(image, 0o600).catch(() => {}));
  const base = await serve(t, root);
  try { await (await fetch(base + '/assets/unreadable.png')).arrayBuffer(); } catch { /* A failed media request must not kill the server. */ }
  assert.equal((await request(base, '/api/health')).status, 200);
});
