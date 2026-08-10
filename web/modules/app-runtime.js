import {
  appState as state,
  domElements,
  DATA_INDEX_URL,
  DOC_CAPABILITIES_URL,
  DOC_HEALTH_URL,
  DOC_API_URL,
  DOC_REBUILD_URL,
  CATEGORY_LABELS,
  CATEGORY_TAG,
  CATEGORY_ORDER,
  ASSET_BASE_URL,
  EDITABLE_SOURCE_PREFIXES,
  APP_ERROR_MESSAGES,
  APP_REQUEST_LABELS,
  APP_RUNTIME_TEXTS,
} from './app-state.js';
import {
  getHeroDisplayDocs,
  getVisibleDocs,
  getSearchIndex,
  getHeroImagesForDisplay,
  getNameAvatarDataUrl,
  getHeroSkillImagePlaceholderPath,
  applyImageFallbackChain,
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
import { getDocTemplate, DOC_TYPE_TEMPLATE_DEFS } from './app-type-templates.js';
import { API_ERRORS } from '../../scripts/lib/doc-api-contract.mjs';
import {
  detectEditBackendAvailability,
  loadDocIndexPayload,
  readDocSource,
  loadTemplateContent,
  rebuildDocIndex,
  writeDoc,
} from './app-doc-service.js';

const {
  statusEl,
  listEl,
  loadRetryBtnEl,
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
  createTypeWrapEl,
  createTypeSelectEl,
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
  runtimeErrorPanelEl,
  runtimeErrorListEl,
  runtimeErrorClearBtnEl,
} = domElements;

const SEARCH_INPUT_DEBOUNCE_MS = 180;
const LIST_RENDER_BATCH_SIZE = 120;
const LIST_ERROR_SUMMARY_VISIBLE_ENTRIES = 3;
const LIST_ERROR_SUMMARY_AUTO_OPEN_THRESHOLD = 8;
const LIST_UI_TEXT = APP_RUNTIME_TEXTS.list;
const LIST_ERROR_SUMMARY_TEXTS = APP_RUNTIME_TEXTS.list.summary;
const REBUILD_TEXT = APP_REQUEST_LABELS.rebuildIndex;
const PAGE_UI_TEXTS = APP_RUNTIME_TEXTS.pageShell;
const DATA_INDEX_REQUEST_TIMEOUT_MS = 12000;
const CAPABILITIES_REQUEST_TIMEOUT_MS = 5000;
const RUNTIME_ERROR_PANEL_LIMIT = 12;
const CATEGORY_ORDER_INDEX = new Map(
  CATEGORY_ORDER.map((category, index) => [category, index]),
);
const MODE_LOCAL_STORAGE_KEY = 'doc-site-mode';
const CREATE_TYPE_LOCAL_STORAGE_KEY = 'doc-site-create-type';
const DEFAULT_DOC_MODE = 'browse';
const DOC_WRITE_ERROR_CONFLICT = API_ERRORS.conflict;
const DOC_WRITE_ERROR_ALREADY_EXISTS = API_ERRORS.alreadyExists;
const DOC_WRITE_ERROR_MISSING_EXPECTED_VERSION = API_ERRORS.missingExpectedVersion;
const DOC_WRITE_ERROR_MISSING_PATH = API_ERRORS.missingPath;
const DOC_WRITE_ERROR_MISSING_CONTENT = API_ERRORS.missingContent;
const DOC_WRITE_ERROR_BAD_PATH = API_ERRORS.badPath;
const DOC_WRITE_ERROR_DOC_NOT_FOUND = API_ERRORS.docNotFound;
let rebuildProgressTimer = null;
let rebuildProgressStart = 0;
let searchDebounceTimer = null;
let lastSearchQuery = '';
let listRenderToken = 0;
let listRenderFrameId = 0;
let listSkeletonRenderState = null;
let dataLoadToken = 0;
let renderedDocSignature = '';
let lastStatusText = '';
let lastListText = '';
let cachedTabCounts = null;
let blockDraftSourcePath = '';
let editSessionVersion = '';
let saveConflictResolver = null;
let renderedDocRef = null;
const createTemplateCache = new Map();
const createTemplateLoadErrorCache = new Map();
const createTypeOrder = ['hero', 'item', 'unit', 'skill', 'building', 'backstory', 'scene', 'rule', 'template'];
let cachedListRenderState = {
  filtered: null,
  activeTab: '',
  groups: null,
};
let detectedEditBackendState = {
  source: 'not_checked',
  reason: 'service_unreachable',
  reasonText: '',
  status: 0,
  attempts: [],
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
let renderedContentDocPath = '';
let renderedContentSignature = '';
const docByPathCache = new Map();
const docBySourcePathCache = new Map();
let runtimeErrorLog = [];

function setStatusText(message = '') {
  const normalized = normalizeDisplayValue(message);
  if (statusEl && statusEl.textContent !== normalized) {
    statusEl.textContent = normalized;
  }
  lastStatusText = normalized;
}

function normalizeEditBackendState(rawState = {}) {
  if (typeof rawState === 'boolean') {
    return {
      available: rawState,
      source: 'legacy',
      reason: rawState ? 'available' : 'service_unreachable',
      reasonText: '',
      status: 0,
      payload: null,
      attempts: [],
    };
  }

  if (!rawState || typeof rawState !== 'object') {
    return {
      available: false,
      source: 'invalid',
      reason: 'service_unreachable',
      reasonText: '',
      status: 0,
      payload: null,
      attempts: [],
    };
  }

  return {
    available: Boolean(rawState.available),
    source: normalizeDisplayValue(rawState.source || 'unavailable'),
    reason: normalizeDisplayValue(rawState.reason || 'service_unreachable'),
    reasonText: normalizeDisplayValue(rawState.reasonText || ''),
    status: typeof rawState.status === 'number' ? rawState.status : 0,
    payload: rawState.payload || null,
    attempts: Array.isArray(rawState.attempts) ? rawState.attempts : [],
  };
}

function getWriteErrorCode(rawError = '') {
  const normalized = normalizeDisplayValue(rawError).toLowerCase();
  if (!normalized) {
    return '';
  }
  const candidates = [
    DOC_WRITE_ERROR_CONFLICT,
    DOC_WRITE_ERROR_ALREADY_EXISTS,
    DOC_WRITE_ERROR_MISSING_EXPECTED_VERSION,
    DOC_WRITE_ERROR_MISSING_PATH,
    DOC_WRITE_ERROR_MISSING_CONTENT,
    DOC_WRITE_ERROR_BAD_PATH,
    DOC_WRITE_ERROR_DOC_NOT_FOUND,
  ];
  const matched = candidates.find((code) => {
    const normalizedCode = normalizeDisplayValue(code).toLowerCase();
    return normalized === normalizedCode || normalized.includes(normalizedCode);
  });
  return matched || '';
}

function getEditModeUnavailableText() {
  if (state.editBackendAvailable) {
    return APP_ERROR_MESSAGES.editModeUnavailable;
  }

  const reason = detectedEditBackendState.reason;
  const reasonHint = APP_ERROR_MESSAGES.editBackendUnavailableReasons?.[reason];
  const messageDetail = reasonHint || detectedEditBackendState.reasonText || APP_ERROR_MESSAGES.editBackendUnavailableReasons?.service_unreachable;
  const attemptSummary = summarizeRequestAttempts(detectedEditBackendState.attempts, {
    label: '编辑能力检测',
    maxEntries: 2,
  });
  if (!messageDetail && !attemptSummary) {
    return APP_ERROR_MESSAGES.editModeUnavailable;
  }
  if (!attemptSummary) {
    return `${APP_ERROR_MESSAGES.editModeUnavailable}（${messageDetail}）`;
  }
  if (!messageDetail) {
    return `${APP_ERROR_MESSAGES.editModeUnavailable}（${attemptSummary}）`;
  }
  return `${APP_ERROR_MESSAGES.editModeUnavailable}（${messageDetail}；${attemptSummary}）`;
}

function summarizeAttemptFailureMeta(attempts = []) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return '';
  }
  const failedAttempts = attempts.filter((attempt) => !attempt?.ok);
  if (!failedAttempts.length) {
    return '';
  }
  const retryCount = Math.max(0, failedAttempts.length - 1);
  const firstFailure = failedAttempts[0];
  const lastFailure = failedAttempts[failedAttempts.length - 1];
  const reason = normalizeDisplayValue(failedAttempts[0]?.message || failedAttempts[0]?.statusText || failedAttempts[0]?.name || '');
  const firstAt = normalizeDisplayValue(firstFailure?.timestamp);
  const lastAt = normalizeDisplayValue(lastFailure?.timestamp);

  const chunks = [`失败${failedAttempts.length}次`];
  if (retryCount > 0) {
    chunks.push(`可重试${retryCount}次`);
  }
  if (reason) {
    chunks.push(`原因：${reason}`);
  }
  if (firstAt) {
    chunks.push(`首次失败：${firstAt}`);
  }
  if (lastAt && lastAt !== firstAt) {
    chunks.push(`最近失败：${lastAt}`);
  }
  return chunks.join('；');
}

function setListText(message = '') {
  const normalized = normalizeDisplayValue(message);
  if (listEl && listEl.textContent !== normalized) {
    listEl.textContent = normalized;
  }
  lastListText = normalized;
}

function renderListSkeletonMarkup(message = '') {
  const safeMessage = normalizeDisplayValue(message) || LIST_UI_TEXT.status.skeleton;
  const rowsHtml = `
    <div class="doc-list-skeleton" role="status" aria-live="polite">
      <div class="doc-list-skeleton-message">${safeMessage}</div>
      ${Array.from({ length: 4 }).map(() => '<div class="doc-skeleton-row"><span class="doc-skeleton-line doc-skeleton-line-title"></span><span class="doc-skeleton-line doc-skeleton-line-sub"></span></div>').join('')}
    </div>
  `;
  return rowsHtml;
}

function setListSkeletonState(message = '') {
  if (!listEl) {
    return;
  }
  listSkeletonRenderState = normalizeDisplayValue(message) || LIST_UI_TEXT.status.skeleton;
  listEl.innerHTML = renderListSkeletonMarkup(listSkeletonRenderState);
}

function clearListSkeletonState() {
  listSkeletonRenderState = null;
}

function formatListRenderErrorSummary(totalErrorCount, errorCountsByContext, topCount = LIST_ERROR_SUMMARY_VISIBLE_ENTRIES) {
  if (!totalErrorCount) {
    return '';
  }
  const topContexts = [...errorCountsByContext.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topCount)
    .map(([context, count]) => `${context}（${count}）`)
    .join('、');
  return `${LIST_ERROR_SUMMARY_TEXTS.label}：${totalErrorCount}${LIST_ERROR_SUMMARY_TEXTS.unitLabel}${topContexts ? `${LIST_ERROR_SUMMARY_TEXTS.topLabel}${topContexts}` : ''}`;
}

function setTextContentById(elementId, value) {
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  el.textContent = normalizeDisplayValue(value);
}

