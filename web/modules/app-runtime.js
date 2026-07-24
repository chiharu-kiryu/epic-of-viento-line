import {
  appState as state,
  domElements,
  DATA_INDEX_URL,
  DOC_CAPABILITIES_URL,
  DOC_API_URL,
  DOC_REBUILD_URL,
  CATEGORY_LABELS,
  CATEGORY_TAG,
  CATEGORY_ORDER,
  ASSET_BASE_URL,
  EDITABLE_SOURCE_PREFIXES,
  APP_ERROR_MESSAGES,
} from './app-state.js';
import {
  getHeroDisplayDocs,
  getVisibleDocs,
  getSearchIndex,
  getHeroImagesForDisplay,
  createDetailsGroup,
  renderTabs,
  markActiveItem,
  formatTime,
  groupDocs,
  createDocButton,
  resetDocListButtonCache,
  getRenderedDocListButtons,
  getDocListButtonCacheVersion,
  getDocListButtonMeta,
  setDocListButtonMeta,
  getDisplayCategory,
  toDisplayValue,
} from './app-helpers.js';
import { renderHeroBanner, buildCommonCards, getHeroCardsByCategory } from './app-render.js';
import { renderStructuredBlocks, hasRenderableToken } from './app-structured.js';

const {
  statusEl,
  listEl,
  searchInput,
  categoryTabsEl,
  searchClearEl,
  titleEl,
  subtitleEl,
  typeChipEl,
  groupChipEl,
  pathChipEl,
  metaEl,
  sectionEl,
  contentEl,
  galleryEl,
  editActionsEl,
  editCreateBtnEl,
  editBtnEl,
  editSaveBtnEl,
  editCancelBtnEl,
  editRebuildBtnEl,
  editPathEl,
  editDirtyIndicatorEl,
  editModeBarEl,
  editSourceModeBtnEl,
  editBlockModeBtnEl,
  editBlockEditorEl,
  createPathWrapEl,
  createPathInputEl,
  editStatusEl,
  editEditorEl,
  saveConflictDialogEl,
  saveConflictDialogTitleEl,
  saveConflictDialogMessageEl,
  saveConflictDialogWarningEl,
  saveConflictReloadBtnEl,
  saveConflictKeepBtnEl,
  saveConflictForceBtnEl,
  saveConflictCancelBtnEl,
  modeSwitchEl,
  modeBrowseBtnEl,
  modeEditBtnEl,
  modeStateEl,
  editPanelEl,
  docEditorWrapEl,
  leftTotalStatEl,
  leftVisibleStatEl,
  leftLegendBodyEl,
} = domElements;

const REBUILD_TEXT = '重建索引';
const SEARCH_INPUT_DEBOUNCE_MS = 180;
const LIST_RENDER_BATCH_SIZE = 120;
const CATEGORY_ORDER_INDEX = new Map(
  CATEGORY_ORDER.map((category, index) => [category, index]),
);
const MODE_LOCAL_STORAGE_KEY = 'doc-site-mode';
const DEFAULT_DOC_MODE = 'browse';
let rebuildProgressTimer = null;
let rebuildProgressStart = 0;
let searchDebounceTimer = null;
let lastSearchQuery = '';
let listRenderToken = 0;
let cachedTabCounts = null;
let blockDraftSourcePath = '';
let editSessionVersion = '';
let saveConflictResolver = null;
let renderedDocRef = null;
let cachedListRenderState = {
  filtered: null,
  activeTab: '',
  groups: null,
};
let cachedEditPermissionSyncState = {
  showGranularEditState: false,
  cacheVersion: -1,
  mode: '',
  backendAvailable: false,
};
const cachedListGroups = {
  source: null,
  activeTab: '',
  filtered: null,
  groups: null,
};
let cachedGroupedDocs = new WeakMap();
let editSessionBaselineContent = '';
const docByPathCache = new Map();
const docBySourcePathCache = new Map();

function getCachedGroupsByFilteredDocs(filteredDocs, activeTab = 'all') {
  if (!Array.isArray(filteredDocs) || filteredDocs.length === 0) {
    return new Map();
  }

  let cacheByTab = cachedGroupedDocs.get(filteredDocs);
  if (!cacheByTab) {
    cacheByTab = new Map();
    cachedGroupedDocs.set(filteredDocs, cacheByTab);
  }

  if (cacheByTab.has(activeTab)) {
    return cacheByTab.get(activeTab);
  }

  const groups = groupDocs(filteredDocs);
  cacheByTab.set(activeTab, groups);
  return groups;
}

function rebuildDocPathCaches(docs = state.docs) {
  docByPathCache.clear();
  docBySourcePathCache.clear();
  if (!Array.isArray(docs)) {
    return;
  }
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') {
      continue;
    }
    if (doc.path) {
      docByPathCache.set(String(doc.path), doc);
    }
    if (doc.sourcePath) {
      docBySourcePathCache.set(canonicalizeSourcePath(doc.sourcePath), doc);
    }
  }
}

function getDocByPath(pathValue = '') {
  const normalizedPath = normalizeDisplayValue(pathValue);
  if (!normalizedPath) {
    return null;
  }
  return docByPathCache.get(normalizedPath) || docByPathCache.get(pathValue) || null;
}

function getDocBySourcePath(sourcePathValue = '') {
  const normalizedSourcePath = canonicalizeSourcePath(sourcePathValue);
  if (!normalizedSourcePath) {
    return null;
  }
  return docBySourcePathCache.get(normalizedSourcePath) || null;
}

function isInEditSession() {
  return state.isEditing || state.isCreating;
}

function getCurrentEditDraftContent() {
  if (!isInEditSession()) {
    return '';
  }
  if (state.isCreating || state.editInputMode !== 'blocks') {
    return editEditorEl ? editEditorEl.value : '';
  }
  return buildSourceFromBlockDrafts();
}

function normalizeEditSessionVersion(rawVersion) {
  if (typeof rawVersion === 'number' && Number.isFinite(rawVersion)) {
    return String(Math.trunc(rawVersion));
  }
  if (typeof rawVersion === 'string') {
    const normalized = rawVersion.trim();
    if (!normalized) {
      return '';
    }
    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      return normalized;
    }
  }
  return '';
}

function formatVersionForConflict(versionValue) {
  const normalized = normalizeEditSessionVersion(versionValue);
  if (!normalized) {
    return '—';
  }
  return normalized.slice(0, 8);
}

function renderConflictMessagePayload(conflictPayload) {
  const currentVersion = normalizeEditSessionVersion(conflictPayload?.currentVersion);
  const lastModified = typeof conflictPayload?.lastModified === 'string' ? conflictPayload.lastModified : '';
  const latestLabel = lastModified
    ? `${formatVersionForConflict(currentVersion)}（${lastModified}）`
    : formatVersionForConflict(currentVersion);

  return [
    `保存冲突：文档已被其他会话更新（最新版本：${latestLabel}）。`,
    '1) 载入服务器最新内容并放弃当前草稿',
    '2) 保留当前草稿，放弃这次保存',
    '3) 强制覆盖（会覆盖他人最新修改，存在风险）',
  ].join('\n');
}

function renderForceConfirmMessagePayload(conflictPayload) {
  const currentVersion = normalizeEditSessionVersion(conflictPayload?.currentVersion);
  const lastModified = typeof conflictPayload?.lastModified === 'string' ? conflictPayload.lastModified : '';
  const latestLabel = lastModified
    ? `${formatVersionForConflict(currentVersion)}（${lastModified}）`
    : formatVersionForConflict(currentVersion);

  return [
    `确定要执行“强制覆盖”吗？`,
    `目标版本：${latestLabel}`,
    '强制覆盖将覆盖该版本内容，可能覆盖其他编辑者的最新修改。',
    '请再次确认，是否继续？',
  ].join('\n');
}

function setSaveConflictDialogMode(mode = 'default') {
  if (
    !saveConflictDialogEl
    || !saveConflictDialogReloadBtnEl
    || !saveConflictDialogKeepBtnEl
    || !saveConflictDialogForceBtnEl
  ) {
    return;
  }
  const isForceConfirm = mode === 'force';
  saveConflictDialogReloadBtnEl.classList.toggle('is-hidden', isForceConfirm);
  saveConflictDialogKeepBtnEl.classList.toggle('is-hidden', isForceConfirm);
  saveConflictDialogForceBtnEl.textContent = isForceConfirm ? '确认覆盖' : '强制覆盖';
  saveConflictDialogEl.classList.toggle('doc-conflict-force', isForceConfirm);
  if (saveConflictDialogTitleEl) {
    saveConflictDialogTitleEl.classList.toggle('doc-conflict-dialog-title-danger', isForceConfirm);
  }
  if (saveConflictDialogWarningEl) {
    saveConflictDialogWarningEl.classList.toggle('is-hidden', !isForceConfirm);
    if (isForceConfirm) {
      saveConflictDialogWarningEl.textContent = '⚠️ 危险操作：此操作会覆盖当前已存在的版本。请确认无误后再继续。';
    }
  }
}

function closeSaveConflictDialog() {
  if (!saveConflictDialogEl) {
    return;
  }
  if (!saveConflictDialogEl.classList.contains('is-hidden')) {
    saveConflictDialogEl.classList.add('is-hidden');
  }
}

function resolveSaveConflictAction(action) {
  if (typeof saveConflictResolver !== 'function') {
    closeSaveConflictDialog();
    return;
  }
  const resolver = saveConflictResolver;
  saveConflictResolver = null;
  closeSaveConflictDialog();
  resolver(action);
}

function openSaveConflictDialog(conflictPayload, options = {}) {
  if (!saveConflictDialogEl || !saveConflictDialogTitleEl || !saveConflictDialogMessageEl) {
    return Promise.resolve('cancel');
  }
  const mode = options.mode === 'force' ? 'force' : 'default';

  if (saveConflictResolver) {
    resolveSaveConflictAction('cancel');
  }

  saveConflictDialogTitleEl.textContent = mode === 'force' ? '强制覆盖确认' : '保存冲突';
  saveConflictDialogMessageEl.textContent = mode === 'force'
    ? renderForceConfirmMessagePayload(conflictPayload)
    : renderConflictMessagePayload(conflictPayload);
  setSaveConflictDialogMode(mode);
  if (saveConflictDialogEl.classList.contains('is-hidden')) {
    saveConflictDialogEl.classList.remove('is-hidden');
  }

  return new Promise((resolve) => {
    saveConflictResolver = resolve;
  });
}

async function handleSaveConflict(doc, conflictPayload) {
  const sourcePath = getSourcePath(doc);
  const currentVersion = normalizeEditSessionVersion(conflictPayload?.currentVersion);
  const action = await openSaveConflictDialog(conflictPayload);

  const normalizedAction = action || 'cancel';
  if (normalizedAction === '1') {
    const reloaded = await syncDocEditorSource(doc);
    if (reloaded?.error) {
      setEditorStatus(`读取最新内容失败：${reloaded.error}`);
      return 'cancel';
    }
    state.activeEditSourceVersion = currentVersion || state.activeEditSourceVersion;
    doc._sourceVersion = state.activeEditSourceVersion;
    fillSourcePreview(doc, sourcePath, { skipSync: true });
    setEditInputMode('source', {
      doc,
      skipBlockToSourceRestore: true,
      forceSourceRefresh: true,
    });
    setEditSessionClean(editEditorEl ? editEditorEl.value : '', state.activeEditSourceVersion);
    setEditorStatus('已加载服务器最新内容，你可以基于该内容继续编辑并保存。');
    return 'reload';
  }

  if (normalizedAction === '2') {
    setEditorStatus('已保留当前草稿，请在确认内容后重试保存。');
    return 'keep';
  }

  if (normalizedAction === '3') {
    const forceConfirmAction = await openSaveConflictDialog(conflictPayload, { mode: 'force' });
    return forceConfirmAction === '3' ? 'force' : 'cancel';
  }

  return 'cancel';
}

