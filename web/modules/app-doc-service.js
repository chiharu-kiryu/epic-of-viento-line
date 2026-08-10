import { API_PATHS, API_REQUEST_KEYS, DOC_CAPABILITIES_FIELDS } from '../../scripts/lib/doc-api-contract.mjs';
import { fetchJsonApiRequest, fetchTextApiRequest, withCacheBust } from './app-services.js';
import { APP_ERROR_MESSAGES, APP_REQUEST_LABELS } from './app-state.js';

const DOC_API_TOKEN_STORAGE_KEY = 'doc-api-token';

function normalizeApiToken(value = '') {
  if (typeof value !== 'string') {
    return '';
  }

  const token = value
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '');
  return token;
}

function getStoredApiToken() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return '';
  }

  return normalizeApiToken(localStorage.getItem(DOC_API_TOKEN_STORAGE_KEY));
}

function withAuthHeaders(options = {}) {
  const token = getStoredApiToken();
  if (!token) {
    return options;
  }

  const headers = options.headers && typeof options.headers === 'object'
    ? { ...options.headers }
    : {};
  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    ...options,
    headers,
  };
}

const DETECT_SOURCE_CAPABILITIES = 'capabilities';
const DETECT_SOURCE_HEALTH = 'health';
const DETECT_SOURCE_UNAVAILABLE = 'unavailable';

function toNormalizedString(value = '') {
  return (value || '').toString().trim();
}

function normalizeStatusCode(status = null) {
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 999) {
    return status;
  }

  const normalizedStatus = toNormalizedString(status);
  if (!normalizedStatus) {
    return 0;
  }

  if (/^\d{3}$/.test(normalizedStatus)) {
    const numericStatus = Number(normalizedStatus);
    return numericStatus >= 100 && numericStatus <= 999 ? numericStatus : 0;
  }

  const matched = normalizedStatus.match(/\b(\d{3})\b/);
  const matchedStatus = matched?.[1] ? Number(matched[1]) : 0;
  return matchedStatus >= 100 && matchedStatus <= 999 ? matchedStatus : 0;
}

function createEditBackendDetectionResult({
  available = false,
  source = DETECT_SOURCE_UNAVAILABLE,
  reason = '',
  reasonText = '',
  status = 0,
  payload = null,
  attempts = [],
}) {
  return {
    available: Boolean(available),
    source,
    reason,
    reasonText,
    status,
    payload,
    attempts,
  };
}

function isUrlUsable(value = '') {
  return typeof value === 'string' && value.trim().length > 0;
}

function toAttemptRecord(url, errorOrResponse, succeeded = false) {
  if (succeeded) {
    return {
      url,
      ok: true,
      status: errorOrResponse?.status || 200,
      statusText: errorOrResponse?.statusText || '',
      timestamp: new Date().toISOString(),
    };
  }

  const status = normalizeStatusCode(errorOrResponse?.status);
  return {
    url,
    ok: false,
    status,
    statusText: errorOrResponse?.statusText || '',
    message: errorOrResponse?.message ? String(errorOrResponse.message) : '',
    name: errorOrResponse?.name || '',
    timestamp: new Date().toISOString(),
  };
}

