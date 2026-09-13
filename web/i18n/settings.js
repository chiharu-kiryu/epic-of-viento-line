import { t, LANGUAGES, LANGUAGE_STORAGE_KEY, applyLanguage, isLanguage, getLanguage, onLanguageChange, translatePage, translateMessage } from './index.js';

// Desktop preferences live in the application's config directory. The editor
// has a new loopback origin each launch, so localStorage alone cannot persist it.
export async function setupSettings({ load, save, subscribe } = {}) {
  const nativeEditor = new URL(location.href).searchParams.get('desktop') === '1';
  if (!load && nativeEditor) {
    load = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/__desktop/preferences', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(t('无法读取语言设置'));
        return (await response.json()).language;
      } finally { clearTimeout(timer); }
    };
    save = (language) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); window.removeEventListener('viento-language-result', receive);
        controller.abort();
        error ? reject(error) : resolve();
      };
      const receive = (event) => {
        if (event.detail?.id !== id) return;
        finish(event.detail.ok === true ? null : new Error(event.detail.error || t('无法保存语言设置')));
      };
      const timer = setTimeout(() => finish(new DOMException(t('保存设置超时，请重试'), 'TimeoutError')), 10000);
      window.addEventListener('viento-language-result', receive);
      fetch('/__desktop/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, language }), signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error(t('无法保存语言设置')); })
        .catch(finish);
    });
    subscribe = (listener) => {
      const receive = (event) => listener(event.detail?.language);
      window.addEventListener('viento-language-changed', receive);
      return () => window.removeEventListener('viento-language-changed', receive);
    };
  }
  if (!load) {
    load = () => localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? 'zh-CN';
    save = (value) => localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
    subscribe = (listener) => {
      const receive = (event) => {
        if (event.storageArea !== localStorage || (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null)) return;
        // Storage events can arrive after another write. Read the current
        // preference, including removal/clear, instead of replaying stale data.
        try { listener(load()); } catch (error) { console.error(error); }
      };
      window.addEventListener('storage', receive);
      return () => window.removeEventListener('storage', receive);
    };
  }

  const dialog = document.createElement('dialog');
  dialog.id = 'settingsDialog'; dialog.className = 'viento-settings';
  dialog.setAttribute('aria-labelledby', 'settingsTitle');
  dialog.innerHTML = `<form method="dialog">
    <div class="viento-settings-heading"><h2 id="settingsTitle" data-i18n="设置"></h2><button type="submit" data-i18n="完成"></button></div>
    <label for="languageSelect" data-i18n="界面语言"></label>
    <select id="languageSelect" name="language"></select>
    <p data-i18n="切换后立即生效，并记住你的选择。"></p>
    <p data-i18n="语言设置仅保存在本机，正文和自定义字段保持原样。"></p>
    <p id="settingsStatus" role="status" aria-live="polite"></p>
  </form>`;
  document.body.appendChild(dialog);
  const select = dialog.querySelector('select');
  const status = dialog.querySelector('#settingsStatus');
  const done = dialog.querySelector('button');
  for (const item of LANGUAGES) {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; select.appendChild(option);
  }
  let pending = false;
  let initialError = false;
  let notificationVersion = 0;
  const receive = (value) => {
    if (!isLanguage(value)) return;
    notificationVersion++;
    initialError = false;
    applyLanguage(value);
  };
  const update = () => { translatePage(); select.value = getLanguage(); status.textContent = translateMessage(status.textContent); };
  onLanguageChange(update);
  let initialVersion = notificationVersion;
  try {
    // Subscribe before reading in every window, including the native library.
    // A notification received while awaiting a read/save is more recent than
    // the value captured by that operation and must not be rolled back.
    await subscribe?.(receive);
    initialVersion = notificationVersion;
    const value = await load();
    if (initialVersion === notificationVersion) {
      if (!isLanguage(value)) throw new Error(t('无法读取语言设置'));
      applyLanguage(value);
    }
  } catch (error) {
    if (initialVersion === notificationVersion) initialError = true;
    console.error(error);
  }
  update();
  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    status.textContent = initialError ? t('无法读取语言设置') : ''; dialog.showModal(); select.focus();
  });
  select.addEventListener('change', async () => {
    if (pending || !isLanguage(select.value)) return;
    const next = select.value;
    const saveVersion = notificationVersion;
    pending = true; select.disabled = true; done.disabled = true;
    status.textContent = t('正在保存设置…');
    try {
      await save(next);
      if (saveVersion === notificationVersion) applyLanguage(next);
      initialError = false; status.textContent = t('语言设置已保存');
    } catch (error) {
      select.value = getLanguage();
      status.textContent = error?.name === 'TimeoutError' ? t('保存设置超时，请重试') : t('无法保存语言设置');
      console.error(error);
    } finally { pending = false; select.value = getLanguage(); select.disabled = false; done.disabled = false; }
  });
  dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
}
