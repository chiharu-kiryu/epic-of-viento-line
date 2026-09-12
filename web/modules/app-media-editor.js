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
  function showPreview(media) {
    const signature = JSON.stringify(media);
    preview.hidden = !adapter.isEditable() || media.length === 0;
    if (signature === previewSignature) return;
    previewSignature = signature;
    preview.replaceChildren();
    if (!media.length) return;
    const title = document.createElement('h3');
    title.textContent = '素材预览';
    preview.appendChild(title);
    media.forEach((item) => preview.appendChild(renderMedia(item)));
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    const generation = ++previewGeneration;
    if (!adapter.isEditable()) { preview.hidden = true; return; }
    if (adapter.isBusy()) return;
    const current = capture();
    if (current?.path !== previewPath) { previewPath = current?.path; showPreview([]); }
    if (!current || !/(?:asset:|\/asset-files\/|!?\[.*\]\(|\bsrc\b|媒体)/.test(current.content)) { showPreview([]); return; }
    previewTimer = setTimeout(async () => {
      try {
        lastPreviewRequestAt = Date.now();
        const result = await prepareDraftMedia(current.content, current.path);
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
        thumbnail.className = 'doc-media-video-icon'; thumbnail.textContent = asset.kind === 'video' ? '▶' : '▧';
        item.appendChild(thumbnail);
      }
      const label = document.createElement('span'); label.textContent = asset.name; item.appendChild(label);
      const detail = document.createElement('small');
      detail.textContent = `${asset.kind === 'video' ? '视频' : '图片'} · ${fileSize(asset.size)}${asset.status === 'available' ? '' : ' · 离线或缺失'}`;
      item.appendChild(detail);
      item.addEventListener('click', () => void insertExisting(asset));
      list.appendChild(item);
    }
    more.hidden = filtered.length <= limit;
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.textContent = '没有匹配的素材，可以从电脑导入。'; list.appendChild(empty);
    }
  }
  async function refreshList() {
    const generation = ++listGeneration;
    status('正在读取作品素材…');
    try {
      const result = await loadMediaAssets();
      if (generation !== listGeneration) return;
      assets = result.assets || []; renderList(); status(`作品中有 ${assets.length} 份图片和视频。`);
    } catch (error) { if (generation === listGeneration) status(error.message, true); }
  }
  function setBusy(busy) {
    adapter.setBusy(busy);
    importer.disabled = busy; close.disabled = busy; search.disabled = busy; kind.disabled = busy;
    const importing = busy && !!aborter;
    picker.disabled = busy; cancel.hidden = !importing; progress.hidden = !importing; progressLabel.hidden = !importing;
    list.querySelectorAll('button').forEach((item) => { item.disabled = busy || assets.find((asset) => asset.id === item.dataset.assetId)?.status !== 'available'; });
  }
  async function insert(selected) {
    if (!context || !adapter.isEditable() || adapter.getContext(context.input)?.path !== context.path) throw new Error('正在编辑的文档已变化，请重新选择插入位置。');
    if (/\.(json|ya?ml)$/i.test(context.path)) {
      const result = await prepareDraftMedia(context.content, context.path, selected.map((asset) => asset.id));
      adapter.replaceSource(result.content);
      showPreview(result.media || []);
    } else {
      adapter.insertText(context, `\n\n${selected.map(mediaMarkup).join('\n\n')}\n\n`);
    }
    adapter.changed();
  }
  async function insertExisting(asset) {
    if (adapter.isBusy()) return;
    setBusy(true);
    try { await insert([asset]); dialog.close(); adapter.status('已插入素材，保存文档后生效。'); }
    catch (error) { status(error.message, true); }
    finally { setBusy(false); schedulePreview(); }
  }
  async function importFiles(files, captured = null) {
    if (!adapter.isEditable() || adapter.isBusy() || !files.length) return;
    context = captured || context || capture();
    const invalid = files.find((file) => !mediaKindForName(file.name) || file.size > MEDIA_MAX_BYTES);
    if (invalid) {
      const text = !mediaKindForName(invalid.name) ? `不支持 ${invalid.name} 的格式。` : `${invalid.name} 超过 256 MB。`;
      status(text, true); adapter.status(text); return;
    }
    if (!dialog.open) dialog.showModal();
    ++listGeneration;
    aborter = new AbortController();
    setBusy(true);
    const imported = [];
    try {
      for (const [index, file] of files.entries()) {
        status(`导入 ${index + 1}/${files.length}：${file.name}`);
        progress.value = 0;
        const result = await uploadMediaFile(file, { signal: aborter.signal, onProgress: (loaded, total) => {
          const percent = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
          progress.value = percent; progressLabel.textContent = `${percent}% · ${percent === 100 ? '正在登记素材…' : fileSize(loaded)}`;
        } });
        imported.push(result.asset);
      }
      await insert(imported);
      dialog.close();
      adapter.status(`已插入 ${imported.length} 份素材，保存文档后生效。`);
    } catch (error) {
      const text = `${error.name === 'AbortError' ? '已取消导入。' : error.message}${imported.length ? ` 已导入的 ${imported.length} 份素材可从作品素材列表重新选择。` : ''}`;
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
  return { refresh() { button.hidden = !adapter.isEditable(); button.disabled = adapter.isBusy(); schedulePreview(); } };
}