function setAttributeById(elementId, attrName, value) {
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  const safeValue = normalizeDisplayValue(value);
  if (!safeValue) {
    el.removeAttribute(attrName);
    return;
  }
  el.setAttribute(attrName, safeValue);
}

function setStaticUiTexts() {
  const ui = PAGE_UI_TEXTS || {};
  if (!ui || typeof ui !== 'object') {
    return;
  }

  if (ui.documentTitle) {
    document.title = ui.documentTitle;
  }

  setTextContentById('siteTitle', ui.siteTitle);
  setTextContentById('siteSubtitle', ui.siteSubtitle);

  setAttributeById('topbarNav', 'aria-label', ui.topbarNavAriaLabel);
  setTextContentById('navCatalogLink', ui.navCatalog);
  setTextContentById('navHeroLink', ui.navHero);
  setTextContentById('navItemLink', ui.navItem);
  setTextContentById('navUnitLink', ui.navUnit);

  setAttributeById('modeSwitch', 'aria-label', ui.modeSwitchAriaLabel);
  if (modeBrowseBtnEl) {
    modeBrowseBtnEl.textContent = ui.modeBrowseBtn || APP_RUNTIME_TEXTS.modeState.browse;
  }
  if (modeEditBtnEl) {
    modeEditBtnEl.textContent = ui.modeEditBtn || APP_RUNTIME_TEXTS.editButtons.editText;
  }
  setTextContentById('modeStateChip', APP_RUNTIME_TEXTS.modeState.browse);

  if (searchInput) {
    searchInput.placeholder = ui.searchPlaceholder || searchInput.placeholder;
  }
  setAttributeById('searchClear', 'aria-label', ui.searchClearAria || ui.searchClearText);
  setAttributeById('searchClear', 'title', ui.searchClearText);

  setAttributeById('categoryTabs', 'aria-label', ui.categoryTabsAriaLabel);
  setTextContentById('status', LIST_UI_TEXT.status.loadingIndex);

  setTextContentById('runtimeErrorPanelTitle', ui.runtimeErrorTitle);
  if (runtimeErrorClearBtnEl) {
    runtimeErrorClearBtnEl.textContent = ui.runtimeErrorClearText || runtimeErrorClearBtnEl.textContent;
    setAttributeById('runtimeErrorClearBtn', 'aria-label', ui.runtimeErrorClearAria || ui.runtimeErrorClearText);
  }
  setTextContentById('docLoadRetryBtn', LIST_UI_TEXT.actions.retryText);
  setAttributeById('docLoadRetryBtn', 'aria-label', LIST_UI_TEXT.actions.retryListTitle);

  setAttributeById('leftStats', 'aria-label', ui.leftPanelAriaLabel);
  setTextContentById('leftTotalStatLabel', ui.totalDocsLabel);
  setTextContentById('leftVisibleStatLabel', ui.visibleDocsLabel);
  setAttributeById('leftLegend', 'aria-label', ui.legendAriaLabel);
  setTextContentById('leftLegendTitle', ui.legendTitle);

  if (listEl) {
    listEl.textContent = ui.docListLoadingPlaceholder || LIST_UI_TEXT.status.loadingList;
  }
  setTextContentById('docTypeChip', ui.docTypeChipPlaceholder);
  setTextContentById('docGroupChip', ui.docGroupChipPlaceholder);
  const docPathChipPrefix = ui.docPathChipPrefix || LIST_UI_TEXT.status.pathChipPrefix || '路径';
  const docPathChipSuffix = ui.docPathChipSuffix || '—';
  setTextContentById('docPathChip', `${docPathChipPrefix}：${docPathChipSuffix}`);
  setTextContentById('docTitle', ui.docTitlePlaceholder);
  setTextContentById('docSubtitle', ui.docSubtitlePlaceholder);
  if (editPathEl) {
    editPathEl.textContent = ui.editableSourcePrefixPlaceholder;
  }
  setTextContentById('docEditDirtyIndicator', ui.unsavedIndicatorText);

  if (editCreateBtnEl) {
    editCreateBtnEl.textContent = ui.createButtonText;
  }
  if (editBtnEl) {
    editBtnEl.textContent = ui.editButtonText;
  }
  if (editSaveBtnEl) {
    editSaveBtnEl.textContent = ui.saveButtonText;
  }
  if (editCancelBtnEl) {
    editCancelBtnEl.textContent = ui.cancelButtonText;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.textContent = ui.rebuildIndexButtonText;
  }

  setTextContentById('docCreateTypeLabel', ui.createTypeLabelText);
  setTextContentById('docCreatePathLabel', ui.createPathLabelText);
  setAttributeById('docCreatePathInput', 'placeholder', ui.createPathPlaceholder);

  if (editSourceModeBtnEl) {
    editSourceModeBtnEl.textContent = ui.sourceModeText;
  }
  if (editBlockModeBtnEl) {
    editBlockModeBtnEl.textContent = ui.blockModeText;
  }
  setAttributeById('docSourceEditor', 'placeholder', ui.editorPlaceholderText);
  setTextContentById('docContent', ui.contentPlaceholderText);

  setTextContentById('docSaveConflictDialogTitle', ui.conflictDialogTitle);
  setTextContentById('docSaveConflictReloadBtn', ui.conflictReloadActionText);
  setTextContentById('docSaveConflictKeepBtn', ui.conflictKeepActionText);
  setTextContentById('docSaveConflictForceBtn', ui.conflictForceActionText);
  setTextContentById('docSaveConflictCancelBtn', ui.conflictCancelActionText);
}

function createListErrorSummaryNode(totalErrorCount, errorCountsByContext) {
  if (!totalErrorCount) {
    return null;
  }
  const detailsNode = document.createElement('details');
  const summaryNode = document.createElement('summary');
  const bodyNode = document.createElement('div');
  const listNode = document.createElement('ul');
  const maxVisibleEntries = LIST_ERROR_SUMMARY_VISIBLE_ENTRIES;

  detailsNode.className = 'doc-list-error-summary';
  summaryNode.className = 'doc-list-error-summary-title';
  summaryNode.textContent = `${LIST_ERROR_SUMMARY_TEXTS.label}：${totalErrorCount}${LIST_ERROR_SUMMARY_TEXTS.unitLabel}`;
  bodyNode.className = 'doc-list-error-summary-body';

  const sortedEntries = [...errorCountsByContext.entries()].sort((a, b) => b[1] - a[1]);
  const visibleEntries = sortedEntries.slice(0, maxVisibleEntries);
  const hiddenEntries = sortedEntries.slice(maxVisibleEntries);

  for (const [context, count] of visibleEntries) {
    const listItem = document.createElement('li');
    listItem.textContent = LIST_ERROR_SUMMARY_TEXTS.countTemplate(context, count);
    listNode.appendChild(listItem);
  }

  if (hiddenEntries.length) {
    const moreItem = document.createElement('li');
    const moreNode = document.createElement('details');
    const moreSummary = document.createElement('summary');
    const moreList = document.createElement('ul');

    moreNode.className = 'doc-list-error-summary-more';
    moreSummary.className = 'doc-list-error-summary-more-title';
    moreSummary.textContent = `${LIST_ERROR_SUMMARY_TEXTS.moreLabel} ${hiddenEntries.length} ${LIST_ERROR_SUMMARY_TEXTS.moreSuffix}`;

    for (const [context, count] of hiddenEntries) {
      const listItem = document.createElement('li');
      listItem.textContent = LIST_ERROR_SUMMARY_TEXTS.countTemplate(context, count);
      moreList.appendChild(listItem);
    }

    moreNode.appendChild(moreSummary);
    moreNode.appendChild(moreList);
    moreItem.className = 'doc-list-error-summary-more-item';
    moreItem.appendChild(moreNode);
    listNode.appendChild(moreItem);
  }

  bodyNode.appendChild(listNode);
  detailsNode.appendChild(summaryNode);
  detailsNode.appendChild(bodyNode);
  if (totalErrorCount <= LIST_ERROR_SUMMARY_AUTO_OPEN_THRESHOLD) {
    detailsNode.open = true;
  }
  return detailsNode;
}

function showLoadRetry(statusMessage, listMessage, mode = 'normal') {
  setStatusText(statusMessage);
  if (listMessage) {
    setListText(listMessage);
  }
  if (loadRetryBtnEl) {
    const isForceMode = mode === 'force';
    loadRetryBtnEl.hidden = false;
    loadRetryBtnEl.classList.remove('is-hidden');
    loadRetryBtnEl.disabled = false;
    loadRetryBtnEl.classList.remove('is-loading');
    loadRetryBtnEl.dataset.retryMode = isForceMode ? 'force' : 'normal';
    loadRetryBtnEl.textContent = isForceMode ? LIST_UI_TEXT.actions.retryForceText : LIST_UI_TEXT.actions.retryText;
  }
}

function hideLoadRetry() {
  if (loadRetryBtnEl) {
    loadRetryBtnEl.hidden = true;
    loadRetryBtnEl.classList.add('is-hidden');
    loadRetryBtnEl.classList.remove('is-loading');
    loadRetryBtnEl.disabled = false;
  }
}

function setLoadingState(stateText, listText) {
  setStatusText(stateText);
  if (listText) {
    setListText(listText);
  }
}

async function retryLoadData({ forceCacheBust = false } = {}) {
  if (loadRetryBtnEl) {
    loadRetryBtnEl.disabled = true;
    loadRetryBtnEl.classList.add('is-loading');
  }
  setLoadingState(LIST_UI_TEXT.status.retryIndex, LIST_UI_TEXT.status.retryLoading);
  hideLoadRetry();
  await loadData({
    isRetryAttempt: true,
    forceCacheBust,
  });
}

function getDataIndexUrlCandidates() {
  const candidates = [DATA_INDEX_URL];
  const currentLocation = new URL(location.href);
  const webPrefix = new URL('/web/data/index.json', currentLocation).href;
  const rootPrefix = new URL('/data/index.json', currentLocation.origin).href;

  if (webPrefix !== DATA_INDEX_URL) {
    candidates.push(webPrefix);
  }
  if (rootPrefix !== DATA_INDEX_URL && rootPrefix !== webPrefix) {
    candidates.push(rootPrefix);
  }
  return candidates;
}

function parseRetryAfterSeconds(rawRetryAfter = '') {
  const normalized = normalizeDisplayValue(rawRetryAfter);
  if (!normalized) {
    return 0;
  }

  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.max(1, Math.floor(numericValue));
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isNaN(timestamp)) {
    const deltaSeconds = Math.floor((timestamp - Date.now()) / 1000);
    return Math.max(1, deltaSeconds);
  }

  return 0;
}

