import {
  EDIT_ROOT_PREFIXES,
  normalizeStandardizeSourceFilter,
  resolveEditableFilePath,
  buildEditableDocIndex,
} from './doc-server.mjs';
import { PROJECT_ROOT, DOCUMENTS_PATH, reloadWorkspaceManifest } from './paths.mjs';
import { readProjectConfiguration, previewProjectTemplate, saveProjectTemplate } from './project-service.mjs';
import { rebuildIndex } from './rebuild-workflow.mjs';
import { clearHeroImageCache } from './image-index.mjs';
import { listMediaAssets, importMediaAsset } from './media-assets.mjs';
import { prepareMediaInsertion } from './media-insertion.mjs';
import { prepareDocumentFields } from './document-field-draft.mjs';
import { userMessage, userMessageText } from './user-message.mjs';
import { createExportService } from './export-service.mjs';
import {
  makeCapabilitiesPayload,
  API_ERRORS,
  normalizeRebuildRequest,
  normalizeRequestId,
} from './doc-api-contract.mjs';
import { createApiMetrics } from './doc-api-metrics.mjs';
import { createDocumentStore } from '../../engine/document-store.mjs';
import { createError } from '../../engine/service-error.mjs';
import { createNodeDocumentStorage } from '../adapters/node-document-storage.mjs';

const DEFAULT_INDEX_CACHE_TTL_MS = 5000;
let requestSequence = 0;

function createRequestId() {
  requestSequence += 1;
  return normalizeRequestId(`${Date.now()}-${requestSequence}`);
}

function getDefaultIndexCacheTtl(rawTtl) {
  if (typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0) {
    return rawTtl;
  }
  return DEFAULT_INDEX_CACHE_TTL_MS;
}

