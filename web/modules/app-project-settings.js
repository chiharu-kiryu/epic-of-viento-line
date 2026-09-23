import { t, translatePage, onLanguageChange, translateMessage } from '../i18n/index.js';
import { requestProject } from './app-doc-service.js';
import { renderDocumentLayout } from './app-document-layout.js';
import { serializeSourceDraft } from './app-editor-draft.js';

export function setupProjectSettings({ getContext, applied, setBusy }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'projectSettingsDialog'; dialog.className = 'project-settings';
  dialog.setAttribute('aria-labelledby', 'projectSettingsTitle');
  dialog.innerHTML = `<header><div><h2 id="projectSettingsTitle" data-i18n="项目类型与模板"></h2><p id="projectSettingsName"></p></div><button type="button" id="projectSettingsClose" data-i18n="返回编辑器"></button></header>
    <p id="projectSettingsMessage" role="status" aria-live="polite"></p>
    <div class="project-settings-body"><p data-i18n="先定义文档类型与模板，再新建内容、关联故事和素材，最后导出整个项目。"></p>
    <div class="project-settings-grid"><aside><label for="projectTypeList" data-i18n="文档类型"></label><select id="projectTypeList" size="9"></select><button type="button" id="projectTypeAdd" data-i18n="新增类型"></button></aside>
    <form id="projectTypeForm"><fieldset id="projectTypeFields">
      <div class="project-type-properties"><label><span data-i18n="类型名称"></span><input id="projectTypeLabel" maxlength="120" required></label><label><span data-i18n="类型标识"></span><input id="projectTypeId" pattern="[a-z][a-z0-9_-]{0,63}" maxlength="64" required placeholder="species"></label>
      <label><span data-i18n="默认子目录"></span><input id="projectTypeDirectory" placeholder="species"></label><label><span data-i18n="解析方式"></span><select id="projectTypeProfile"><option value="structured" data-i18n="字段与段落"></option><option value="prose" data-i18n="叙事正文"></option></select></label></div>
      <p data-i18n="类型标识创建后固定。子目录相对于项目正文目录；已有文档的位置和归属保持原样。"></p>
      <label for="projectTemplateFormat" data-i18n="模板格式"></label><select id="projectTemplateFormat"><option value="md">Markdown</option><option value="txt">Text</option><option value="json">JSON</option><option value="yaml">YAML</option><option value="yml">YML</option></select>
      <label for="projectTemplateContent" data-i18n="模板正文"></label><textarea id="projectTemplateContent" rows="12" spellcheck="false"></textarea>
      <p data-i18n="标题决定默认分区；字段名自由填写。修改模板只影响之后新建的文档。"></p>
      <details><summary data-i18n="字段解析与展示规则"></summary><p data-i18n="规则作用于这个类型的所有文档。每行填写一个字段名，按名称精确匹配。"></p>
        <label><span data-i18n="作为标题的字段（可选）"></span><input id="projectTitleField" maxlength="120"></label>
        <div class="project-type-properties"><label><span data-i18n="叙事中仍需识别的字段"></span><textarea id="projectAllowedFields" rows="4"></textarea></label><label><span data-i18n="可包含子字段的长文本字段"></span><textarea id="projectMultilineFields" rows="4"></textarea></label><label><span data-i18n="结束长文本的字段"></span><textarea id="projectBoundaryFields" rows="4"></textarea></label></div>
        <p data-i18n="字段分组可重新安排展示顺序；未列出的内容仍会保留。"></p><div id="projectFieldGroups"></div><button type="button" id="projectGroupAdd" data-i18n="添加字段分组"></button>
      </details>
    </fieldset></form></div>
    <section id="projectTemplatePreviewPanel" hidden><h3 data-i18n="模板预览"></h3><div id="projectTemplatePreviewContent" class="project-template-preview"></div></section></div>
    <footer class="project-settings-actions"><button type="button" id="projectTypeCancel" data-i18n="取消新增" hidden></button><button type="button" id="projectTemplatePreview" data-i18n="预览解析结果"></button><button type="submit" form="projectTypeForm" id="projectTemplateSave" data-i18n="保存并应用"></button></footer>`;
  document.body.appendChild(dialog);
  const el = (id) => dialog.querySelector(`#${id}`);
  const message = el('projectSettingsMessage');
  let configuration, selected = '', returnType = '', original = '', busy = false, changed = false;
  const lines = (id) => el(id).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const payload = () => {
    const entry = configuration?.entries.find((entry) => entry.type.id === selected);
    const previous = entry?.type || {};
    const parserOptions = {
      allowedFieldKeys: lines('projectAllowedFields'), multilineFieldKeys: lines('projectMultilineFields'), boundaryFieldKeys: lines('projectBoundaryFields'),
    };
    if (el('projectTitleField').value.trim()) parserOptions.titleField = el('projectTitleField').value.trim();
    return { revision: configuration?.revision, create: !selected, type: { ...previous,
      id: el('projectTypeId').value.trim(), label: el('projectTypeLabel').value.trim(), directory: el('projectTypeDirectory').value.trim(), parserProfile: el('projectTypeProfile').value,
      parserOptions, fieldGroups: [...el('projectFieldGroups').children].map((row) => ({ title: row.querySelector('input').value.trim(), fields: row.querySelector('textarea').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) })),
    }, format: el('projectTemplateFormat').value, content: serializeSourceDraft(entry?.content || '', el('projectTemplateContent').value) };
  };
  const dirty = () => configuration && JSON.stringify(payload()) !== original;
  function updateActions() {
    const creating = Boolean(configuration && !selected);
    const unsaved = Boolean(dirty());
    dialog.dataset.dirty = String(unsaved);
    const cancel = el('projectTypeCancel');
    cancel.dataset.i18n = creating ? '取消新增' : '放弃修改';
    cancel.textContent = t(cancel.dataset.i18n);
    cancel.hidden = !creating && !unsaved;
    cancel.disabled = busy || !configuration;
    el('projectTypeAdd').disabled = busy || !configuration || creating;
  }
  const track = () => { updateActions(); el('projectTemplatePreviewPanel').hidden = true; };
  const canDiscard = () => !dirty() || window.confirm(t('类型或模板有未保存的修改，确定丢弃？'));
  function addGroup(group = { title: '', fields: [] }) {
    const row = document.createElement('div'); row.className = 'project-field-group';
    const name = document.createElement('input'); name.value = group.title; name.maxLength = 120; name.placeholder = t('分组名称'); name.setAttribute('aria-label', t('分组名称'));
    name.dataset.i18nPlaceholder = '分组名称'; name.dataset.i18nAriaLabel = '分组名称';
    const fields = document.createElement('textarea'); fields.rows = 3; fields.value = group.fields.join('\n'); fields.placeholder = t('每行一个字段名'); fields.setAttribute('aria-label', t('每行一个字段名'));
    fields.dataset.i18nPlaceholder = '每行一个字段名'; fields.dataset.i18nAriaLabel = '每行一个字段名';
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = t('移除分组'); remove.addEventListener('click', () => { row.remove(); track(); });
    remove.dataset.i18n = '移除分组';
    row.append(name, fields, remove); el('projectFieldGroups').appendChild(row);
  }
  function choose(id) {
    selected = id;
    const entry = configuration.entries.find((entry) => entry.type.id === id);
    if (entry) returnType = id;
    const type = entry?.type || { id: '', label: '', directory: '', parserProfile: 'structured' };
    el('projectTypeId').value = type.id; el('projectTypeId').readOnly = !!entry;
    el('projectTypeLabel').value = type.label; el('projectTypeDirectory').value = type.directory;
    el('projectTypeProfile').value = type.parserProfile; el('projectTemplateFormat').value = entry?.format || 'md';
    el('projectTemplateContent').value = entry?.content ?? '# 新建文档\n\n## 内容\n\n';
    el('projectTitleField').value = type.parserOptions?.titleField || '';
    for (const [field, key] of [['projectAllowedFields', 'allowedFieldKeys'], ['projectMultilineFields', 'multilineFieldKeys'], ['projectBoundaryFields', 'boundaryFieldKeys']]) el(field).value = (type.parserOptions?.[key] || (key === 'allowedFieldKeys' ? ['_header'] : [])).join('\n');
    el('projectFieldGroups').replaceChildren(); (type.fieldGroups || []).forEach(addGroup);
    el('projectTypeList').value = id;
    original = JSON.stringify(payload()); updateActions();
    dialog.querySelector('.project-settings-body').scrollTop = 0;
    el('projectTemplatePreviewPanel').hidden = true;
    message.textContent = entry?.problem || '';
  }
  function list() {
    el('projectTypeList').replaceChildren();
    for (const entry of configuration.entries) {
      const option = document.createElement('option'); option.value = entry.type.id; option.textContent = entry.type.label; el('projectTypeList').appendChild(option);
    }
    el('projectSettingsName').textContent = configuration.workspace.name + (configuration.workspace.example?.id ? ` · ${t('官方示范')}` : '');
  }
  async function run(action) {
    if (busy) return;
    busy = true; setBusy(true); dialog.setAttribute('aria-busy', 'true');
    el('projectTemplatePreview').disabled = true; el('projectTemplateSave').disabled = true;
    el('projectTypeFields').disabled = true; el('projectTypeList').disabled = true; el('projectSettingsClose').disabled = true; updateActions();
    message.textContent = t('正在处理项目配置…');
    try { await action(); }
    catch (error) { message.textContent = error.message || String(error); }
    finally { busy = false; setBusy(false); dialog.setAttribute('aria-busy', 'false'); el('projectTypeFields').disabled = !configuration; el('projectTypeList').disabled = !configuration; el('projectSettingsClose').disabled = false; el('projectTemplatePreview').disabled = !configuration; el('projectTemplateSave').disabled = !configuration; updateActions(); }
  }
  const showPreview = (preview) => { el('projectTemplatePreviewContent').replaceChildren(...renderDocumentLayout(preview)); el('projectTemplatePreviewPanel').hidden = false; el('projectTemplatePreviewPanel').scrollIntoView({ block: 'nearest' }); };
  async function open() {
    const context = getContext();
    if (!context.editable || !context.workspace?.configurable) { window.alert(t('请在已登记项目的编辑模式下管理模板。')); return; }
    if (context.dirty || context.creating || context.busy) { window.alert(t('请先保存或结束当前文档草稿，再调整项目模板。')); return; }
    configuration = undefined; selected = ''; returnType = ''; changed = false; updateActions(); dialog.showModal();
    await run(async () => { configuration = await requestProject(); changed = false; list(); choose(configuration.entries[0]?.type.id || ''); message.textContent = configuration.warnings.join('\n'); });
  }
  async function close() {
    if (busy || !canDiscard()) return;
    const finish = () => { configuration = undefined; dialog.dataset.dirty = 'false'; dialog.close(); };
    if (changed) await run(async () => { await applied(); changed = false; finish(); });
    else finish();
  }
  function cancelChanges() {
    if (busy || !configuration) return;
    const target = selected || returnType || configuration.entries[0]?.type.id;
    if (!target) { void close(); return; }
    if (!canDiscard()) return;
    choose(target);
    el('projectTypeList').focus();
  }
  document.getElementById('projectSettingsBtn')?.addEventListener('click', () => void open());
  const shortcut = document.createElement('button'); shortcut.type = 'button'; shortcut.dataset.i18n = '项目类型与模板'; shortcut.textContent = t('项目类型与模板');
  document.getElementById('settingsDialog')?.querySelector('form')?.appendChild(shortcut);
  shortcut.addEventListener('click', () => { document.getElementById('settingsDialog').close(); void open(); });
  el('projectSettingsClose').addEventListener('click', () => void close());
  el('projectTypeCancel').addEventListener('click', cancelChanges);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (configuration && !selected) cancelChanges(); else void close(); });
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (!busy && configuration) el('projectTypeForm').requestSubmit();
    }
  });
  el('projectTypeList').addEventListener('change', () => { if (busy || !configuration) return; if (canDiscard()) choose(el('projectTypeList').value); else el('projectTypeList').value = selected; });
  el('projectTypeAdd').addEventListener('click', () => { if (busy || !configuration || !selected) return; if (canDiscard()) { choose(''); el('projectTypeLabel').focus(); } });
  el('projectGroupAdd').addEventListener('click', () => { addGroup(); track(); });
  el('projectTypeForm').addEventListener('input', track);
  el('projectTypeForm').addEventListener('change', track);
  el('projectTemplatePreview').addEventListener('click', () => void run(async () => { showPreview(await requestProject('preview', payload())); message.textContent = t('解析通过，可以保存模板。'); }));
  el('projectTypeForm').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const value = payload();
      configuration = await requestProject('save', value); changed = true;
      list(); choose(value.type.id); showPreview(configuration.preview);
      message.textContent = configuration.indexWarning || t('已保存。新建文档将使用这份模板。');
    });
  });
  onLanguageChange(() => {
    translatePage(); message.textContent = translateMessage(message.textContent);
    if (configuration) el('projectSettingsName').textContent = configuration.workspace.name + (configuration.workspace.example?.id ? ` · ${t('官方示范')}` : '');
  });
  translatePage();
}
