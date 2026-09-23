import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { deferred, editorHarness } from './editor-harness.mjs';

const original = '\uFEFF# needle role\r\n\r\n保留格式。  \r\n';
const edited = original.replace('needle role', 'updated role');

async function filteringHarness() {
  const files = new Map(), writes = [], errors = [], confirmations = [], renderedMetadata = [];
  let nextIndex = [];
  const h = await editorHarness({
    readDocSource: async ({ pathValue }) => ({ ...files.get(pathValue.replace(/^docs-standard\//, '')) }),
    writeDoc: async (payload) => {
      writes.push(payload);
      files.set(payload.pathValue.replace(/^docs-standard\//, ''), { content: payload.content, version: '2' });
      return { version: '2' };
    },
    rebuildDocIndex: async () => ({}),
    loadDocIndexPayload: async () => ({ payload: { docs: structuredClone(nextIndex), workspace: h.state.workspace } }),
    loadTemplateContent: async () => '# 新草稿\n',
  });
  // Load the real filtering, search caches, ownership and tab controllers into
  // the same state/DOM as the editor; only presentation and I/O are simulated.
  const helperSource = (await fs.readFile(new URL('../../web/modules/app-helpers.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
    .replace(/export\s*\{[^}]+\};\s*$/, '');
  Object.assign(h.runtime, vm.runInContext(`(() => { ${helperSource}\nreturn { getVisibleDocs, getHeroDisplayDocs, getSearchIndex, getTabCounts, renderTabs, getDisplayCategory, groupDocs }; })()`, h.runtime));
  const createElement = h.runtime.document.createElement;
  h.runtime.document.createElement = (tag) => {
    const element = createElement(tag), handlers = new Map();
    element.addEventListener = (type, callback) => handlers.set(type, callback);
    element.click = () => handlers.get('click')?.({ target: element });
    return element;
  };
  for (const name of ['setLoadingState', 'setListSkeletonState', 'hideLoadRetry', 'renderHeroBanner',
    'renderSectionCards', 'renderGallery', 'markActiveItem', 'updateLeftPanelStatsFromGroups']) h.runtime[name] = () => {};
  h.runtime.renderList = () => ({});
  h.runtime.getHeroImagesForDisplay = () => [];
  h.runtime.renderMeta = (doc) => renderedMetadata.push(doc);
  h.runtime.formatTime = () => '';
  h.runtime.showLoadRetry = (message) => errors.push(message);
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => { errors.push(error.message); return error.message; };
  h.runtime.window.confirm = (message) => { confirmations.push(message); return false; };
  h.state.workspace = { version: 3, projectTypes: true, paths: { documents: 'documents' }, documentTypes: [
    { id: 'character', label: '角色', directory: 'characters', template: 'character.md', templateSource: 'templates/character.md' },
    { id: 'item', label: '物品', directory: 'items', template: 'item.md' },
  ] };
  Object.assign(h.doc, { path: 'character/active', sourcePath: 'documents/characters/active.md', category: 'character', name: 'needle role', owners: [], blocks: [], _sourceCachedText: original });
  const other = { path: 'item/other', sourcePath: 'documents/items/other.md', category: 'item', name: 'needle item', owners: [], _sourceCachedText: '# needle item\n', _sourceVersion: '1' };
  h.state.docs = [h.doc, other].map((doc) => h.runtime.normalizeDocFromIndex(doc));
  h.state.activePath = h.doc.path;
  h.runtime.rebuildDocPathCaches(h.state.docs);
  for (const doc of h.state.docs) files.set(doc.sourcePath, { content: doc._sourceCachedText, version: '1' });
  h.runtime.renderFilteredDocs();
  return { ...h, other, files, writes, errors, confirmations, renderedMetadata,
    search(value) { h.element('searchInput').value = value; h.runtime.renderFilteredDocs('', { skipTabs: true }); },
    visiblePaths() { return Array.from(h.runtime.getVisibleDocs(), (doc) => doc.path); },
    chooseItems() { h.runtime.renderTabsNow(); h.element('categoryTabs').querySelectorAll('button').find((button) => button.textContent.startsWith('物品')).click(); },
    refreshedIndex() {
      const current = { path: 'character/rebuilt', source: { path: `docs-standard/${h.doc.sourcePath}` }, category: 'character', name: 'updated role', owners: [], blocks: [] };
      nextIndex = [current, { ...other }];
      return current;
    },
  };
}

for (const mode of ['source', 'blocks']) {
  test(`filtering: searching while writing a ${mode} draft changes the list without requesting discard`, async () => {
    const h = await filteringHarness();
    await h.runtime.enterEditMode();
    if (mode === 'blocks') h.runtime.setEditInputMode('blocks');
    const input = mode === 'blocks' ? h.element('docBlockEditor').querySelectorAll('textarea')[1] : h.source;
    input.value += '还没保存'; h.runtime.refreshEditSessionDirtyState();
    const draft = h.runtime.getCurrentEditContent();
    h.search('needle item');
    assert.deepEqual(h.visiblePaths(), [h.other.path]);
    assert.deepEqual(h.confirmations, []);
    assert.equal(h.state.activePath, h.doc.path);
    assert.equal(h.state.isEditing, true);
    assert.equal(h.state.editHasUnsavedChanges, true);
    assert.equal(h.runtime.getCurrentEditContent(), draft);
    h.runtime.selectDoc(h.other.path);
    assert.equal(h.confirmations.length, 1, 'explicit document selection must still ask before discarding');
    assert.equal(h.state.activePath, h.doc.path);
    h.runtime.window.confirm = () => true;
    h.runtime.selectDoc(h.other.path);
    assert.equal(h.state.activePath, h.other.path);
    assert.equal(h.state.isEditing, false);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.errors, []);
  });
}

test('filtering: a custom category tab keeps a clean edit session open until a document is explicitly selected', async () => {
  const h = await filteringHarness();
  await h.runtime.enterEditMode();
  h.chooseItems();
  assert.equal(h.state.activeTab, 'type:item');
  assert.deepEqual(h.visiblePaths(), [h.other.path]);
  assert.equal(h.state.activePath, h.doc.path);
  assert.equal(h.state.isEditing, true);
  assert.equal(h.runtime.getCurrentEditContent(), original);
  assert.deepEqual(h.confirmations, []);
  h.runtime.selectDoc(h.other.path);
  assert.equal(h.state.activePath, h.other.path);
  assert.equal(h.state.isEditing, false);
  assert.deepEqual(h.errors, []);
});

test('filtering: changing the list cannot cancel an unfinished new template or the resulting draft', async () => {
  const h = await filteringHarness(), template = deferred();
  h.runtime.loadTemplateContent = () => template.promise;
  const creating = h.runtime.enterCreateMode();
  const path = h.state.activeCreatePath;
  h.search('needle item');
  template.resolve('# 当前模板\n'); await creating;
  assert.equal(h.state.isCreating, true);
  assert.equal(h.state.activePath, h.doc.path);
  assert.equal(h.state.activeCreatePath, path);
  assert.equal(h.state.activeCreateType, 'character');
  assert.equal(h.source.value, '# 当前模板\n');
  h.source.value += '我的草稿'; h.runtime.refreshEditSessionDirtyState();
  h.chooseItems();
  assert.equal(h.state.isCreating, true);
  assert.equal(h.source.value, '# 当前模板\n我的草稿');
  assert.equal(h.state.editHasUnsavedChanges, true);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.errors, []);
});

test('filtering: changing the list while source loading does not cancel the requested editor', async () => {
  const h = await filteringHarness(), source = deferred();
  h.runtime.readDocSource = () => source.promise;
  const entering = h.runtime.enterEditMode();
  h.chooseItems();
  source.resolve({ content: original, version: '1' }); await entering;
  assert.equal(h.state.activePath, h.doc.path);
  assert.equal(h.state.isEditing, true);
  assert.equal(h.state.isLoadingSource, false);
  assert.equal(h.runtime.getCurrentEditContent(), original);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.errors, []);
});

for (const mode of ['source', 'blocks']) {
  test(`filtering: saving a ${mode} draft that no longer matches search keeps the rebuilt editor and version`, async () => {
    const h = await filteringHarness();
    h.search('needle');
    await h.runtime.enterEditMode();
    if (mode === 'blocks') {
      h.runtime.setEditInputMode('blocks');
      h.element('docBlockEditor').querySelectorAll('textarea')[0].value = '\uFEFF# updated role';
    } else h.source.value = edited;
    const updated = h.refreshedIndex();
    await h.runtime.saveCurrentDoc();
    assert.equal(h.writes[0].pathValue, h.doc.sourcePath);
    assert.equal(h.writes[0].expectedVersion, '1');
    assert.equal(h.writes[0].content, edited);
    assert.deepEqual(h.visiblePaths(), [h.other.path]);
    assert.equal(h.state.activePath, updated.path);
    assert.equal(h.state.isEditing, true);
    assert.equal(h.state.editInputMode, mode);
    assert.equal(h.state.activeEditSourceVersion, '2');
    assert.equal(h.state.editHasUnsavedChanges, false);
    assert.equal(h.runtime.getCurrentEditContent(), edited);
    assert.equal(h.state.isSaving, false);
    assert.equal(h.state.isRebuilding, false);
    assert.equal(h.files.get(h.other.sourcePath).content, '# needle item\n');
    assert.match(h.element('docEditStatus').textContent, /重建完成/);
    assert.deepEqual(h.confirmations, []);
    assert.deepEqual(h.errors, []);
  });
}

test('filtering: an empty result list still refreshes the current editor from its new catalog entry', async () => {
  const h = await filteringHarness();
  await h.runtime.enterEditMode();
  h.search('没有匹配的结果');
  assert.deepEqual(h.visiblePaths(), []);
  h.source.value = edited;
  const updated = h.refreshedIndex();
  await h.runtime.saveCurrentDoc();
  const current = h.runtime.getActiveDoc();
  assert.equal(h.state.activePath, updated.path);
  assert.equal(h.state.isEditing, true);
  assert.equal(h.renderedMetadata.at(-1), current);
  assert.equal(h.runtime.getCurrentEditContent(), edited);
  assert.equal(h.state.activeEditSourceVersion, '2');
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.errors, []);
});

test('filtering: browse still selects a matching result and explicit preserveSelection does not switch documents', async () => {
  const h = await filteringHarness();
  h.runtime.setMode('browse');
  h.element('searchInput').value = 'needle item';
  h.runtime.renderFilteredDocs('', { preserveSelection: true });
  assert.equal(h.state.activePath, h.doc.path);
  h.runtime.renderFilteredDocs();
  assert.equal(h.state.activePath, h.other.path);
  assert.equal(h.state.isEditing, false);
  h.search('没有匹配的结果');
  assert.equal(h.state.activePath, h.other.path);
  h.search('');
  assert.equal(h.state.activePath, h.other.path);
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.errors, []);
});

for (const mode of ['edit', 'browse']) {
  test(`filtering: a compact sidebar stays open during ${mode} search and closes on an explicit selection`, async () => {
    const h = await filteringHarness();
    if (mode === 'edit') await h.runtime.enterEditMode();
    else h.runtime.setMode('browse');
    h.runtime.window.matchMedia = () => ({ matches: true });
    h.runtime.setEditorSidebarCollapsed(false);
    h.search('needle role');
    assert.equal(h.state.isSidebarCollapsed, false);
    assert.equal(h.state.activePath, h.doc.path);
    h.runtime.selectDoc(h.other.path);
    assert.equal(h.state.isSidebarCollapsed, true);
    assert.equal(h.state.activePath, h.other.path);
    assert.deepEqual(h.confirmations, []);
    assert.deepEqual(h.errors, []);
  });
}
