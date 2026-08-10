export const API_PATHS = Object.freeze({
  CAPABILITIES: '/api/capabilities',
  HEALTH: '/api/health',
  INDEX: '/api/index',
  DOC: '/api/doc',
  METRICS: '/api/metrics',
  REBUILD: '/api/rebuild',
});

export const API_METHODS = Object.freeze({
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
});

export const API_REQUEST_KEYS = Object.freeze({
  path: 'path',
  content: 'content',
  expectedVersion: 'expectedLastModified',
  expectedLockVersion: 'expectedVersion',
  force: 'force',
  create: 'create',
  source: 'source',
  runStandardize: 'runStandardize',
  runBuild: 'runBuild',
});

export const DOC_CAPABILITIES_FIELDS = Object.freeze({
  ok: 'ok',
  mode: 'mode',
  editablePrefixes: 'editablePrefixes',
  endpoints: 'endpoints',
  backstoryMergeMode: 'backstoryMergeMode',
  version: 'version',
  capabilities: 'capabilities',
  edit: 'edit',
  create: 'create',
  rebuild: 'rebuild',
  okValue: true,
  modeValue: 'edit',
});

export const API_RESPONSE = Object.freeze({
  error: 'error',
  errorCode: 'errorCode',
  requestId: 'requestId',
  data: 'data',
  ok: 'ok',
  source: 'source',
  mode: 'mode',
  performedStandardize: 'performedStandardize',
  performedBuild: 'performedBuild',
  elapsedMs: 'elapsedMs',
  stdout: 'stdout',
  generatedAt: 'generatedAt',
  status: 'status',
  metrics: 'metrics',
  startedAt: 'startedAt',
  message: 'message',
});

export const API_RESPONSE_DEFAULTS = Object.freeze({
  ok: true,
  requestIdPrefix: 'req_',
  methodErrorPrefix: 'method_not_allowed',
  notFoundErrorPrefix: 'not_found',
  internalErrorPrefix: 'internal_error',
  invalidJsonErrorPrefix: 'invalid_json',
});

export const REBUILD_REQUEST_DEFAULTS = Object.freeze({
  runStandardize: true,
  runBuild: true,
});

export const API_ERRORS = Object.freeze({
  badPath: 'bad path',
  missingPath: 'missing path',
  missingContent: 'missing content',
  missingExpectedVersion: 'missing expectedLastModified for existing doc',
  docNotFound: 'document not found',
  conflict: 'document was modified by another client',
  alreadyExists: 'document already exists',
  rebuildInProgress: 'rebuild already in progress',
});

export function normalizeRebuildRequest(rawPayload = {}) {
  const payload = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
  return {
    source: typeof payload[API_REQUEST_KEYS.source] === 'string'
      ? payload[API_REQUEST_KEYS.source]
      : (typeof payload[API_REQUEST_KEYS.path] === 'string' ? payload[API_REQUEST_KEYS.path] : ''),
    runStandardize: payload[API_REQUEST_KEYS.runStandardize] !== false,
    runBuild: payload[API_REQUEST_KEYS.runBuild] !== false,
  };
}

export function normalizeDocWriteRequest(rawPayload = {}) {
  const payload = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
  return {
    path: typeof payload[API_REQUEST_KEYS.path] === 'string' ? payload[API_REQUEST_KEYS.path] : '',
    content: typeof payload[API_REQUEST_KEYS.content] === 'string' ? payload[API_REQUEST_KEYS.content] : undefined,
    expectedVersion: (() => {
      const explicit = payload[API_REQUEST_KEYS.expectedVersion] ?? payload[API_REQUEST_KEYS.expectedLockVersion];
      return (typeof explicit === 'string' || typeof explicit === 'number') ? String(explicit) : '';
    })(),
    force: payload[API_REQUEST_KEYS.force] === true,
    create: payload[API_REQUEST_KEYS.create] === true,
  };
}

export function makeErrorPayload(errorMessage, extra = {}) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return {
      [API_RESPONSE.error]: String(errorMessage || ''),
      ...extra,
    };
  }

  return {
    [API_RESPONSE.error]: errorMessage,
    ...extra,
  };
}

