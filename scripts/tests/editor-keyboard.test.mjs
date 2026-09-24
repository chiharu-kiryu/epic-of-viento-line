import test from 'node:test';
import assert from 'node:assert/strict';
import { editorHarness } from './editor-harness.mjs';
import { dialogHarness, flushDialogs } from './dialog-harness.mjs';

const key = (target, options = {}) => ({
  target, key: 's', ctrlKey: true, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, ...options,
});
async function keyboardHarness(overrides = {}) {
  const writes = [];
  const h = await editorHarness({ writeDoc: async (payload) => { writes.push(payload); return { version: '2' }; }, ...overrides });
  h.runtime.rebuildIndexForDoc = async () => {};
  h.element('docSaveConflictDialog').classList.add('is-hidden');
  h.begin(); h.source.value += '入力中'; h.runtime.refreshEditSessionDirtyState();
  return { ...h, writes };
}

for (const modifier of ['ctrlKey', 'metaKey']) test(`${modifier}+S saves from the filename field without leaving the new draft`, async () => {
  const h = await keyboardHarness();
  h.runtime.window.confirm = () => true;
  await h.runtime.enterCreateMode();
  assert.equal(h.state.isCreating, true);
  const path = h.element('docCreatePathInput'); path.value = 'design-data/新しい角色.md';
  h.source.value = '# 小春\n\n原文と日本語。\n';
  const event = key(path, { ctrlKey: false, [modifier]: true });
  h.runtime.handleWindowKeydown(event); await flushDialogs();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].pathValue, path.value);
  assert.equal(h.writes[0].content, h.source.value);
  assert.equal(h.state.isCreating, false);
  assert.equal(h.state.isEditing, true);
});

test('IME: filename Enter waits for a committed candidate, then creates the chosen filename exactly once', async () => {
  const h = await keyboardHarness(); h.runtime.window.confirm = () => true; await h.runtime.enterCreateMode();
  assert.equal(h.state.isCreating, true);
  const path = h.element('docCreatePathInput'); path.value = 'design-data/新しい物語.md';
  h.source.value = '# 新しい物語\n';
  for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    const event = key(path, { key: 'Enter', ctrlKey: false, ...composition });
    h.runtime.handleCreatePathKeydown(event); h.runtime.handleWindowKeydown(event); await flushDialogs();
    assert.equal(h.writes.length, 0); assert.equal(event.defaultPrevented, false);
    assert.equal(h.state.isCreating, true); assert.equal(path.value, 'design-data/新しい物語.md');
  }
  const event = key(path, { key: 'Enter', ctrlKey: false });
  h.runtime.handleCreatePathKeydown(event); h.runtime.handleWindowKeydown(event); await flushDialogs();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].pathValue, 'design-data/新しい物語.md');
  assert.equal(h.writes[0].content, '# 新しい物語\n');
});

test('save shortcuts preserve modal workflows and respect already handled, repeating and Alt-modified keys', async () => {
  const h = await keyboardHarness();
  const ui = await dialogHarness('app-export');
  h.runtime.document.querySelector = ui.document.querySelector;
  const dialog = ui.element('docExportDialog'); dialog.showModal();
  const blocked = key(h.source);
  h.runtime.handleWindowKeydown(blocked); await flushDialogs();
  assert.equal(h.writes.length, 0);
  assert.equal(blocked.defaultPrevented, true, 'a modal must not open the browser Save Page dialog either');
  dialog.close();
  for (const options of [{ defaultPrevented: true }, { repeat: true }, { altKey: true }]) h.runtime.handleWindowKeydown(key(h.source, options));
  await flushDialogs(); assert.equal(h.writes.length, 0);
  // Ctrl+Enter is reserved for the writing surface, not a focused sidebar input.
  h.runtime.handleWindowKeydown(key(h.element('searchInput'), { key: 'Enter' }));
  await flushDialogs(); assert.equal(h.writes.length, 0);
  h.runtime.handleWindowKeydown(key(h.element('searchInput'))); await flushDialogs();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].content, '原文\n入力中');
});

for (const mode of ['source', 'blocks']) test(`Ctrl+Enter saves the ${mode} editor once through the shared keyboard handler`, async () => {
  const h = await keyboardHarness();
  if (mode === 'blocks') h.runtime.setEditInputMode('blocks');
  const target = mode === 'blocks' ? h.element('docBlockEditor').querySelector('textarea') : h.source;
  target.value += ' 最後の一行'; h.runtime.refreshEditSessionDirtyState();
  const content = h.runtime.getCurrentEditContent();
  const event = key(target, { key: 'Enter' });
  h.runtime.handleWindowKeydown(event); await flushDialogs();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].content, content);
  assert.equal(event.defaultPrevented, true);
});

test('IME: candidate numbers and held keys cannot choose a destructive conflict action', async () => {
  const h = await keyboardHarness(), choices = [];
  h.runtime.resolveSaveConflictAction = value => choices.push(value);
  h.element('docSaveConflictDialog').classList.remove('is-hidden');
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    h.runtime.handleWindowKeydown(key(h.source, { key: '3', ctrlKey: false, ...options }));
  }
  h.runtime.handleWindowKeydown(key(h.source));
  assert.deepEqual(choices, []); assert.equal(h.writes.length, 0);
  h.runtime.handleWindowKeydown(key(h.source, { key: '2', ctrlKey: false }));
  assert.deepEqual(choices, ['2']);
});

test('IME: search keeps the committed query until composition finishes and resumes a cancelled pending search', async () => {
  const timers = new Map(), rendered = []; let timer = 0;
  const h = await keyboardHarness({ setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id) });
  h.runtime.renderFilteredDocs = () => rendered.push(h.runtime.getSearchQuery());
  const input = h.element('searchInput');
  const flush = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  input.value = '旅人'; h.runtime.handleSearchInput({});
  h.runtime.beginSearchComposition(); input.value = 'ものが'; h.runtime.handleSearchInput({ isComposing: true }); flush();
  assert.deepEqual(rendered, []); assert.equal(h.runtime.getSearchQuery(), '旅人');
  input.value = '物語'; h.runtime.endSearchComposition(); h.runtime.handleSearchInput({}); flush();
  assert.deepEqual(rendered, ['物語']);
  input.value = '小春'; h.runtime.handleSearchInput({}); h.runtime.beginSearchComposition();
  input.value = '小春に'; h.runtime.handleSearchInput({ isComposing: true });
  input.value = '小春'; h.runtime.endSearchComposition(); flush();
  assert.deepEqual(rendered, ['物語', '小春']);
  assert.equal(h.runtime.getCurrentEditContent(), '原文\n入力中');
  assert.deepEqual(h.writes, []);
});

for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
  test(`IME: choosing a candidate must not save a source draft (${JSON.stringify(composition)})`, async () => {
    const h = await keyboardHarness();
    const event = key(h.source, { key: 'Enter', ...composition });
    h.runtime.handleEditorSaveShortcut(event); await flushDialogs();
    assert.equal(h.writes.length, 0);
    assert.equal(event.defaultPrevented, false, 'the input method must receive the key');
    assert.equal(h.state.editHasUnsavedChanges, true);
    assert.equal(h.source.value, '原文\n入力中');
  });
}
