import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import english from '../../web/i18n/en.js';
import { LANGUAGE_STORAGE_KEY } from '../../web/i18n/index.js';
import { deferred } from './editor-harness.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';

const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');
async function settingsHarness(overrides = {}) {
  const errors = [];
  const storage = new Map();
  const harness = await dialogHarness('../i18n/settings', {
    english, crypto: { randomUUID }, console: { error: (error) => errors.push(error) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    ...overrides,
  });
  // Use the real translation catalogue/controller in an isolated window, so
  // subscriptions and language state cannot leak into another test's window.
  const source = await fs.readFile(new URL('../../web/i18n/index.js', import.meta.url), 'utf8');
  vm.runInContext(`${stripImports(source).replaceAll('export ', '')}\nglobalThis.getLanguage = getLanguage;`, harness.runtime);
  const broadcast = (language) => harness.runtime.window.dispatch('viento-language-changed', { detail: { language } });
  const select = (language) => {
    const element = harness.element('languageSelect'); element.value = language; element.dispatch('change');
  };
  return { ...harness, errors, storage, broadcast, select };
}

async function nativeHarness(load = Promise.resolve({ ok: true, json: async () => ({ language: 'zh-CN' }) })) {
  const requests = [];
  const harness = await settingsHarness({
    location: { href: 'http://127.0.0.1/?mode=edit&desktop=1' },
    fetch: (url, options) => {
      if (!options.method) return load;
      const response = deferred();
      requests.push({ url, options, body: JSON.parse(options.body), response });
      return response.promise;
    },
  });
  const acknowledge = (request, ok = true) => harness.runtime.window.dispatch('viento-language-result', { detail: { id: request.body.id, ok } });
  return { ...harness, requests, acknowledge };
}

test('a late initial language read cannot overwrite a newer desktop notification or touch the draft', async () => {
  const read = deferred();
  const h = await nativeHarness(read.promise);
  const source = h.element('docSourceEditor'); source.value = '# 场景\n保存：作品正文\n'; source.selectionStart = 4; source.selectionEnd = 8;
  const path = h.element('docCreatePathInput'); path.value = 'characters/设置.md';
  const setup = h.runtime.setupSettings(); await flushDialogs();
  h.broadcast('en');
  read.resolve({ ok: true, json: async () => ({ language: 'zh-CN' }) });
  await setup;
  assert.equal(h.runtime.getLanguage(), 'en');
  assert.equal(h.document.documentElement.lang, 'en');
  assert.equal(h.element('languageSelect').value, 'en');
  assert.equal(h.element('settingsTitle').textContent, 'Settings');
  assert.equal(h.element('docSourceEditor'), source);
  assert.equal(source.value, '# 场景\n保存：作品正文\n');
  assert.deepEqual([source.selectionStart, source.selectionEnd], [4, 8]);
  assert.equal(path.value, 'characters/设置.md');
});

test('the library subscribes before its initial language read and retains newer editor changes', async () => {
  const h = await settingsHarness();
  const html = await fs.readFile(new URL('../../desktop/ui/index.html', import.meta.url), 'utf8');
  h.document.body.innerHTML = html.match(/<body\b[^>]*>([\s\S]*?)<script/)[1];
  const read = deferred();
  const events = new Map();
  h.runtime.window.__TAURI__ = {
    core: { invoke: async (command) => {
      if (command === 'get_language') return read.promise;
      if (command === 'library_state') return { version: 'b.2.8.1', recent: [], active: null };
      throw new Error(`Unexpected command ${command}`);
    } },
    event: { listen: async (name, handler) => { events.set(name, handler); return () => events.delete(name); } },
  };
  const source = await fs.readFile(new URL('../../desktop/ui/app.js', import.meta.url), 'utf8');
  const ready = vm.runInContext(`(async () => { ${stripImports(source)} })()`, h.runtime);
  await flushDialogs();
  const receive = events.get('language-changed');
  receive?.({ payload: 'en' });
  read.resolve('zh-CN'); await ready;
  assert.ok(receive, 'the real library must subscribe before waiting for preferences');
  assert.equal(h.runtime.getLanguage(), 'en');
  assert.equal(h.element('settingsTitle').textContent, 'Settings');
  assert.match(h.document.title, /Library/);
});

test('a late save acknowledgement cannot undo a newer language from another desktop window', async () => {
  for (const notifications of [['en', 'zh-CN'], ['zh-CN']]) {
    const h = await nativeHarness(); await h.runtime.setupSettings();
    h.element('settingsBtn').click(); h.select('en');
    const request = h.requests[0]; request.response.resolve({ ok: true }); await flushDialogs();
    assert.equal(h.element('languageSelect').disabled, true, 'HTTP acceptance is not a save acknowledgement');
    // A newer notification can also confirm the already displayed language,
    // which does not trigger onLanguageChange but still supersedes this save.
    notifications.forEach(h.broadcast);
    h.acknowledge(request); await flushDialogs();
    assert.equal(h.runtime.getLanguage(), 'zh-CN');
    assert.equal(h.element('languageSelect').value, 'zh-CN');
    assert.equal(h.element('languageSelect').disabled, false);
    assert.equal(h.timers.size, 0);
  }
});

test('language changes also translate settings progress and saved status while preserving the pending guard', async () => {
  const h = await nativeHarness(); await h.runtime.setupSettings();
  h.element('settingsBtn').click(); h.select('en');
  assert.equal(h.element('settingsDialog').dispatch('cancel').defaultPrevented, true);
  assert.equal(h.element('settingsDialog').querySelector('button').disabled, true);
  h.broadcast('en');
  assert.equal(h.element('settingsStatus').textContent, 'Saving settings…');
  h.requests[0].response.resolve({ ok: true }); h.acknowledge(h.requests[0]); await flushDialogs();
  assert.equal(h.element('settingsStatus').textContent, 'Language preference saved');
  h.broadcast('zh-CN');
  assert.equal(h.element('settingsStatus').textContent, '语言设置已保存');
  assert.equal(h.element('settingsDialog').dispatch('cancel').defaultPrevented, undefined);
  assert.equal(h.element('settingsDialog').querySelector('button').disabled, false);
});

test('a timed out language request is aborted and a late reply cannot finish its retry', async () => {
  const h = await nativeHarness(); await h.runtime.setupSettings();
  h.select('en'); const old = h.requests[0];
  const timeout = [...h.timers.values()][0]; timeout(); await flushDialogs();
  assert.equal(old.options.signal?.aborted, true);
  assert.equal(h.element('languageSelect').disabled, false);
  assert.equal(h.element('languageSelect').value, 'zh-CN');
  assert.match(h.element('settingsStatus').textContent, /超时.*重试/);
  assert.equal((h.runtime.window.listeners.get('viento-language-result') || []).length, 0);
  h.select('en'); const retry = h.requests[1];
  old.response.resolve({ ok: true }); h.acknowledge(old); await flushDialogs();
  assert.equal(h.element('languageSelect').disabled, true);
  retry.response.resolve({ ok: true }); h.acknowledge(retry); await flushDialogs();
  assert.equal(h.runtime.getLanguage(), 'en');
  assert.equal(h.element('languageSelect').disabled, false);
  assert.equal(h.timers.size, 0);
});

test('a settings timeout actually closes an unfinished HTTP request', { timeout: 4000 }, async (t) => {
  const received = deferred(); const closed = deferred();
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ language: 'zh-CN' }));
    } else {
      request.resume();
      response.on('close', () => closed.resolve());
      received.resolve(); // Keep the response pending until the client aborts.
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = await settingsHarness({
    location: { href: `${base}/?desktop=1` },
    fetch: (url, options) => fetch(new URL(url, base), options),
  });
  await h.runtime.setupSettings(); h.select('en'); await received.promise;
  [...h.timers.values()][0](); await closed.promise; await flushDialogs();
  assert.equal(h.runtime.getLanguage(), 'zh-CN');
  assert.match(h.element('settingsStatus').textContent, /超时.*重试/);
  assert.equal(h.element('languageSelect').disabled, false);
  assert.equal(h.timers.size, 0);
});

