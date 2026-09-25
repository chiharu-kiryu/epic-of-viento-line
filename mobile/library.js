import { t, onLanguageChange, translatePage } from '../web/i18n/index.js';
import { translateDiagnostic } from '../web/i18n/diagnostics.js';
import { setupSettings } from '../web/i18n/settings.js';
import { nativeFailure } from './platform.mjs';

const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const status = document.getElementById('mobileStatus');
const form = document.getElementById('createWorkspace'), input = document.getElementById('workspaceName');
const list = document.getElementById('workspaces'), retry = document.getElementById('mobileRetry');
const importButton = document.getElementById('importWorkspace');
let works = [], busy = false, loaded = false, message = null;
let retryAction = refresh;
function notify(key, ...values) { message = { key, values }; render(); }
function showError(failure, retryOperation = refresh) {
  const error = nativeFailure(failure);
  message = { key: error.message, values: [], diagnostic: true };
  retryAction = retryOperation;
  retry.hidden = false;
  render();
}
function render() {
  translatePage();
  status.textContent = !message ? '' : message.diagnostic
    ? translateDiagnostic(message, message.key) : t(message.key, ...message.values);
  input.disabled = busy;
  form.querySelector('button').disabled = busy;
  importButton.disabled = busy;
  retry.disabled = busy;
  list.setAttribute('aria-busy', String(busy));
  document.getElementById('mobileEmpty').hidden = !loaded || works.length > 0;
  list.replaceChildren(...works.map((work) => {
    const row = document.createElement('div'); row.className = 'mobile-work-row';
    const button = document.createElement('button'); button.className = 'mobile-work';
    button.textContent = work.name; button.disabled = busy;
    button.addEventListener('click', () => { location.href = `/editor.html?mode=edit&workspace=${encodeURIComponent(work.id)}`; });
    const exportButton = document.createElement('button'); exportButton.className = 'mobile-work-export';
    exportButton.textContent = t('导出项目包'); exportButton.disabled = busy;
    exportButton.setAttribute('aria-label', t('导出“{0}”的项目包', work.name));
    exportButton.addEventListener('click', () => transfer('export', work));
    row.append(button, exportButton);
    return row;
  }));
}
async function refresh() {
  if (busy) return;
  busy = true; retry.hidden = true; message = null; render();
  try { works = await invoke('mobile_storage', { action: 'list' }); loaded = true; }
  catch (error) { showError(error); }
  finally { busy = false; render(); }
}
async function transfer(action, work) {
  if (busy) return;
  busy = true; retry.hidden = true;
  let transferred = false;
  notify(action === 'import' ? '请选择项目包，导入完成前请保持应用打开。' : '正在准备项目包，随后请选择保存位置。');
  try {
    const result = await invoke('mobile_archive', { action, workspaceId: work?.id });
    if (result.cancelled) { notify('已取消迁移。'); return; }
    transferred = true;
    if (action === 'import') {
      works = await invoke('mobile_storage', { action: 'list' }); loaded = true;
      notify('已导入“{0}”。', result.workspace.name);
    } else notify('“{0}”的项目包已导出。', work.name);
  } catch (error) { showError(error, transferred ? refresh : () => transfer(action, work)); }
  finally { busy = false; render(); }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy || !input.value.trim()) return;
  busy = true; retry.hidden = true; message = null; render();
  try {
    const work = await invoke('mobile_storage', { action: 'create', payload: { name: input.value.trim() } });
    location.href = `/editor.html?mode=edit&workspace=${encodeURIComponent(work.id)}`;
  } catch (error) { showError(error); }
  finally { busy = false; render(); }
});
retry.addEventListener('click', () => retryAction());
importButton.addEventListener('click', () => transfer('import'));
onLanguageChange(render);
await setupSettings();
await refresh();
