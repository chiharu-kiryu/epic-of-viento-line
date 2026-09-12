import { t, onLanguageChange, translateMessage } from '../i18n/index.js';
import { API_PATHS } from '../../scripts/lib/doc-api-contract.mjs';
import { requestExport, releaseExport } from './app-doc-service.js';

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
  const kind = () => options.querySelector('input[name="exportKind"]:checked').value;
  const discard = () => {
    if (job && !downloadStarted) void releaseExport(job.id).catch(() => {});
    job = null; download.hidden = true; download.removeAttribute('href'); save.hidden = true; downloadStarted = false;
  };
  function refresh() {
    byId('docExportDocumentOptions').hidden = kind() !== 'document';
    const reason = exportAvailability(context, kind());
    byId('docExportHint').textContent = reason || (kind() === 'workspace'
      ? t('包含全部已保存内容与素材，自动排除缓存、临时文件和本机路径配置。')
      : t('原始正文与引用素材一并打包。解压后即可阅读；视频保留原始格式。'));
    start.disabled = !!controller || !!reason || !!job;
    options.disabled = !!controller || nativePending;
    cancel.hidden = !controller || nativePending;
    close.disabled = nativePending;
  }
  function closeDialog() {
    if (nativePending) return;
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
    return new Promise((resolve, reject) => {
      const receive = (event) => {
        if (event.detail?.id !== id) return;
        cleanup();
        event.detail.ok ? resolve(event.detail) : reject(new Error(event.detail.error || t('无法保存导出文件')));
      };
      const cleanup = () => window.removeEventListener('viento-export-result', receive);
      window.addEventListener('viento-export-result', receive);
      fetch('/__desktop/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
        .then(async (response) => {
          if (!response.ok) throw new Error((await response.json()).error || t('无法打开保存窗口'));
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
    } catch (error) { message.textContent = error.message; }
    finally { nativePending = false; setBusy(false); save.disabled = false; refresh(); }
  }
  byId('docExportBtn')?.addEventListener('click', () => {
    context = getContext();
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
  download.addEventListener('click', () => { downloadStarted = true; message.textContent = t('下载已交给浏览器。请先解压整个文件，再打开正文。'); });
  save.addEventListener('click', () => { void saveNative(); });
  start.addEventListener('click', async () => {
    if (controller || exportAvailability(getContext(), kind())) return;
    const requestController = new AbortController(); controller = requestController;
    setBusy(true); refresh(); message.textContent = t('正在整理正文与素材并校验文件…');
    try {
      job = await requestExport({ kind: kind(), format: format.value, path: context.path, includeChildren: byId('docExportChildren').checked }, requestController.signal);
      if (requestController.signal.aborted || !dialog.open) { discard(); return; }
      message.textContent = t`已准备好 ${job.fileName}（${(job.bytes / 1024 ** 2).toFixed(1)} MB，${job.assetCount} 个素材）。`;
      if (native) save.hidden = false;
      else { download.href = `${API_PATHS.EXPORT}?id=${encodeURIComponent(job.id)}`; download.download = job.fileName; download.hidden = false; }
    } catch (error) {
      if (dialog.open) message.textContent = requestController.signal.aborted ? t('已取消导出，原始内容保留。') : t`导出失败：${error.message}`;
    } finally { controller = null; setBusy(false); refresh(); }
    if (native && job && dialog.open) await saveNative();
  });
}