test('native preference write failures leave the language unchanged and permit a successful retry', async () => {
  const h = await nativeHarness(); await h.runtime.setupSettings();
  for (const failure of ['http', 'network', 'host']) {
    h.select('en'); const request = h.requests.at(-1);
    if (failure === 'http') request.response.resolve({ ok: false });
    else if (failure === 'network') request.response.reject(new Error('offline'));
    else { request.response.resolve({ ok: true }); h.acknowledge(request, false); }
    await flushDialogs();
    assert.equal(h.runtime.getLanguage(), 'zh-CN', failure);
    assert.equal(h.element('languageSelect').value, 'zh-CN', failure);
    assert.equal(h.element('languageSelect').disabled, false, failure);
    assert.equal(h.timers.size, 0, failure);
  }
  h.select('en'); const request = h.requests.at(-1);
  request.response.resolve({ ok: true }); h.acknowledge(request); await flushDialogs();
  assert.equal(h.runtime.getLanguage(), 'en');
});

test('a failed initial read stays localized and clears after saving; invalid values are not a successful default', async () => {
  const h = await settingsHarness();
  h.runtime.applyLanguage('en');
  const saved = [];
  await h.runtime.setupSettings({ load: async () => 'unsupported', save: async (language) => saved.push(language) });
  h.element('settingsBtn').click();
  assert.equal(h.runtime.getLanguage(), 'en');
  assert.equal(h.element('settingsStatus').textContent, 'Unable to read language preferences');
  h.runtime.applyLanguage('zh-CN');
  assert.equal(h.element('settingsStatus').textContent, '无法读取语言设置');
  h.element('settingsDialog').close(); h.element('settingsBtn').click();
  assert.equal(h.element('settingsStatus').textContent, '无法读取语言设置');
  h.select('en'); await flushDialogs();
  assert.deepEqual(saved, ['en']);
  h.element('settingsDialog').close(); h.element('settingsBtn').click();
  assert.equal(h.element('settingsStatus').textContent, '');
});