function normalizeEditBackendResultFromCapabilities(payload) {
  if (!payload || typeof payload !== 'object') {
    return createEditBackendDetectionResult({
      reason: 'capabilities_invalid',
      reasonText: '编辑能力接口返回结构异常',
      source: DETECT_SOURCE_CAPABILITIES,
      payload,
    });
  }

  const capabilities = payload?.[DOC_CAPABILITIES_FIELDS.capabilities];
  if (capabilities && typeof capabilities === 'object' && Object.prototype.hasOwnProperty.call(capabilities, DOC_CAPABILITIES_FIELDS.edit)) {
    const editEnabled = capabilities?.[DOC_CAPABILITIES_FIELDS.edit];
    if (editEnabled === true) {
      return createEditBackendDetectionResult({
        available: true,
        reason: 'available',
        source: DETECT_SOURCE_CAPABILITIES,
        payload,
      });
    }
    return createEditBackendDetectionResult({
      reason: 'capabilities_disabled',
      reasonText: '服务已关闭编辑能力',
      source: DETECT_SOURCE_CAPABILITIES,
      payload,
    });
  }

  const editMode = toNormalizedString(payload?.[DOC_CAPABILITIES_FIELDS.mode]);
  const legacyEditMode = toNormalizedString(payload?.editMode || payload?.EditMode || payload?.MODE);
  const endpoints = Array.isArray(payload?.[DOC_CAPABILITIES_FIELDS.endpoints]) ? payload[DOC_CAPABILITIES_FIELDS.endpoints] : [];
  const hasDocEndpoint = endpoints.includes(API_PATHS.DOC);
  const isOk = payload?.[DOC_CAPABILITIES_FIELDS.ok] === true;
  const resolvedMode = editMode || legacyEditMode;

  if ((resolvedMode === DOC_CAPABILITIES_FIELDS.modeValue && (isOk || hasDocEndpoint)) || (hasDocEndpoint && isOk)) {
    return createEditBackendDetectionResult({
      available: true,
      reason: 'available',
      source: DETECT_SOURCE_CAPABILITIES,
      payload,
    });
  }

  return createEditBackendDetectionResult({
    reason: 'capabilities_missing_edit_flag',
    reasonText: '能力字段缺失，无法确认是否支持编辑',
    source: DETECT_SOURCE_CAPABILITIES,
    payload,
  });
}

function normalizeEditBackendResultFromHealth(payload) {
  if (!payload || typeof payload !== 'object') {
    return createEditBackendDetectionResult({
      reason: 'health_invalid',
      reasonText: '健康检查返回格式异常',
      source: DETECT_SOURCE_HEALTH,
      payload,
    });
  }

  const isHealthy = payload?.ok === true;
  if (!isHealthy) {
    return createEditBackendDetectionResult({
      reason: 'health_unavailable',
      reasonText: '后端健康检查不可用',
      source: DETECT_SOURCE_HEALTH,
      payload,
      status: 200,
    });
  }

  return createEditBackendDetectionResult({
    reason: 'health_no_edit_info',
    reasonText: '检测到健康服务，但未检测到编辑能力字段',
    source: DETECT_SOURCE_HEALTH,
    payload,
    status: 200,
  });
}

export async function detectEditBackendAvailability({
  capabilitiesUrl = '',
  healthUrl = '',
  requestTimeoutMs = 5000,
  requestLabel = APP_REQUEST_LABELS.detectEditCapability,
}) {
  let firstError = null;
  const attempts = [];

  const checkApi = async (url) => {
    const { response, payload } = await fetchJsonApiRequest(
      url,
      { cache: 'no-store' },
      requestTimeoutMs,
      requestLabel,
    );
    attempts.push(toAttemptRecord(url, response, true));
    return payload;
  };

  try {
    const payload = await checkApi(capabilitiesUrl);
    return {
      ...normalizeEditBackendResultFromCapabilities(payload),
      attempts,
    };
  } catch (error) {
    firstError = error || null;
    attempts.push(toAttemptRecord(capabilitiesUrl, firstError, false));
    // fall back to health
  }

  try {
    const payload = await checkApi(healthUrl);
    return {
      ...normalizeEditBackendResultFromHealth(payload),
      attempts,
    };
  } catch (error) {
    attempts.push(toAttemptRecord(healthUrl, error, false));
    const firstErrorStatus = normalizeStatusCode(firstError?.status);
    const currentStatus = normalizeStatusCode(error?.status);

    if (firstErrorStatus === 404 && currentStatus !== 404) {
      return createEditBackendDetectionResult({
        reason: 'capabilities_http_404',
        reasonText: '编辑能力接口不可达，可能未启动可写服务',
        source: DETECT_SOURCE_UNAVAILABLE,
        status: firstErrorStatus || 404,
        attempts,
      });
    }
    const status = normalizeStatusCode(error?.status);
    if (status === 404) {
      return createEditBackendDetectionResult({
        reason: 'capabilities_http_404',
        reasonText: '编辑能力接口不可达，可能未启动可写服务',
        source: DETECT_SOURCE_UNAVAILABLE,
        status,
        attempts,
      });
    }
    return createEditBackendDetectionResult({
      reason: 'service_unreachable',
      reasonText: '文档服务不可达',
      source: DETECT_SOURCE_UNAVAILABLE,
      status,
      attempts,
    });
  }
}

