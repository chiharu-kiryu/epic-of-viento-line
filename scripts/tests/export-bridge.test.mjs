import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { deferred } from './editor-harness.mjs';
import { fixture, write } from './helpers.mjs';
import { registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { API_PATHS } from '../lib/doc-api-contract.mjs';
import { createExportService } from '../lib/export-service.mjs';
import { createDesktopSession } from '../lib/desktop-session.mjs';

async function nativeDialog() {
  const requests = [], releases = [], prepared = deferred();
  const current = { path: 'documents/角色.md', title: '角色', busy: false, dirty: false, creating: false };
  const job = { id: randomUUID(), fileName: '角色.zip', bytes: 123, assetCount: 1 };
  const h = await dialogHarness('app-export', {
    API_PATHS, crypto: { randomUUID }, location: { href: 'http://127.0.0.1/?desktop=1' },
    requestExport: () => prepared.promise,
    releaseExport: async id => { releases.push(id); },
    fetch: (url, options) => { const pending = deferred(); requests.push({ ...pending, url, options, payload: JSON.parse(options.body) }); return pending.promise; },
  });
  h.runtime.setupExport({ getContext: () => ({ ...current }), setBusy: busy => { current.busy = busy; } });
  h.element('docSourceEditor').value = '\uFEFF# 原有正文\r\n原始内容。  \r\n';
  const sourceValue = h.element('docSourceEditor').value;
  h.element('docExportBtn').click(); h.element('docExportStartBtn').click();
  prepared.resolve(job); await flushDialogs();
  const dispatch = detail => h.runtime.window.dispatch('viento-export-result', { detail });
  const result = (attempt, detail) => dispatch({ ...requests[attempt].payload, ...detail });
  const listeners = () => h.runtime.window.listeners.get('viento-export-result')?.length || 0;
  return { ...h, requests, releases, current, job, dispatch, result, listeners, sourceValue };
}

for (const outcome of ['saved', 'cancelled', 'failed']) test(`a late ${outcome} result from a disconnected save attempt cannot settle its retry`, async () => {
  const h = await nativeDialog();
  h.requests[0].reject(new Error('save bridge disconnected')); await flushDialogs();
  assert.equal(h.current.busy, false);
  assert.equal(h.listeners(), 0);
  h.element('docExportSaveBtn').click();
  h.requests[1].resolve({ ok: true });
  const stale = outcome === 'saved' ? { ok: true, path: '/exports/旧位置.zip' }
    : outcome === 'cancelled' ? { ok: true, cancelled: true } : { ok: false, error: '旧窗口保存失败' };
  h.result(0, stale); await flushDialogs();
  assert.equal(h.current.busy, true, 'the current save picker must remain pending until its own result');
  assert.equal(h.element('docExportCloseBtn').disabled, true);
  assert.equal(h.element('docExportOptions').disabled, true);
  assert.equal(h.element('docExportSaveBtn').disabled, true);
  assert.deepEqual(h.releases, [], 'a stale success must not release the package belonging to the active retry');
  assert.equal(h.listeners(), 1);
  for (const request of h.requests) assert.match(request.payload.requestId, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
  assert.notEqual(h.requests[0].payload.requestId, h.requests[1].payload.requestId);
  assert.equal(h.requests[0].payload.id, h.requests[1].payload.id, 'only the save attempt changes, not the prepared ZIP');
  h.result(1, { ok: true, path: '/exports/新位置.zip' }); await flushDialogs();
  assert.equal(h.current.busy, false); assert.equal(h.listeners(), 0);
  assert.deepEqual(h.releases, [h.job.id]);
  assert.equal(h.element('docExportStartBtn').disabled, false);
  assert.match(h.element('docExportMessage').textContent, /新位置\.zip/);
  h.result(0, stale); await flushDialogs();
  assert.match(h.element('docExportMessage').textContent, /新位置\.zip/);
  assert.equal(h.element('docSourceEditor').value, h.sourceValue);
});

test('native export results require both the current request and package identities', async () => {
  const h = await nativeDialog();
  h.requests[0].resolve({ ok: true });
  for (const identity of [
    { id: h.job.id },
    { id: h.job.id, requestId: randomUUID() },
    { id: randomUUID(), requestId: h.requests[0].payload.requestId },
  ]) {
    h.dispatch({ ...identity, ok: true, path: '/exports/别的任务.zip' }); await flushDialogs();
    assert.equal(h.current.busy, true, 'unrelated or uncorrelated results must not unlock the editor');
    assert.deepEqual(h.releases, []);
  }
  h.result(0, { ok: true, cancelled: true }); await flushDialogs();
  assert.equal(h.current.busy, false); assert.equal(h.listeners(), 0);
  assert.equal(h.element('docExportSaveBtn').hidden, false);
  h.element('docExportCloseBtn').click();
  assert.deepEqual(h.releases, [h.job.id]);
});

test('a matching native result can arrive before its HTTP acknowledgement and settle only once', async () => {
  const h = await nativeDialog();
  h.result(0, { ok: true, cancelled: true }); await flushDialogs();
  assert.equal(h.current.busy, false); assert.equal(h.listeners(), 0);
  h.element('docExportSaveBtn').click();
  h.requests[0].reject(new Error('late acknowledgement failure')); await flushDialogs();
  assert.equal(h.current.busy, true); assert.equal(h.listeners(), 1);
  h.requests[1].resolve({ ok: true });
  h.result(1, { ok: true, path: '/exports/完成.zip' }); await flushDialogs();
  assert.equal(h.current.busy, false); assert.equal(h.listeners(), 0);
  assert.deepEqual(h.releases, [h.job.id]);
});

async function bridge(t) {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '保存交接验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.md', '\uFEFF# 角色\r\n\r\n原始内容。  \r\n');
  await write(root, 'assets/立绘.png', Buffer.from('original image bytes'));
  await registerWorkspace(root);
  const exports = createExportService(root), job = await exports.create({ kind: 'workspace' });
  t.after(() => exports.release(job.id));
  const file = exports.get(job.id).file, expected = await fs.readFile(file);
  const events = [];
  t.mock.method(console, 'log', line => { if (line.startsWith('VIENTO_EVENT ')) events.push(JSON.parse(line.slice('VIENTO_EVENT '.length))); });
  const token = 'e'.repeat(32), session = createDesktopSession(token, { exports });
  const server = createServer((request, response) => { void session(request, response, new URL(request.url, 'http://127.0.0.1').pathname); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const handshake = await fetch(`${base}/__desktop/session/${token}`, { redirect: 'manual' });
  const cookie = handshake.headers.get('set-cookie').split(';')[0];
  const post = (payload, headers = {}) => fetch(`${base}/__desktop/export`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  async function preserved() {
    assert.deepEqual(await fs.readFile(file), expected);
    assert.equal(await fs.readFile(path.join(root, 'documents/角色.md'), 'utf8'), '\uFEFF# 角色\r\n\r\n原始内容。  \r\n');
    assert.equal(await fs.readFile(path.join(root, 'assets/立绘.png'), 'utf8'), 'original image bytes');
  }
  return { exports, job, events, post, preserved };
}

test('authenticated native export handoffs forward a separate request identity while retaining the same ZIP', async (t) => {
  const h = await bridge(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestId = randomUUID();
    const response = await h.post({ id: h.job.id, requestId, fileName: '../untrusted.zip' });
    assert.equal(response.status, 204);
    assert.deepEqual(h.events[attempt], { type: 'export', id: h.job.id, requestId, fileName: h.job.fileName });
    await h.preserved();
  }
});

test('native export handoffs reject missing or invalid request identities without opening a picker', async (t) => {
  const h = await bridge(t), requestId = randomUUID();
  assert.equal((await h.post({ id: h.job.id, requestId }, { Cookie: '' })).status, 401);
  assert.equal((await h.post({ id: h.job.id, requestId }, { Origin: 'https://example.org' })).status, 403);
  for (const payload of [null, [], {}, { id: h.job.id }, ...['', null, 12, {}, '../request', requestId.toUpperCase()].map(value => ({ id: h.job.id, requestId: value }))]) {
    assert.equal((await h.post(payload)).status, 400, JSON.stringify(payload));
    assert.deepEqual(h.events, [], 'invalid requests must never dispatch a native save');
  }
  assert.equal((await h.post({ id: randomUUID(), requestId })).status, 410);
  await h.preserved();
  assert.equal((await h.post({ id: h.job.id, requestId })).status, 204);
  assert.equal(h.events.length, 1, 'valid retry still reaches the host');
});
