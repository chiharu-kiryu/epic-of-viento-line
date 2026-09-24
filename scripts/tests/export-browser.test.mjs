import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, write, serve, request } from './helpers.mjs';
import { registerWorkspace } from '../lib/workspace.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { API_PATHS } from '../lib/doc-api-contract.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';
import { deferred } from './editor-harness.mjs';
import { fetchWithTimeout, fetchJsonApiRequest, makeRequestError, safeParseJsonResponse } from '../../web/modules/app-services.js';
import { applyLanguage, onLanguageChange } from '../../web/i18n/index.js';

const prepared = { id: 'prepared', fileName: '角色 #100%.zip', bytes: 1234, assetCount: 3 };

async function browser(t, overrides = {}) {
  const checks = [], requests = [], releases = [], handoffs = [], languageListeners = [];
  const current = { path: 'documents/角色.md', title: '角色', dirty: false, creating: false, busy: false };
  const h = await dialogHarness('app-export', {
    API_PATHS,
    requestExport: (payload, signal) => { const task = deferred(); requests.push({ ...task, payload, signal }); return task.promise; },
    checkExport: (id, signal) => { const task = deferred(); checks.push({ ...task, id, signal }); return task.promise; },
    releaseExport: async id => { releases.push(id); },
    onLanguageChange: callback => { const stop = onLanguageChange(callback); languageListeners.push(stop); return stop; },
    ...overrides,
  });
  t.after(() => { languageListeners.forEach(stop => stop()); applyLanguage('zh-CN'); });
  const createElement = h.document.createElement;
  h.document.createElement = tag => {
    const node = createElement(tag);
    if (tag.toLowerCase() === 'a') node.click = () => handoffs.push({ href: node.href, fileName: node.download });
    return node;
  };
  // Simulate the default navigation of the old anchor too. A controller test
  // must notice when the click is handed off before any validity check.
  const button = h.element('docExportDownload');
  button.click = () => {
    if (button.disabled) return;
    const event = button.dispatch('click', { bubbles: true });
    if (!event.defaultPrevented && button.tagName === 'A' && button.href) handoffs.push({ href: button.href, fileName: button.download });
    return event;
  };
  h.runtime.setupExport({ getContext: () => ({ ...current }), setBusy: value => { current.busy = value; } });
  const editor = h.element('docSourceEditor'); editor.value = '\uFEFF# 原始正文\r\n'; editor.selectionStart = 2; editor.selectionEnd = 5;
  const displayedDraft = editor.value; // Textareas normalize CRLF on assignment.
  t.after(() => { assert.equal(editor.value, displayedDraft); assert.equal(editor.selectionStart, 2); assert.equal(editor.selectionEnd, 5); });
  async function prepare(job = prepared) {
    h.element('docExportBtn').click(); h.element('docExportStartBtn').click();
    requests.at(-1).resolve(job); await flushDialogs();
  }
  return { ...h, current, checks, requests, releases, handoffs, prepare };
}

test('an expired browser download is stopped and can be regenerated in the same dialog', async t => {
  const h = await browser(t); await h.prepare(); h.element('docExportDownload').click();
  assert.deepEqual(h.handoffs, [], 'an unchecked link must not download an error response as a ZIP');
  assert.equal(h.checks.length, 1); h.checks[0].reject(Object.assign(new Error('expired'), { status: 410 })); await flushDialogs();
  assert.equal(h.element('docExportDialog').open, true); assert.equal(h.current.busy, false);
  assert.equal(h.element('docExportDownload').hidden, true); assert.equal(h.element('docExportStartBtn').disabled, false);
  assert.match(h.element('docExportMessage').textContent, /已过期.*重新导出/); assert.deepEqual(h.releases, ['prepared']);
  h.element('docExportStartBtn').click(); h.requests[1].resolve({ ...prepared, id: 'replacement' }); await flushDialogs();
  h.element('docExportDownload').click(); h.checks[1].resolve(); await flushDialogs();
  assert.deepEqual(h.handoffs, [{ href: '/api/export?id=replacement', fileName: prepared.fileName }]);
  h.element('docExportCloseBtn').click(); assert.deepEqual(h.releases, ['prepared'], 'handed-off downloads must stay available to the browser');
});

