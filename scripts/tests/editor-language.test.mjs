import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { formatMessage } from '../../web/i18n/messages.js';
import { supportedLanguages, isSupportedLanguage } from '../../web/i18n/languages.js';
import { deferred, editorHarness } from './editor-harness.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';

const original = '\uFEFF# 角色\r\n\r\n保留正文和格式。  \r\n';
const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');

async function languageHarness(overrides = {}) {
  const writes = [], reads = [], errors = [];
  const ui = await dialogHarness('../i18n/settings', { formatMessage, supportedLanguages, isSupportedLanguage });
  const translations = await fs.readFile(new URL('../../web/i18n/index.js', import.meta.url), 'utf8');
  const i18n = vm.runInContext(`(() => { ${stripImports(translations).replaceAll('export ', '')}\nreturn { t, localize, getLanguage, onLanguageChange, applyLanguage, translatePage, translateMessage, isLanguage, LANGUAGES }; })()`, ui.runtime);
  Object.assign(ui.runtime, i18n);
  const h = await editorHarness({
    ...i18n, document: ui.document, window: ui.runtime.window,
    readDocSource: async (request) => { reads.push(request); return { content: original, version: '1' }; },
    writeDoc: async (payload) => { writes.push(payload); return { version: '2' }; },
    ...overrides,
  });
  const helpers = stripImports(await fs.readFile(new URL('../../web/modules/app-helpers.js', import.meta.url), 'utf8'))
    .replace(/export\s*\{[^}]+\};\s*$/, '');
  Object.assign(h.runtime, vm.runInContext(`(() => { ${helpers}\nreturn { getVisibleDocs, getHeroDisplayDocs, getSearchIndex, getTabCounts, renderTabs, getDisplayCategory, groupDocs }; })()`, h.runtime));
  // The actual settings, i18n, filtering, load and editor controllers share one
  // DOM. Only network, catalog presentation and file I/O are simulated.
  for (const name of ['renderHeroBanner', 'renderSectionCards', 'renderGallery', 'markActiveItem',
    'updateLeftPanelStatsFromGroups', 'resetDocListButtonCache']) h.runtime[name] = () => {};
  h.runtime.getHeroImagesForDisplay = () => [];
  h.runtime.renderList = () => { ui.element('docList').textContent = 'catalog fixture'; return {}; };
  h.runtime.formatTime = (value) => value || '';
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => { errors.push(error.message); return error.message; };
  h.runtime.rebuildIndexForDoc = async () => {};
  Object.assign(h.doc, { owners: [], name: '角色', _sourceCachedText: original });
  h.runtime.renderCreateTypeOptions();
  h.runtime.updateEditorForDoc(h.doc);
  await ui.runtime.setupSettings({ load: async () => 'zh-CN', save: async () => {}, subscribe: (receive) => {
    ui.runtime.window.addEventListener('viento-language-changed', (event) => receive(event.detail.language));
  } });
  i18n.onLanguageChange(h.runtime.refreshLanguageUi);
  const switchLanguage = (language) => ui.runtime.window.dispatch('viento-language-changed', { detail: { language } });
  const begin = () => h.runtime.enterEditMode();
  const snapshot = () => ({ payload: { docs: h.state.docs.map((doc) => ({ ...doc })), workspace: h.state.workspace, generatedAt: '2026-09-23' } });
  return { ...h, ...ui, runtime: h.runtime, source: ui.element('docSourceEditor'), writes, reads, errors, switchLanguage, begin, snapshot, i18n };
}

test('language: source location keeps the authored path instead of exposing the generated cache prefix', async () => {
  const h = await languageHarness();
  h.doc.sourcePath = 'docs-standard/design-data/design-rules/编辑检查.md';
  for (const language of ['ja', 'en', 'zh-CN']) {
    h.switchLanguage(language);
    assert.ok(h.element('docEditPath').textContent.endsWith('design-data/design-rules/编辑检查.md'));
    assert.ok(!h.element('docEditPath').textContent.includes('docs-standard/'));
  }
  assert.deepEqual(h.writes, []);
});