function summarizeRequestAttempts(attempts = [], options = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return '';
  }
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.floor(options.maxEntries)) : 3;
  const label = normalizeDisplayValue(options.label || '请求尝试');
  const normalizedItems = attempts
    .map((entry) => {
      const normalizedEntry = entry && typeof entry === 'object' ? entry : {};
      const url = normalizeDisplayValue(normalizedEntry.url);
      if (!url) {
        return '';
      }
      const statusText = normalizeDisplayValue(normalizedEntry.statusText || '');
      const status = typeof normalizedEntry.status === 'number' ? String(normalizedEntry.status) : '';
      const attemptTime = normalizeDisplayValue(normalizedEntry.timestamp || '');
      const suffixParts = [status, statusText, normalizedEntry.message || '', attemptTime]
        .map((item) => normalizeDisplayValue(item))
        .filter(Boolean);
      const suffix = suffixParts.length ? `（${normalizedEntry.ok ? '成功' : '失败'}：${suffixParts.join(' ')}）` : `${normalizedEntry.ok ? '（成功）' : '（失败）'}`;
      return `${url}${suffix}`;
    })
    .filter(Boolean)
    .slice(0, maxEntries);

  if (normalizedItems.length === 0) {
    return '';
  }
  return `${label}：${normalizedItems.join('；')}${attempts.length > maxEntries ? `；…共${attempts.length}次` : ''}`;
}

function enrichRequestError(error, attempts = [], fallbackMessage = '') {
  const fallback = normalizeDisplayValue(fallbackMessage);
  const normalizedError = error && error instanceof Error
    ? error
    : new Error(fallback || APP_ERROR_MESSAGES.requestInvalidResponse);
  if (Array.isArray(attempts) && attempts.length) {
    normalizedError.attempts = attempts;
  }
  if (!normalizedError.message && fallback) {
    normalizedError.message = fallback;
  }
  return normalizedError;
}

function getFriendlyRequestError(error, options = {}) {
  if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean') {
    return normalizeDisplayValue(error);
  }

  const payloadMessage = extractRequestErrorPayloadMessage(error);
  if (error?.name === 'SyntaxError') {
    return APP_ERROR_MESSAGES.requestInvalidResponse;
  }
  if (!error) {
    return APP_ERROR_MESSAGES.serviceUnavailable;
  }
  if (error.name === 'AbortError') {
    return APP_ERROR_MESSAGES.requestTimeout;
  }
  if (error.name === 'TypeError') {
    return APP_ERROR_MESSAGES.serviceUnavailable;
  }
  if (typeof error?.status === 'number') {
    const status = error.status;
    if (status === 401) {
      const details = APP_ERROR_MESSAGES.requestUnauthorizedHint;
      return details ? `${APP_ERROR_MESSAGES.requestUnauthorized}，${details}` : APP_ERROR_MESSAGES.requestUnauthorized;
    }
    if (status === 403) {
      const details = APP_ERROR_MESSAGES.requestForbiddenHint;
      return details ? `${APP_ERROR_MESSAGES.requestForbidden}，${details}` : APP_ERROR_MESSAGES.requestForbidden;
    }
    if (status === 429) {
      const retryAfterText = parseRetryAfterSeconds(error?.retryAfter);
      const rateLimitedTemplate = APP_ERROR_MESSAGES.requestRateLimitedHint;
      const hint = typeof rateLimitedTemplate === 'function'
        ? rateLimitedTemplate(retryAfterText)
        : APP_ERROR_MESSAGES.requestRateLimitedHint;
      return `${APP_ERROR_MESSAGES.requestRateLimited}，${hint}`;
    }
    if (status === 413) {
      return APP_ERROR_MESSAGES.requestPayloadTooLarge;
    }
    if (status >= 500 && status < 600) {
      const hint = APP_ERROR_MESSAGES.requestServerErrorHint;
      return hint ? `${APP_ERROR_MESSAGES.requestServerError}，${hint}` : APP_ERROR_MESSAGES.requestServerError;
    }
  }
  const message = normalizeDisplayValue(error.message || '');
  const attemptSummary = summarizeRequestAttempts(error?.attempts, options);
  if (!message) {
    return attemptSummary
      ? `${APP_ERROR_MESSAGES.requestInvalidResponse}（${attemptSummary}）`
      : APP_ERROR_MESSAGES.requestInvalidResponse;
  }
  if (!payloadMessage || message.includes(payloadMessage)) {
    return attemptSummary ? `${message}（${attemptSummary}）` : message;
  }
  return attemptSummary
    ? `${message}（${payloadMessage}；${attemptSummary}）`
    : `${message}（${payloadMessage}）`;
}

function getFriendlyLoadErrorMessage(error) {
  return getFriendlyRequestError(error);
}

function logRuntimeError(context, error) {
  const contextText = normalizeDisplayValue(context) || APP_ERROR_MESSAGES.runtimeContextDefault;
  const message = getFriendlyRequestError(error);
  if (!message || !runtimeErrorPanelEl || !runtimeErrorListEl) {
    return message;
  }

  const statusText = typeof error?.status === 'number'
    ? `HTTP ${error.status}`
    : (typeof error?.status === 'string' && error.status.trim() ? error.status : '');
  const payloadMessage = extractRequestErrorPayloadMessage(error);
  const details = [];
  if (statusText) {
    details.push(statusText);
  }
  if (error?.statusText) {
    details.push(error.statusText);
  }
  if (payloadMessage) {
    details.push(payloadMessage);
  }
  if (error?.message && !String(error.message).includes(message)) {
    details.push(error.message);
  }
  const attemptSummary = summarizeRequestAttempts(error?.attempts, { maxEntries: 5 });
  if (attemptSummary) {
    details.push(attemptSummary);
  }
  const retrySummary = summarizeAttemptFailureMeta(error?.attempts);
  if (retrySummary) {
    details.push(retrySummary);
  }

  const fingerprint = `${contextText}||${message}`;
  const existingIndex = runtimeErrorLog.findIndex((item) => item.fingerprint === fingerprint);
  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    const existing = runtimeErrorLog.splice(existingIndex, 1)[0];
    runtimeErrorLog.unshift({
      ...existing,
      count: (existing.count || 1) + 1,
      lastAt: now,
      details: details.join('；') || existing.details,
    });
  } else {
    runtimeErrorLog.unshift({
      context: contextText,
      message,
      details: details.join('；'),
      count: 1,
      at: now,
      lastAt: now,
      fingerprint,
    });
    if (runtimeErrorLog.length > RUNTIME_ERROR_PANEL_LIMIT) {
      runtimeErrorLog = runtimeErrorLog.slice(0, RUNTIME_ERROR_PANEL_LIMIT);
    }
  }

  renderRuntimeErrorPanel();
  return message;
}

function renderRuntimeErrorPanel() {
  if (!runtimeErrorPanelEl || !runtimeErrorListEl) {
    return;
  }
  if (!runtimeErrorLog.length) {
    runtimeErrorPanelEl.hidden = true;
    runtimeErrorPanelEl.classList.add('is-hidden');
    runtimeErrorListEl.textContent = '';
    if (runtimeErrorClearBtnEl) {
      runtimeErrorClearBtnEl.disabled = true;
    }
    return;
  }

  runtimeErrorPanelEl.hidden = false;
  runtimeErrorPanelEl.classList.remove('is-hidden');
  if (runtimeErrorClearBtnEl) {
    runtimeErrorClearBtnEl.disabled = false;
  }

  runtimeErrorListEl.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (const item of runtimeErrorLog) {
    const node = document.createElement('div');
    const summary = document.createElement('div');
    const context = document.createElement('div');
    const detail = document.createElement('div');
    const countText = item.count > 1 ? `（x${item.count}）` : '';
    const timeText = item.lastAt ? ` · ${item.lastAt.replace('T', ' ').replace(/\..*$/, '')}` : '';

    node.className = 'runtime-error-item';
    summary.className = 'runtime-error-item-summary';
    summary.textContent = `${item.context}: ${item.message}${countText}${timeText}`;
    context.className = 'runtime-error-item-context';
    context.textContent = item.context;
    detail.className = 'runtime-error-item-detail';
    detail.textContent = item.details || '';

    node.appendChild(context);
    node.appendChild(summary);
    node.appendChild(detail);
    fragment.appendChild(node);
  }

  runtimeErrorListEl.appendChild(fragment);
}

function clearRuntimeErrors() {
  runtimeErrorLog = [];
  renderRuntimeErrorPanel();
}

function logRuntimeErrorOrMessage(context, error) {
  return error ? logRuntimeError(context, error) : '';
}

function extractRequestErrorPayloadMessage(error) {
  const payload = error?.payload;
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload?.msg === 'string' && payload.msg.trim()) {
    return payload.msg.trim();
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0];
    if (typeof firstError === 'string' && firstError.trim()) {
      return firstError.trim();
    }
    if (firstError && typeof firstError === 'object' && typeof firstError?.message === 'string' && firstError.message.trim()) {
      return firstError.message.trim();
    }
  }
  return '';
}


function getStoredCreateType(defaultType = 'hero') {
  try {
    const rawType = normalizeCreateType(typeof window !== 'undefined' && window.localStorage
      ? localStorage.getItem(CREATE_TYPE_LOCAL_STORAGE_KEY)
      : '');
    return rawType || defaultType;
  } catch {
    return defaultType;
  }
}

function setStoredCreateType(type = '') {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    const normalizedType = normalizeCreateType(type);
    if (!normalizedType) {
      localStorage.removeItem(CREATE_TYPE_LOCAL_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CREATE_TYPE_LOCAL_STORAGE_KEY, normalizedType);
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

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
    APP_ERROR_MESSAGES.saveConflictHeader(latestLabel),
    APP_ERROR_MESSAGES.saveConflictOptions.loadLatest,
    APP_ERROR_MESSAGES.saveConflictOptions.keepDraft,
    APP_ERROR_MESSAGES.saveConflictOptions.forceSave,
  ].join('\n');
}