function createDocumentService(options = {}) {
  const exports = createExportService(PROJECT_ROOT);
  const sharedState = options.state || {};
  const state = {
    rebuildInProgress: false,
    editablePrefixes: Array.isArray(options.editablePrefixes) ? options.editablePrefixes : [`${DOCUMENTS_PATH}/`, `docs-standard/${DOCUMENTS_PATH}/`],
    backstoryMergeMode: options.backstoryMergeMode || 'disabled (default)',
    indexCacheTtlMs: getDefaultIndexCacheTtl(options.indexCacheTtlMs),
    indexCache: null,
    indexCacheAt: 0,
    ...sharedState,
  };
  const indexCache = { value: null, fetchedAt: 0 };
  let indexBuildInFlight = null;
  let indexGeneration = 0;
  const requestMetrics = options.requestMetrics || createApiMetrics();
  const { getDocByPath, writeDoc } = createDocumentStore({
    storage: createNodeDocumentStorage({ root: PROJECT_ROOT, resolvePath: resolveEditableFilePath }),
    editablePrefixes: EDIT_ROOT_PREFIXES,
    onWrite: invalidateIndexCache,
  });

  async function getCapabilities() {
    return makeCapabilitiesPayload(state.editablePrefixes, state.backstoryMergeMode);
  }

  function getRuntimeConfig() {
    return {
      editablePrefixes: [...state.editablePrefixes],
      backstoryMergeMode: state.backstoryMergeMode,
    };
  }

  function isIndexCacheValid() {
    return indexCache.value !== null && state.indexCacheTtlMs > 0
      && (Date.now() - indexCache.fetchedAt) <= state.indexCacheTtlMs;
  }

  function invalidateIndexCache() {
    indexGeneration += 1;
    indexBuildInFlight = null;
    indexCache.value = null;
    indexCache.fetchedAt = 0;
    clearHeroImageCache();
  }

  async function rebuildIndexCache(generation) {
    const index = await buildEditableDocIndex();
    if (generation === indexGeneration) {
      indexCache.value = index;
      indexCache.fetchedAt = Date.now();
    }
    return index;
  }

  async function getDocIndex() {
    if (isIndexCacheValid()) {
      return indexCache.value;
    }
    if (indexBuildInFlight) {
      return indexBuildInFlight;
    }

    const building = rebuildIndexCache(indexGeneration).finally(() => {
      if (indexBuildInFlight === building) indexBuildInFlight = null;
    });
    indexBuildInFlight = building;
    return building;
  }

  function getHealth() {
    const health = {
      ok: true,
      status: state.rebuildInProgress ? 'degraded' : 'healthy',
      timestamp: new Date().toISOString(),
      uptimeMs: Number.isFinite(process.uptime())
        ? Math.round(process.uptime() * 1000)
        : 0,
      rebuildInProgress: Boolean(state.rebuildInProgress),
      indexCacheAt: indexCache.fetchedAt,
      indexCacheMissed: indexCache.value === null,
      backstoryMergeMode: state.backstoryMergeMode,
      editablePrefixes: [...state.editablePrefixes],
      requestMetrics: getRequestMetricsSnapshot(),
    };
    return health;
  }

  function startRequest(route, method) {
    const requestId = createRequestId();
    if (requestMetrics && typeof requestMetrics.startRequest === 'function') {
      return {
        ...requestMetrics.startRequest(route, method),
        requestId,
      };
    }
    return {
      requestId,
      route,
      method,
      startedAtPerf: process.hrtime.bigint(),
      routeBucket: {
        count: 0,
        errorCount: 0,
        totalResponseTimeMs: 0,
        lastStatusCode: 0,
        lastDurationMs: 0,
        lastAt: 0,
      },
    };
  }

  function finishRequest(trace, statusCode) {
    if (requestMetrics && typeof requestMetrics.finishRequest === 'function') {
      requestMetrics.finishRequest(trace, statusCode);
    }
  }

  function getRequestMetricsSnapshot() {
    if (requestMetrics && typeof requestMetrics.getSnapshot === 'function') {
      return requestMetrics.getSnapshot();
    }
    return {
      startedAt: new Date().toISOString(),
      activeRequests: 0,
      totalRequests: 0,
      errorRequests: 0,
      successRequests: 0,
      averageResponseMs: 0,
      statusCodes: {},
      routes: {},
    };
  }

  async function runRebuild(rawPayload = {}) {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)
      || ['source', 'path'].some((key) => rawPayload[key] !== undefined && typeof rawPayload[key] !== 'string')
      || ['runStandardize', 'runBuild'].some((key) => rawPayload[key] !== undefined && typeof rawPayload[key] !== 'boolean')) {
      throw createError(400, 'invalid rebuild request', {}, API_ERRORS.badPath);
    }
    const rebuildRequest = normalizeRebuildRequest(rawPayload);
    const sourceFilter = normalizeStandardizeSourceFilter(rebuildRequest.source);
    if (sourceFilter === null) throw createError(400, API_ERRORS.badPath, {}, API_ERRORS.badPath);
    if (state.rebuildInProgress) {
      throw createError(409, API_ERRORS.rebuildInProgress, {}, API_ERRORS.rebuildInProgress);
    }

    state.rebuildInProgress = true;
    try {
      const result = await rebuildIndex({
        backstoryMode: state.backstoryMergeMode,
        sourceFilter,
        runStandardize: rebuildRequest.runStandardize,
        runBuild: rebuildRequest.runBuild,
      });
      invalidateIndexCache();
      return { result, sourceFilter };
    } finally {
      state.rebuildInProgress = false;
    }
  }

  function getDiagnosticSnapshot() {
    const requestMetricsSnapshot = getRequestMetricsSnapshot();
    return {
      rebuildInProgress: Boolean(state.rebuildInProgress),
      indexCacheAt: indexCache.fetchedAt,
      indexCacheMissed: indexCache.value === null,
      backstoryMergeMode: state.backstoryMergeMode,
      requestCount: requestMetricsSnapshot.totalRequests || 0,
      requestMetrics: requestMetricsSnapshot,
    };
  }

  async function saveProject(payload) {
    if (state.rebuildInProgress) throw createError(409, API_ERRORS.rebuildInProgress);
    state.rebuildInProgress = true;
    try {
      const result = await saveProjectTemplate(PROJECT_ROOT, payload);
      reloadWorkspaceManifest();
      invalidateIndexCache();
      try { await rebuildIndex({ runStandardize: true, runBuild: true }); }
      catch (error) {
        result.indexWarningMessage = userMessage`配置已保存，索引更新失败，请重新构建：${error.payload?.userMessage || error.message}`;
        result.indexWarning = userMessageText(result.indexWarningMessage);
      }
      return result;
    } finally { state.rebuildInProgress = false; }
  }

  return {
    getProject: () => readProjectConfiguration(PROJECT_ROOT),
    previewProject: (payload) => previewProjectTemplate(reloadWorkspaceManifest(), payload),
    saveProject,
    exports,
    getMediaAssets: () => listMediaAssets(PROJECT_ROOT),
    importMediaAsset: (request, name) => importMediaAsset(PROJECT_ROOT, request, name),
    prepareMediaInsertion: (payload) => prepareMediaInsertion(PROJECT_ROOT, payload),
    prepareDocumentFields: (payload) => prepareDocumentFields(PROJECT_ROOT, payload),
    getCapabilities,
    getRuntimeConfig,
    getDocIndex,
    getDocByPath,
    writeDoc,
    runRebuild,
    getHealth,
    startRequest,
    finishRequest,
    getRequestMetricsSnapshot,
    invalidateIndexCache,
    getDiagnosticSnapshot,
  };
}

export {
  createDocumentService,
  createError,
  DEFAULT_INDEX_CACHE_TTL_MS,
};