function setEditSessionClean(content, version = '') {
  editSessionBaselineContent = content;
  editSessionVersion = normalizeEditSessionVersion(version);
  state.activeEditSourceVersion = editSessionVersion;
  state.editHasUnsavedChanges = false;
  updateEditUnsavedUi();
}

function refreshEditSessionDirtyState() {
  if (!isInEditSession()) {
    state.editHasUnsavedChanges = false;
    updateEditUnsavedUi();
    return false;
  }
  const currentContent = getCurrentEditDraftContent();
  state.editHasUnsavedChanges = currentContent !== editSessionBaselineContent;
  updateEditUnsavedUi();
  return state.editHasUnsavedChanges;
}

function updateEditUnsavedUi() {
  const showUnsaved = isInEditSession() && !!state.editHasUnsavedChanges;
  if (editDirtyIndicatorEl) {
    editDirtyIndicatorEl.classList.toggle('is-hidden', !showUnsaved);
    editDirtyIndicatorEl.classList.toggle('is-unsaved', showUnsaved);
  }
  if (editSaveBtnEl) {
    editSaveBtnEl.classList.toggle('doc-btn-unsaved', showUnsaved);
  }
}

function confirmDiscardUnsavedChanges(message = '放弃后，当前编辑未保存内容将丢失，是否继续？') {
  if (!state.editHasUnsavedChanges) {
    return true;
  }
  return window.confirm(message);
}

function getActiveDoc() {
  return getDocByPath(state.activePath);
}

function setModeUi() {
  const isEditMode = state.mode === 'edit';
  const activeDoc = getActiveDoc();
  const activeDocEditable = activeDoc ? canUserEditDoc(activeDoc) : false;
  if (modeBrowseBtnEl) {
    modeBrowseBtnEl.classList.toggle('mode-btn-active', !isEditMode);
    modeBrowseBtnEl.setAttribute('aria-pressed', isEditMode ? 'false' : 'true');
  }
  if (modeEditBtnEl) {
    modeEditBtnEl.classList.toggle('mode-btn-active', isEditMode);
    modeEditBtnEl.setAttribute('aria-pressed', isEditMode ? 'true' : 'false');
    modeEditBtnEl.disabled = !state.editBackendAvailable;
  }
  if (modeStateEl) {
    if (isEditMode) {
      if (!state.editBackendAvailable) {
        modeStateEl.textContent = '编辑模式（后端未接入）';
      } else if (!activeDoc) {
        modeStateEl.textContent = '编辑模式（请选择文档）';
      } else if (activeDocEditable) {
        modeStateEl.textContent = '编辑模式';
      } else {
        modeStateEl.textContent = '编辑模式（当前文档不可编辑）';
      }
    } else if (state.editBackendAvailable) {
      modeStateEl.textContent = '浏览模式';
    } else {
      modeStateEl.textContent = '浏览模式（编辑接口不可用）';
    }
  }
  if (modeSwitchEl && !state.editBackendAvailable) {
    modeEditBtnEl?.setAttribute('title', '编辑模式需要启动 /api 服务');
  } else if (modeEditBtnEl) {
    modeEditBtnEl.removeAttribute('title');
  }
}

function setMode(requestedMode, options = {}) {
  const shouldPersist = options.persist === true;
  const resolvedMode = normalizeMode(requestedMode) || DEFAULT_DOC_MODE;
  const finalMode = resolvedMode === 'edit' && state.editBackendAvailable ? 'edit' : 'browse';

  const prevMode = state.mode;

  if (prevMode === 'edit' && finalMode === 'browse' && (state.isEditing || state.isCreating)) {
    if (!confirmDiscardUnsavedChanges('当前有未保存内容，切换到浏览模式将丢失这些修改，是否继续？')) {
      return;
    }
  }

  state.mode = finalMode;

  if (shouldPersist) {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(MODE_LOCAL_STORAGE_KEY, finalMode);
    }
  }

  const url = new URL(location.href);
  url.searchParams.set('mode', finalMode);
  if (url.searchParams.get('mode') !== state.mode || location.search !== url.search) {
    if (typeof history !== 'undefined' && history.replaceState) {
      history.replaceState({}, '', url.toString());
    }
  }

  setModeUi();

  if (prevMode !== finalMode && state.docs?.length) {
    if (!isEditModeActive()) {
      resetDocEditorState();
      setEditorPanelVisibility(false);
      if (state.isEditing || state.isCreating) {
        exitEditMode({ skipUnsavedConfirm: true });
      }
      const current = getDocByPath(state.activePath);
      if (current) {
        updateEditorForDoc(current);
      } else if (state.docs.length > 0) {
        selectDoc(state.docs[0].path);
      }
      syncDocListEditPermissions();
      return;
    }
    const current = getDocByPath(state.activePath);
    if (current) {
      updateEditorForDoc(current);
    } else if (state.docs.length > 0) {
      selectDoc(state.docs[0].path);
    }
  }

  if (resolvedMode === 'edit' && !state.editBackendAvailable && modeStateEl) {
    modeStateEl.textContent = APP_ERROR_MESSAGES.editModeUnavailable;
  }

  syncDocListEditPermissions();
}

async function detectEditBackend() {
  state.editBackendAvailable = false;
  try {
    const response = await fetch(DOC_CAPABILITIES_URL, { cache: 'no-store' });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    if (typeof payload === 'object' && payload !== null) {
      const direct = Boolean(payload?.capabilities?.edit);
      const legacy = payload?.editMode === 'edit';
      const modeFlag = direct || legacy;
      state.editBackendAvailable = Boolean(modeFlag || payload?.ok);
    }
  } catch {
    state.editBackendAvailable = false;
  }
}

function resolveInitialMode() {
  const queryMode = normalizeMode(new URL(location.href).searchParams.get('mode'));
  if (queryMode) {
    return queryMode;
  }

  const savedMode = normalizeMode(
    typeof window !== 'undefined' && window.localStorage
      ? localStorage.getItem(MODE_LOCAL_STORAGE_KEY)
      : '',
  );
  return savedMode || DEFAULT_DOC_MODE;
}

function normalizeMode(mode) {
  const normalized = normalizeDisplayValue(mode).toLowerCase();
  if (normalized === 'edit') {
    return 'edit';
  }
  if (normalized === 'browse') {
    return 'browse';
  }
  return '';
}

function hasEditableBackend() {
  return Boolean(state.editBackendAvailable);
}

function isEditModeActive() {
  return state.mode === 'edit' && hasEditableBackend();
}

function isEditableSourceAvailable(sourcePath) {
  return isEditModeActive() && isEditableSourcePath(sourcePath);
}

function canUserEditDoc(doc) {
  return isEditableSourceAvailable(getSourcePath(doc));
}

function getSearchQuery() {
  return normalizeDisplayValue(searchInput.value).toLowerCase();
}

function formatElapsedSeconds(startAt) {
  const elapsed = Math.max(0, Date.now() - startAt);
  return `${(elapsed / 1000).toFixed(1)}s`;
}

function normalizeCreatePathValue(rawPath) {
  return normalizeDisplayValue(rawPath).replace(/\\+/g, '/');
}

function getCreateBaseDirectory(sourcePath) {
  const normalizedPath = normalizeCreatePathValue(sourcePath);
  if (!normalizedPath.startsWith('design-data/')) {
    return 'design-data/';
  }
  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash === -1) {
    return 'design-data/';
  }
  return `${normalizedPath.slice(0, lastSlash + 1)}`;
}

