import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { formatMessage } from '../../web/i18n/messages.js';
import { supportedLanguages, isSupportedLanguage } from '../../web/i18n/languages.js';
import { deferred } from './editor-harness.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';

const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');
async function libraryHarness(active = true, handlers = {}) {
  const h = await dialogHarness('../i18n/settings', { formatMessage, supportedLanguages, isSupportedLanguage });
  const html = await fs.readFile(new URL('../../desktop/ui/index.html', import.meta.url), 'utf8');
  h.document.body.innerHTML = html.match(/<body\b[^>]*>([\s\S]*?)<script/)[1];
  const catalogue = await fs.readFile(new URL('../../web/i18n/index.js', import.meta.url), 'utf8');
  vm.runInContext(stripImports(catalogue).replaceAll('export ', ''), h.runtime);
  const recent = ['current', 'other'].map((name) => ({ name, path: `/projects/${name}`, lastOpened: 0 }));
  let state = { version: 'test', recent, active: active ? recent[0] : null };
  const calls = [], events = new Map();
  h.runtime.window.__TAURI__ = {
    core: { invoke: async (name, args) => {
      calls.push({ name, args });
      if (name === 'library_state') return state;
      if (name === 'get_language') return 'zh-CN';
      if (handlers[name]) return handlers[name](args);
      throw new Error(`Unexpected native call: ${name}`);
    } },
    event: { listen: async (name, handler) => { events.set(name, handler); return () => events.delete(name); } },
  };
  const source = await fs.readFile(new URL('../../desktop/ui/app.js', import.meta.url), 'utf8');
  await vm.runInContext(`(async () => { ${stripImports(source)} })()`, h.runtime);
  return { ...h, calls, events,
    rows: () => h.element('workspaces').querySelectorAll('.workspace-actions').map((row) => row.querySelectorAll('button')),
    setActive: async (active) => { state = { ...state, active: active ? recent[0] : null }; await events.get('library-changed')(); },
  };
}

test('an active editor blocks new/open/import and other projects across backup completion and language changes', async () => {
  const backup = deferred();
  const h = await libraryHarness(true, { backup_workspace: () => backup.promise, resume_editor: () => {} });
  const assertGuard = () => {
    for (const id of ['createBtn', 'openBtn', 'importBtn']) assert.equal(h.element(id).disabled, true, id);
    assert.equal(h.rows()[1][2].disabled, true, 'other project stays blocked');
    assert.equal(h.rows()[0][2].disabled, false, 'current editor can resume');
    assert.equal(h.rows()[0][1].disabled, false, 'saved files can be backed up');
    assert.equal(h.element('closeEditorBtn').disabled, false);
  };
  assertGuard();
  for (const id of ['createBtn', 'openBtn', 'importBtn']) h.element(id).click();
  h.rows()[1][2].click();
  assert.equal(h.element('createDialog').open, false);
  assert.ok(h.calls.every(({ name }) => ['library_state', 'get_language'].includes(name)));
  h.rows()[0][1].click();
  assert.equal(h.element('resumeBtn').disabled, true);
  h.events.get('language-changed')({ payload: 'en' });
  await h.events.get('library-changed')();
  assert.ok(h.rows().flat().every((button) => button.disabled), 'refreshes during backup retain the busy guard');
  backup.resolve('/backups/project.zip'); await flushDialogs();
  assert.match(h.element('status').textContent, /Backup saved to/);
  assertGuard();
  h.rows()[0][2].click(); await flushDialogs();
  assert.equal(h.calls.filter(({ name }) => name === 'resume_editor').length, 1);
  assertGuard();
  await h.setActive(false);
  for (const id of ['createBtn', 'openBtn', 'importBtn']) assert.equal(h.element(id).disabled, false, id);
  assert.ok(h.rows().flat().every((button) => !button.disabled));
  h.element('createBtn').click();
  assert.equal(h.element('createDialog').open, true);
});

test('a cancelled picker or failed backup permits retry while preserving the current session guard', async () => {
  const choose = deferred();
  let attempts = 0;
  const h = await libraryHarness(false, {
    choose_workspace: () => choose.promise,
    backup_workspace: () => { if (!attempts++) throw new Error('disk unavailable'); return null; },
  });
  h.element('openBtn').click();
  await h.events.get('library-changed')();
  assert.ok(h.rows().flat().every((button) => button.disabled));
  choose.resolve(null); await flushDialogs();
  assert.equal(h.element('status').textContent, '已取消');
  assert.equal(h.element('openBtn').disabled, false);
  assert.equal(h.calls.some(({ name }) => name === 'launch_workspace'), false);
  await h.setActive(true);
  h.rows()[0][1].click(); await flushDialogs();
  assert.equal(h.element('status').textContent, 'disk unavailable');
  assert.equal(h.element('status').classList.contains('error'), true);
  assert.equal(h.element('createBtn').disabled, true);
  assert.equal(h.rows()[0][1].disabled, false);
  h.rows()[0][1].click(); await flushDialogs();
  assert.equal(attempts, 2);
  assert.equal(h.element('status').textContent, '已取消导出');
  assert.equal(h.element('status').classList.contains('error'), false);
  assert.equal(h.element('importBtn').disabled, true);
});

test('library refreshes cannot unlock settings while a language write is pending', async () => {
  const save = deferred();
  const h = await libraryHarness(true, { set_language: () => save.promise });
  h.element('settingsBtn').click();
  const select = h.element('languageSelect'); select.value = 'en'; select.dispatch('change');
  const done = h.element('settingsDialog').querySelector('button');
  assert.equal(done.disabled, true);
  await h.events.get('library-changed')();
  h.events.get('language-changed')({ payload: 'en' });
  assert.equal(done.disabled, true);
  assert.equal(select.disabled, true);
  assert.equal(h.element('settingsDialog').dispatch('cancel').defaultPrevented, true);
  save.resolve(); await flushDialogs();
  assert.equal(done.disabled, false);
  assert.equal(select.disabled, false);
  assert.equal(h.document.documentElement.lang, 'en');
  assert.equal(h.element('openBtn').disabled, true);
});

test('library translates suggested names and actions but preserves names already entered', async () => {
  const h = await libraryHarness(false);
  h.element('createBtn').click();
  assert.equal(h.element('workspaceName').value, '我的作品库');
  h.events.get('language-changed')({ payload: 'ja' });
  assert.equal(h.element('workspaceName').value, 'マイライブラリ');
  assert.equal(h.element('createBtn').textContent, 'ライブラリを作成');
  assert.equal(h.rows()[0][1].textContent, 'バックアップを書き出す');
  assert.equal(h.document.title, 'Viento Studio test · ライブラリ');
  assert.equal(h.element('createDialog').open, true);
  h.element('workspaceName').value = '設定 / My world / 原文';
  h.element('workspaceName').dispatch('input');
  h.events.get('language-changed')({ payload: 'en' });
  h.events.get('language-changed')({ payload: 'zh-CN' });
  assert.equal(h.element('workspaceName').value, '設定 / My world / 原文');
  assert.equal(h.calls.some(({ name }) => name === 'new_workspace'), false);
});
