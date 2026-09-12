import { t, getLanguage, applyLanguage, onLanguageChange, translateMessage } from './i18n/index.js';
import { setupSettings } from './i18n/settings.js';
const byId = (id) => document.getElementById(id);
const status = byId('status');
const invoke = window.__TAURI__?.core?.invoke;
let busy = false;
let currentLibrary;

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  document.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  byId('workspaces').setAttribute('aria-busy', String(value));
}

function makeButton(label, action, className = '') {
  const button = document.createElement('button');
  button.textContent = label;
  button.type = 'button';
  button.className = className;
  button.disabled = busy;
  button.addEventListener('click', action);
  return button;
}

async function refresh() {
  currentLibrary = await invoke('library_state');
  renderLibrary();
}

function renderLibrary() {
  const library = currentLibrary;
  if (!library) return;
  byId('appVersion').textContent = library.version;
  document.title = t`Viento Studio ${library.version} · 作品库`;
  const list = byId('workspaces');
  list.replaceChildren();
  byId('count').textContent = t`${library.recent.length} 个作品库`;
  byId('emptyState').hidden = library.recent.length !== 0;
  byId('activeSession').hidden = !library.active;
  byId('activeName').textContent = library.active ? t`正在编辑：${library.active.name}` : '';
  for (const item of library.recent) {
    const row = document.createElement('article');
    row.className = 'workspace';
    const copy = document.createElement('div');
    copy.className = 'workspace-copy';
    const title = document.createElement('h3'); title.textContent = item.name;
    if (library.examples?.includes(item.path)) {
      const badge = document.createElement('small'); badge.className = 'example-badge'; badge.textContent = t('官方示范'); title.appendChild(badge);
    }
    const path = document.createElement('p'); path.className = 'workspace-path'; path.textContent = item.path; path.title = item.path;
    const time = document.createElement('p'); time.className = 'workspace-time';
    time.textContent = t`上次打开 ${new Date(item.lastOpened).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' })}`;
    copy.append(title, path, time);
    const actions = document.createElement('div'); actions.className = 'workspace-actions';
    const current = library.active?.path === item.path;
    actions.append(
      makeButton(t('文件夹'), () => run(t('正在打开文件夹…'), () => invoke('reveal_workspace', { path: item.path }))),
      makeButton(t('导出备份'), () => run(t('正在导出并校验已保存的内容…'), async () => {
        const output = await invoke('backup_workspace', { path: item.path });
        return output ? t`备份已保存到 ${output}` : t('已取消导出');
      })),
      makeButton(current ? t('继续编辑') : t('打开'), () => run(t('正在打开作品库并准备预览…'), () => current ? invoke('resume_editor') : invoke('launch_workspace', { path: item.path })), 'open'),
    );
    row.append(copy, actions); list.append(row);
  }
}

async function run(message, action) {
  if (busy) return;
  setBusy(true); setStatus(message);
  try {
    const result = await action();
    await refresh();
    setStatus(typeof result === 'string' ? result : t('作品库已准备好。'));
  } catch (error) { setStatus(String(error?.message || error), true); }
  finally { setBusy(false); }
}

async function openChosen(command, args = {}) {
  const workspace = await invoke(command, args);
  if (!workspace) return t('已取消');
  await refresh();
  setStatus(t('正在打开作品库并准备预览…'));
  await invoke('launch_workspace', { path: workspace.path });
}

byId('createBtn').addEventListener('click', () => { byId('createDialog').showModal(); if (!byId('workspaceName').dataset.edited) byId('workspaceName').value = t('我的作品库'); byId('workspaceName').select(); });
byId('workspaceName').addEventListener('input', () => { byId('workspaceName').dataset.edited = 'true'; });
byId('cancelCreateBtn').addEventListener('click', () => byId('createDialog').close());
byId('createForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = byId('workspaceName').value.trim();
  if (!name) return;
  byId('createDialog').close();
  void run(t('正在创建作品库…'), () => openChosen('new_workspace', { name }));
});
byId('openBtn').addEventListener('click', () => run(t('请选择作品库文件夹…'), () => openChosen('choose_workspace')));
byId('importBtn').addEventListener('click', () => run(t('正在导入迁移包并逐文件校验…'), () => openChosen('restore_workspace')));
byId('resumeBtn').addEventListener('click', () => run(t('正在返回编辑器…'), () => invoke('resume_editor')));
byId('closeEditorBtn').addEventListener('click', () => run(t('请在编辑窗口确认关闭…'), () => invoke('close_editor')));

await setupSettings(invoke ? { load: () => invoke('get_language'), save: (language) => invoke('set_language', { language }) } : {});
onLanguageChange(() => {
  renderLibrary();
  status.textContent = translateMessage(status.textContent);
});

if (invoke) {
  await window.__TAURI__.event.listen('language-changed', (event) => applyLanguage(event.payload));
  await window.__TAURI__.event.listen('library-changed', () => refresh().catch((error) => setStatus(String(error), true)));
  await window.__TAURI__.event.listen('library-error', (event) => setStatus(event.payload, true));
  await run(t('正在读取作品库…'), () => Promise.resolve());
} else {
  setBusy(true);
  document.body.classList.remove('busy');
  byId('emptyState').hidden = false;
  setStatus(t('请从 Viento Studio 桌面应用打开作品库。'));
}