function ensureMarkdownLikeExtension(sourcePath) {
  const trimmed = normalizeDisplayValue(sourcePath);
  if (!trimmed) {
    return '';
  }
  if (/\.[A-Za-z0-9]+$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.txt`;
}

function getSuggestedCreatePath(sourcePath = '') {
  const base = getCreateBaseDirectory(sourcePath) || 'design-data/';
  const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').replace(/Z$/, '');
  return `${base}新建文档_${timestamp}.txt`;
}

function getCreateInputPath() {
  if (!createPathInputEl) {
    return '';
  }
  return normalizeCreatePathValue(createPathInputEl.value);
}

function isInvalidCreatePath(pathValue) {
  const normalizedPath = normalizeCreatePathValue(pathValue);
  if (!normalizedPath) {
    return APP_ERROR_MESSAGES.createPathRequired;
  }
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath)) {
    return '路径不能是绝对路径';
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return '路径不能包含 . 或 .. 路径段';
  }
  if (!normalizedPath.startsWith('design-data/')
    && !normalizedPath.startsWith('docs-standard/design-data/')) {
    return '路径必须以 design-data/ 或 docs-standard/design-data/ 开头';
  }
  if (normalizedPath.endsWith('/')) {
    return '路径不能以 / 结尾';
  }
  if (/[<>:"|?*]/.test(normalizedPath)) {
    return '路径包含非法字符';
  }
  return '';
}

function validateCreatePath(rawPath) {
  const normalizedPath = normalizeCreatePathValue(rawPath);
  const errorMessage = isInvalidCreatePath(normalizedPath);
  if (errorMessage) {
    return {
      isValid: false,
      value: normalizedPath,
      message: `${APP_ERROR_MESSAGES.createPathInvalid}：${errorMessage}`,
    };
  }
  return {
    isValid: true,
    value: normalizedPath,
    message: '',
  };
}

function setCreatePath(pathValue, fallback = '', ensureExt = false) {
  if (!createPathInputEl) {
    return '';
  }
  const rawValue = normalizeCreatePathValue(pathValue || fallback || getCreateInputPath());
  const value = ensureExt ? ensureMarkdownLikeExtension(rawValue) : rawValue;
  const validation = validateCreatePath(value);

  createPathInputEl.value = value;
  state.isCreatePathValid = validation.isValid;
  createPathInputEl.classList.toggle('is-invalid', !validation.isValid);
  return value;
}

function updateCreatePathValidation(showStatus = false) {
  if (!state.isCreating || !createPathInputEl) {
    return {
      isValid: state.isCreating ? state.isCreatePathValid : true,
      value: getCreateInputPath(),
      message: '',
    };
  }
  const validation = validateCreatePath(createPathInputEl.value);
  setCreatePath(validation.value);
  if (showStatus) {
    if (!validation.isValid) {
      setEditorStatus(validation.message);
    } else {
      setEditorStatus('');
    }
  }
  if (editSaveBtnEl && state.isCreating) {
    editSaveBtnEl.disabled = !validation.isValid || state.isRebuilding;
  }
  return validation;
}

function startRebuildProgressIndicator() {
  if (rebuildProgressTimer) {
    clearInterval(rebuildProgressTimer);
  }
  rebuildProgressStart = Date.now();

  if (editRebuildBtnEl && !editRebuildBtnEl.dataset.rebuildText) {
    editRebuildBtnEl.dataset.rebuildText = editRebuildBtnEl.textContent || REBUILD_TEXT;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.classList.add('is-loading');
  }

  const refreshProgress = () => {
    const elapsedText = formatElapsedSeconds(rebuildProgressStart);
    if (editRebuildBtnEl && editRebuildBtnEl.hidden === false) {
      editRebuildBtnEl.textContent = `重建中 ${elapsedText}`;
    }
    setEditorStatus(`${APP_ERROR_MESSAGES.rebuildStarting} ${formatElapsedSeconds(rebuildProgressStart)}`);
  };
  refreshProgress();
  rebuildProgressTimer = setInterval(refreshProgress, 300);
}

function stopRebuildProgressIndicator() {
  if (rebuildProgressTimer) {
    clearInterval(rebuildProgressTimer);
    rebuildProgressTimer = null;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.classList.remove('is-loading');
    editRebuildBtnEl.textContent = editRebuildBtnEl.dataset.rebuildText || REBUILD_TEXT;
  }
}

function normalizeDisplayValue(value) {
  return (value || '').toString().trim();
}

function normalizeMatchValue(value) {
  return normalizeDisplayValue(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\uFEFF]/g, '')
    .replace(/[\s\-_\.:：]/g, '')
    .replace(/[\[\]【】()（）]/g, '')
    .replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
}

function normalizeContentFingerprint(value) {
  return normalizeMatchValue(value)
    .toLowerCase();
}

function collectDedupeValuesByUsedKeys(doc, dedupeKeys) {
  const values = new Set();
  const fields = doc?.fields || {};
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];

  for (const [key, rawValue] of Object.entries(fields)) {
    if (!dedupeKeys.has(key) && !dedupeKeys.has(normalizeMatchValue(key))) {
      continue;
    }
    const value = toDisplayValue(rawValue);
    const signature = normalizeContentFingerprint(value);
    if (signature) {
      values.add(signature);
    }
  }

  for (const item of sections) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const key = normalizeDisplayValue(item.key);
    if (!key || !dedupeKeys.has(key) && !dedupeKeys.has(normalizeMatchValue(key))) {
      continue;
    }
    const value = toDisplayValue(item.value);
    const signature = normalizeContentFingerprint(value);
    if (signature) {
      values.add(signature);
    }
  }

  if (doc?._contentDedupeValues instanceof Set) {
    for (const value of doc._contentDedupeValues) {
      const signature = normalizeContentFingerprint(value);
      if (signature) {
        values.add(signature);
      }
    }
  }

  return values;
}

function getContentRenderMode(doc) {
  return doc?._contentRenderMode || 'hybrid';
}

function getSourcePath(doc) {
  const source = doc?.meta?.source || doc?.source?.path || doc?.sourcePath;
  return normalizeDisplayValue(source);
}

function canonicalizeSourcePath(rawPath) {
  const normalized = normalizeDisplayValue(rawPath)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  if (!normalized) {
    return '';
  }
  return normalized.startsWith('docs-standard/')
    ? normalized.replace(/^docs-standard\//, '')
    : normalized;
}

function getSourcePathKey(doc) {
  return canonicalizeSourcePath(getSourcePath(doc));
}

function toRebuildFilter(sourcePath) {
  const normalized = normalizeDisplayValue(sourcePath).replace(/^[/\\]+/, '');
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('design-data/')) {
    return normalized;
  }
  if (normalized.startsWith('docs-standard/design-data/')) {
    return normalized.replace(/^docs-standard\/design-data\//, 'design-data/');
  }
  return '';
}

function isEditableSourcePath(sourcePath) {
  return (
    typeof sourcePath === 'string'
    && EDITABLE_SOURCE_PREFIXES.some((prefix) => sourcePath.startsWith(prefix))
  );
}

function getEditableFallbackContent(doc) {
  if (typeof doc?.content === 'string' && doc.content.trim()) {
    return doc.content;
  }

  if (Array.isArray(doc?.sections) && doc.sections.length > 0) {
    return doc.sections
      .map((item) => `${normalizeDisplayValue(item?.key || '')}: ${normalizeDisplayValue(item?.value || '')}`.trim())
      .filter(Boolean)
      .join('\\n\\n');
  }

  if (Array.isArray(doc?.blocks) && doc.blocks.length > 0) {
    return doc.blocks
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        if (block.type === 'paragraph' || block.type === 'heading') {
          return normalizeDisplayValue(block.text || block.title || '');
        }
        if (block.type === 'json' && block.value && typeof block.value === 'object') {
          return JSON.stringify(block.value, null, 2);
        }
        if (block.type === 'table' && Array.isArray(block.rows)) {
          return JSON.stringify(block.rows, null, 2);
        }
        if (block.type === 'list' && Array.isArray(block.items)) {
          return block.items.join('\\n');
        }
        if (block.type === 'kv' && block.key) {
          return `${block.key}: ${toDisplayValue(block.value)}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\\n\\n');
  }

  return '';
}

function hasStructuredBlocks(doc) {
  return Array.isArray(doc?.blocks) && doc.blocks.length > 0;
}

function isBlockModeEnabled() {
  return state.editInputMode === 'blocks';
}