for (const mode of ['source', 'blocks']) test(`language: ${mode} draft, cursor and original bytes survive settings changes and save`, async () => {
  const h = await languageHarness(); await h.begin();
  if (mode === 'blocks') h.runtime.setEditInputMode('blocks');
  const input = mode === 'blocks' ? h.element('docBlockEditor').querySelectorAll('textarea')[1] : h.source;
  input.value += '未保存的内容'; input.selectionStart = 2; input.selectionEnd = 5; input.scrollTop = 37; input.focus();
  h.runtime.refreshEditSessionDirtyState();
  const content = h.runtime.getCurrentEditContent();
  for (const language of ['en', 'ja', 'zh-CN', 'ja', 'en']) {
    h.switchLanguage(language);
    assert.equal(h.i18n.getLanguage(), language);
    assert.equal(h.element('languageSelect').value, language);
    assert.equal(h.document.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.scrollTop], [2, 5, 37]);
    assert.equal(h.runtime.getCurrentEditContent(), content);
    assert.equal(h.state.editInputMode, mode);
    assert.equal(h.state.editHasUnsavedChanges, true);
    assert.equal(h.state.activeEditSourceVersion, '1');
    assert.equal(mode === 'blocks' ? h.element('docBlockEditor').querySelectorAll('textarea')[1] : h.source, input);
  }
  await h.runtime.saveCurrentDoc();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].content, content);
  assert.equal(h.writes[0].expectedVersion, '1');
  assert.ok(content.startsWith('\uFEFF'));
  assert.ok(content.includes('\r\n'));
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.equal(h.state.activeEditSourceVersion, '2');
});

test('language: switching during an original-source read preserves the pending request and opens its result', async () => {
  const response = deferred(); let reads = 0;
  const h = await languageHarness({ readDocSource: () => { reads += 1; return response.promise; } });
  const opening = h.begin();
  assert.equal(h.state.isLoadingSource, true);
  h.switchLanguage('en');
  assert.equal(h.state.isLoadingSource, true);
  assert.equal(h.element('docSaveBtn').disabled, true);
  assert.equal(h.source.readOnly, true);
  response.resolve({ content: original, version: '3' }); await opening;
  assert.equal(reads, 1);
  assert.equal(h.runtime.getCurrentEditContent(), original);
  assert.equal(h.state.activeEditSourceVersion, '3');
  assert.equal(h.source.readOnly, false);
  assert.deepEqual(h.writes, []);
});

for (const [locale, settings, save] of [['en', 'Settings', 'Save changes'], ['ja', '設定', '変更を保存']]) test(`language: choosing ${locale} in settings updates the editor without changing its draft or selection`, async () => {
  const h = await languageHarness(); await h.begin();
  h.source.value += '未保存'; h.source.selectionStart = 3; h.source.selectionEnd = 6;
  h.runtime.refreshEditSessionDirtyState(); const content = h.runtime.getCurrentEditContent();
  h.element('settingsBtn').click();
  h.element('languageSelect').value = locale; h.element('languageSelect').dispatch('change');
  await flushDialogs();
  assert.equal(h.element('settingsTitle').textContent, settings);
  assert.equal(h.element('docSaveBtn').textContent, save);
  assert.equal(h.element('languageSelect').disabled, false);
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.deepEqual([h.source.selectionStart, h.source.selectionEnd], [3, 6]);
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.deepEqual(h.writes, []);
});