function renderForceConfirmMessagePayload(conflictPayload) {
  const currentVersion = normalizeEditSessionVersion(conflictPayload?.currentVersion);
  const lastModified = typeof conflictPayload?.lastModified === 'string' ? conflictPayload.lastModified : '';
  const latestLabel = lastModified
    ? `${formatVersionForConflict(currentVersion)}（${lastModified}）`
    : formatVersionForConflict(currentVersion);

  return [
    APP_ERROR_MESSAGES.forceSaveConfirmMessages.confirmTitle,
    `${APP_ERROR_MESSAGES.forceSaveConfirmMessages.versionLabelPrefix}${latestLabel}`,
    APP_ERROR_MESSAGES.forceSaveConfirmMessages.overwriteWarn,
    APP_ERROR_MESSAGES.forceSaveConfirmMessages.finalConfirm,
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
  saveConflictDialogForceBtnEl.textContent = isForceConfirm
    ? APP_ERROR_MESSAGES.forceSaveConfirmMessages.forceButton
    : APP_ERROR_MESSAGES.forceSaveActionButton;
  saveConflictDialogEl.classList.toggle('doc-conflict-force', isForceConfirm);
  if (saveConflictDialogTitleEl) {
    saveConflictDialogTitleEl.classList.toggle('doc-conflict-dialog-title-danger', isForceConfirm);
  }
  if (saveConflictDialogWarningEl) {
    saveConflictDialogWarningEl.classList.toggle('is-hidden', !isForceConfirm);
    if (isForceConfirm) {
      saveConflictDialogWarningEl.textContent = APP_ERROR_MESSAGES.forceSaveConfirmMessages.forceWarning;
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

  saveConflictDialogTitleEl.textContent = mode === 'force'
    ? APP_ERROR_MESSAGES.forceSaveConfirmTitle
    : APP_ERROR_MESSAGES.saveConflictTitle;
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
      setEditorStatus(`${APP_ERROR_MESSAGES.readLatestSourceFailure}：${reloaded.error}`);
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
    setEditorStatus(APP_ERROR_MESSAGES.conflictReloadMessage);
    return 'reload';
  }

  if (normalizedAction === '2') {
    setEditorStatus(APP_ERROR_MESSAGES.conflictKeepDraftMessage);
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

function confirmDiscardUnsavedChanges(message = APP_ERROR_MESSAGES.unsavedConfirmDefault) {
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
    modeEditBtnEl.disabled = false;
    modeEditBtnEl.setAttribute('aria-disabled', state.editBackendAvailable ? 'false' : 'true');
  }
  if (modeStateEl) {
    if (isEditMode) {
      if (!state.editBackendAvailable) {
        modeStateEl.textContent = getEditModeUnavailableText();
      } else if (!activeDoc) {
        modeStateEl.textContent = APP_RUNTIME_TEXTS.modeState.editNoDoc;
      } else if (activeDocEditable) {
        modeStateEl.textContent = APP_RUNTIME_TEXTS.modeState.editActive;
      } else {
        modeStateEl.textContent = APP_RUNTIME_TEXTS.modeState.editDocReadonly;
      }
    } else if (state.editBackendAvailable) {
      modeStateEl.textContent = APP_RUNTIME_TEXTS.modeState.browse;
    } else {
      modeStateEl.textContent = getEditModeUnavailableText();
    }
  }
  if (modeSwitchEl && !state.editBackendAvailable) {
    modeEditBtnEl?.setAttribute('title', getEditModeUnavailableText());
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
    if (!confirmDiscardUnsavedChanges(APP_ERROR_MESSAGES.discardUnsavedModeExit)) {
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
    modeStateEl.textContent = getEditModeUnavailableText();
  }

  syncDocListEditPermissions();
}

async function detectEditBackend() {
  const detection = await detectEditBackendAvailability({
    capabilitiesUrl: DOC_CAPABILITIES_URL,
    healthUrl: DOC_HEALTH_URL,
    requestTimeoutMs: CAPABILITIES_REQUEST_TIMEOUT_MS,
    requestLabel: APP_REQUEST_LABELS.detectEditCapability,
  });
  const normalizedDetection = normalizeEditBackendState(detection);
  detectedEditBackendState = normalizedDetection;
  state.editBackendAvailable = Boolean(normalizedDetection.available);
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

function getCreateTypeLabel(type = '') {
  return CATEGORY_LABELS[type] || type || APP_RUNTIME_TEXTS.list.otherFallback;
}

function getCreateTypeDisplayList() {
  const available = createTypeOrder.filter((type) => Boolean(getDocTemplate(type)));
  if (available.length > 0) {
    return available;
  }
  return ['hero'];
}

function getCreateDefaultNameByType(type = '') {
  const template = getDocTemplate(type);
  if (!template) {
    return APP_RUNTIME_TEXTS.create.defaultName;
  }
  if (APP_RUNTIME_TEXTS.create[type]) {
    return APP_RUNTIME_TEXTS.create[type];
  }
  return template.templateSource && template.templateSource.includes('场景')
    ? APP_RUNTIME_TEXTS.create.fallbackSceneByTemplateSource
    : `${APP_RUNTIME_TEXTS.create.prefix}${getCreateTypeLabel(type)}`;
}

function normalizeCreateType(rawType = '') {
  const normalized = normalizeDisplayValue(rawType).toLowerCase();
  return getCreateTypeDisplayList().includes(normalized)
    ? normalized
    : getCreateTypeDisplayList()[0];
}

function splitCreateSourcePath(sourcePath = '') {
  const normalizedSourcePath = normalizeCreatePathValue(sourcePath).replace(/^docs-standard\//, '');
  return normalizedSourcePath
    .split('/')
    .filter(Boolean);
}

function splitDesignSourcePath(sourcePath = '') {
  const segments = splitCreateSourcePath(sourcePath);
  if (segments[0] === 'design-data' && segments[1]) {
    return {
      domain: segments[1],
      chain: segments.slice(2),
    };
  }
  return {
    domain: segments[0] || '',
    chain: segments.slice(1),
  };
}

function getCreateTypeBasePath(createType = '', referenceSourcePath = '') {
  const type = normalizeCreateType(createType);
  const { chain } = splitDesignSourcePath(referenceSourcePath);
  const baseSegment = chain[0] || '';
  const subSegment = chain.length >= 3 ? chain[1] : '';

  if (type === 'hero') {
    return `design-data/design-heros/${baseSegment || '力量'}/`;
  }
  if (type === 'item') {
    return `design-data/design-item/${baseSegment || '基础'}/${subSegment || '通用'}/`;
  }
  if (type === 'skill') {
    return `design-data/design-skills/${baseSegment || '主动'}/`;
  }
  if (type === 'unit') {
    return `design-data/design-units/${baseSegment || '中立'}/`;
  }
  if (type === 'building') {
    return 'design-data/design-building/';
  }
  if (type === 'backstory') {
    return `design-data/backstory/${baseSegment || '故事'}/`;
  }
  if (type === 'scene') {
    return 'design-data/design-scenes/';
  }
  if (type === 'rule') {
    return 'design-data/design-rules/';
  }
  if (type === 'template') {
    return 'design-data/design-template/';
  }

  return 'design-data/';
}

function getCreateDefaultTypeFromActiveContext() {
  const activeDoc = getDocByPath(state.activePath);
  if (activeDoc && activeDoc.category && DOC_TYPE_TEMPLATE_DEFS[activeDoc.category]) {
    return normalizeCreateType(activeDoc.category);
  }

  const persistedType = getStoredCreateType('hero');
  if (persistedType) {
    return persistedType;
  }

  const tabType = normalizeCreateType(state.activeTab);
  if (createTypeOrder.includes(tabType)) {
    return tabType;
  }

  if (state.activeTab === 'item') {
    return 'item';
  }

  if (state.activeTab === 'hero') {
    return 'hero';
  }

  return 'hero';
}

function renderCreateTypeOptions() {
  if (!createTypeSelectEl) {
    return;
  }
  const types = getCreateTypeDisplayList();
  const previousType = normalizeCreateType(createTypeSelectEl.value || state.activeCreateType);
  createTypeSelectEl.innerHTML = types
    .map((type) => `<option value="${type}">${getCreateTypeLabel(type)}</option>`)
    .join('');
  const nextType = types.includes(previousType) ? previousType : types[0] || '';
  createTypeSelectEl.value = nextType;
  state.activeCreateType = nextType || 'hero';
}

function getCreateTypeTemplateContent(type = '') {
  const definition = getDocTemplate(normalizeCreateType(type));
  if (!definition || !definition.templateSource) {
    return '';
  }
  return normalizeCreatePathValue(definition.templateSource);
}

function getCreateTypeTemplateCacheKey(type = '') {
  return getCreateTypeTemplateContent(type) || '';
}

function getCreateTemplateContentPath(type = '') {
  const templateSource = getCreateTypeTemplateCacheKey(type);
  if (!templateSource) {
    return '';
  }
  return `/${templateSource}`;
}

async function loadCreateTypeTemplate(type = '') {
  const normalizedType = normalizeCreateType(type);
  const templatePath = getCreateTemplateContentPath(normalizedType);

  if (!templatePath) {
    return '';
  }

  if (createTemplateCache.has(templatePath)) {
    return createTemplateCache.get(templatePath);
  }

  try {
    const content = await loadTemplateContent({
      templatePath,
      requestTimeoutMs: DATA_INDEX_REQUEST_TIMEOUT_MS,
      requestLabel: APP_REQUEST_LABELS.templateLoad,
    });
    createTemplateCache.set(templatePath, content);
    createTemplateLoadErrorCache.delete(templatePath);
    return content;
  } catch (error) {
    createTemplateLoadErrorCache.set(templatePath, logRuntimeErrorOrMessage(APP_REQUEST_LABELS.templateLoad, error));
    createTemplateCache.set(templatePath, '');
    return '';
  }
}

async function applyCreateTemplate(type = '') {
  if (!editEditorEl) {
    return;
  }
  const normalizedType = normalizeCreateType(type);
  const templatePath = getCreateTemplateContentPath(normalizedType);
  const templateContent = await loadCreateTypeTemplate(normalizedType);
  editEditorEl.value = templateContent;
  syncEditSessionBaseline();
  if (createTypeSelectEl) {
    createTypeSelectEl.value = normalizedType;
  }
  state.activeCreateType = normalizedType;

  if (templateContent === '' && createTemplateLoadErrorCache.has(templatePath) && isInEditSession()) {
    setEditorStatus(`${APP_ERROR_MESSAGES.templateLoadFallback}：${createTemplateLoadErrorCache.get(templatePath)}`);
  }
}

async function setCreateTypeState(type = '', options = {}) {
  const normalizedType = normalizeCreateType(type);
  const nextType = normalizedType;
  const referenceSourcePath = options.referenceSourcePath || '';
  const shouldLoadTemplate = options.loadTemplate !== false;

  state.activeCreateType = nextType;
  if (createTypeSelectEl) {
    createTypeSelectEl.value = nextType;
  }

  const pathSeed = referenceSourcePath || getSourcePath(getDocByPath(state.activePath)) || '';
  const suggestedPath = getSuggestedCreatePath(pathSeed, nextType);
  const finalPath = setCreatePath(suggestedPath, '', true);

  if (editPathEl) {
    editPathEl.textContent = `${APP_RUNTIME_TEXTS.create.sourcePrefix}${getCreateTypeLabel(nextType)}${APP_RUNTIME_TEXTS.create.sourceTypeSuffix}${finalPath}`;
  }
  state.activeCreatePath = finalPath;

  if (shouldLoadTemplate && isInEditSession()) {
    await applyCreateTemplate(nextType);
  }
  setStoredCreateType(nextType);

  return {
    type: nextType,
    path: finalPath,
  };
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

function getSuggestedCreatePath(sourcePath = '', createType = 'hero') {
  const base = getCreateTypeBasePath(createType, sourcePath) || 'design-data/';
  const defaultName = getCreateDefaultNameByType(createType);
  const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').replace(/Z$/, '');
  return `${base}${defaultName}_${timestamp}.txt`;
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
    return APP_ERROR_MESSAGES.createPathValidation.absolutePath;
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return APP_ERROR_MESSAGES.createPathValidation.dotSegment;
  }
  if (!normalizedPath.startsWith('design-data/')
    && !normalizedPath.startsWith('docs-standard/design-data/')) {
    return APP_ERROR_MESSAGES.createPathValidation.basePrefix;
  }
  if (normalizedPath.endsWith('/')) {
    return APP_ERROR_MESSAGES.createPathValidation.trailingSlash;
  }
  if (/[<>:"|?*]/.test(normalizedPath)) {
    return APP_ERROR_MESSAGES.createPathValidation.invalidChars;
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
      editRebuildBtnEl.textContent = `${APP_ERROR_MESSAGES.rebuildInProgress} ${elapsedText}`;
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
    editBlockEditorEl.innerHTML = `<div class="doc-edit-status">${APP_RUNTIME_TEXTS.editBlock.noBlockHint}</div>`;
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
    label.textContent = `${APP_RUNTIME_TEXTS.editBlock.blockTypePrefix} ${index + 1} ${APP_RUNTIME_TEXTS.editBlock.blockTypeSeparator} ${block.type || APP_RUNTIME_TEXTS.editBlock.defaultBlockType}`;
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
    editBtnEl.textContent = APP_RUNTIME_TEXTS.editButtons.editText;
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
  if (createTypeWrapEl) {
    createTypeWrapEl.classList.add('is-hidden');
  }
  if (createPathInputEl) {
    createPathInputEl.value = '';
    createPathInputEl.placeholder = APP_ERROR_MESSAGES.createPathPlaceholder;
    createPathInputEl.classList.remove('is-invalid');
  }
  if (createTypeSelectEl) {
    createTypeSelectEl.value = getCreateTypeDisplayList()[0] || '';
  }
  state.activeCreateType = getCreateTypeDisplayList()[0] || 'hero';
}

const NEW_SKILL_MARKERS = /^(?:获得新技能|新增技能|新增被动技能|新增主动技能|新增额外技能)$/;

function updateSearchClearState() {
  if (!searchClearEl) {
    return;
  }
  searchClearEl.classList.toggle('is-visible', searchInput.value.trim().length > 0);
}

function categoryLabel(category) {
  return CATEGORY_LABELS[getDisplayCategory({ category })] || CATEGORY_LABELS[category] || category || APP_RUNTIME_TEXTS.list.otherFallback;
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
    leftLegendBodyEl.innerHTML = `<span class="left-legend-item">${APP_RUNTIME_TEXTS.listMeta.noMatchStatus}</span>`;
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
  heading.textContent = APP_RUNTIME_TEXTS.heroSkill.heading;
  card.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'hero-skill-list';

  for (const item of entries) {
    const row = document.createElement('div');
    row.className = 'hero-skill-row';

    const media = document.createElement('div');
    media.className = 'hero-skill-media';
    const iconLabel = normalizeDisplayValue(item.name || item.key || APP_RUNTIME_TEXTS.heroSkill.fallbackName);
    const fallbackIconPath = getHeroSkillImagePlaceholderPath(doc, iconLabel);
    const fallbackIconDataUrl = getNameAvatarDataUrl(iconLabel);
    const applyFallback = (imgEl) => {
      if (imgEl.dataset.placeholderLoaded === '1') {
        return;
      }
      imgEl.dataset.placeholderLoaded = '1';
      if (fallbackIconPath) {
        imgEl.src = new URL(fallbackIconPath, ASSET_BASE_URL).href;
      } else {
        imgEl.src = fallbackIconDataUrl;
      }
      imgEl.onerror = () => {
        if (imgEl.dataset.placeholderFallbacked === '1') {
          return;
        }
        imgEl.dataset.placeholderFallbacked = '1';
        imgEl.src = fallbackIconDataUrl;
      };
    };
    if (item.icon) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = new URL(item.icon, ASSET_BASE_URL).href;
      img.alt = `${item.name || item.key || APP_RUNTIME_TEXTS.heroSkill.fallbackName}${APP_RUNTIME_TEXTS.heroSkill.mediaImageAltSuffix}`;
      img.onerror = () => applyFallback(img);
      media.appendChild(img);
    } else {
      const placeholder = document.createElement('img');
      placeholder.className = 'hero-skill-empty';
      placeholder.loading = 'lazy';
      if (fallbackIconPath) {
        placeholder.src = new URL(fallbackIconPath, ASSET_BASE_URL).href;
      } else {
        placeholder.src = fallbackIconDataUrl;
      }
      placeholder.alt = `${iconLabel || APP_RUNTIME_TEXTS.heroSkill.fallbackName} ${APP_RUNTIME_TEXTS.heroSkill.mediaPlaceholderSuffix}`;
      placeholder.onerror = () => applyFallback(placeholder);
      media.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'hero-skill-info';

    const title = document.createElement('div');
    title.className = 'text-title';
    title.textContent = `${item.key || APP_RUNTIME_TEXTS.heroSkill.sectionKeyDefault}：${item.name}`;

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
  const removeTitles = new Set(APP_RUNTIME_TEXTS.heroSkill.duplicateSectionTitles || []);
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

function renderGallery(images, fallbackLabel = APP_RUNTIME_TEXTS.heroSkill.mediaFallbackLabel) {
  if (!galleryEl) {
    return;
  }
  galleryEl.innerHTML = '';
  if (!images || images.length === 0) {
    return;
  }

  for (const url of images) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = url;
    applyImageFallbackChain(img, [url], fallbackLabel);
    galleryEl.appendChild(img);
  }
}

function renderMeta(doc) {
  metaEl.innerHTML = '';
  const category = getDisplayCategory(doc);
  titleEl.textContent = doc.meta?.title || doc.title || doc.name;

  if (typeChipEl) {
    typeChipEl.textContent = `${APP_RUNTIME_TEXTS.listMeta.typeLabelPrefix}${CATEGORY_LABELS[category] || category || APP_RUNTIME_TEXTS.list.otherFallback}`;
    typeChipEl.className = `doc-chip ${CATEGORY_TAG[category] || 'other'}`;
  }

  if (groupChipEl) {
    if (doc.group) {
      groupChipEl.textContent = `${LIST_UI_TEXT.status.groupChipPrefix}：${doc.group}`;
      groupChipEl.hidden = false;
    } else {
      groupChipEl.textContent = '';
      groupChipEl.hidden = true;
    }
  }

  if (pathChipEl) {
    pathChipEl.textContent = `${LIST_UI_TEXT.status.pathChipPrefix}：${doc.path || '-'}`;
  }

  if (subtitleEl) {
    const sourceCategory = CATEGORY_LABELS[category] || category || APP_RUNTIME_TEXTS.list.otherFallback;
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
  tag.textContent = `${APP_RUNTIME_TEXTS.listMeta.typeLabelPrefix}${CATEGORY_LABELS[category] || APP_RUNTIME_TEXTS.list.otherFallback}`;
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
  const normalizedMessage = normalizeDisplayValue(message);
  if (!editStatusEl || editStatusEl.textContent === normalizedMessage) {
    return;
  }
  editStatusEl.textContent = normalizedMessage;
  editStatusEl.className = normalizedMessage ? 'doc-edit-status is-visible' : 'doc-edit-status';
}

function setEditButtons({ isEditing, isCreating, canEdit }) {
  const editModeAvailable = isEditModeActive();
  const isCreateMode = !!isCreating;
  const saveText = isCreateMode ? APP_REQUEST_LABELS.createDoc : APP_REQUEST_LABELS.saveDoc;
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
    if (createTypeWrapEl) {
      createTypeWrapEl.classList.add('is-hidden');
    }
    if (docEditorWrapEl) {
      docEditorWrapEl.hidden = true;
    }
    if (editEditorEl) {
      editEditorEl.disabled = true;
    }
    if (editPathEl) {
      editPathEl.textContent = APP_RUNTIME_TEXTS.editPath.noBackend;
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
    editBtnEl.textContent = isEditing ? APP_RUNTIME_TEXTS.editButtons.returnText : APP_RUNTIME_TEXTS.editButtons.editText;
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

  if (createTypeWrapEl) {
    createTypeWrapEl.classList.toggle('is-hidden', !isCreateMode);
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

async function enterCreateMode() {
  if (!isEditModeActive()) {
    return;
  }
  if (state.isEditing && state.isCreating) {
    return;
  }
  if (state.isEditing) {
    if (!confirmDiscardUnsavedChanges(APP_ERROR_MESSAGES.discardUnsavedCreate)) {
      return;
    }
    exitEditMode();
  }

  const activeDoc = getDocByPath(state.activePath);
  const baseSourcePath = canUserEditDoc(activeDoc || {})
    ? getSourcePath(activeDoc || {})
    : 'design-data/';
  const defaultCreateType = getCreateDefaultTypeFromActiveContext();
  const suggestedPath = getSuggestedCreatePath(baseSourcePath, defaultCreateType);

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
  const createState = await setCreateTypeState(defaultCreateType, {
    referenceSourcePath: baseSourcePath,
    loadTemplate: true,
  });
  state.activeCreatePath = createState?.path || getCreateInputPath() || suggestedPath;
  updateCreatePathValidation();
  setEditInputMode('source');
  contentEl.classList.add('is-hidden');
  contentEl.hidden = true;
  contentEl.classList.toggle('is-empty', false);
  setEditorStatus(APP_ERROR_MESSAGES.createDocHintTemplate(APP_REQUEST_LABELS.createDoc));
}

async function fetchEditableSource(pathValue) {
  if (!isEditModeActive()) {
    return { error: APP_ERROR_MESSAGES.noEditablePath };
  }
  try {
    const payload = await readDocSource({
      docApiUrl: DOC_API_URL,
      pathValue,
      requestTimeoutMs: DATA_INDEX_REQUEST_TIMEOUT_MS,
      requestLabel: APP_REQUEST_LABELS.readSource,
    });
    if (typeof payload?.content !== 'string') {
      return { error: APP_ERROR_MESSAGES.requestInvalidResponse };
    }
    return {
      content: payload.content,
      lastModified: typeof payload?.lastModified === 'string' ? payload.lastModified : '',
      version: normalizeEditSessionVersion(payload?.version),
    };
  } catch (error) {
    return { error: logRuntimeErrorOrMessage(APP_REQUEST_LABELS.readSource, error) };
  }
}

function fillSourcePreview(doc, sourcePath, options = {}) {
  const sourceContent = typeof doc._sourceCachedText === 'string' ? doc._sourceCachedText : getEditableFallbackContent(doc);
  const sourceVersion = typeof doc._sourceVersion === 'string' ? doc._sourceVersion : '';
  if (editPathEl) {
    editPathEl.textContent = sourcePath
      ? `${APP_RUNTIME_TEXTS.editPath.sourcePrefix}${sourcePath}`
      : `${APP_RUNTIME_TEXTS.editPath.sourcePrefix}${APP_RUNTIME_TEXTS.editPath.sourceMissing}`;
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
    const payload = await writeDoc({
      docApiUrl: DOC_API_URL,
      pathValue: sourcePath,
      content,
      isCreate: true,
      requestTimeoutMs: DATA_INDEX_REQUEST_TIMEOUT_MS,
      requestLabel: APP_REQUEST_LABELS.createDoc,
    });

    const createdSource = sourcePath;
    const createdVersion = normalizeEditSessionVersion(payload?.version);
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
    const payload = error?.payload || null;
    const payloadErrorCode = getWriteErrorCode(payload?.error || payload?.message || '');
    const requestMessage = getFriendlyRequestError(error);
    const message = payloadErrorCode === DOC_WRITE_ERROR_ALREADY_EXISTS
      ? APP_ERROR_MESSAGES.createPathExists
      : payloadErrorCode === DOC_WRITE_ERROR_MISSING_CONTENT
        ? APP_ERROR_MESSAGES.saveMissingContent
        : payloadErrorCode === DOC_WRITE_ERROR_BAD_PATH || error?.status === 400
          ? `${APP_REQUEST_LABELS.createDoc}失败：${requestMessage}`
          : `${APP_REQUEST_LABELS.createDoc}失败：${logRuntimeErrorOrMessage(APP_REQUEST_LABELS.createDoc, error) || requestMessage}`;
    setEditorStatus(message);
    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = false;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
    return;
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
      throw new Error(APP_ERROR_MESSAGES.lockVersionMissing);
    }
    const payload = await writeDoc({
      docApiUrl: DOC_API_URL,
      pathValue: sourcePath,
      content,
      expectedVersion,
      force: forceOverwrite,
      requestTimeoutMs: DATA_INDEX_REQUEST_TIMEOUT_MS,
      requestLabel: APP_REQUEST_LABELS.saveDoc,
    });

    if (payload?.currentVersion) {
      const latestVersion = normalizeEditSessionVersion(payload.currentVersion);
      if (latestVersion) {
        state.activeEditSourceVersion = latestVersion;
      }
    }
    doc._sourceCachedText = content;
    doc._sourceRenderedText = content;
    doc._renderSignature = makeDocRenderSignature(doc);
    setEditorStatus(APP_ERROR_MESSAGES.saveSuccess);
    setEditSessionClean(content, payload?.version);
    doc._sourceVersion = normalizeEditSessionVersion(payload?.version);
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
    const payload = error?.payload || null;
    const payloadErrorCode = getWriteErrorCode(payload?.error || payload?.message || '');
    if (
      error?.status === 409
      && !forceOverwrite
      && payloadErrorCode === DOC_WRITE_ERROR_CONFLICT
      && payload?.currentVersion
    ) {
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
        setEditorStatus(APP_ERROR_MESSAGES.saveConflictCancelled);
        if (editSaveBtnEl) {
          editSaveBtnEl.disabled = false;
        }
        if (editRebuildBtnEl) {
          editRebuildBtnEl.disabled = false;
        }
        return;
      }
    }
    if (error?.status === 409 && !forceOverwrite && payloadErrorCode === DOC_WRITE_ERROR_MISSING_EXPECTED_VERSION) {
      setEditorStatus(APP_ERROR_MESSAGES.lockVersionMissing);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }
    if (error?.status === 404 && payloadErrorCode === DOC_WRITE_ERROR_DOC_NOT_FOUND) {
      setEditorStatus(APP_ERROR_MESSAGES.saveDocMissing);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }
    if (error?.status === 400 && payloadErrorCode === DOC_WRITE_ERROR_MISSING_CONTENT) {
      setEditorStatus(APP_ERROR_MESSAGES.saveMissingContent);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }
    const requestMessage = getFriendlyRequestError(error);
    const message = error?.status === 409
      ? `${APP_ERROR_MESSAGES.saveConflict}：${requestMessage}`
        : `${APP_REQUEST_LABELS.saveDoc}失败：${logRuntimeErrorOrMessage(APP_REQUEST_LABELS.saveDoc, error) || requestMessage}`;
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
    await rebuildDocIndex({
      rebuildUrl: DOC_REBUILD_URL,
      sourceFilter: rebuildFilter,
      requestTimeoutMs: DATA_INDEX_REQUEST_TIMEOUT_MS,
      requestLabel: APP_REQUEST_LABELS.rebuildIndex,
    });

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
    setEditorStatus(`${APP_ERROR_MESSAGES.rebuildSuccess}${APP_ERROR_MESSAGES.rebuildElapsedTemplate(elapsed)}`);
  } catch (error) {
    const message = logRuntimeErrorOrMessage(APP_REQUEST_LABELS.rebuildIndex, error) || getFriendlyRequestError(error);
    setEditorStatus(`${APP_REQUEST_LABELS.rebuildIndex}失败：${message}`);
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
  if (!options.skipUnsavedConfirm && isInEditSession() && !confirmDiscardUnsavedChanges(APP_ERROR_MESSAGES.discardUnsavedEditExit)) {
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
  doc._renderSignature = makeDocRenderSignature(doc);
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
      editPathEl.textContent = APP_RUNTIME_TEXTS.editPath.browseMode;
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
      editPathEl.textContent = APP_RUNTIME_TEXTS.editPath.nonEditableDoc;
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
    const rawPath = button.dataset.path || '';
    if (!rawPath) {
      continue;
    }
    const buttonMeta = getDocListButtonMeta(rawPath);
    const textWrap = buttonMeta?.textWrap || null;
    let permissionTag = buttonMeta?.permissionTag || null;
    const cachedState = buttonMeta?.editPermissionState || button.dataset.editPermission || 'hidden';

    if (!showGranularEditState) {
      if (cachedState !== 'hidden') {
        button.dataset.editPermission = 'hidden';
        button.classList.remove('doc-item-readonly');
        button.classList.remove('doc-item-editable');
        if (permissionTag) {
          permissionTag.remove();
          permissionTag = null;
          setDocListButtonMeta(rawPath, {
            permissionTag: null,
            editPermissionState: 'hidden',
          });
        }
      }
      if (buttonMeta && buttonMeta.editPermissionState !== 'hidden') {
        buttonMeta.editPermissionState = 'hidden';
      }
      continue;
    }

    const path = button.dataset.pathKey || rawPath;
    const itemDoc = getDocByPath(path);
    if (!itemDoc) {
      if (cachedState !== 'hidden') {
        button.dataset.editPermission = 'hidden';
        button.classList.remove('doc-item-readonly');
        button.classList.remove('doc-item-editable');
        if (permissionTag) {
          permissionTag.remove();
          permissionTag = null;
          setDocListButtonMeta(rawPath, {
            permissionTag: null,
            editPermissionState: 'hidden',
          });
        } else {
          setDocListButtonMeta(rawPath, {
            editPermissionState: 'hidden',
          });
        }
      } else if (buttonMeta?.editPermissionState !== 'hidden') {
        buttonMeta.editPermissionState = 'hidden';
      }
      continue;
    }

    const editable = itemDoc ? canUserEditDoc(itemDoc) : false;
    const nextState = editable ? 'editable' : 'readonly';

    if (cachedState === nextState) {
      if (permissionTag && editable) {
        const nextClassName = 'doc-item-edit-access is-editable';
        const nextLabel = APP_RUNTIME_TEXTS.listMeta.permissionEditable;
        if (permissionTag.textContent !== nextLabel || permissionTag.className !== nextClassName) {
          permissionTag.textContent = nextLabel;
          permissionTag.className = nextClassName;
        }
      } else if (permissionTag && !editable) {
        const nextClassName = 'doc-item-edit-access is-readonly';
        const nextLabel = APP_RUNTIME_TEXTS.listMeta.permissionReadonly;
        if (permissionTag.textContent !== nextLabel || permissionTag.className !== nextClassName) {
          permissionTag.textContent = nextLabel;
          permissionTag.className = nextClassName;
        }
      } else if (!permissionTag && textWrap) {
        permissionTag = document.createElement('div');
        permissionTag.className = editable ? 'doc-item-edit-access is-editable' : 'doc-item-edit-access is-readonly';
        permissionTag.textContent = editable ? APP_RUNTIME_TEXTS.listMeta.permissionEditable : APP_RUNTIME_TEXTS.listMeta.permissionReadonly;
        textWrap.appendChild(permissionTag);
        setDocListButtonMeta(rawPath, { permissionTag });
      }

      if (buttonMeta) {
        buttonMeta.editPermissionState = nextState;
      } else {
        setDocListButtonMeta(rawPath, { editPermissionState: nextState });
      }
      continue;
    }

    button.dataset.editPermission = nextState;
    if (itemDoc) {
      button.classList.toggle('doc-item-editable', editable);
      button.classList.toggle('doc-item-readonly', !editable);
    }

    if (!permissionTag && textWrap) {
      permissionTag = document.createElement('div');
      permissionTag.className = editable ? 'doc-item-edit-access is-editable' : 'doc-item-edit-access is-readonly';
      permissionTag.textContent = editable ? APP_RUNTIME_TEXTS.listMeta.permissionEditable : APP_RUNTIME_TEXTS.listMeta.permissionReadonly;
      textWrap.appendChild(permissionTag);
      setDocListButtonMeta(rawPath, { permissionTag });
    } else if (permissionTag) {
      const nextClassName = editable ? 'doc-item-edit-access is-editable' : 'doc-item-edit-access is-readonly';
      const nextLabel = editable ? APP_RUNTIME_TEXTS.listMeta.permissionEditable : APP_RUNTIME_TEXTS.listMeta.permissionReadonly;
      if (permissionTag.textContent !== nextLabel || permissionTag.className !== nextClassName) {
        permissionTag.textContent = nextLabel;
        permissionTag.className = nextClassName;
      }
    }

    if (buttonMeta) {
      buttonMeta.editPermissionState = nextState;
    } else {
      setDocListButtonMeta(rawPath, { editPermissionState: nextState });
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
  if (!doc || !contentEl) {
    return;
  }

  const contentPath = normalizeDisplayValue(doc.path);
  const mode = getContentRenderMode(doc);
  const contentSignature = `${mode}::${getDocRenderSignature(doc)}`;

  if (
    renderedContentDocPath === contentPath
    && renderedContentSignature === contentSignature
  ) {
    if (mode === 'card-only') {
      contentEl.classList.add('is-empty');
      contentEl.style.display = 'none';
    } else {
      contentEl.style.display = '';
      contentEl.classList.remove('is-empty');
    }
    return;
  }

  if (typeof doc?._sourceRenderedText === 'string') {
    contentEl.classList.remove('is-empty');
    contentEl.style.display = '';
    contentEl.textContent = doc._sourceRenderedText;
    renderedContentDocPath = contentPath;
    renderedContentSignature = contentSignature;
    return;
  }

  try {
    contentEl.style.display = '';
    contentEl.innerHTML = '';

    if (mode === 'card-only') {
      contentEl.classList.add('is-empty');
      contentEl.style.display = 'none';
      renderedContentDocPath = contentPath;
      renderedContentSignature = contentSignature;
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
        renderedContentDocPath = contentPath;
        renderedContentSignature = contentSignature;
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
      renderedContentDocPath = contentPath;
      renderedContentSignature = contentSignature;
      return;
    }

    contentEl.classList.remove('is-empty');
    renderedContentDocPath = contentPath;
    renderedContentSignature = contentSignature;
  } catch (error) {
    const message = logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.contentRender, error) || getFriendlyRequestError(error);
    contentEl.classList.remove('is-empty');
    contentEl.style.display = '';
    contentEl.textContent = `${LIST_UI_TEXT.labels.pathSuffixError}：${message}`;
    renderedContentDocPath = '';
    renderedContentSignature = '';
    setEditorStatus(`${LIST_UI_TEXT.labels.renderFailedStatus}：${message}`);
  }
}


function renderList(groups) {
  const currentRenderId = ++listRenderToken;
  resetDocListButtonCache();
  if (listRenderFrameId) {
    cancelAnimationFrame(listRenderFrameId);
    listRenderFrameId = 0;
  }
  if (!listEl) {
    listRenderFrameId = 0;
    return {
      errorCount: 0,
      errorSummary: '',
    };
  }
  clearListSkeletonState();
  listEl.innerHTML = '';
  const renderedErrorOccurrence = new Map();
  const errorCountsByContext = new Map();
  let listRenderErrorCount = 0;

  const countListError = (context) => {
    const contextKey = normalizeDisplayValue(context) || LIST_UI_TEXT.errors.unknownEntry;
    const contextStat = errorCountsByContext.get(contextKey) || 0;
    errorCountsByContext.set(contextKey, contextStat + 1);
    listRenderErrorCount += 1;
  };

  if (!(groups instanceof Map) || !groups.size) {
    const msg = lastSearchQuery ? LIST_UI_TEXT.status.noDataByKeyword : LIST_UI_TEXT.status.noDataByTab;
    listEl.innerHTML = `<div class="doc-group">${msg}</div>`;
    markActiveItem();
    return {
      errorCount: 0,
      errorSummary: '',
    };
  }

  const renderNodeError = (context = LIST_UI_TEXT.errors.nodeDefaultContext, error) => {
    logRuntimeErrorOrMessage(`${APP_RUNTIME_TEXTS.runtimeContext.listNode}：${context}`, error);
    const createRetryButton = () => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'doc-btn-small doc-item-retry-btn';
      button.textContent = LIST_UI_TEXT.actions.retryText;
      button.title = LIST_UI_TEXT.actions.retryListTitle;
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setStatusText(LIST_UI_TEXT.status.retryIndex);
        void loadData(state.activePath, {
          isRetryAttempt: true,
          forceCacheBust: true,
        });
      });
      return button;
    };

    const node = document.createElement('div');
    const message = document.createElement('div');
    const retryBtn = createRetryButton();
    const details = document.createElement('details');
    const detailsSummary = document.createElement('summary');
    const detailsBody = document.createElement('pre');
    const detailsText = [];
    const requestErrorText = getFriendlyRequestError(error);
    const statusText = typeof error?.status === 'number'
      ? error.status
      : (typeof error?.status === 'string' && error.status.trim() ? error.status : '');
    const errorFingerprint = `${statusText || ''}||${error?.statusText || ''}||${requestErrorText}`;
    countListError(context);
    const errorOccurrence = renderedErrorOccurrence.get(errorFingerprint);

    if (errorOccurrence) {
      errorOccurrence.count += 1;
      if (errorOccurrence.messageEl) {
        errorOccurrence.messageEl.textContent = `${LIST_UI_TEXT.errors.duplicatePrefix}${errorOccurrence.count}${LIST_UI_TEXT.errors.duplicateSuffix}`;
      }
      return null;
    }

    renderedErrorOccurrence.set(errorFingerprint, { count: 1, node: null, messageEl: message });

    node.className = 'doc-item doc-item-error';
    message.className = 'doc-item-error-message';
    message.textContent = LIST_UI_TEXT.errors.contextLoadFailureTemplate(context, requestErrorText);

    details.className = 'doc-item-error-details';
    detailsSummary.className = 'doc-item-error-summary';
    detailsSummary.textContent = LIST_UI_TEXT.errors.latestErrorLabel;
    details.appendChild(detailsSummary);

    if (statusText) {
      detailsText.push(`${LIST_UI_TEXT.errors.requestCodeLabel}${statusText}`);
    }
    if (error?.statusText) {
      detailsText.push(`${LIST_UI_TEXT.errors.statusLabel}${error.statusText}`);
    }
    if (error?.message && error.message !== requestErrorText) {
      detailsText.push(`${LIST_UI_TEXT.errors.rawMessageLabel}${error.message}`);
    }
    if (Array.isArray(error?.errors) && error.errors.length > 0) {
      const firstError = error.errors[0];
      if (typeof firstError === 'string' && firstError) {
        detailsText.push(`${LIST_UI_TEXT.errors.detailLabel}${firstError}`);
      } else if (firstError && typeof firstError.message === 'string' && firstError.message) {
        detailsText.push(`${LIST_UI_TEXT.errors.detailLabel}${firstError.message}`);
      }
    } else if (error?.payload?.error) {
      detailsText.push(`${LIST_UI_TEXT.errors.detailLabel}${error.payload.error}`);
    } else if (typeof error?.payload === 'string' && error.payload) {
      detailsText.push(`${LIST_UI_TEXT.errors.detailLabel}${error.payload}`);
    }
    if (!detailsText.length) {
      detailsText.push(`${LIST_UI_TEXT.errors.descriptionLabel}${requestErrorText}`);
    }
    detailsBody.className = 'doc-item-error-body';
    detailsBody.textContent = detailsText.join('\n');
    details.appendChild(detailsBody);

    node.appendChild(message);
    node.appendChild(retryBtn);
    node.appendChild(details);
    renderedErrorOccurrence.set(errorFingerprint, {
      count: 1,
      node,
      messageEl: message,
    });
    return node;
  };

  const appendListNode = (nodes, context, error) => {
    const node = renderNodeError(context, error);
    if (node) {
      nodes.push(node);
    }
  };

  const appendNode = (parentNode, context, error) => {
    const node = renderNodeError(context, error);
    if (node) {
      parentNode.appendChild(node);
    }
  };

  const categoryNames = [...groups.keys()].sort((a, b) => {
    const aOrder = CATEGORY_ORDER_INDEX.has(a) ? CATEGORY_ORDER_INDEX.get(a) : Number.MAX_SAFE_INTEGER;
    const bOrder = CATEGORY_ORDER_INDEX.has(b) ? CATEGORY_ORDER_INDEX.get(b) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.localeCompare(b, 'zh-CN');
  });

  const categoryNodes = [];
  const totalCountByCategory = (categoryMap) => [...categoryMap.values()]
    .reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);

  try {
    for (const categoryName of categoryNames) {
      const categoryMap = groups.get(categoryName);
      if (!(categoryMap instanceof Map)) {
        appendListNode(
          categoryNodes,
          `${LIST_UI_TEXT.status.categoryPrefix} ${CATEGORY_LABELS[categoryName] || categoryName}`,
          new Error(APP_RUNTIME_TEXTS.runtimeContext.dataCategoryInvalid),
        );
        continue;
      }

      const totalCount = totalCountByCategory(categoryMap);
      const categoryNode = createDetailsGroup(`${LIST_UI_TEXT.status.categoryPrefix} ${CATEGORY_LABELS[categoryName] || categoryName}`, totalCount, true);

      const groupNames = [...categoryMap.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      for (const groupName of groupNames) {
        const docsInGroup = categoryMap.get(groupName);
        if (!Array.isArray(docsInGroup)) {
          appendNode(categoryNode, `${LIST_UI_TEXT.status.groupPrefix} ${groupName}`, new Error(APP_RUNTIME_TEXTS.runtimeContext.dataGroupInvalid));
          continue;
        }

        const groupNode = createDetailsGroup(groupName, docsInGroup.length, true);
        for (const doc of docsInGroup) {
          try {
            const button = createDocButton(doc, selectDoc, {
              showEditAccess: isEditModeActive(),
              isEditable: canUserEditDoc(doc),
            });
            groupNode.appendChild(button);
          } catch (error) {
            appendNode(groupNode, doc?.name || doc?.path || LIST_UI_TEXT.errors.unknownEntry, error);
          }
        }
        categoryNode.appendChild(groupNode);
      }

      categoryNodes.push(categoryNode);
    }
  } catch (error) {
    logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.listRender, error);
    setStatusText(`${LIST_UI_TEXT.errors.renderFailureText}：${getFriendlyRequestError(error)}`);
    listEl.textContent = `${LIST_UI_TEXT.errors.renderFailureText}：${getFriendlyRequestError(error)}`;
    markActiveItem();
    listRenderFrameId = 0;
    return {
      errorCount: listRenderErrorCount,
      errorSummary: formatListRenderErrorSummary(listRenderErrorCount, errorCountsByContext),
    };
  }

  const listErrorSummaryNode = createListErrorSummaryNode(
    listRenderErrorCount,
    errorCountsByContext,
  );
  if (listErrorSummaryNode) {
    categoryNodes.unshift(listErrorSummaryNode);
  }

  if (categoryNodes.length <= LIST_RENDER_BATCH_SIZE) {
    const fragment = document.createDocumentFragment();
    for (const node of categoryNodes) {
      fragment.appendChild(node);
    }
    listEl.appendChild(fragment);
    markActiveItem();
    listRenderFrameId = 0;
    return {
      errorCount: listRenderErrorCount,
      errorSummary: formatListRenderErrorSummary(listRenderErrorCount, errorCountsByContext),
    };
  }

  let cursor = 0;
  const flushNodes = () => {
    if (currentRenderId !== listRenderToken) {
      listRenderFrameId = 0;
      return;
    }
    if (cursor >= categoryNodes.length) {
      markActiveItem();
      listRenderFrameId = 0;
      return;
    }

    const fragment = document.createDocumentFragment();
    const end = Math.min(cursor + LIST_RENDER_BATCH_SIZE, categoryNodes.length);
    try {
      for (let i = cursor; i < end; i += 1) {
        fragment.appendChild(categoryNodes[i]);
      }
      cursor = end;
      listEl.appendChild(fragment);
      listRenderFrameId = requestAnimationFrame(flushNodes);
    } catch (error) {
      logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.listRender, error);
      setStatusText(`${LIST_UI_TEXT.errors.renderFailureText}：${getFriendlyRequestError(error)}`);
      listEl.textContent = `${LIST_UI_TEXT.errors.renderFailureText}：${getFriendlyRequestError(error)}`;
      markActiveItem();
      listRenderFrameId = 0;
      return;
    }
  };

  listRenderFrameId = requestAnimationFrame(flushNodes);
  return {
    errorCount: listRenderErrorCount,
    errorSummary: formatListRenderErrorSummary(listRenderErrorCount, errorCountsByContext),
  };
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
  let listRenderInfo = null;
  if (shouldRenderList) {
    setListSkeletonState(LIST_UI_TEXT.status.renderingList);
    listRenderInfo = renderList(groups);
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
    setStatusText(`${hasKeyword ? LIST_UI_TEXT.status.noDataByKeyword : LIST_UI_TEXT.status.noDataByTab} ${state.generatedStatus}`);
    if (!skipTabs) {
      renderTabsNow();
    }
    return;
  }

  const displayText = LIST_UI_TEXT.status.visibleCountTemplate(filtered.length, state.docs.length);
  const tabText = searchQuery ? LIST_UI_TEXT.status.filteredTagText : '';
  const listErrorSummary = listRenderInfo && listRenderInfo.errorSummary ? listRenderInfo.errorSummary : '';
  setStatusText(`${displayText} ${tabText} ${state.generatedStatus}${listErrorSummary ? ` ${listErrorSummary}` : ''}`);

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

  const targetSignature = getDocRenderSignature(doc);
  const isDifferentDoc = state.activePath !== pathValue;
  const shouldRefreshContent = isDifferentDoc
    || renderedDocRef !== doc
    || renderedDocSignature !== targetSignature;
  if (isDifferentDoc && isInEditSession() && !confirmDiscardUnsavedChanges(APP_ERROR_MESSAGES.discardUnsavedSwitchDoc)) {
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
            const message = logRuntimeErrorOrMessage(APP_REQUEST_LABELS.readSource, error) || getFriendlyRequestError(error);
            setEditorStatus(`${APP_REQUEST_LABELS.readSource}失败：${message}`);
          }
        });
    }
  }

  try {
    renderHeroBanner(doc);
    renderMeta(doc);
    renderSectionCards(doc);
    const heroImages = getHeroImagesForDisplay(doc, doc.heroSkills || []);
    renderGallery(heroImages, doc.meta?.title || doc.title || doc.name || doc.path);
    renderContent(doc);
    updateEditorForDoc(doc);
    setModeUi();
    markActiveItem();
    renderedDocRef = doc;
    renderedDocSignature = targetSignature;
  } catch (error) {
    const message = logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.docSwitchRender, error) || getFriendlyRequestError(error);
    setEditorStatus(`${LIST_UI_TEXT.labels.renderFailedStatus}：${message}`);
    if (contentEl) {
      contentEl.classList.remove('is-empty');
      contentEl.style.display = '';
      contentEl.textContent = `${LIST_UI_TEXT.labels.genericRenderFailed}：${message}`;
    }
  }
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

function makeStableSignature(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => makeStableSignature(item)).join('|')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${key}:${makeStableSignature(value[key])}`)
      .join(',')}}`;
  }
  return '';
}

function makeDocRenderSignature(doc) {
  const sections = Array.isArray(doc.sections)
    ? doc.sections.map((item) => ({
      key: item?.key || '',
      value: item?.value || '',
    }))
    : [];
  const blocks = Array.isArray(doc.blocks)
    ? doc.blocks.map((item) => ({
      type: item?.type || '',
      title: item?.title || '',
      key: item?.key || '',
      value: item?.value || '',
      text: item?.text || '',
    }))
    : [];

  return [
    normalizeMatchValue(doc.path || ''),
    normalizeMatchValue(doc.meta?.title || doc.title || doc.name || ''),
    normalizeMatchValue(getSourcePath(doc)),
    normalizeMatchValue(doc.category || ''),
    normalizeMatchValue(doc.group || ''),
    normalizeMatchValue(doc.type || ''),
    normalizeMatchValue(doc._sourceVersion || doc._sourceLastModified || doc.lastModified || ''),
    normalizeMatchValue(typeof doc.content === 'string' ? doc.content : ''),
    normalizeMatchValue(makeStableSignature(doc.fields || {})),
    normalizeMatchValue(makeStableSignature(sections)),
    normalizeMatchValue(makeStableSignature(blocks)),
    normalizeMatchValue(makeStableSignature(doc.outline || [])),
  ].join('||');
}

function getDocRenderSignature(doc) {
  if (!doc || typeof doc !== 'object') {
    return '';
  }
  if (!doc._renderSignature) {
    doc._renderSignature = makeDocRenderSignature(doc);
  }
  return doc._renderSignature;
}

function normalizeDocFromIndex(doc) {
  if (!doc || typeof doc !== 'object') {
    return null;
  }
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
  doc._sourceCachedText = doc._sourceCachedText === undefined ? undefined : doc._sourceCachedText;
  doc._sourceVersion = normalizeEditSessionVersion(doc._sourceVersion || doc.lastModified || doc._sourceLastModified || '');
  doc._sourceLastModified = doc._sourceLastModified || doc.lastModified || '';
  doc._renderSignature = makeDocRenderSignature(doc);
  return doc;
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
  const isRetryAttempt = Boolean(loadArgs.isRetryAttempt);
  const forceCacheBust = Boolean(loadArgs.forceCacheBust);
  const currentLoadToken = ++dataLoadToken;

  try {
    setLoadingState(LIST_UI_TEXT.status.loadingIndex, LIST_UI_TEXT.status.loadingList);
    setListSkeletonState(LIST_UI_TEXT.status.loadingIndex);
    hideLoadRetry();
    const indexUrls = getDataIndexUrlCandidates();
    const { payload, lastError, attempts } = await loadDocIndexPayload({
      indexUrlCandidates: indexUrls,
      forceCacheBust,
      requestTimeoutMs: DATA_INDEX_REQUEST_TIMEOUT_MS,
      requestLabel: APP_REQUEST_LABELS.loadDocIndex,
    });

    if (!payload) {
      throw enrichRequestError(
        lastError,
        attempts,
        APP_RUNTIME_TEXTS.runtimeContext.indexLoadFailed,
      );
    }

    if (currentLoadToken !== dataLoadToken) {
      clearListSkeletonState();
      return;
    }

    state.docs = payload?.docs || payload?.state?.docs || [];
    if (!Array.isArray(state.docs)) {
      throw new Error(APP_RUNTIME_TEXTS.runtimeContext.indexFormatInvalid);
    }
    state.docs = state.docs.map((doc) => normalizeDocFromIndex(doc)).filter(Boolean);
    hideLoadRetry();
    if (currentLoadToken !== dataLoadToken) {
      clearListSkeletonState();
      return;
    }

    rebuildDocPathCaches(state.docs);
    getSearchIndex(state.docs, true);

    cachedTabCounts = getTabCounts();
    cachedListRenderState = {
      filtered: null,
      activeTab: '',
      groups: null,
    };
    renderedDocSignature = '';
    renderedContentDocPath = '';
    renderedContentSignature = '';
    renderedDocRef = null;
    cachedListGroups.source = null;
    cachedListGroups.activeTab = '';
    cachedListGroups.filtered = null;
    cachedListGroups.groups = null;
    cachedGroupedDocs = new WeakMap();
    state.generatedStatus = APP_ERROR_MESSAGES.generatedStatusTemplate(formatTime(payload.generatedAt));
    renderTabsNow();
    renderFilteredDocs(normalizedPreferredPath || state.activePath, { preferredSourcePath });
    syncDocListEditPermissions();
    lastSearchQuery = getSearchQuery();
    updateSearchClearState();
  } catch (error) {
    if (currentLoadToken !== dataLoadToken) {
      clearListSkeletonState();
      return;
    }
    showLoadRetry(
      `${LIST_UI_TEXT.errors.genericLoadFailureText}：${getFriendlyLoadErrorMessage(error)}`,
      `${LIST_UI_TEXT.errors.loadFailureText}：${getFriendlyLoadErrorMessage(error)}${LIST_UI_TEXT.errors.loadFailureSuffix}`,
      isRetryAttempt && forceCacheBust ? 'force' : (isRetryAttempt ? 'force' : 'normal'),
    );
    logRuntimeErrorOrMessage(APP_REQUEST_LABELS.loadDocIndex, error);
  }
}

async function initApp() {
  setStaticUiTexts();

  setStatusText(LIST_UI_TEXT.status.initializing);
  setListText(LIST_UI_TEXT.status.initializingList);

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

  if (loadRetryBtnEl) {
    loadRetryBtnEl.addEventListener('click', () => {
      void retryLoadData();
    });
  }

  if (runtimeErrorClearBtnEl) {
    runtimeErrorClearBtnEl.addEventListener('click', () => {
      clearRuntimeErrors();
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
      void enterCreateMode();
    });
  }

  if (createTypeSelectEl) {
    createTypeSelectEl.addEventListener('change', async () => {
      if (!state.isCreating) {
        return;
      }
      if (state.editHasUnsavedChanges && !confirmDiscardUnsavedChanges(APP_RUNTIME_TEXTS.createTypeSwitchConfirm)) {
        createTypeSelectEl.value = state.activeCreateType;
        return;
      }
      await setCreateTypeState(createTypeSelectEl.value, {
        referenceSourcePath: getSourcePath(getDocByPath(state.activePath)) || 'design-data/',
        loadTemplate: true,
      });
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
    createPathInputEl.addEventListener('keydown', (event) => {
      if (!state.isCreating) {
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        updateCreatePathValidation(true);
        if (state.isCreatePathValid) {
          void saveCurrentDoc();
        }
      }
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
      if (!state.editBackendAvailable) {
        void (async () => {
          if (modeEditBtnEl) {
            modeEditBtnEl.disabled = true;
          }
          setEditorStatus(getEditModeUnavailableText());
          await detectEditBackend();
          setModeUi();
          if (state.editBackendAvailable) {
            setMode('edit', { persist: true });
          } else {
            setEditorStatus(getEditModeUnavailableText());
          }
          if (modeEditBtnEl) {
            modeEditBtnEl.disabled = false;
          }
        })();
        return;
      }
      setMode('edit', { persist: true });
    });
  }

  if (editEditorEl) {
    editEditorEl.addEventListener('keydown', (event) => {
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveCurrentDoc();
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void saveCurrentDoc();
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (event) => {
      const error = event.error || event.message || event.type;
      logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.globalError, error);
    });

    window.addEventListener('unhandledrejection', (event) => {
      logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.unhandledPromise, event?.reason);
    });

    window.addEventListener('keydown', (event) => {
      if (!saveConflictDialogEl || saveConflictDialogEl.classList.contains('is-hidden')) {
        return;
      }
      if (event.key === '1') {
        event.preventDefault();
        resolveSaveConflictAction('1');
        return;
      }
      if (event.key === '2') {
        event.preventDefault();
        resolveSaveConflictAction('2');
        return;
      }
      if (event.key === '3') {
        event.preventDefault();
        resolveSaveConflictAction('3');
        return;
      }
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
  state.activeCreateType = getStoredCreateType(state.activeCreateType);
  renderCreateTypeOptions();
  setEditorPanelVisibility(false);
  try {
    await detectEditBackend();
    setMode(resolveInitialMode());
    await loadData();
  } catch (error) {
    const message = logRuntimeErrorOrMessage(APP_RUNTIME_TEXTS.runtimeContext.init, error) || getFriendlyRequestError(error);
    setStatusText(`${LIST_UI_TEXT.status.initFailed}：${message}`);
    setListText(LIST_UI_TEXT.status.initListFailure);
    if (modeStateEl) {
      modeStateEl.textContent = LIST_UI_TEXT.status.initFailed;
    }
    console.error('[doc-site] initApp failed', error);
  }
}

export { initApp };
