import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, serve, request, write } from './helpers.mjs';
import { writeDocumentAtomically } from '../lib/doc-file-store.mjs';

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
  assert.equal((await fetch(`${base}/scripts/lib/doc-api-service.mjs`)).status, 404);
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

test('atomic saves preserve permissions and advance numeric versions on coarse clocks', async (t) => {
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
  for (const name of ['clip.mp4', 'sound.ogg', 'font.woff2', 'icon.svg']) await write(root, 'assets/' + name, contents);
  const base = await serve(t, root);
  for (const [name, mime] of [['clip.mp4', 'video/mp4'], ['sound.ogg', 'audio/ogg'], ['font.woff2', 'font/woff2'], ['icon.svg', 'image/svg+xml']]) {
    const response = await fetch(base + '/assets/' + name);
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