test('language: built-in create options translate in place without restarting the pending template or changing its path', async () => {
  const template = deferred(); let requests = 0;
  const h = await languageHarness({ loadTemplateContent: () => { requests += 1; return template.promise; } });
  const creating = h.runtime.enterCreateMode();
  const type = h.state.activeCreateType, path = h.element('docCreatePathInput').value;
  const option = h.element('docCreateTypeSelect').querySelectorAll('option').find((item) => item.value === 'item');
  assert.equal(option.textContent, '物品');
  h.switchLanguage('en');
  assert.equal(option.textContent, 'Items');
  assert.equal(h.element('docCreateTypeSelect').querySelectorAll('option').find((item) => item.value === 'item'), option);
  assert.equal(h.state.activeCreateType, type);
  assert.equal(h.element('docCreatePathInput').value, path);
  assert.equal(h.state.isLoadingTemplate, true);
  template.resolve(original); await creating;
  assert.equal(requests, 1);
  assert.equal(h.runtime.getCurrentEditContent(), original);
  assert.equal(h.state.isCreating, true);
  assert.deepEqual(h.writes, []);
});

test('language: authored type labels and new draft paths are never translated', async () => {
  const h = await languageHarness({ loadTemplateContent: async () => original });
  h.state.workspace = { documentTypes: [{ id: 'item', label: '物品', directory: 'items', templateSource: 'templates/item.md' }] };
  h.runtime.renderCreateTypeOptions(); await h.runtime.enterCreateMode();
  h.element('docCreatePathInput').value = 'design-data/items/保存.md';
  h.source.value += '创作者写的保存与物品'; h.runtime.refreshEditSessionDirtyState();
  const content = h.runtime.getCurrentEditContent();
  h.switchLanguage('en');
  assert.equal(h.element('docCreateTypeSelect').querySelector('option').textContent, '物品');
  assert.equal(h.element('docCreatePathInput').value, 'design-data/items/保存.md');
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.equal(h.state.isCreating, true);
});

test('language: a pending save retains disabled mode controls and cannot be submitted twice', async () => {
  const response = deferred(); const writes = [];
  const h = await languageHarness({ writeDoc: (payload) => { writes.push(payload); return response.promise; } });
  await h.begin(); h.source.value += '继续编辑'; h.runtime.refreshEditSessionDirtyState();
  const saving = h.runtime.saveCurrentDoc();
  h.switchLanguage('en');
  assert.equal(h.element('docSaveBtn').textContent, 'Saving…');
  assert.equal(h.element('modeEditBtn').disabled, true);
  assert.equal(h.element('modeEditBtn').getAttribute('aria-disabled'), 'true');
  assert.equal(h.element('modeBrowseBtn').disabled, true);
  assert.equal(h.source.readOnly, true);
  await h.runtime.saveCurrentDoc(); h.runtime.setMode('browse');
  assert.equal(h.state.mode, 'edit'); assert.equal(writes.length, 1);
  response.resolve({ version: '2' }); await saving;
  assert.equal(h.element('modeEditBtn').disabled, false);
  assert.equal(h.element('modeEditBtn').getAttribute('aria-disabled'), 'false');
  assert.equal(h.source.readOnly, false);
});

test('language: a read-only backend keeps edit mode unavailable after refresh', async () => {
  const h = await languageHarness(); h.state.mode = 'browse'; h.state.editBackendAvailable = false;
  h.runtime.setModeUi(); h.switchLanguage('en');
  assert.equal(h.element('modeEditBtn').disabled, true);
  assert.equal(h.element('modeEditBtn').getAttribute('aria-disabled'), 'true');
  h.runtime.setMode('edit'); assert.equal(h.state.mode, 'browse');
});

for (const mode of ['default', 'force']) test(`language: ${mode} conflict retains its draft, decision and overwrite warning`, async () => {
  const h = await languageHarness(); await h.begin();
  h.source.value += '冲突草稿'; h.runtime.refreshEditSessionDirtyState();
  const content = h.runtime.getCurrentEditContent();
  const decision = h.runtime.openSaveConflictDialog({ currentVersion: `sha256:12345678${'a'.repeat(56)}`, lastModified: '2026-09-23' }, { mode });
  let settled = false; decision.then(() => { settled = true; });
  h.switchLanguage('en'); await flushDialogs();
  assert.equal(settled, false);
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.match(h.element('docSaveConflictDialogMessage').textContent, /12345678/);
  assert.match(h.element('docSaveConflictDialogTitle').textContent, mode === 'force' ? /overwrite/i : /conflict/i);
  assert.equal(h.element('docSaveConflictDialogWarning').classList.contains('is-hidden'), mode !== 'force');
  assert.equal(h.element('docSaveConflictReloadBtn').classList.contains('is-hidden'), mode === 'force');
  h.runtime.resolveSaveConflictAction('cancel'); assert.equal(await decision, 'cancel');
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.deepEqual(h.writes, []);
});