function serializeBlockForEditor(block) {
  if (!block || typeof block !== 'object') {
    return '';
  }

  if (block.type === 'heading') {
    return `${'#'.repeat(block.level || 1)} ${normalizeDisplayValue(block.title || block.text || '')}`.trim();
  }

  if (block.type === 'paragraph' || block.type === 'json') {
    return normalizeDisplayValue(block.text || block.value || '');
  }

  if (block.type === 'kv') {
    return `${normalizeDisplayValue(block.key || '')}：${normalizeDisplayValue(block.value || '')}`;
  }

  if (block.type === 'list') {
    const items = Array.isArray(block.items) ? block.items : [];
    const prefix = block.ordered ? (index) => `${index + 1}. ` : () => '- ';
    return items
      .filter((item) => item !== undefined && item !== null)
      .map((item, index) => `${prefix(index)}${normalizeDisplayValue(item)}`)
      .filter(Boolean)
      .join('\n');
  }

  if (block.type === 'table') {
    const lines = [];
    if (Array.isArray(block.header) && block.header.length > 0) {
      lines.push(`| ${block.header.join(' | ')} |`);
      lines.push(`| ${block.header.map(() => '---').join(' | ')} |`);
    }
    const rows = Array.isArray(block.rows) ? block.rows : [];
    for (const row of rows) {
      if (Array.isArray(row) && row.length > 0) {
        lines.push(`| ${row.join(' | ')} |`);
      }
    }
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  if (block.type === 'kv' || block.type === 'text') {
    return normalizeDisplayValue(block.text || block.value || '');
  }

  return normalizeDisplayValue(block.value || block.text || '');
}

function buildBlockFromEditorLines(type, text) {
  if (type === 'heading') {
    const trimmed = normalizeDisplayValue(text);
    const rawMatch = trimmed.match(/^(#{1,6})\s*(.*)$/);
    if (rawMatch) {
      return `${rawMatch[1]} ${rawMatch[2]}`.trim();
    }
    return `# ${trimmed}`;
  }

  if (type === 'list') {
    const lines = normalizeDisplayValue(text).split('\n');
    return lines
      .map((line) => normalizeDisplayValue(line))
      .filter(Boolean)
      .join('\n');
  }

  if (type === 'kv') {
    const normalized = normalizeDisplayValue(text);
    const hasKey = normalized.includes('：') || normalized.includes(':');
    if (hasKey) {
      return normalized;
    }
    return `${normalized}`;
  }

  return normalizeDisplayValue(text);
}

function buildSourceFromBlockDrafts() {
  if (!editBlockEditorEl) {
    return '';
  }
  const textareas = Array.from(editBlockEditorEl.querySelectorAll('.doc-block-editor-text'));
  const blocks = [];
  for (const textarea of textareas) {
    const blockType = textarea.dataset.blockType || '';
    const value = normalizeDisplayValue(textarea.value);
    const rebuilt = buildBlockFromEditorLines(blockType, value);
    blocks.push(rebuilt);
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

function canUseBlockEditor(doc) {
  return hasStructuredBlocks(doc) && isEditModeActive();
}

function getCurrentEditableDocForMode(overrides = null) {
  if (overrides) {
    return overrides;
  }
  if (!state.isEditing && !state.isCreating) {
    return null;
  }
  return getDocByPath(state.activePath) || null;
}

function renderBlockEditor(doc) {
  if (!editBlockEditorEl) {
    return;
  }
  if (!doc || !hasStructuredBlocks(doc)) {
    editBlockEditorEl.innerHTML = '<div class="doc-edit-status">该文档暂无可编辑结构区块，可直接切到源码模式修改。</div>';
    state.editBlockDrafts = [];
    blockDraftSourcePath = '';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.editBlockDrafts = [];
  doc.blocks.forEach((block, index) => {
    const value = serializeBlockForEditor(block);
    const item = document.createElement('div');
    item.className = 'doc-block-editor-item';
    const label = document.createElement('div');
    label.className = 'doc-block-editor-label';
    label.textContent = `区块 ${index + 1} · ${block.type || 'text'}`;
    const editor = document.createElement('textarea');
    editor.className = 'doc-block-editor-text';
    editor.rows = 6;
    editor.dataset.blockType = block.type || 'text';
    editor.dataset.blockIndex = String(index);
    editor.value = value;
    item.appendChild(label);
    item.appendChild(editor);
    fragment.appendChild(item);
    state.editBlockDrafts.push({
      index,
      type: block.type || 'text',
      value,
    });
  });
  editBlockEditorEl.innerHTML = '';
  editBlockEditorEl.appendChild(fragment);
  blockDraftSourcePath = doc?.path || '';
}

function setEditInputMode(mode, options = {}) {
  const doc = getCurrentEditableDocForMode(options.doc);
  const previousMode = state.editInputMode || 'source';
  const nextMode = mode === 'blocks' ? 'blocks' : 'source';
  const preserveCleanState = isInEditSession() && !state.editHasUnsavedChanges;

  if (!state.isEditing && !state.isCreating) {
    if (editStatusEl) {
      setEditorStatus('');
    }
    state.editInputMode = 'source';
    state.editBlockDrafts = [];
    blockDraftSourcePath = '';
    if (editModeBarEl) {
      editModeBarEl.classList.add('is-hidden');
    }
    if (docEditorWrapEl) {
      docEditorWrapEl.hidden = true;
    }
    if (editEditorEl) {
      editEditorEl.disabled = true;
    }
    if (editBlockEditorEl) {
      editBlockEditorEl.classList.add('is-hidden');
      editBlockEditorEl.innerHTML = '';
    }
    if (editSourceModeBtnEl) {
      editSourceModeBtnEl.classList.remove('doc-btn-active');
      editSourceModeBtnEl.disabled = false;
    }
    if (editBlockModeBtnEl) {
      editBlockModeBtnEl.classList.remove('doc-btn-active');
      editBlockModeBtnEl.disabled = true;
    }
    return;
  }

  const canUseBlock = canUseBlockEditor(doc);
  if (nextMode === 'blocks' && canUseBlock) {
    state.editInputMode = 'blocks';
    if (blockDraftSourcePath !== (doc?.path || '')) {
      state.editBlockDrafts = [];
      renderBlockEditor(doc);
    } else if (!state.editBlockDrafts.length) {
      renderBlockEditor(doc);
    }
  } else {
    state.editInputMode = 'source';
    if (nextMode === 'blocks' && !canUseBlock && editStatusEl) {
      setEditorStatus(APP_ERROR_MESSAGES.granularEditUnavailable);
    }
  }

  const isSourceMode = state.editInputMode === 'source';
  if (editModeBarEl) {
    editModeBarEl.classList.remove('is-hidden');
  }

  if (editSourceModeBtnEl) {
    editSourceModeBtnEl.classList.toggle('doc-btn-active', isSourceMode);
    editSourceModeBtnEl.disabled = false;
  }
  if (editBlockModeBtnEl) {
    editBlockModeBtnEl.classList.toggle('doc-btn-active', !isSourceMode);
    editBlockModeBtnEl.disabled = !canUseBlock;
  }

  if (isSourceMode) {
    if (doc && editEditorEl) {
      if (previousMode === 'blocks' && !options.skipBlockToSourceRestore) {
        editEditorEl.value = buildSourceFromBlockDrafts();
      } else if (options.forceSourceRefresh || !editEditorEl.value) {
        fillSourcePreview(doc, getSourcePath(doc));
      }
      editEditorEl.focus();
    }
    if (editStatusEl) {
      setEditorStatus('');
    }
  }

  if (docEditorWrapEl) {
    docEditorWrapEl.hidden = !isSourceMode;
  }
  if (editEditorEl) {
    editEditorEl.disabled = !isSourceMode;
  }
  if (editBlockEditorEl) {
    editBlockEditorEl.classList.toggle('is-hidden', isSourceMode);
  }

  refreshEditSessionDirtyState();
  if (preserveCleanState && isInEditSession()) {
    syncEditSessionBaseline();
  }
}

function getCurrentEditContent() {
  if (state.isCreating || state.editInputMode !== 'blocks') {
    return editEditorEl ? editEditorEl.value : '';
  }
  return buildSourceFromBlockDrafts();
}

function syncEditSessionBaseline(nextVersion = '') {
  if (!isInEditSession()) {
    return;
  }
  const cleanContent = getCurrentEditDraftContent();
  setEditSessionClean(cleanContent, nextVersion || state.activeEditSourceVersion);
}

function resetDocEditorState() {
  state.isEditing = false;
  state.isCreating = false;
  state.editInputMode = 'source';
  state.editBlockDrafts = [];
  blockDraftSourcePath = '';
  state.isCreatePathValid = true;
  state.activeEditPath = '';
  state.activeEditSource = '';
  state.activeEditSourceVersion = '';
  editSessionVersion = '';
  state.activeCreatePath = '';
  state.editHasUnsavedChanges = false;
  editSessionBaselineContent = '';
  updateEditUnsavedUi();
  if (editStatusEl) {
    editStatusEl.textContent = '';
  }
  if (docEditorWrapEl) {
    docEditorWrapEl.hidden = true;
  }
  if (editModeBarEl) {
    editModeBarEl.classList.add('is-hidden');
  }
  if (editBlockEditorEl) {
    editBlockEditorEl.classList.add('is-hidden');
    editBlockEditorEl.innerHTML = '';
  }
  if (editBtnEl) {
    editBtnEl.hidden = false;
    editBtnEl.disabled = false;
    editBtnEl.textContent = '编辑';
  }
  if (editSaveBtnEl) {
    editSaveBtnEl.hidden = true;
  }
  if (editCancelBtnEl) {
    editCancelBtnEl.hidden = true;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.hidden = true;
    editRebuildBtnEl.disabled = false;
  }
  if (editCreateBtnEl) {
    editCreateBtnEl.hidden = false;
    editCreateBtnEl.disabled = false;
  }
  if (createPathWrapEl) {
    createPathWrapEl.classList.add('is-hidden');
  }
  if (createPathInputEl) {
    createPathInputEl.value = '';
    createPathInputEl.placeholder = APP_ERROR_MESSAGES.createPathPlaceholder;
    createPathInputEl.classList.remove('is-invalid');
  }
}

const NEW_SKILL_MARKERS = /^(?:获得新技能|新增技能|新增被动技能|新增主动技能|新增额外技能)$/;

function updateSearchClearState() {
  if (!searchClearEl) {
    return;
  }
  searchClearEl.classList.toggle('is-visible', searchInput.value.trim().length > 0);
}

function categoryLabel(category) {
  return CATEGORY_LABELS[getDisplayCategory({ category })] || CATEGORY_LABELS[category] || category || '其他';
}

function updateLeftPanelStatsFromGroups(groupMap, filteredCount = 0) {
  if (leftTotalStatEl) {
    leftTotalStatEl.textContent = String(state.docs.length);
  }

  if (leftVisibleStatEl) {
    leftVisibleStatEl.textContent = String(filteredCount);
  }

  if (!leftLegendBodyEl) {
    return;
  }

  const countMap = new Map();
  for (const [key, groupMapByCategory] of groupMap) {
    let count = 0;
    for (const docsInGroup of groupMapByCategory.values()) {
      count += docsInGroup.length;
    }
    countMap.set(key, count);
  }

  if (countMap.size === 0) {
    leftLegendBodyEl.innerHTML = '<span class="left-legend-item">暂无命中文档</span>';
    return;
  }

  const items = [...countMap.entries()].sort((a, b) => b[1] - a[1]);
  leftLegendBodyEl.innerHTML = '';
  for (const [key, count] of items) {
    const pill = document.createElement('span');
    pill.className = 'left-legend-item';
    pill.textContent = `${categoryLabel(key)} (${count})`;
    leftLegendBodyEl.appendChild(pill);
  }
}

function isLikelySkillDescription(key, value) {
  if (normalizeMatchValue(value).length > 20 && value.length > 20) {
    return true;
  }
  if (key === '阳印' || key === '阴印' || key === '铸神' || key === '铸魔') {
    return /[，。；%]|将|会|每秒|持续|范围|伤害|提高|增加|回复/.test(value);
  }
  return false;
}

function stripSkillSuffixes(value) {
  return normalizeDisplayValue(value).replace(/[：:]+$/u, '').trim();
}

function isLikelyDescriptionPrefix(value) {
  const trimmed = stripSkillSuffixes(value);
  if (!trimmed) {
    return false;
  }
  return /^(?:伤害|持续|范围|冷却|施法距离|施法范围|魔力消耗|攻击距离|攻击速度|移动速度|护甲|魔抗|debuff|基础|间隔|回复|击退|回血|每秒|伤害间隔|作用间隔|弧线|角度|弹道速度|持续时间|减速|伤害系数|层数)/.test(trimmed);
}

function isLikelyForgedOrRuneName(key, value) {
  if (key !== '铸神' && key !== '铸魔') {
    return true;
  }

  const normalized = normalizeMatchValue(value);
  if (normalized.length > 12) {
    return false;
  }
  if (/[0-9%+]/.test(value)) {
    return false;
  }
  if (isLikelyDescriptionPrefix(value)) {
    return false;
  }
  return true;
}

function normalizeForNameCompare(value) {
  return normalizeMatchValue(value)
    .replace(/(?:持续|造成|可以|能够|并且|可以)?(?:会|期间|提高|增加|减少|获得|触发|使得)?/gu, '')
    .replace(/(?:[a-z]{1,2}\d+%?)?/giu, '')
    .replace(/\d+(?:\.\d+)?%?/gu, '')
    .replace(/[，。；:+\-/*（）()【】\[\].]/g, '');
}

function trimKnownSkillName(rawName, knownNames = []) {
  const normalizedRaw = normalizeForNameCompare(rawName);
  if (!normalizedRaw) {
    return rawName;
  }
  for (const candidate of knownNames) {
    const normalizedCandidate = normalizeForNameCompare(candidate);
    if (!normalizedCandidate) {
      continue;
    }
    if (normalizedRaw === normalizedCandidate) {
      return candidate;
    }
    if (normalizedRaw.startsWith(normalizedCandidate) && normalizedRaw.length > normalizedCandidate.length + 2) {
      return candidate;
    }
  }
  return rawName;
}

function parseHeroSkillHeaderFromLines(key, lines = [], knownNames = []) {
  let cursor = 0;
  const normalizedKey = normalizeMatchValue(key);

  while (cursor < lines.length) {
    const current = stripSkillSuffixes(lines[cursor]);
    if (!current) {
      cursor += 1;
      continue;
    }

    const explicitName = current.match(/^名称(?:[:：]\s*(.*))?$/);
    if (explicitName) {
      const name = stripSkillSuffixes(explicitName[1]) || key;
      const description = lines
        .slice(cursor + 1)
        .map((line) => line.replace(/^描述[:：]\s*/, ''))
        .filter((line) => !/^(?:类型|描述)[:：]\s*$/.test(line))
        .join('\n');
      return { name, description };
    }

    if (NEW_SKILL_MARKERS.test(current) || /^新增/.test(current)) {
      cursor += 1;
      continue;
    }

    const passivePrefix = current.match(/^(?:被动|主动)[:：]\s*(.+)$/);
    if (passivePrefix) {
      return {
        name: stripSkillSuffixes(passivePrefix[1]) || key,
        description: lines.slice(cursor + 1).join('\n'),
      };
    }

    const inlineMatch = current.match(/^(.*?)[:：]\s*(.+)$/);
    if (inlineMatch) {
      const inlineName = stripSkillSuffixes(inlineMatch[1]);
      const inlineDescription = inlineMatch[2].trim();
      if (inlineName && inlineDescription && !isLikelyDescriptionPrefix(inlineName) && isLikelyForgedOrRuneName(key, inlineName)) {
        return {
          name: inlineName,
          description: [inlineDescription, ...lines.slice(cursor + 1)].join('\n'),
        };
      }
    }

    if (normalizeMatchValue(current) === normalizedKey && cursor + 1 < lines.length) {
      const next = stripSkillSuffixes(lines[cursor + 1]);
      if (next && normalizeMatchValue(next) !== normalizedKey && next.length <= 24 && !/[，。；:：]/.test(next)) {
        return {
          name: stripSkillSuffixes(next),
          description: lines.slice(cursor + 2).join('\n'),
        };
      }
    }

    return {
      name: isLikelySkillDescription(key, current) || !isLikelyForgedOrRuneName(key, current)
        ? key
        : trimKnownSkillName(stripSkillSuffixes(current), knownNames),
      description: lines.slice(cursor + (isLikelySkillDescription(key, current) ? 0 : 1)).join('\n'),
    };
  }

  return { name: key, description: '' };
}

function pickSkillIconFromGallery(skillName, heroImages = [], excludedImages = new Set()) {
  const targetCandidates = [];

  const addNeedle = (value) => {
    const normalized = normalizeMatchValue(value);
    if (!normalized || targetCandidates.includes(normalized)) {
      return;
    }
    targetCandidates.push(normalized);
  };

  const compactName = normalizeDisplayValue(skillName)
    .replace(/^(?:技能\d+|天生技能|先天技能)[:：]?\s*/, '')
    .replace(/^(?:被动|主动)[:：]?\s*/, '')
    .trim();

  addNeedle(skillName);
  addNeedle(compactName);

  if (!targetCandidates.length) {
    return null;
  }

  for (const image of heroImages) {
    const base = image ? image.split('/').at(-1) : '';
    if (!base) {
      continue;
    }
    const normalized = normalizeMatchValue(base.replace(/\.[^.]+$/u, ''));
    if (!normalized) {
      continue;
    }

    if (excludedImages.has(image)) {
      continue;
    }
    if (targetCandidates.some((needle) => (
      normalized === needle
      || normalized.includes(needle)
      || needle.includes(normalized)
    ))) {
      return image;
    }
  }

  return null;
}

function buildHeroSkillsFallback(sections = []) {
  const result = [];
  const seen = new Set();
  const knownNames = [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      continue;
    }
    const key = normalizeDisplayValue(section.key);
    if (!key || !/^(天生技能|先天技能|技能[1-4]|阳印|阴印|铸神|铸魔)$/.test(key)) {
      continue;
    }

    const lines = normalizeDisplayValue(section.value)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      continue;
    }

    const parsed = parseHeroSkillHeaderFromLines(key, lines, knownNames);
    const name = trimKnownSkillName(parsed.name || key, knownNames);
    const description = parsed.description;
    const signature = normalizeMatchValue(key);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    result.push({ key, name, description });
    knownNames.push(name);
  }

  return result;
}

function buildHeroSkillCards(doc) {
  const sourceEntries = Array.isArray(doc.heroSkills) && doc.heroSkills.length > 0
    ? doc.heroSkills
    : buildHeroSkillsFallback(doc.sections || []);
  if (!sourceEntries.length) {
    return null;
  }

  const heroImages = getHeroImagesForDisplay(doc, doc.heroSkills || []);
  const portraitImage = heroImages[0] || null;
  const excludeIcons = new Set();
  if (portraitImage) {
    excludeIcons.add(portraitImage);
  }

  const used = new Set();
  const entries = [];
  for (const item of sourceEntries) {
    const key = normalizeDisplayValue(item.key);
    const name = normalizeDisplayValue(item.name || key);
    const signature = `${normalizeMatchValue(key)}::${normalizeMatchValue(name)}`;
    if (!signature || used.has(signature)) {
      continue;
    }
    used.add(signature);

    const icon = normalizeDisplayValue(item.icon)
      || pickSkillIconFromGallery(name, heroImages, excludeIcons);
    entries.push({
      key,
      name,
      icon,
      description: normalizeDisplayValue(item.description),
    });
  }

  if (!entries.length) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'meta-card';

  const heading = document.createElement('h3');
  heading.textContent = '技能图标与说明';
  card.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'hero-skill-list';

  for (const item of entries) {
    const row = document.createElement('div');
    row.className = 'hero-skill-row';

    const media = document.createElement('div');
    media.className = 'hero-skill-media';
    if (item.icon) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = new URL(item.icon, ASSET_BASE_URL).href;
      img.alt = `${item.name || item.key || '技能'}图标`;
      media.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'hero-skill-empty';
      media.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'hero-skill-info';

    const title = document.createElement('div');
    title.className = 'text-title';
    title.textContent = `${item.key || '技能'}：${item.name}`;

    const body = document.createElement('div');
    body.className = 'text-body';
    if (item.description) {
      body.textContent = item.description;
      info.appendChild(body);
    }

    info.appendChild(title);
    row.appendChild(media);
    row.appendChild(info);
    list.appendChild(row);
  }

  card.appendChild(list);
  return card;
}

function removeDuplicateHeroSkillCards() {
  const removeTitles = new Set(['技能树', '技能说明']);
  const cards = sectionEl.querySelectorAll('.meta-card');
  for (const card of cards) {
    const title = card.querySelector('h3');
    if (!title) {
      continue;
    }
    if (removeTitles.has(normalizeDisplayValue(title.textContent))) {
      card.remove();
    }
  }
}

function renderHeroSkillCards(doc) {
  if (doc?.category !== 'hero') {
    return;
  }
  removeDuplicateHeroSkillCards();
  const card = buildHeroSkillCards(doc);
  if (card) {
    sectionEl.appendChild(card);
  }
}

function renderSectionCards(doc) {
  sectionEl.innerHTML = '';
  const sectionCards = getHeroCardsByCategory(doc);
  for (const card of sectionCards) {
    if (card) {
      sectionEl.appendChild(card);
    }
  }
  if (doc?.category === 'hero') {
    renderHeroSkillCards(doc);
  }
}

function renderGallery(images) {
  galleryEl.innerHTML = '';
  if (!images || images.length === 0) {
    return;
  }

  for (const url of images) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = new URL(url, ASSET_BASE_URL).href;
    img.alt = url;
    galleryEl.appendChild(img);
  }
}

function renderMeta(doc) {
  metaEl.innerHTML = '';
  const category = getDisplayCategory(doc);
  titleEl.textContent = doc.meta?.title || doc.title || doc.name;

  if (typeChipEl) {
    typeChipEl.textContent = `类型：${CATEGORY_LABELS[category] || category || '其他'}`;
    typeChipEl.className = `doc-chip ${CATEGORY_TAG[category] || 'other'}`;
  }

  if (groupChipEl) {
    if (doc.group) {
      groupChipEl.textContent = `分组：${doc.group}`;
      groupChipEl.hidden = false;
    } else {
      groupChipEl.textContent = '';
      groupChipEl.hidden = true;
    }
  }

  if (pathChipEl) {
    pathChipEl.textContent = `路径：${doc.path || '-'}`;
  }

  if (subtitleEl) {
    const sourceCategory = CATEGORY_LABELS[category] || category || '其他';
    const parts = [sourceCategory];
    if (doc.group) {
      parts.push(doc.group);
    }
    parts.push(doc.type || 'txt');
    subtitleEl.textContent = parts.join(' · ');
  }

  const tags = document.createElement('div');
  const tag = document.createElement('span');
  tag.className = `hero-tag ${CATEGORY_TAG[category] || 'other'}`;
  tag.textContent = `类型：${CATEGORY_LABELS[category] || '其他'}`;
  tags.appendChild(tag);
  metaEl.appendChild(tags);

  const baseCards = buildCommonCards(doc);
  for (const card of baseCards) {
    metaEl.appendChild(card);
  }
}

function setEditorPanelVisibility(visible) {
  if (!editPanelEl) {
    return;
  }
  editPanelEl.classList.toggle('is-hidden', !visible);
}

function setEditorStatus(message = '') {
  if (editStatusEl) {
    editStatusEl.textContent = message;
    editStatusEl.className = message ? 'doc-edit-status is-visible' : 'doc-edit-status';
  }
}

function setEditButtons({ isEditing, isCreating, canEdit }) {
  const editModeAvailable = isEditModeActive();
  const isCreateMode = !!isCreating;
  const saveText = isCreateMode ? '创建' : '保存';
  const isEditorVisible = isEditing || isCreateMode;

  if (!editModeAvailable) {
    if (editCreateBtnEl) {
      editCreateBtnEl.hidden = true;
      editCreateBtnEl.disabled = true;
    }
    if (editBtnEl) {
      editBtnEl.hidden = true;
      editBtnEl.disabled = true;
    }
    if (editSaveBtnEl) {
      editSaveBtnEl.hidden = true;
      editSaveBtnEl.disabled = true;
      editSaveBtnEl.classList.remove('doc-btn-success');
    }
    if (editCancelBtnEl) {
      editCancelBtnEl.hidden = true;
      editCancelBtnEl.disabled = true;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.hidden = true;
      editRebuildBtnEl.disabled = true;
    }
    if (createPathWrapEl) {
      createPathWrapEl.classList.add('is-hidden');
    }
    if (docEditorWrapEl) {
      docEditorWrapEl.hidden = true;
    }
    if (editEditorEl) {
      editEditorEl.disabled = true;
    }
    if (editPathEl) {
      editPathEl.textContent = '可编辑源：编辑模式未开启';
    }
    setEditorPanelVisibility(false);
    return;
  }

  if (editCreateBtnEl) {
    editCreateBtnEl.hidden = isCreateMode || isEditorVisible;
    editCreateBtnEl.disabled = false;
  }

  if (editBtnEl) {
    editBtnEl.hidden = isCreateMode || !canEdit;
    editBtnEl.disabled = !canEdit;
    editBtnEl.textContent = isEditing ? '返回' : '编辑';
  }

  if (editSaveBtnEl) {
    editSaveBtnEl.hidden = !isEditorVisible;
    editSaveBtnEl.textContent = saveText;
    const createPathBlocked = isCreateMode && state.isCreatePathValid === false;
    editSaveBtnEl.disabled = !isEditorVisible || state.isRebuilding || createPathBlocked;
    editSaveBtnEl.classList.toggle('doc-btn-success', isEditorVisible);
  }

  if (editCancelBtnEl) {
    editCancelBtnEl.hidden = !isEditorVisible;
  }

  if (editRebuildBtnEl) {
    editRebuildBtnEl.hidden = !canEdit || isEditing || isCreateMode;
    editRebuildBtnEl.disabled = !canEdit || isEditorVisible || state.isRebuilding;
  }

  if (createPathWrapEl) {
    createPathWrapEl.classList.toggle('is-hidden', !isCreateMode);
  }

  if (docEditorWrapEl) {
    docEditorWrapEl.hidden = !isEditorVisible;
  }

  if (editEditorEl) {
    editEditorEl.disabled = !isEditorVisible;
  }

  if (editCreateBtnEl && isCreateMode) {
    editCreateBtnEl.disabled = true;
  }

  if (!isCreateMode && isEditorVisible) {
    editCreateBtnEl.hidden = true;
  }
}

function applyEditMode(doc, isEditing) {
  if (!isEditModeActive()) {
    resetDocEditorState();
    setEditorPanelVisibility(false);
    return;
  }
  state.isEditing = isEditing;
  state.isCreating = false;
  state.isCreatePathValid = true;
  if (!isEditing) {
    state.editHasUnsavedChanges = false;
    state.activeEditSourceVersion = '';
    editSessionBaselineContent = '';
    editSessionVersion = '';
    updateEditUnsavedUi();
  }
  setEditButtons({
    isEditing,
    isCreating: false,
    canEdit: isEditableSourceAvailable(getSourcePath(doc)),
  });
  if (!state.isCreating && state.isEditing && !state.activeEditPath) {
    state.activeEditPath = doc?.path || '';
  }

  if (!isEditing) {
    state.activeEditPath = '';
    state.activeEditSource = '';
    if (editEditorEl) {
      editEditorEl.value = '';
    }
    setEditInputMode('source', { doc: null });
    contentEl.classList.remove('is-hidden');
    contentEl.hidden = false;
  } else if (editEditorEl) {
    contentEl.classList.add('is-hidden');
    contentEl.hidden = true;
    setEditInputMode(state.editInputMode || 'source', { doc });
  }
  contentEl.classList.toggle('is-empty', false);
}

function enterCreateMode() {
  if (!isEditModeActive()) {
    return;
  }
  if (state.isEditing && state.isCreating) {
    return;
  }
  if (state.isEditing) {
    if (!confirmDiscardUnsavedChanges('当前有未保存内容，进入新建将丢失这些修改，是否继续？')) {
      return;
    }
    exitEditMode();
  }

  const activeDoc = getDocByPath(state.activePath);
  const baseSourcePath = canUserEditDoc(activeDoc || {})
    ? getSourcePath(activeDoc || {})
    : 'design-data/';
  const suggestedPath = getSuggestedCreatePath(baseSourcePath);

  state.isEditing = true;
  state.isCreating = true;
  state.editInputMode = 'source';
  state.editBlockDrafts = [];
  blockDraftSourcePath = '';
  state.activeEditPath = '__new__';
  state.activeCreatePath = suggestedPath;
  setEditButtons({
    isEditing: false,
    isCreating: true,
    canEdit: true,
  });
  if (editPathEl) {
    editPathEl.textContent = `新建源：${suggestedPath}`;
  }
  if (editEditorEl) {
    editEditorEl.value = '';
  }
  setCreatePath(suggestedPath);
  updateCreatePathValidation();
  setEditInputMode('source');
  syncEditSessionBaseline();
  contentEl.classList.add('is-hidden');
  contentEl.hidden = true;
  contentEl.classList.toggle('is-empty', false);
  setEditorStatus('输入新建路径与内容后，点击“创建”');
}

async function fetchEditableSource(pathValue) {
  if (!isEditModeActive()) {
    return { error: APP_ERROR_MESSAGES.noEditablePath };
  }
  const response = await fetch(`${DOC_API_URL}?path=${encodeURIComponent(pathValue)}`);
  if (!response.ok) {
    const message = `读取源码失败（HTTP ${response.status}）`;
    return { error: message };
  }

  const payload = await response.json();
  const content = typeof payload?.content === 'string' ? payload.content : '';
  return {
    content,
    lastModified: typeof payload?.lastModified === 'string' ? payload.lastModified : '',
    version: normalizeEditSessionVersion(payload?.version),
  };
}

function fillSourcePreview(doc, sourcePath, options = {}) {
  const sourceContent = typeof doc._sourceCachedText === 'string' ? doc._sourceCachedText : getEditableFallbackContent(doc);
  const sourceVersion = typeof doc._sourceVersion === 'string' ? doc._sourceVersion : '';
  if (editPathEl) {
    editPathEl.textContent = sourcePath ? `可编辑源：${sourcePath}` : '可编辑源：—';
  }
  if (editEditorEl) {
    editEditorEl.value = sourceContent || '';
  }
  if (!options.skipSync && isInEditSession() && getActiveDoc()?.path === doc?.path && !state.isCreating) {
    syncEditSessionBaseline(sourceVersion);
  }
}

async function enterEditMode() {
  if (!isEditModeActive()) {
    return;
  }
  const doc = getDocByPath(state.activePath);
  if (!doc) {
    return;
  }
  const sourcePath = getSourcePath(doc);
  if (!isEditableSourceAvailable(sourcePath)) {
    return;
  }

  state.activeEditPath = doc.path;
  state.activeEditSource = sourcePath;
  state.activeEditSourceVersion = normalizeEditSessionVersion(
    doc._sourceVersion || doc._sourceLastModified || doc.lastModified,
  );
  state.editInputMode = 'source';
  state.editBlockDrafts = [];
  blockDraftSourcePath = '';
  if (doc._sourceCachedText === undefined) {
    const sourceInfo = await syncDocEditorSource(doc);
    if (sourceInfo?.error) {
      setEditorStatus(sourceInfo.error);
      return;
    }
  }
  if (!doc._sourceCachedText) {
    doc._sourceCachedText = getEditableFallbackContent(doc);
  }
  applyEditMode(doc, true);
  setEditInputMode('source', { doc });
  if (editEditorEl) {
    fillSourcePreview(doc, sourcePath);
    editEditorEl.focus();
  }
  syncEditSessionBaseline();
}

async function saveCurrentDoc() {
  if (!isEditModeActive()) {
    return;
  }
  if (!editEditorEl) {
    return;
  }

  if (state.isCreating) {
    await saveNewDoc();
    return;
  }

  await saveExistingDoc();
}

async function saveNewDoc() {
  if (!isEditModeActive()) {
    return;
  }
  const validation = updateCreatePathValidation(true);
  if (!validation.isValid) {
    return;
  }
  const sourcePath = ensureMarkdownLikeExtension(validation.value);
  setCreatePath(sourcePath, '', true);
  if (!sourcePath) {
    setEditorStatus(APP_ERROR_MESSAGES.createPathRequired);
    return;
  }

  const content = getCurrentEditContent();
  setEditorStatus(APP_ERROR_MESSAGES.savingSource);
  if (editSaveBtnEl) {
    editSaveBtnEl.disabled = true;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.disabled = true;
  }

  try {
    const response = await fetch(DOC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: sourcePath,
        content,
        create: true,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const extra = payload?.error ? `：${payload.error}` : '';
      setEditorStatus(`新建失败（HTTP ${response.status}）${extra}`);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }

    const saved = await response.json();
    const createdSource = sourcePath;
    const createdVersion = normalizeEditSessionVersion(saved?.version);
    setEditSessionClean(content, createdVersion);
    state.activeCreatePath = createdSource;
    state.isCreating = false;
    state.isEditing = false;
    state.activeEditPath = '';
    state.activeEditSource = '';
    setEditorStatus(APP_ERROR_MESSAGES.createSuccess);
    await rebuildIndexForDoc({
      path: createdSource,
      meta: {},
      sourcePath: createdSource,
    }, {
      preferredPath: createdSource,
      preferredSourcePath: createdSource,
    });
    await loadData({
      preferredPath: state.activePath,
      preferredSourcePath: createdSource,
    });
  } catch (error) {
    setEditorStatus(`新建失败：${error?.message || '未知错误'}`);
  } finally {
    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = state.isRebuilding;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
  }
}

async function saveExistingDoc(options = {}) {
  const forceOverwrite = options.forceOverwrite === true;
  if (!isEditModeActive()) {
    return;
  }
  const doc = getDocByPath(state.activePath);
  if (!doc || !isEditableSourceAvailable(getSourcePath(doc))) {
    return;
  }

  const sourcePath = getSourcePath(doc);
  if (!editEditorEl) {
    return;
  }

  const content = getCurrentEditContent();
  setEditorStatus(APP_ERROR_MESSAGES.savingSource);
  if (editSaveBtnEl) {
    editSaveBtnEl.disabled = true;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.disabled = true;
  }

  try {
    const expectedVersion = normalizeEditSessionVersion(
      state.activeEditSourceVersion || doc._sourceVersion || doc._sourceLastModified || doc.lastModified,
    );
    if (!expectedVersion) {
      throw new Error('未获取到当前文件的编辑锁版本，请刷新后重试');
    }
    const response = await fetch(DOC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: sourcePath,
        content,
        expectedLastModified: expectedVersion,
        force: forceOverwrite,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const extra = payload?.error ? `：${payload.error}` : '';
      let message = response.status === 409
        ? `${APP_ERROR_MESSAGES.saveConflict}（HTTP ${response.status}）${extra}`
        : `保存失败（HTTP ${response.status}）${extra}`;
      if (payload?.currentVersion) {
        const latestVersion = normalizeEditSessionVersion(payload.currentVersion);
        if (latestVersion) {
          state.activeEditSourceVersion = latestVersion;
        }
      }
      if (response.status === 409 && !forceOverwrite && payload?.currentVersion) {
        const conflictAction = await handleSaveConflict(doc, payload);
        if (conflictAction === 'reload' || conflictAction === 'keep') {
          if (editSaveBtnEl) {
            editSaveBtnEl.disabled = false;
          }
          if (editRebuildBtnEl) {
            editRebuildBtnEl.disabled = false;
          }
          return;
        }
        if (conflictAction === 'force') {
          if (payload?.currentVersion) {
            state.activeEditSourceVersion = normalizeEditSessionVersion(payload.currentVersion);
          }
          if (editSaveBtnEl) {
            editSaveBtnEl.disabled = true;
          }
          if (editRebuildBtnEl) {
            editRebuildBtnEl.disabled = true;
          }
          await saveExistingDoc({ forceOverwrite: true });
          return;
        }
        if (conflictAction === 'cancel') {
          message = '已取消保存：版本冲突处理已中止。';
          setEditorStatus(message);
          if (editSaveBtnEl) {
            editSaveBtnEl.disabled = false;
          }
          if (editRebuildBtnEl) {
            editRebuildBtnEl.disabled = false;
          }
          return;
        }
      }
      setEditorStatus(message);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }

    const saved = await response.json();
    doc._sourceCachedText = content;
    doc._sourceRenderedText = content;
    setEditorStatus(APP_ERROR_MESSAGES.saveSuccess);
    setEditSessionClean(content, saved?.version);
    doc._sourceVersion = normalizeEditSessionVersion(saved?.version);
    state.activeEditSource = getSourcePath(doc);

    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = false;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
    applyEditMode(doc, true);
    renderContent(doc);
    renderMeta(doc);
    await rebuildIndexForDoc(doc);
  } catch (error) {
    const message = `保存失败：${error?.message || '未知错误'}`;
    setEditorStatus(message);
    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = false;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
  }
}

async function rebuildIndexForDoc(doc, options = {}) {
  if (!isEditModeActive()) {
    return;
  }
  if (!doc) {
    return;
  }

  const sourcePath = getSourcePath(doc);
  if (!isEditableSourceAvailable(sourcePath)) {
    return;
  }

  const rebuildFilter = toRebuildFilter(sourcePath);
  state.isRebuilding = true;
  const preferredPath = options.preferredPath || state.activePath;
  const isCurrentDocEditing = state.isEditing && !state.isCreating && state.activeEditPath === doc.path;
  setEditButtons({
    isEditing: isCurrentDocEditing,
    isCreating: false,
    canEdit: true,
  });
  startRebuildProgressIndicator();

  try {
    const response = await fetch(DOC_REBUILD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: rebuildFilter,
      }),
    });

    if (!response.ok) {
      const message = `重建失败（HTTP ${response.status}）`;
      const payload = await response.json().catch(() => null);
      const extra = payload?.error ? `：${payload.error}` : '';
      setEditorStatus(`${message}${extra}`);
      stopRebuildProgressIndicator();
      return;
    }

    await response.json();
    await loadData(preferredPath, {
      preferredSourcePath: options.preferredSourcePath || '',
    });
    if (!state.isEditing && isCurrentDocEditing) {
      void enterEditMode();
    } else if (state.isEditing && state.activeEditPath === doc.path) {
      const activeDoc = getDocByPath(state.activePath);
      if (activeDoc) {
        syncDocEditorSource(activeDoc).then(() => {
          if (state.activePath === activeDoc.path) {
            fillSourcePreview(activeDoc, getSourcePath(activeDoc));
          }
        });
      }
    }
    const elapsed = formatElapsedSeconds(rebuildProgressStart);
    setEditorStatus(`${APP_ERROR_MESSAGES.rebuildSuccess}（耗时 ${elapsed}）`);
  } catch (error) {
    setEditorStatus(`重建失败：${error?.message || '未知错误'}`);
  } finally {
    stopRebuildProgressIndicator();
    state.isRebuilding = false;
    const currentDoc = getDocByPath(state.activePath);
    setEditButtons({
      isEditing: state.isEditing && state.activeEditPath === (currentDoc?.path || ''),
      isCreating: state.isCreating,
      canEdit: isEditableSourceAvailable(getSourcePath(currentDoc || {})),
    });
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
  }
}