export async function loadDocIndexPayload({
  indexUrlCandidates = [],
  forceCacheBust = false,
  requestTimeoutMs = 10000,
  requestLabel = APP_REQUEST_LABELS.loadDocIndex,
}) {
  let payload = null;
  let lastError = null;
  const attempts = [];

  const validCandidates = indexUrlCandidates.filter(isUrlUsable);
  for (const candidateUrl of validCandidates) {
    const requestUrl = withCacheBust(candidateUrl, forceCacheBust);
    try {
      const response = await fetchJsonApiRequest(
        requestUrl,
        { cache: 'no-store' },
        requestTimeoutMs,
        requestLabel,
      );
      payload = response.payload;
      attempts.push(toAttemptRecord(requestUrl, response, true));
      return {
        payload,
        lastError,
        attempts,
      };
    } catch (error) {
      lastError = error;
      attempts.push(toAttemptRecord(requestUrl, error, false));
    }
  }

  return {
    payload,
    lastError,
    attempts,
  };
}

export async function readDocSource({
  docApiUrl = '',
  pathValue = '',
  requestTimeoutMs = 10000,
  requestLabel = APP_REQUEST_LABELS.readSource,
}) {
  if (!docApiUrl || !pathValue) {
    throw new Error(APP_ERROR_MESSAGES.readDocSourceParamsInvalid);
  }
  const { payload } = await fetchJsonApiRequest(
    `${docApiUrl}?path=${encodeURIComponent(pathValue)}`,
    withAuthHeaders({
      method: 'GET',
    }),
    requestTimeoutMs,
    requestLabel,
  );
  return payload;
}

export async function loadTemplateContent({
  templatePath = '',
  requestTimeoutMs = 10000,
  requestLabel = APP_REQUEST_LABELS.loadTemplate,
}) {
  if (!templatePath) {
    throw new Error(APP_ERROR_MESSAGES.templatePathRequired);
  }

  const normalizedTemplatePath = templatePath.startsWith('/') ? templatePath : `/${templatePath}`;
  const { response, text } = await fetchTextApiRequest(
    normalizedTemplatePath,
    { cache: 'no-store' },
    requestTimeoutMs,
    requestLabel,
  );
  const contentType = response.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) {
    throw new Error(APP_ERROR_MESSAGES.templateInvalidContentType);
  }
  return text;
}

export async function writeDoc({
  docApiUrl = '',
  pathValue = '',
  content = '',
  isCreate = false,
  expectedVersion = '',
  force = false,
  requestTimeoutMs = 10000,
  requestLabel = APP_REQUEST_LABELS.saveDoc,
}) {
  if (!docApiUrl || !pathValue) {
    throw new Error(APP_ERROR_MESSAGES.saveDocParamsInvalid);
  }

  const body = {
    [API_REQUEST_KEYS.path]: pathValue,
    [API_REQUEST_KEYS.content]: content,
  };
  if (isCreate) {
    body[API_REQUEST_KEYS.create] = true;
  }
  if (!isCreate && expectedVersion) {
    body[API_REQUEST_KEYS.expectedVersion] = expectedVersion;
  }
  if (force) {
    body[API_REQUEST_KEYS.force] = true;
  }

  const { payload } = await fetchJsonApiRequest(
    docApiUrl,
    withAuthHeaders({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    requestTimeoutMs,
    requestLabel,
  );
  return payload;
}

export async function rebuildDocIndex({
  rebuildUrl = '',
  sourceFilter = '',
  requestTimeoutMs = 10000,
  requestLabel = APP_REQUEST_LABELS.rebuildIndex,
}) {
  if (!rebuildUrl) {
    throw new Error(APP_ERROR_MESSAGES.rebuildIndexParamsInvalid);
  }

  const body = {
    [API_REQUEST_KEYS.source]: sourceFilter,
  };

  await fetchJsonApiRequest(
    rebuildUrl,
    withAuthHeaders({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    requestTimeoutMs,
    requestLabel,
  );
}