for (const failure of [new TypeError('network unavailable'), Object.assign(new Error('temporary server failure'), { status: 500 }), Object.assign(new Error('check timed out'), { name: 'TimeoutError' })]) {
  test(`browser download ${failure.name}: ${failure.message} retains the package for retry`, async t => {
    const h = await browser(t); await h.prepare(); h.element('docExportDownload').click();
    assert.equal(h.current.busy, true); assert.equal(h.handoffs.length, 0);
    h.checks[0].reject(failure); await flushDialogs();
    assert.equal(h.current.busy, false); assert.equal(h.element('docExportDownload').disabled, false);
    assert.equal(h.element('docExportDownload').hidden, false); assert.equal(h.element('docExportStartBtn').disabled, true);
    assert.ok(h.element('docExportMessage').textContent.includes(failure.message)); assert.deepEqual(h.releases, []);
    h.element('docExportDownload').click(); h.checks[1].resolve(); await flushDialogs(); assert.equal(h.handoffs.length, 1);
  });
}

test('cancelling a browser availability check preserves the prepared package and allows retry', async t => {
  const h = await browser(t); await h.prepare(); h.element('docExportDownload').click();
  assert.equal(h.checks.length, 1); assert.equal(h.element('docExportCancelBtn').hidden, false);
  h.element('docExportCancelBtn').click(); assert.equal(h.checks[0].signal.aborted, true);
  h.checks[0].resolve(); await flushDialogs();
  assert.equal(h.current.busy, false); assert.deepEqual(h.handoffs, []); assert.deepEqual(h.releases, []);
  assert.equal(h.element('docExportDownload').hidden, false);
  h.element('docExportDownload').click(); h.checks[1].resolve(); await flushDialogs(); assert.equal(h.handoffs.length, 1);
});

for (const outcome of ['success', 'expired']) test(`a late ${outcome} check cannot download or alter a closed and reopened dialog`, async t => {
  const h = await browser(t); await h.prepare(); h.element('docExportDownload').click();
  assert.equal(h.checks.length, 1); h.element('docExportCloseBtn').click(); h.element('docExportBtn').click();
  assert.equal(h.checks[0].signal.aborted, true); assert.deepEqual(h.releases, ['prepared']);
  if (outcome === 'success') h.checks[0].resolve(); else h.checks[0].reject(Object.assign(new Error('expired'), { status: 410 }));
  await flushDialogs(); assert.deepEqual(h.handoffs, []); assert.equal(h.element('docExportMessage').textContent, '');
  assert.equal(h.current.busy, false); assert.equal(h.element('docExportStartBtn').disabled, false);
  h.element('docExportStartBtn').click(); h.requests[1].resolve({ ...prepared, id: 'fresh' }); await flushDialogs();
  h.element('docExportDownload').click(); h.checks[1].resolve(); await flushDialogs();
  assert.equal(h.handoffs[0].href, '/api/export?id=fresh');
});

test('closing during a repeated check does not revoke an earlier browser handoff', async t => {
  const h = await browser(t); await h.prepare(); h.element('docExportDownload').click();
  assert.equal(h.checks.length, 1); h.checks[0].resolve(); await flushDialogs();
  h.element('docExportDownload').click(); h.element('docExportCloseBtn').click();
  assert.equal(h.checks[1].signal.aborted, true); h.checks[1].resolve(); await flushDialogs();
  assert.equal(h.handoffs.length, 1); assert.deepEqual(h.releases, []); assert.equal(h.current.busy, false);
});

test('repeated activation checks once, locks options and translates status without changing the download name', async t => {
  const h = await browser(t); await h.prepare(); h.element('docExportDownload').click(); h.element('docExportDownload').click();
  assert.equal(h.checks.length, 1); assert.equal(h.handoffs.length, 0); assert.equal(h.element('docExportOptions').disabled, true);
  assert.equal(h.element('docExportCloseBtn').disabled, false); assert.match(h.element('docExportMessage').textContent, /检查/);
  applyLanguage('en'); assert.match(h.element('docExportMessage').textContent, /Checking/);
  h.checks[0].resolve(); await flushDialogs(); assert.equal(h.handoffs.length, 1);
  assert.equal(h.handoffs[0].fileName, prepared.fileName); assert.match(h.element('docExportMessage').textContent, /Download started/);
  assert.equal(h.element('docExportOptions').disabled, false); assert.equal(h.document.querySelectorAll('a[download]').length, 0);
});

