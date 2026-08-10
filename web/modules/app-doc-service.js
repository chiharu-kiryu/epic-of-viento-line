import { API_REQUEST_KEYS } from '../../scripts/lib/doc-api-contract.mjs';
import { fetchJsonApiRequest, fetchTextApiRequest, withCacheBust } from './app-services.js';
import { APP_ERROR_MESSAGES, APP_REQUEST_LABELS } from './app-state.js';

export async function detectEditBackendAvailability({
  capabilitiesUrl = '',
  healthUrl = '',
  requestTimeoutMs = 5000,
  requestLabel = APP_REQUEST_LABELS.detectEditCapability,
}) {
  const checkApi = async (url) => {
    const { payload } = await fetchJsonApiRequest(
      url,
      { cache: 'no-store' },
      requestTimeoutMs,
      requestLabel,
    );
    return payload;
  };

  try {
    const payload = await checkApi(capabilitiesUrl);
    if (typeof payload === 'object' && payload !== null) {
      const direct = Boolean(payload?.capabilities?.edit);
      const legacy = payload?.editMode === 'edit';
      const modeFlag = direct || legacy;
      return Boolean(modeFlag || payload?.ok);
    }
  } catch {
    // fall back to health
  }

  try {
    const payload = await checkApi(healthUrl);
    if (typeof payload === 'object' && payload !== null) {
      return Boolean(payload?.ok || payload?.alive || payload !== null);
    }
  } catch {
    // keep false when fallback fails
  }

  return false;
}

export async function loadDocIndexPayload({
  indexUrlCandidates = [],
  forceCacheBust = false,
  requestTimeoutMs = 10000,
  requestLabel = APP_REQUEST_LABELS.loadDocIndex,
}) {
  let payload = null;
  let lastError = null;

  for (const candidateUrl of indexUrlCandidates) {
    try {
      const response = await fetchJsonApiRequest(
        withCacheBust(candidateUrl, forceCacheBust),
        { cache: 'no-store' },
        requestTimeoutMs,
        requestLabel,
      );
      payload = response.payload;
      break;
    } catch (error) {
      lastError = error;
      if (error?.status === 404 || error?.status === 403) {
        continue;
      }
      break;
    }
  }

  return { payload, lastError };
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
    {},
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
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
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
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    requestTimeoutMs,
    requestLabel,
  );
}