function exitEditMode(options = {}) {
  if (!options.skipUnsavedConfirm && isInEditSession() && !confirmDiscardUnsavedChanges('当前有未保存内容，放弃编辑并返回浏览？')) {
    return;
  }

  if (state.isCreating) {
    state.isCreating = false;
    state.activeEditPath = '';
    state.activeEditSource = '';
    if (state.activePath) {
      const currentDoc = getDocByPath(state.activePath);
      if (currentDoc) {
        setEditorStatus('');
        applyEditMode(currentDoc, false);
        return;
      }
    }
  }

  const doc = getDocByPath(state.activePath);
  if (doc) {
    renderContent(doc);
  }
  setEditorStatus('');
  applyEditMode(doc, false);
}

async function syncDocEditorSource(doc) {
  const sourcePath = getSourcePath(doc);
  if (!sourcePath) {
    return null;
  }
  const sourceInfo = await fetchEditableSource(sourcePath);
  if (sourceInfo?.error) {
    return { error: sourceInfo.error };
  }
  doc._editorSource = sourcePath;
  doc._sourceCachedText = sourceInfo.content;
  doc._sourceLastModified = sourceInfo.lastModified || '';
  doc._sourceVersion = sourceInfo.version || '';
  return { sourcePath, content: sourceInfo.content };
}