for (const populated of [false, true]) test(`language: index loading remains visible with ${populated ? 'an existing draft' : 'an empty catalog'}`, async () => {
  const response = deferred(); let reads = 0;
  const h = await languageHarness({ loadDocIndexPayload: () => { reads += 1; return response.promise; } });
  if (populated) { await h.begin(); h.source.value += '草稿'; h.runtime.refreshEditSessionDirtyState(); }
  else { h.state.docs = []; h.state.activePath = ''; h.runtime.rebuildDocPathCaches([]); }
  const content = h.runtime.getCurrentEditContent();
  const loading = h.runtime.loadData();
  h.switchLanguage('en');
  assert.equal(h.element('status').textContent, 'Loading document index…');
  assert.match(h.element('docList').textContent, /Loading document index/);
  assert.equal(h.element('docLoadRetryBtn').hidden, true);
  response.resolve(h.snapshot()); await loading;
  assert.equal(reads, 1);
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.doesNotMatch(h.element('status').textContent, /Loading document index/);
  assert.deepEqual(h.errors, []);
});

test('language: failed index retains the error and force-retry action, then recovers after a successful retry', async () => {
  const h = await languageHarness({ loadDocIndexPayload: async () => { throw new Error('fixture-index-offline'); } });
  await h.begin(); h.source.value += '草稿'; h.runtime.refreshEditSessionDirtyState();
  const content = h.runtime.getCurrentEditContent();
  await h.runtime.loadData({ isRetryAttempt: true });
  h.switchLanguage('en');
  assert.match(h.element('status').textContent, /Loading failed.*fixture-index-offline/);
  assert.match(h.element('docList').textContent, /fixture-index-offline/);
  assert.equal(h.element('docLoadRetryBtn').textContent, 'Clear cache and retry');
  assert.equal(h.element('docLoadRetryBtn').dataset.retryMode, 'force');
  assert.equal(h.element('docLoadRetryBtn').hidden, false);
  const response = deferred(); h.runtime.loadDocIndexPayload = () => response.promise;
  const retrying = h.runtime.retryLoadData({ forceCacheBust: true });
  h.switchLanguage('zh-CN');
  assert.match(h.element('status').textContent, /正在加载文档索引/);
  assert.equal(h.element('docLoadRetryBtn').hidden, true);
  response.resolve(h.snapshot()); await retrying; h.switchLanguage('en');
  assert.doesNotMatch(h.element('status').textContent, /failed|Loading|fixture-index-offline/);
  assert.equal(h.element('docLoadRetryBtn').hidden, true);
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.deepEqual(h.writes, []);
});

test('language: late index failures cannot replace the current loading or successful view', async () => {
  const requests = [];
  const h = await languageHarness({ loadDocIndexPayload: () => { const response = deferred(); requests.push(response); return response.promise; } });
  await h.begin();
  const first = h.runtime.loadData(), second = h.runtime.loadData(), current = h.runtime.loadData();
  requests[0].reject(new Error('stale-first')); await first;
  h.switchLanguage('en');
  assert.equal(h.element('status').textContent, 'Loading document index…');
  requests[2].resolve(h.snapshot()); await current;
  requests[1].reject(new Error('stale-second')); await second;
  h.switchLanguage('zh-CN');
  assert.match(h.element('status').textContent, /当前显示/);
  assert.equal(h.element('docLoadRetryBtn').hidden, true);
  assert.deepEqual(h.errors, []);
  assert.equal(h.runtime.getCurrentEditContent(), original);
});