export function makeResponseEnvelope(payload, requestId = '', ok = true, extra = {}) {
  const normalizedRequestId = typeof requestId === 'string'
    ? requestId.trim()
    : '';
  const hasData = extra && Object.prototype.hasOwnProperty.call(extra, API_RESPONSE.data);
  const hasError = extra && Object.prototype.hasOwnProperty.call(extra, API_RESPONSE.error);
  const normalizedExtra = extra && typeof extra === 'object' ? extra : {};

  if (hasData || hasError) {
    return {
      [API_RESPONSE.ok]: ok,
      ...(normalizedRequestId ? { [API_RESPONSE.requestId]: normalizedRequestId } : {}),
      ...normalizedExtra,
    };
  }

  return {
    [API_RESPONSE.ok]: ok,
    [API_RESPONSE.data]: payload,
    ...(normalizedRequestId ? { [API_RESPONSE.requestId]: normalizedRequestId } : {}),
    ...normalizedExtra,
  };
}

export function normalizeRequestId(seed = '') {
  const normalized = typeof seed === 'string' ? seed.trim() : '';
  if (normalized) {
    return normalized;
  }
  return `${API_RESPONSE_DEFAULTS.requestIdPrefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function extractApiDataPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload[API_RESPONSE.ok] !== true) {
    return null;
  }

  return Object.prototype.hasOwnProperty.call(payload, API_RESPONSE.data)
    ? payload[API_RESPONSE.data]
    : payload;
}

export function makeCapabilitiesPayload(editablePrefixes, backstoryMergeMode, version = (typeof process === 'object' && process !== null && typeof process.version === 'string' ? process.version : 'node')) {
  return {
    [DOC_CAPABILITIES_FIELDS.ok]: DOC_CAPABILITIES_FIELDS.okValue,
    [DOC_CAPABILITIES_FIELDS.mode]: DOC_CAPABILITIES_FIELDS.modeValue,
    [DOC_CAPABILITIES_FIELDS.editablePrefixes]: editablePrefixes,
    [DOC_CAPABILITIES_FIELDS.endpoints]: [
      API_PATHS.CAPABILITIES,
      API_PATHS.HEALTH,
      API_PATHS.METRICS,
      API_PATHS.DOC,
      API_PATHS.REBUILD,
      API_PATHS.INDEX,
    ],
    [DOC_CAPABILITIES_FIELDS.backstoryMergeMode]: backstoryMergeMode,
    [DOC_CAPABILITIES_FIELDS.version]: version,
    [DOC_CAPABILITIES_FIELDS.capabilities]: {
      [DOC_CAPABILITIES_FIELDS.edit]: true,
      [DOC_CAPABILITIES_FIELDS.create]: true,
      [DOC_CAPABILITIES_FIELDS.rebuild]: true,
    },
  };
}

export function makeRebuildResponse(result, sourceFilter) {
  return {
    [API_RESPONSE.ok]: true,
    [API_RESPONSE.mode]: result?.mode || 'full',
    [API_RESPONSE.source]: sourceFilter || null,
    [API_RESPONSE.performedStandardize]: Boolean(result?.performedStandardize),
    [API_RESPONSE.performedBuild]: Boolean(result?.performedBuild),
    [API_RESPONSE.generatedAt]: new Date().toISOString(),
    [API_RESPONSE.elapsedMs]: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : 0,
    [API_RESPONSE.message]: `rebuild finished in ${Number.isFinite(result?.elapsedMs) ? result.elapsedMs : 0}ms`,
    [API_RESPONSE.stdout]: mergeStdoutForRebuildResult(result),
  };
}

function mergeStdoutForRebuildResult(result = {}) {
  const chunks = [];
  if (result?.standardize?.stdout) {
    chunks.push(String(result.standardize.stdout));
  }
  if (result?.build?.stdout) {
    chunks.push(String(result.build.stdout));
  }
  return chunks.join('\n');
}