function updateEditorForDoc(doc) {
  const sourcePath = getSourcePath(doc);
  const canEdit = canUserEditDoc(doc);
  const isCurrentDocEditable = canEdit && isEditModeActive();

  setEditorPanelVisibility(isEditModeActive());
  setEditorStatus('');

  if (!isEditModeActive()) {
    if (editPathEl) {
      editPathEl.textContent = '可编辑源：当前为浏览模式';
    }
    if (editEditorEl) {
      editEditorEl.value = '';
    }
    setEditButtons({
      isEditing: false,
      isCreating: false,
      canEdit: false,
    });
    return;
  }

  if (isCurrentDocEditable) {
    fillSourcePreview(doc, sourcePath);
  } else {
    if (editPathEl) {
      editPathEl.textContent = '可编辑源：当前文档不可直接编辑';
    }
    if (editEditorEl) {
      editEditorEl.value = '';
    }
  }

  setEditButtons({
    isEditing: state.isEditing && state.activeEditPath === doc.path,
    isCreating: false,
    canEdit,
  });
  syncDocListEditPermissions();
}

function syncDocListEditPermissions() {
  if (!listEl) {
    return;
  }
  const showGranularEditState = isEditModeActive();
  const cacheVersion = getDocListButtonCacheVersion();
  if (
    cachedEditPermissionSyncState.showGranularEditState === showGranularEditState
    && cachedEditPermissionSyncState.cacheVersion === cacheVersion
    && cachedEditPermissionSyncState.mode === state.mode
    && cachedEditPermissionSyncState.backendAvailable === state.editBackendAvailable
  ) {
    return;
  }

  const buttons = getRenderedDocListButtons();
  for (const button of buttons) {
    const path = normalizeDisplayValue(button.dataset.path);
    if (!path) {
      continue;
    }
    const itemDoc = getDocByPath(path);
    const buttonMeta = getDocListButtonMeta(path);
    const textWrap = buttonMeta?.textWrap || null;
    let permissionTag = buttonMeta?.permissionTag || null;
    const editable = itemDoc ? canUserEditDoc(itemDoc) : false;
    const nextState = showGranularEditState ? (editable ? 'editable' : 'readonly') : 'hidden';
    if (!itemDoc) {
      if (button.dataset.editPermission !== 'hidden') {
        button.dataset.editPermission = 'hidden';
        button.classList.remove('doc-item-readonly');
        button.classList.remove('doc-item-editable');
        if (permissionTag) {
          permissionTag.remove();
          permissionTag = null;
          setDocListButtonMeta(path, { permissionTag: null });
        }
      }
      continue;
    }

    const showEditTag = showGranularEditState;
    const currentState = button.dataset.editPermission || 'hidden';

    if (currentState !== nextState) {
      button.dataset.editPermission = nextState;
      if (!showEditTag || nextState === 'hidden') {
        button.classList.remove('doc-item-readonly');
        button.classList.remove('doc-item-editable');
        if (permissionTag) {
          permissionTag.remove();
          permissionTag = null;
          setDocListButtonMeta(path, { permissionTag: null });
        }
        continue;
      }

      button.classList.toggle('doc-item-editable', editable);
      button.classList.toggle('doc-item-readonly', !editable);

      if (!permissionTag && textWrap) {
        permissionTag = document.createElement('div');
        permissionTag.className = editable ? 'doc-item-edit-access is-editable' : 'doc-item-edit-access is-readonly';
        permissionTag.textContent = editable ? '可编辑' : '不可编辑';
        textWrap.appendChild(permissionTag);
        setDocListButtonMeta(path, { permissionTag });
      } else if (permissionTag) {
        const nextLabel = editable ? '可编辑' : '不可编辑';
        const nextClassName = `doc-item-edit-access ${editable ? 'is-editable' : 'is-readonly'}`;
        if (permissionTag.textContent !== nextLabel || permissionTag.className !== nextClassName) {
          permissionTag.textContent = nextLabel;
          permissionTag.className = nextClassName;
        }
      }
    } else if (showEditTag) {
      if (!permissionTag && textWrap) {
        permissionTag = document.createElement('div');
        permissionTag.className = editable ? 'doc-item-edit-access is-editable' : 'doc-item-edit-access is-readonly';
        permissionTag.textContent = editable ? '可编辑' : '不可编辑';
        textWrap.appendChild(permissionTag);
        setDocListButtonMeta(path, { permissionTag });
      } else if (permissionTag) {
        const nextLabel = editable ? '可编辑' : '不可编辑';
        const nextClassName = `doc-item-edit-access ${editable ? 'is-editable' : 'is-readonly'}`;
        if (permissionTag.textContent !== nextLabel || permissionTag.className !== nextClassName) {
          permissionTag.textContent = nextLabel;
          permissionTag.className = nextClassName;
        }
      }
    }
  }

  cachedEditPermissionSyncState = {
    showGranularEditState,
    cacheVersion,
    mode: state.mode,
    backendAvailable: state.editBackendAvailable,
  };
}

