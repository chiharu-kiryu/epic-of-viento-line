import { configureRequestTransport } from '../web/modules/app-services.js';
import { t, onLanguageChange } from '../web/i18n/index.js';
import { createMobilePlatform } from './platform.mjs';
import { createDraftStorage } from './drafts.mjs';

const workspaceId = new URL(location.href).searchParams.get('workspace');
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const back = document.createElement('button');
back.className = 'doc-sidebar-toggle'; back.type = 'button';
back.textContent = t('作品库');
onLanguageChange(() => { back.textContent = t('作品库'); });
document.querySelector('.topbar-identity').prepend(back);
const notice = document.createElement('p'); notice.className = 'mobile-draft-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
document.body.prepend(notice);
let noticeMessage = '';
const notify = (message) => { noticeMessage = message; notice.textContent = t(message); notice.hidden = false; };
onLanguageChange(() => { if (noticeMessage) notice.textContent = t(noticeMessage); });
let editor, persistence = true;
const drafts = createDraftStorage(localStorage, workspaceId);
const retain = (draft) => {
  if (!persistence) return true;
  try { drafts.save(draft); return true; }
  catch { notify('无法保留恢复草稿，请尽快保存文档。'); return false; }
};
back.addEventListener('click', () => {
  if (editor?.isBusy()) { notify('正在保存或更新内容，请完成后再返回作品库。'); return; }
  if (!retain(editor?.captureDraft() || null)) return;
  // Browsers may still ask about leaving a dirty document. The recovery copy
  // is already durable; no fabricated click or automatic confirmation is used.
  location.href = '/';
});

try {
  const pending = drafts.load();
  configureRequestTransport(createMobilePlatform({ invoke, workspaceId }).request);
  const { initApp } = await import('../web/modules/app-runtime.js');
  editor = await initApp({ onDraftChange: retain, features: { project: false, export: false, media: false } });
  if (pending) {
    persistence = false;
    const restored = await editor.restoreDraft(pending);
    if (!restored) throw new Error(t('无法自动恢复草稿，原草稿仍保留，请返回作品库重试。'));
    persistence = true;
    retain(editor.captureDraft());
    notify('已恢复上次的编辑内容。');
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) retain(editor.captureDraft()); });
  window.addEventListener('pagehide', () => retain(editor.captureDraft()));
} catch (error) {
  persistence = false;
  notify(error.message || '无法打开作品库');
  // Avoid editing over an unreadable recovery record. Keep the library return
  // available; the stored draft is left untouched for a later retry.
  document.getElementById('workspaceShell')?.setAttribute('inert', '');
  // Place the only exit outside the disabled editor on recovery failure.
  notice.after(back);
}