async function client(base, overrides = {}) {
  const probes = [];
  const h = await dialogHarness('app-doc-service', {
    API_PATHS, makeRequestError, safeParseJsonResponse,
    fetchJsonApiRequest: (url, ...args) => fetchJsonApiRequest(new URL(url, base).href, ...args),
    fetchWithTimeout: (url, options, timeout, label, consume) => {
      probes.push({ url, options, timeout });
      return fetchWithTimeout(new URL(url, base).href, options, timeout, label, async response => {
        probes.at(-1).status = response.status; probes.at(-1).bytes = Number(response.headers.get('content-length'));
        return consume(response);
      });
    },
    ...overrides,
  });
  return { ...h, probes };
}

for (const script of ['doc-site-server.mjs', 'browse-server.mjs']) test(`browser check uses one HTTP byte and recovers an unavailable job against ${script}`, async t => {
  const root = await fixture(t);
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version: 3, id: randomUUID(), name: '浏览器导出验证', createdAt: 0,
    paths: { documents: 'documents', templates: 'templates', metadata: 'metadata' }, assetStores: { main: { path: 'assets' } }, documentTypes: PROJECT_DEFAULTS.documentTypes }));
  await write(root, 'documents/角色.md', '\uFEFF# 角色\r\n\r\n![图片](../assets/立绘.png)\r\n');
  await write(root, 'assets/立绘.png', 'original image'); await registerWorkspace(root);
  const source = await fs.readFile(path.join(root, 'documents/角色.md')), image = await fs.readFile(path.join(root, 'assets/立绘.png'));
  const base = await serve(t, root, {}, script), c = await client(base), jobs = [];
  const pending = [];
  const h = await browser(t, {
    requestExport: async (...args) => { const job = await c.runtime.requestExport(...args); jobs.push(job); return job; },
    checkExport: (...args) => { const check = c.runtime.checkExport(...args); pending.push(check); return check; },
    releaseExport: id => c.runtime.releaseExport(id),
  });
  async function settled(check) {
    const end = Date.now() + 3000;
    while (!check()) { assert.ok(Date.now() < end, 'controller must settle'); await delay(10); }
  }
  try {
    h.element('docExportBtn').click(); h.element('docExportStartBtn').click();
    await settled(() => !h.current.busy); assert.equal(jobs.length, 1);
    const staged = path.join(root, '.viento/cache/exports', jobs[0].id, 'payload.zip'), bytes = await fs.readFile(staged);
    const spare = [await c.runtime.requestExport({ kind: 'workspace' }), await c.runtime.requestExport({ kind: 'workspace' })]; jobs.push(...spare);
    h.element('docExportDownload').click(); await settled(() => !h.current.busy);
    assert.equal(pending.length, 1, 'real client must probe before handing the file off'); await pending[0];
    assert.equal(c.probes[0].status, 206); assert.equal(c.probes[0].bytes, 1); assert.equal(h.handoffs.length, 1);
    assert.equal((await request(base, '/api/export', { kind: 'workspace' })).status, 409, 'a one-byte check must not count as a completed download');
    const response = await fetch(new URL(h.handoffs[0].href, base)); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await c.runtime.releaseExport(jobs[0].id);
    h.element('docExportDownload').click(); await settled(() => !h.current.busy);
    assert.equal(h.handoffs.length, 1); assert.match(h.element('docExportMessage').textContent, /已过期.*重新导出/);
    assert.equal(h.element('docExportStartBtn').disabled, false);
    h.element('docExportStartBtn').click(); await settled(() => !h.current.busy); assert.equal(jobs.length, 4);
    h.element('docExportCloseBtn').click();
    assert.deepEqual(await fs.readFile(path.join(root, 'documents/角色.md')), source); assert.deepEqual(await fs.readFile(path.join(root, 'assets/立绘.png')), image);
  } finally { await Promise.all(jobs.map(job => c.runtime.releaseExport(job.id))); }
});

test('a non-range or malformed probe is rejected without reading a full archive into memory', async () => {
  for (const [status, contentRange] of [[200, null], [206, 'bytes 5-5/10'], [206, 'bytes 0-0/0']]) {
    let cancelled = false, consumed = false;
    const response = { ok: true, status, headers: { get: key => key === 'content-range' ? contentRange : null },
      body: { cancel: async () => { cancelled = true; } }, arrayBuffer: async () => { consumed = true; throw new Error('must not buffer an unexpected archive'); } };
    const c = await client('http://127.0.0.1', { fetchWithTimeout: async (_url, _options, _timeout, _label, consume) => consume(response) });
    assert.equal(typeof c.runtime.checkExport, 'function'); await assert.rejects(c.runtime.checkExport('one'));
    assert.equal(cancelled, true); assert.equal(consumed, false);
  }
});