function renderContent(doc) {
  if (typeof doc?._sourceRenderedText === 'string') {
    contentEl.classList.remove('is-empty');
    contentEl.style.display = '';
    contentEl.textContent = doc._sourceRenderedText;
    return;
  }

  const mode = getContentRenderMode(doc);
  contentEl.style.display = '';
  contentEl.innerHTML = '';

  if (mode === 'card-only') {
    contentEl.classList.add('is-empty');
    contentEl.style.display = 'none';
    return;
  }

  contentEl.classList.remove('is-empty');

  if (Array.isArray(doc.blocks) && doc.blocks.length > 0) {
    const dedupeFieldKeys = new Set(Object.keys(doc.fields || {}));
    if (doc._contentDedupeKeys instanceof Set) {
      for (const key of doc._contentDedupeKeys) {
        dedupeFieldKeys.add(key);
      }
    }
    const dedupeTextValues = collectDedupeValuesByUsedKeys(doc, dedupeFieldKeys);
    const rendered = renderStructuredBlocks(doc.blocks, {
      dedupeKeys: dedupeFieldKeys,
      dedupeText: dedupeTextValues,
      renderMode: mode,
    });

    if (rendered) {
      contentEl.appendChild(rendered);
    } else if (mode === 'full') {
      contentEl.classList.add('is-empty');
      contentEl.style.display = 'none';
      return;
    }
  } else {
    const content = typeof doc.content === 'string' ? doc.content : '';
    const dedupeText = collectDedupeValuesByUsedKeys(doc, new Set(Object.keys(doc.fields || {})));
    const contentText = content
      .split(/\n{2,}/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!hasRenderableToken(line)) {
          return false;
        }
        const signature = normalizeContentFingerprint(line);
        if (!signature || dedupeText.has(signature)) {
          return false;
        }
        dedupeText.add(signature);
        return true;
      })
      .join('\n\n');
    contentEl.textContent = contentText;
  }

  if (!normalizeDisplayValue(contentEl.textContent || '').trim() && contentEl.children.length === 0) {
    contentEl.textContent = '';
    contentEl.classList.add('is-empty');
    contentEl.style.display = 'none';
  }
}

function renderList(groups) {
  const currentRenderId = ++listRenderToken;
  resetDocListButtonCache();
  listEl.innerHTML = '';

  if (!(groups instanceof Map) || !groups.size) {
    const msg = lastSearchQuery ? '未匹配到文档' : '当前标签暂无文档';
    listEl.innerHTML = `<div class="doc-group">${msg}</div>`;
    markActiveItem();
    return;
  }

  const categoryNames = [...groups.keys()].sort((a, b) => {
    const aOrder = CATEGORY_ORDER_INDEX.has(a) ? CATEGORY_ORDER_INDEX.get(a) : Number.MAX_SAFE_INTEGER;
    const bOrder = CATEGORY_ORDER_INDEX.has(b) ? CATEGORY_ORDER_INDEX.get(b) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.localeCompare(b, 'zh-CN');
  });

  const categoryNodes = [];

  for (const categoryName of categoryNames) {
    const categoryMap = groups.get(categoryName) || new Map();
    const totalCount = [...categoryMap.values()].reduce((acc, arr) => acc + arr.length, 0);
    const categoryNode = createDetailsGroup(`分类 ${CATEGORY_LABELS[categoryName] || categoryName}`, totalCount, true);

    const groupNames = [...categoryMap.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const groupName of groupNames) {
      const docsInGroup = categoryMap.get(groupName);
      const groupNode = createDetailsGroup(groupName, docsInGroup.length, true);
      for (const doc of docsInGroup) {
        const button = createDocButton(doc, selectDoc, {
          showEditAccess: isEditModeActive(),
          isEditable: canUserEditDoc(doc),
        });
        groupNode.appendChild(button);
      }
      categoryNode.appendChild(groupNode);
    }

    categoryNodes.push(categoryNode);
  }

  let cursor = 0;
  const flushNodes = () => {
    if (currentRenderId !== listRenderToken) {
      return;
    }
    if (cursor >= categoryNodes.length) {
      markActiveItem();
      return;
    }

    const fragment = document.createDocumentFragment();
    const end = Math.min(cursor + LIST_RENDER_BATCH_SIZE, categoryNodes.length);
    for (let i = cursor; i < end; i += 1) {
      fragment.appendChild(categoryNodes[i]);
    }
    cursor = end;
    listEl.appendChild(fragment);
    requestAnimationFrame(flushNodes);
  };

  requestAnimationFrame(flushNodes);
}

function renderTabsNow() {
  if (!categoryTabsEl) {
    return;
  }
  renderTabs(
    () => renderFilteredDocs('', { skipTabs: false }),
    cachedTabCounts,
  );
}

