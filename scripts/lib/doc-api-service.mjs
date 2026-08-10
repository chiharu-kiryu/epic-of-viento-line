import path from 'node:path';
import fs from 'node:fs/promises';
import {
  safePathFromQuery,
  normalizeLockVersion,
  normalizeStandardizeSourceFilter,
  isAllowedEditPath,
  resolveEditableFilePath,
  readTextFile,
  buildEditableDocIndex,
} from './doc-server.mjs';
import { trimName } from './paths.mjs';
import { rebuildIndex } from './rebuild-workflow.mjs';
import {
  makeCapabilitiesPayload,
  API_ERRORS,
  normalizeRebuildRequest,
  normalizeDocWriteRequest,
  normalizeRequestId,
} from './doc-api-contract.mjs';
import { createApiMetrics } from './doc-api-metrics.mjs';

const DEFAULT_INDEX_CACHE_TTL_MS = 5000;
let requestSequence = 0;

function createRequestId() {
  requestSequence += 1;
  return normalizeRequestId(`${Date.now()}-${requestSequence}`);
}

function createError(statusCode, message, extra = {}, errorCode = '') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.payload = extra;
  error.errorCode = typeof errorCode === 'string' && errorCode ? errorCode : '';
  return error;
}

function getDefaultIndexCacheTtl(rawTtl) {
  if (typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0) {
    return rawTtl;
  }
  return DEFAULT_INDEX_CACHE_TTL_MS;
}

function createDocumentService(options = {}) {
  const sharedState = options.state || {};
  const state = {
    rebuildInProgress: false,
    editablePrefixes: Array.isArray(options.editablePrefixes) ? options.editablePrefixes : ['design-data/', 'docs-standard/design-data/'],
    backstoryMergeMode: options.backstoryMergeMode || 'disabled (default)',
    indexCacheTtlMs: getDefaultIndexCacheTtl(options.indexCacheTtlMs),
    indexCache: null,
    indexCacheAt: 0,
    ...sharedState,
  };
  const indexCache = { value: null, fetchedAt: 0 };
  const requestMetrics = options.requestMetrics || createApiMetrics();

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
    indexCache.value = null;
    indexCache.fetchedAt = 0;
  }

  async function getDocIndex() {
    if (isIndexCacheValid()) {
      return indexCache.value;
    }
    const index = await buildEditableDocIndex();
    indexCache.value = index;
    indexCache.fetchedAt = Date.now();
    return index;
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

  async function getDocByPath(rawPath = '') {
    const filePath = safePathFromQuery(rawPath);
    if (!filePath || !isAllowedEditPath(filePath)) {
      throw createError(400, API_ERRORS.badPath, {}, API_ERRORS.badPath);
    }

    const resolved = await resolveEditableFilePath(filePath);
    if (!resolved) {
      throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
    }

    const content = await readTextFile(resolved.absolutePath);
    if (content === null) {
      throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
    }

    let lastModified = '';
    let version = '';
    try {
      const stats = await fs.stat(resolved.absolutePath);
      lastModified = stats.mtime.toISOString();
      version = String(stats.mtimeMs);
    } catch {
      // keep defaults
    }

    const extension = path.extname(resolved.relativePath).replace('.', '') || 'txt';
    return {
      path: resolved.relativePath,
      type: extension,
      title: trimName(path.basename(resolved.relativePath)),
      content,
      lastModified,
      version,
    };
  }

  async function writeDoc(rawPayload = {}) {
    const normalized = normalizeDocWriteRequest(rawPayload);
    if (!normalized.path) {
      throw createError(400, API_ERRORS.missingPath, {}, API_ERRORS.missingPath);
    }

    const filePath = safePathFromQuery(normalized.path);
    if (!filePath || !isAllowedEditPath(filePath)) {
      throw createError(400, API_ERRORS.badPath, {}, API_ERRORS.badPath);
    }

    if (typeof normalized.content !== 'string') {
      throw createError(400, API_ERRORS.missingContent, {}, API_ERRORS.missingContent);
    }

    const createMode = normalized.create === true;
    const forceOverwrite = normalized.force === true;
    const expectedVersion = normalizeLockVersion(normalized.expectedVersion);
    const resolved = await resolveEditableFilePath(filePath, { allowCreate: createMode });
    if (!resolved) {
      throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
    }

    if (!createMode && !resolved.exists) {
      throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
    }
    if (createMode && resolved.exists) {
      throw createError(409, API_ERRORS.alreadyExists, {}, API_ERRORS.alreadyExists);
    }
    if (!createMode && !expectedVersion && !forceOverwrite) {
      throw createError(409, API_ERRORS.missingExpectedVersion, {}, API_ERRORS.missingExpectedVersion);
    }

    if (!createMode && expectedVersion && !forceOverwrite) {
      try {
        const stats = await fs.stat(resolved.absolutePath);
        const currentVersion = String(stats.mtimeMs);
        if (currentVersion !== expectedVersion) {
          throw createError(409, API_ERRORS.conflict, {
            currentVersion,
            lastModified: stats.mtime.toISOString(),
          }, API_ERRORS.conflict);
        }
      } catch (error) {
        if (error?.statusCode) {
          throw error;
        }
        if (error?.code === 'ENOENT') {
          throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
        }
        throw createError(500, error?.message || 'failed to check version');
      }
    }

    try {
      await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      await fs.writeFile(resolved.absolutePath, normalized.content, 'utf8');
      const stats = await fs.stat(resolved.absolutePath);
      invalidateIndexCache();
      return {
        ok: true,
        path: resolved.relativePath,
        lastModified: stats.mtime.toISOString(),
        version: String(stats.mtimeMs),
      };
    } catch (error) {
      throw createError(500, error?.message || 'failed to save');
    }
  }

  async function runRebuild(rawPayload = {}) {
    if (state.rebuildInProgress) {
      throw createError(409, API_ERRORS.rebuildInProgress, {}, API_ERRORS.rebuildInProgress);
    }

    state.rebuildInProgress = true;
    try {
      const rebuildRequest = normalizeRebuildRequest(rawPayload);
      const sourceFilter = normalizeStandardizeSourceFilter(rebuildRequest.source);
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

  return {
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
