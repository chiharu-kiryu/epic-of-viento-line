import { t } from '../i18n/index.js';
import { fieldValueValid, serializeFieldDraft } from './app-field-draft.js';

export function createFieldEditor({ document, element, changed, translate = t }) {
  const t = translate;
  let source = '', model = null, rows = [], groups = [], busy = false, composing = false;
  const make = (tag, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const toolbar = make('div', 'doc-field-toolbar');
  const search = make('input', 'doc-field-search'); search.type = 'search';
  const filterLabel = make('label', 'doc-field-modified-filter');
  const onlyChanged = make('input'); onlyChanged.type = 'checkbox';
  const filterText = make('span'); filterLabel.appendChild(onlyChanged); filterLabel.appendChild(filterText);
  const count = make('span', 'doc-field-count'); count.setAttribute('aria-live', 'polite');
  toolbar.appendChild(search); toolbar.appendChild(filterLabel); toolbar.appendChild(count);
  const hint = make('p', 'doc-field-hint'), list = make('div', 'doc-field-groups'), empty = make('p', 'doc-field-empty');
  element.replaceChildren(toolbar, hint, list, empty);
  const values = () => rows.map(row => row.input.value);
  const modified = row => row.input.value !== row.baseline;
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows) {
      row.node.hidden = (onlyChanged.checked && !modified(row))
        || ![row.field.group, row.field.label, row.input.value].join(' ').toLocaleLowerCase().includes(query);
      if (!row.node.hidden) visible++;
    }
    for (const group of groups) group.node.hidden = !group.rows.some(row => !row.node.hidden);
    count.textContent = t`显示 ${visible} / ${rows.length} 个字段`;
    empty.hidden = visible > 0;
    empty.textContent = rows.length ? t('没有匹配的字段。') : model?.format === 'json' || model?.format === 'yaml'
      ? t('暂无可编辑字段。请在源码中添加对象字段或列表项。') : t('暂无可编辑字段。可以在源码中添加“字段名：值”，或使用分段编辑。');
  }
  function refreshRow(row) {
    if (row.field.kind === 'string') row.input.rows = Math.min(6, Math.max(1, row.input.value.split('\n').length));
    row.node.classList.toggle('is-modified', modified(row));
    const valid = fieldValueValid(row.field, row.input.value);
    row.input.setAttribute('aria-invalid', String(!valid));
    row.error.hidden = valid;
    row.error.textContent = valid ? '' : t('请输入有效数值，例如 12、-0.5 或 1e3。');
    row.reset.disabled = busy || !modified(row);
  }
  function refreshLanguage() {
    search.placeholder = t('筛选字段名或值'); search.setAttribute('aria-label', t('筛选字段名或值'));
    filterText.textContent = t('只看已修改');
    hint.textContent = t('直接修改右侧的值，保存后生效。未列出的正文保持原样。')
      + (model?.omitted ? ' ' + t('复杂引用、空值与空集合请在源码中编辑。') : '');
    for (const group of groups) group.title.textContent = group.name || t('字段');
    for (const row of rows) {
      row.kind.textContent = t({ string: '文本', number: '数值', boolean: '开关' }[row.field.kind]);
      row.reset.textContent = t('恢复'); row.reset.title = t('恢复此字段的原值');
      row.reset.setAttribute('aria-label', t`恢复字段：${row.field.label}`);
      for (const option of row.input.querySelectorAll('option')) option.textContent = option.value === 'true' ? t('是') : t('否');
      refreshRow(row);
    }
    filter();
  }
  function load(nextSource, nextModel) {
    source = nextSource; model = nextModel; rows = []; groups = []; composing = false;
    search.value = ''; onlyChanged.checked = false; list.replaceChildren();
    const byName = new Map();
    model.fields.forEach((field, index) => {
      let group = byName.get(field.group);
      if (!group) {
        const node = make('details', 'doc-field-group'), title = make('summary'), table = make('div', 'doc-field-table');
        node.open = true; node.appendChild(title); node.appendChild(table); list.appendChild(node);
        group = { name: field.group, node, title, table, rows: [] }; groups.push(group); byName.set(field.group, group);
      }
      const node = make('div', 'doc-field-row'), label = make('label', 'doc-field-label', field.label);
      const kind = make('small', 'doc-field-kind'), cell = make('div', 'doc-field-cell');
      const input = make(field.kind === 'boolean' ? 'select' : field.kind === 'number' ? 'input' : 'textarea', 'doc-field-input');
      input.id = `docFieldValue-${index}`; input.dataset.fieldIndex = String(index);
      input.setAttribute('aria-label', [field.group, field.label].filter(Boolean).join(' / '));
      input.setAttribute('aria-describedby', `docFieldError-${index}`);
      label.setAttribute('for', input.id); label.appendChild(kind);
      if (field.kind === 'boolean') {
        for (const value of ['true', 'false']) { const option = make('option'); option.value = value; input.appendChild(option); }
      } else if (field.kind === 'number') { input.type = 'text'; input.inputMode = 'decimal'; }
      else { input.rows = Math.min(6, Math.max(1, field.value.split('\n').length)); input.spellcheck = false; }
      input.value = field.value;
      const reset = make('button', 'doc-btn doc-btn-ghost doc-field-reset'); reset.type = 'button';
      const error = make('span', 'doc-field-error'); error.id = `docFieldError-${index}`; error.setAttribute('aria-live', 'polite');
      cell.appendChild(input); cell.appendChild(reset); cell.appendChild(error); node.appendChild(label); node.appendChild(cell); group.table.appendChild(node);
      const row = { field, node, input, kind, reset, error, baseline: field.value }; rows.push(row); group.rows.push(row);
      const update = () => { refreshRow(row); changed(); };
      input.addEventListener('input', update); input.addEventListener('change', () => { update(); filter(); });
      reset.addEventListener('click', () => { if (busy) return; input.value = row.baseline; update(); filter(); (node.hidden ? search : input).focus(); });
    });
    refreshLanguage(); setBusy(busy);
  }
  function setBusy(value) {
    busy = value;
    for (const row of rows) {
      row.input.readOnly = busy; row.input.disabled = busy && row.field.kind === 'boolean'; refreshRow(row);
    }
  }
  function validate() {
    const invalid = rows.find(row => !fieldValueValid(row.field, row.input.value));
    if (!invalid) return true;
    search.value = ''; onlyChanged.checked = false; filter();
    const group = groups.find(group => group.rows.includes(invalid)); group.node.open = true;
    refreshRow(invalid); invalid.input.focus(); return false;
  }
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; filter(); });
  search.addEventListener('input', event => { if (!composing && !event.isComposing) filter(); });
  onlyChanged.addEventListener('change', filter);
  return { load, setBusy, validate, refreshLanguage,
    focus: () => { (rows[0]?.input || search).focus(); },
    refreshValues: () => { rows.forEach(refreshRow); },
    content: () => model ? serializeFieldDraft(source, model, values()) : source,
    commit: () => { rows.forEach(row => { row.baseline = row.input.value; refreshRow(row); }); filter(); },
    textInputs: () => rows.filter(row => row.field.kind === 'string').map(row => row.input),
    isMediaReference: input => rows.find(row => row.input === input)?.field.mediaReference || false,
  };
}