function renderFilteredDocs(preferredPath = '', options = {}) {
  const { skipTabs = false } = options;
  const preferredSourcePath = canonicalizeSourcePath(options.preferredSourcePath || '');
  const searchQuery = getSearchQuery();
  const filtered = getHeroDisplayDocs(getVisibleDocs(state.docs, searchQuery), state.activeTab);
  let groups = null;
  if (
    searchQuery === ''
    && cachedListGroups.source === state.docs
    && cachedListGroups.activeTab === state.activeTab
    && cachedListGroups.filtered === filtered
  ) {
    groups = cachedListGroups.groups;
  } else {
    groups = getCachedGroupsByFilteredDocs(filtered, state.activeTab);
    if (searchQuery === '') {
      cachedListGroups.source = state.docs;
      cachedListGroups.activeTab = state.activeTab;
      cachedListGroups.filtered = filtered;
      cachedListGroups.groups = groups;
    }
  }

  const shouldRenderList = cachedListRenderState.filtered !== filtered
    || cachedListRenderState.activeTab !== state.activeTab;
  const shouldRenderStats = cachedListRenderState.groups !== groups
    || cachedListRenderState.filtered !== filtered
    || cachedListRenderState.activeTab !== state.activeTab;
  if (shouldRenderStats) {
    updateLeftPanelStatsFromGroups(groups, filtered.length);
  }
  if (shouldRenderList) {
    renderList(groups);
  } else if (state.activePath && state.activePath !== (renderedDocRef && renderedDocRef.path)) {
    // Keep active marker aligned when active path changes but list structure unchanged.
    markActiveItem();
  }

  cachedListRenderState = {
    filtered,
    activeTab: state.activeTab,
    groups,
  };

  if (!filtered.length) {
    const hasKeyword = Boolean(searchQuery);
    statusEl.textContent = `${hasKeyword ? '未匹配到文档' : '当前标签暂无文档'} ${state.generatedStatus}`;
    if (!skipTabs) {
      renderTabsNow();
    }
    return;
  }

  const displayText = `当前显示 ${filtered.length} 个文档（共 ${state.docs.length} 个）`;
  const tabText = searchQuery ? '（已按关键词筛选）' : '';
  statusEl.textContent = `${displayText} ${tabText} ${state.generatedStatus}`;

  const filteredPathSet = new Set(filtered.map((doc) => doc.path));
  let desiredPath = preferredPath;
  if (preferredSourcePath) {
    const fromSource = getDocBySourcePath(preferredSourcePath);
    if (fromSource && filteredPathSet.has(fromSource.path)) {
      desiredPath = fromSource.path;
    }
  }
  if (!desiredPath || !filteredPathSet.has(desiredPath)) {
    desiredPath = state.activePath;
  }

  let targetPath = '';
  if (desiredPath && filteredPathSet.has(desiredPath)) {
    targetPath = desiredPath;
  }
  if (!targetPath) {
    const activeDoc = getDocByPath(state.activePath);
    if (activeDoc && filteredPathSet.has(activeDoc.path)) {
      targetPath = activeDoc.path;
    }
  }
  if (!targetPath) {
    targetPath = filtered[0].path;
  }

  selectDoc(targetPath);

  if (!skipTabs) {
    renderTabsNow();
  }
}

function selectDoc(pathValue) {
  const doc = getDocByPath(pathValue);
  if (!doc) {
    return;
  }

  const isDifferentDoc = state.activePath !== pathValue;
  const shouldRefreshContent = isDifferentDoc || renderedDocRef !== doc;
  if (isDifferentDoc && isInEditSession() && !confirmDiscardUnsavedChanges('当前有未保存内容，切换文档将丢失这些修改，是否继续？')) {
    return;
  }
  state.activePath = doc.path;

  if (isDifferentDoc) {
    applyEditMode(null, false);
    setEditorStatus('');
  }

  if (!shouldRefreshContent) {
    markActiveItem();
    setModeUi();
    return;
  }

  if (isEditModeActive() && isEditableSourcePath(getSourcePath(doc))) {
    if (doc._sourceCachedText === undefined) {
      setEditorStatus(APP_ERROR_MESSAGES.loadingSource);
      syncDocEditorSource(doc)
        .then((result) => {
          if (state.activePath !== doc.path) {
            return;
          }
          if (result?.error) {
            setEditorStatus(result.error);
            return;
          }
          fillSourcePreview(doc, getSourcePath(doc));
          setEditorStatus('');
        })
        .catch((error) => {
          if (state.activePath === doc.path) {
            setEditorStatus(`读取源码失败：${error?.message || '未知错误'}`);
          }
        });
    }
  }

  renderHeroBanner(doc);
  renderMeta(doc);
  renderSectionCards(doc);
  const heroImages = getHeroImagesForDisplay(doc, doc.heroSkills || []);
  renderGallery(heroImages);
  renderContent(doc);
  updateEditorForDoc(doc);
  setModeUi();
  markActiveItem();
  renderedDocRef = doc;
}

function collectSearchText(doc) {
  const base = `${doc.name} ${doc.path} ${doc.group} ${doc.category} ${doc.type || ''}`;
  const fields = doc.fields ? Object.entries(doc.fields).map(([key, value]) => `${key} ${value}`).join(' ') : '';
  const sections = Array.isArray(doc.sections)
    ? doc.sections.map((item) => `${item.key || ''} ${item.value || ''}`).join(' ')
    : '';
  const blocks = Array.isArray(doc.blocks)
    ? doc.blocks.map((item) => `${item.type || ''} ${item.title || ''} ${item.key || ''} ${item.value || ''}`).join(' ')
    : '';
  const outline = Array.isArray(doc.outline)
    ? doc.outline.map((item) => `${item.title || ''} ${item.anchor || ''}`).join(' ')
    : '';

  return `${base} ${fields} ${sections} ${blocks} ${outline}`.toLowerCase();
}

async function loadData(preferredPath = '', options = {}) {
  const loadArgs = typeof preferredPath === 'object' && preferredPath !== null
    ? preferredPath
    : {
      preferredPath,
      ...options,
    };
  const normalizedPreferredPath = normalizeDisplayValue(loadArgs.preferredPath || '');
  const preferredSourcePath = normalizeDisplayValue(loadArgs.preferredSourcePath || '');

  try {
    const response = await fetch(DATA_INDEX_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    state.docs = payload?.docs || payload?.state?.docs || [];
    state.docs.forEach((doc) => {
      doc._searchText = collectSearchText(doc);
      doc.meta = doc.meta || {};
      doc.sourcePath = getSourcePath(doc);
      doc.fields = doc.fields || {};
      doc.sections = doc.sections || [];
      doc.outline = doc.outline || [];
      doc.blocks = doc.blocks || [];
      doc.parser = doc.parser || {};
      doc.heroSkills = doc.heroSkills || [];
      doc._heroImagesOrdered = undefined;
      doc._sourceRenderedText = undefined;
      doc._sourceCachedText = undefined;
      doc._sourceVersion = normalizeEditSessionVersion(doc._sourceVersion || doc.lastModified || doc._sourceLastModified || '');
      doc._sourceLastModified = doc._sourceLastModified || doc.lastModified || '';
    });
    rebuildDocPathCaches(state.docs);
    getSearchIndex(state.docs, true);

    cachedTabCounts = getTabCounts();
    cachedListRenderState = {
      filtered: null,
      activeTab: '',
      groups: null,
    };
    renderedDocRef = null;
    cachedListGroups.source = null;
    cachedListGroups.activeTab = '';
    cachedListGroups.filtered = null;
    cachedListGroups.groups = null;
    cachedGroupedDocs = new WeakMap();
    state.generatedStatus = `（静态生成 ${formatTime(payload.generatedAt)}）`;
    renderTabsNow();
    renderFilteredDocs(normalizedPreferredPath || state.activePath, { preferredSourcePath });
    syncDocListEditPermissions();
    lastSearchQuery = getSearchQuery();
    updateSearchClearState();
  } catch (error) {
    statusEl.textContent = `加载失败：${error.message}`;
    listEl.textContent = '请先执行静态生成脚本：node scripts/build-static-doc-site.mjs';
  }
}

async function initApp() {
  searchInput.addEventListener('input', () => {
    updateSearchClearState();
    const query = getSearchQuery();
    if (query === lastSearchQuery) {
      return;
    }
    lastSearchQuery = query;

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = setTimeout(() => {
      renderFilteredDocs('', { skipTabs: true });
      searchDebounceTimer = null;
    }, SEARCH_INPUT_DEBOUNCE_MS);
  });

  if (searchClearEl) {
    searchClearEl.addEventListener('click', () => {
      searchInput.value = '';
      updateSearchClearState();
      lastSearchQuery = '';
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      renderFilteredDocs('', { skipTabs: true });
      searchInput.focus();
    });
  }

  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      if (!isEditModeActive()) {
        return;
      }
      if (state.isCreating) {
        return;
      }
      const doc = getDocByPath(state.activePath);
      if (!doc) {
        return;
      }
      if (state.isEditing && state.activeEditPath === doc.path) {
        exitEditMode();
      } else if (canUserEditDoc(doc)) {
        void enterEditMode();
      }
    });
  }

  if (editCreateBtnEl) {
    editCreateBtnEl.addEventListener('click', () => {
      enterCreateMode();
    });
  }

  if (editSourceModeBtnEl) {
    editSourceModeBtnEl.addEventListener('click', () => {
      if (!state.isEditing || state.isCreating || !isEditModeActive()) {
        return;
      }
      const doc = getActiveDoc();
      if (!doc) {
        return;
      }
      setEditInputMode('source', { doc });
    });
  }

  if (editBlockModeBtnEl) {
    editBlockModeBtnEl.addEventListener('click', () => {
      if (!state.isEditing || state.isCreating || !isEditModeActive()) {
        return;
      }
      const doc = getActiveDoc();
      if (!doc) {
        return;
      }
      setEditInputMode('blocks', { doc });
    });
  }

  if (createPathInputEl) {
    createPathInputEl.addEventListener('input', () => {
      if (!state.isCreating) {
        return;
      }
      updateCreatePathValidation(true);
    });
    createPathInputEl.addEventListener('blur', () => {
      if (!state.isCreating) {
        return;
      }
      updateCreatePathValidation(true);
    });
  }

  if (editSaveBtnEl) {
    editSaveBtnEl.addEventListener('click', () => {
      if (!isEditModeActive()) {
        return;
      }
      void saveCurrentDoc();
    });
  }

  if (editEditorEl) {
    const onSourceInput = () => {
      if (!isInEditSession()) {
        return;
      }
      refreshEditSessionDirtyState();
    };
    editEditorEl.addEventListener('input', onSourceInput);
  }

  if (editBlockEditorEl) {
    editBlockEditorEl.addEventListener('input', (event) => {
      const target = event.target;
      if (!isInEditSession() || !target || !target.classList || !target.classList.contains('doc-block-editor-text')) {
        return;
      }
      refreshEditSessionDirtyState();
    });
  }

  if (editCancelBtnEl) {
    editCancelBtnEl.addEventListener('click', () => {
      exitEditMode();
    });
  }

  if (saveConflictDialogEl) {
    const attachConflictAction = (button, action) => {
      if (!button) {
        return;
      }
      button.addEventListener('click', () => {
        resolveSaveConflictAction(action);
      });
    };
    attachConflictAction(saveConflictDialogReloadBtnEl, '1');
    attachConflictAction(saveConflictDialogKeepBtnEl, '2');
    attachConflictAction(saveConflictDialogForceBtnEl, '3');
    attachConflictAction(saveConflictDialogCancelBtnEl, 'cancel');

    saveConflictDialogEl.addEventListener('click', (event) => {
      if (event.target === saveConflictDialogEl || event.target.classList.contains('doc-conflict-backdrop')) {
        resolveSaveConflictAction('cancel');
      }
    });
  }

  if (editRebuildBtnEl) {
    editRebuildBtnEl.addEventListener('click', () => {
      if (!isEditModeActive()) {
        return;
      }
  const doc = getDocByPath(state.activePath);
      if (!doc || state.isEditing) {
        return;
      }
      void rebuildIndexForDoc(doc);
    });
  }

  if (modeBrowseBtnEl) {
    modeBrowseBtnEl.addEventListener('click', () => {
      setMode('browse', { persist: true });
    });
  }

  if (modeEditBtnEl) {
    modeEditBtnEl.addEventListener('click', () => {
      setMode('edit', { persist: true });
    });
  }

  if (editEditorEl) {
    editEditorEl.addEventListener('keydown', (event) => {
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveCurrentDoc();
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && typeof saveConflictResolver === 'function') {
        resolveSaveConflictAction('cancel');
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.editHasUnsavedChanges) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    });
  }

  resetDocEditorState();
  setEditorPanelVisibility(false);
  await detectEditBackend();
  setMode(resolveInitialMode());
  await loadData();
}

export { initApp };
