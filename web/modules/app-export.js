import { t, getLanguage, onLanguageChange, translateMessage, asUiMessage } from '../i18n/index.js';
import { API_PATHS } from '../../scripts/lib/doc-api-contract.mjs';
import { requestExport, checkExport, releaseExport } from './app-doc-service.js';

export function exportAvailability(context, kind) {
  if (context.busy) return t('正在保存或更新内容，请完成后再导出。');
  if (context.dirty || context.creating) return t('当前有未保存的草稿，请先保存，再导出。');
  if (kind === 'document' && !context.path) return t('请先选择一份正文文档，或改为导出完整项目包。');
  return '';
}

export function setupExport({ getContext, setBusy }) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId('docExportDialog');
  if (!dialog) return;
  const options = byId('docExportOptions'), format = byId('docExportFormat');
  const start = byId('docExportStartBtn'), close = byId('docExportCloseBtn');
  const cancel = byId('docExportCancelBtn'), message = byId('docExportMessage');
  const download = byId('docExportDownload'), save = byId('docExportSaveBtn');
  const native = new URL(location.href).searchParams.get('desktop') === '1';
  let controller, job, context, nativePending = false, downloadStarted = false;
  let session = 0;
  const kind = () => options.querySelector('input[name="exportKind"]:checked').value;
  const discard = () => {
    if (job && !downloadStarted) void releaseExport(job.id).catch(() => {});
    job = null; download.hidden = true; save.hidden = true; downloadStarted = false;
  };
  function refresh() {
    byId('docExportDocumentOptions').hidden = kind() !== 'document';
    const reason = exportAvailability(context, kind());
    byId('docExportHint').textContent = reason || (kind() === 'workspace'
      ? t('包含全部已保存内容与素材，自动排除缓存、临时文件和本机路径配置。')
      : t('原始正文与引用素材一并打包。解压后即可阅读；音视频保留原始格式。'));
    start.disabled = !!controller || nativePending || !!reason || !!job;
    options.disabled = !!controller || nativePending;
    download.disabled = !!controller || nativePending || !job;
    cancel.hidden = !controller || nativePending;
    close.disabled = nativePending;
  }
  function closeDialog() {
    if (nativePending) return;
    session += 1;
    controller?.abort();
    discard();
    dialog.close();
  }
  onLanguageChange(() => {
    if (!context) return;
    refresh();
    byId('docExportContext').textContent = context.title ? t`当前文档：${context.title}` : t('导出当前作品');
    message.textContent = translateMessage(message.textContent);
  });
  function nativeSave() {
    const id = job.id;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const receive = (event) => {
        // The same prepared ZIP can be saved again after a transport failure.
        // A late result belongs to that earlier attempt, not the current picker.
        if (event.detail?.id !== id || event.detail?.requestId !== requestId) return;
        cleanup();
        event.detail.ok ? resolve(event.detail) : reject(new Error(event.detail.error || t('无法保存导出文件')));
      };
      const cleanup = () => window.removeEventListener('viento-export-result', receive);
      window.addEventListener('viento-export-result', receive);
      fetch('/__desktop/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, requestId }) })
        .then(async (response) => {
          if (!response.ok) {
            const error = new Error((await response.json()).error || t('无法打开保存窗口'));
            error.status = response.status;
            throw error;
          }
        }).catch((error) => { cleanup(); reject(error); });
    });
  }
  async function saveNative() {
    if (!job || nativePending) return;
    nativePending = true; setBusy(true); save.disabled = true; refresh();
    message.textContent = t('请选择导出文件的保存位置…');
    try {
      const result = await nativeSave();
      if (result.cancelled) message.textContent = t('已取消保存，可以重新选择位置。');
      else { message.textContent = t`已保存到 ${result.path}`; discard(); }
    } catch (error) {
      if (error.status === 410) {
        discard();
        message.textContent = t('导出文件已过期，请重新导出');
      } else message.textContent = error.message;
    }
    finally { nativePending = false; setBusy(false); save.disabled = false; refresh(); }
  }
  async function saveBrowser() {
    if (!job || controller || nativePending) return;
    const prepared = job, requestSession = session;
    const requestController = new AbortController(); controller = requestController;
    setBusy(true); refresh(); message.textContent = t('正在检查导出文件…');
    try {
      await checkExport(prepared.id, requestController.signal);
      if (requestSession !== session || job !== prepared || !dialog.open) return;
      requestController.signal.throwIfAborted();
      const link = document.createElement('a');
      link.href = `${API_PATHS.EXPORT}?id=${encodeURIComponent(prepared.id)}`;
      link.download = prepared.fileName; link.hidden = true; dialog.append(link);
      try { link.click(); } finally { link.remove(); }
      downloadStarted = true;
      message.textContent = t('下载已交给浏览器。请先解压整个文件，再打开正文。');
    } catch (error) {
      if (requestSession !== session || job !== prepared || !dialog.open) return;
      if (requestController.signal.aborted) message.textContent = t('已取消下载，可以重试。');
      else if (error.status === 410) {
        discard(); message.textContent = t('导出文件已过期，请重新导出');
      } else message.textContent = t`下载失败：${asUiMessage(error.message)}`;
    } finally { controller = null; setBusy(false); refresh(); }
  }
  byId('docExportBtn')?.addEventListener('click', () => {
    if (nativePending) return;
    const current = getContext();
    if (current.busy && !controller) { window.alert(exportAvailability(current, kind())); return; }
    // An aborted request may still be settling when this window is reopened.
    // Track its busy state through controller, never through the new snapshot.
    context = { ...current, busy: false };
    session += 1;
    discard();
    if (!context.path) options.querySelector('input[value="workspace"]').checked = true;
    byId('docExportContext').textContent = context.title ? t`当前文档：${context.title}` : t('导出当前作品');
    message.textContent = '';
    refresh(); dialog.showModal();
  });
  options.addEventListener('change', () => { discard(); message.textContent = ''; refresh(); });
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
  cancel.addEventListener('click', () => controller?.abort());
  download.addEventListener('click', () => { void saveBrowser(); });
  save.addEventListener('click', () => { void saveNative(); });
  start.addEventListener('click', async () => {
    if (controller || nativePending || job || exportAvailability(getContext(), kind())) return;
    const requestSession = session;
    const requestController = new AbortController(); controller = requestController;
    setBusy(true); refresh(); message.textContent = t('正在整理正文与素材并校验文件…');
    try {
      const prepared = await requestExport({ kind: kind(), format: format.value, path: context.path, language: getLanguage(), includeChildren: byId('docExportChildren').checked }, requestController.signal);
      if (requestController.signal.aborted || requestSession !== session || !dialog.open) {
        void releaseExport(prepared.id).catch(() => {}); return;
      }
      job = prepared;
      message.textContent = t`已准备好 ${job.fileName}（${(job.bytes / 1024 ** 2).toFixed(1)} MB，${job.assetCount} 个素材）。`;
      if (native) save.hidden = false;
      else download.hidden = false;
    } catch (error) {
      if (requestSession === session && dialog.open) message.textContent = requestController.signal.aborted ? t('已取消导出，原始内容保留。') : t`导出失败：${asUiMessage(error.message)}`;
    } finally { controller = null; setBusy(false); refresh(); }
    if (native && job && dialog.open) await saveNative();
  });
}
