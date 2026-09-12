import { t, onLanguageChange } from '../i18n/index.js';
if (new URL(location.href).searchParams.get('desktop') === '1') {
  const button = document.createElement('button');
  button.className = 'doc-sidebar-toggle';
  button.type = 'button';
  button.textContent = t('作品库');
  button.title = t('返回作品库，保留当前编辑草稿');
  onLanguageChange(() => {
    button.textContent = t('作品库');
    button.title = t('返回作品库，保留当前编辑草稿');
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await fetch('/__desktop/library', { method: 'POST' });
      if (!response.ok) throw new Error(t('无法打开作品库'));
    } catch (error) { window.alert(error.message); }
    finally { button.disabled = false; }
  });
  document.querySelector('.topbar-identity')?.prepend(button);
}
