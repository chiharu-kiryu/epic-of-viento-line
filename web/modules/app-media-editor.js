import { t, onLanguageChange, translateMessage } from '../i18n/index.js';
import { MEDIA_MAX_BYTES, mediaKindForName, mediaMarkup } from '../../scripts/lib/media-format.mjs';
import { loadMediaAssets, uploadMediaFile, prepareDraftMedia } from './app-doc-service.js';
import { renderMedia } from './app-media-render.js';

export function setupMediaEditor(adapter) {
  const get = (id) => document.getElementById(id);
  const button = get('docMediaInsertBtn'), dialog = get('docMediaDialog');
  const picker = get('docMediaFileInput'), importer = get('docMediaImportBtn');
  const list = get('docMediaList'), search = get('docMediaSearch'), kind = get('docMediaKind');
  const message = get('docMediaMessage'), progress = get('docMediaProgress'), progressLabel = get('docMediaProgressLabel');
  const cancel = get('docMediaAbortBtn'), close = get('docMediaCloseBtn'), more = get('docMediaMoreBtn');
  const preview = get('docMediaPreview'), surface = document.querySelector('.doc-editor-surface');
  let assets = [], limit = 60, lastInput = null, context = null, aborter = null;
  let previewTimer = null, previewGeneration = 0, previewSignature = '', listGeneration = 0;
  let lastPreviewRequestAt = 0, previewPath = '';
  const fileSize = (bytes) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const status = (text, error = false) => { message.textContent = text; message.classList.toggle('is-error', error); };
  const editableInput = (node) => node?.tagName === 'TEXTAREA' && surface.contains(node);
  const capture = () => {
    if (editableInput(document.activeElement)) lastInput = document.activeElement;
    return adapter.getContext(lastInput);
  };
  const pausePreview = () => preview.querySelectorAll('audio, video').forEach((player) => player.pause());
  function showPreview(media) {
    const signature = JSON.stringify(media);
    preview.hidden = !adapter.isEditable() || media.length === 0;
    if (signature === previewSignature) return;
    previewSignature = signature;
    pausePreview();
    preview.replaceChildren();
    if (!media.length) return;
    const title = document.createElement('h3');
    title.dataset.i18n = '素材预览';
    title.textContent = t('素材预览');
    preview.appendChild(title);
    media.forEach((item) => preview.appendChild(renderMedia(item)));
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    const generation = ++previewGeneration;
    if (!adapter.isEditable()) { preview.hidden = true; pausePreview(); return; }
    if (adapter.isBusy()) return;
    const current = capture();
    if (current?.path !== previewPath) { previewPath = current?.path; showPreview([]); }
    if (!current || !/(?:asset:|\/asset-files\/|!?\[.*\]\(|\bsrc\b|媒体)/.test(current.content)) { showPreview([]); return; }
    previewTimer = setTimeout(async () => {
      try {
        lastPreviewRequestAt = Date.now();
        const result = await prepareDraftMedia(current.content, current.path, [], current.documentType);
        if (generation === previewGeneration && adapter.isEditable()) showPreview(result.media || []);
      } catch { /* Keep the last preview while a source is incomplete. */ }
    }, Math.max(350, 1000 - (Date.now() - lastPreviewRequestAt)));
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = assets.filter((asset) => (!kind.value || asset.kind === kind.value) && asset.name.toLocaleLowerCase().includes(query));
    list.replaceChildren();
    for (const asset of filtered.slice(0, limit)) {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'doc-media-choice';
      item.dataset.assetId = asset.id; item.title = asset.name;
      item.disabled = asset.status !== 'available' || !!aborter;
      if (asset.kind === 'image' && asset.status === 'available') {
        const thumbnail = document.createElement('img');
        thumbnail.src = asset.url; thumbnail.loading = 'lazy'; thumbnail.alt = '';
        item.appendChild(thumbnail);
      } else {
        const thumbnail = document.createElement('span');
        thumbnail.className = 'doc-media-kind-icon'; thumbnail.textContent = asset.kind === 'audio' ? '♫' : asset.kind === 'video' ? '▶' : '▧';
        item.appendChild(thumbnail);
      }
      const label = document.createElement('span'); label.textContent = asset.name; item.appendChild(label);
      const detail = document.createElement('small');
      detail.textContent = `${t({ image: '图片', video: '视频', audio: '音频' }[asset.kind])} · ${fileSize(asset.size)}${asset.status === 'available' ? '' : t(' · 离线或缺失')}`;
      item.appendChild(detail);
      item.addEventListener('click', () => void insertExisting(asset));
      list.appendChild(item);
    }
    more.hidden = filtered.length <= limit;
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.textContent = t('没有匹配的素材，可以从电脑导入。'); list.appendChild(empty);
    }
  }
  async function refreshList() {
    const generation = ++listGeneration;
    status(t('正在读取作品素材…'));
    try {
      const result = await loadMediaAssets();
      if (generation !== listGeneration) return;
      assets = result.assets || []; renderList(); status(t`作品中有 ${assets.length} 份图片、视频和音频。`);
    } catch (error) { if (generation === listGeneration) status(error.message, true); }
  }
  function setBusy(busy) {
    adapter.setBusy(busy);
    importer.disabled = busy; close.disabled = busy; search.disabled = busy; kind.disabled = busy;
    const importing = busy && !!aborter;
    picker.disabled = busy; cancel.hidden = !importing; progress.hidden = !importing; progressLabel.hidden = !importing;
    list.querySelectorAll('button').forEach((item) => { item.disabled = busy || assets.find((asset) => asset.id === item.dataset.assetId)?.status !== 'available'; });
  }
  async function insert(selected, signal) {
    const target = context;
    const checkDraft = () => {
      if (signal?.aborted) throw new DOMException(t('已取消导入'), 'AbortError');
      const current = target && adapter.getContext(target.input);
      if (!target || context !== target || !adapter.isEditable() || current?.path !== target.path
        || current.input !== target.input || current.content !== target.content || current.documentType !== target.documentType) {
        throw new Error(t('正在编辑的文档已变化，请重新选择插入位置。'));
      }
    };
    checkDraft();
    if (/\.(json|ya?ml)$/i.test(target.path)) {
      const result = await prepareDraftMedia(target.content, target.path, selected.map((asset) => asset.id), target.documentType, signal);
      checkDraft();
      adapter.replaceSource(result.content);
      showPreview(result.media || []);
    } else {
      adapter.insertText(target, `\n\n${selected.map(mediaMarkup).join('\n\n')}\n\n`);
    }
    adapter.changed();
  }
  async function insertExisting(asset) {
    if (adapter.isBusy()) return;
    setBusy(true);
    try { await insert([asset]); dialog.close(); adapter.status(t('已插入素材，保存文档后生效。')); }
    catch (error) { status(error.message, true); }
    finally { setBusy(false); schedulePreview(); }
  }
  async function importFiles(files, captured = null) {
    if (!adapter.isEditable() || adapter.isBusy() || !files.length) return;
    context = captured || context || capture();
    const invalid = files.find((file) => !mediaKindForName(file.name) || file.size > MEDIA_MAX_BYTES);
    if (invalid) {
      const text = !mediaKindForName(invalid.name) ? t`不支持 ${invalid.name} 的格式。` : t`${invalid.name} 超过 256 MB。`;
      status(text, true); adapter.status(text); return;
    }
    if (!dialog.open) dialog.showModal();
    ++listGeneration;
    aborter = new AbortController();
    setBusy(true);
    const imported = [];
    try {
      for (const [index, file] of files.entries()) {
        status(t`导入 ${index + 1}/${files.length}：${file.name}`);
        progress.value = 0;
        const result = await uploadMediaFile(file, { signal: aborter.signal, onProgress: (loaded, total) => {
          const percent = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
          progress.value = percent; progressLabel.textContent = `${percent}% · ${percent === 100 ? t('正在登记素材…') : fileSize(loaded)}`;
        } });
        imported.push(result.asset);
      }
      await insert(imported, aborter.signal);
      dialog.close();
      adapter.status(t`已插入 ${imported.length} 份素材，保存文档后生效。`);
    } catch (error) {
      const text = `${error.name === 'AbortError' ? t('已取消导入。') : error.message}${imported.length ? t` 已导入的 ${imported.length} 份素材可从作品素材列表重新选择。` : ''}`;
      status(text, error.name !== 'AbortError'); adapter.status(text);
      if (imported.length) { assets = (await loadMediaAssets().catch(() => ({ assets }))).assets; renderList(); }
    } finally { aborter = null; setBusy(false); schedulePreview(); picker.value = ''; }
  }
  surface.addEventListener('focusin', (event) => { if (editableInput(event.target)) lastInput = event.target; });
  surface.addEventListener('input', schedulePreview);
  surface.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length || !adapter.isEditable()) return;
    event.preventDefault(); void importFiles(files, capture());
  });
  surface.addEventListener('dragover', (event) => {
    if (adapter.isEditable() && Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); surface.classList.add('is-media-drop'); }
  });
  surface.addEventListener('dragleave', () => surface.classList.remove('is-media-drop'));
  surface.addEventListener('drop', (event) => {
    surface.classList.remove('is-media-drop');
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length || !adapter.isEditable()) return;
    event.preventDefault();
    if (editableInput(event.target)) lastInput = event.target;
    void importFiles(files, capture());
  });
  button.addEventListener('click', () => {
    if (!adapter.isEditable() || adapter.isBusy()) return;
    context = capture(); dialog.showModal(); void refreshList();
  });
  importer.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => void importFiles(Array.from(picker.files || [])));
  cancel.addEventListener('click', () => aborter?.abort());
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => { if (adapter.isBusy()) { event.preventDefault(); aborter?.abort(); } });
  dialog.addEventListener('close', () => { ++listGeneration; context = null; });
  search.addEventListener('input', () => { limit = 60; renderList(); });
  kind.addEventListener('change', () => { limit = 60; renderList(); });
  more.addEventListener('click', () => { limit += 60; renderList(); });
  onLanguageChange(() => {
    if (dialog.open) renderList();
    message.textContent = translateMessage(message.textContent);
  });
  return { refresh() { button.hidden = !adapter.isEditable(); button.disabled = adapter.isBusy(); schedulePreview(); } };
}