test('browser language follows current local storage, ignores session storage, and handles cleared settings', async () => {
  const h = await settingsHarness(); await h.runtime.setupSettings();
  const area = h.runtime.localStorage;
  const storageEvent = (properties) => h.runtime.window.dispatch('storage', { key: LANGUAGE_STORAGE_KEY, storageArea: area, ...properties });
  storageEvent({ storageArea: {}, newValue: 'en' });
  assert.equal(h.runtime.getLanguage(), 'zh-CN', 'session storage is unrelated to the preference');
  h.storage.set(LANGUAGE_STORAGE_KEY, 'en');
  storageEvent({ newValue: 'zh-CN' });
  assert.equal(h.runtime.getLanguage(), 'en', 'a delayed event must not restore a value already superseded in storage');
  h.storage.clear(); storageEvent({ key: null, newValue: null });
  assert.equal(h.runtime.getLanguage(), 'zh-CN');
  area.setItem = () => { throw new Error('storage is unavailable'); };
  h.select('en'); await flushDialogs();
  assert.equal(h.runtime.getLanguage(), 'zh-CN');
  assert.equal(h.element('languageSelect').disabled, false);
  area.setItem = (key, value) => h.storage.set(key, value);
  h.select('en'); await flushDialogs();
  assert.equal(h.runtime.getLanguage(), 'en');
  assert.equal(h.storage.get(LANGUAGE_STORAGE_KEY), 'en');
});
