import { API_RESPONSE } from '../../scripts/lib/doc-api-contract.mjs';
import { t } from '../i18n/index.js';

export const DEFAULT_INVALID_RESPONSE_MESSAGE = '后端返回了非预期响应格式';

function parseStatusCode(status = null) {
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 999) {
    return status;
  }
  const normalizedStatus = (status || '').toString().trim();
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

function normalizeRequestUrl(value = '') {
  if (!value) {
    return '';
  }
  const trimmed = value.toString().trim();
  return trimmed;
}

function toRequestAttemptRecord(url = '', errorOrResponse = {}, ok = false) {
  const status = parseStatusCode(errorOrResponse?.status);

  return {
    url: normalizeRequestUrl(url),
    ok,
    status,
    statusText: errorOrResponse?.statusText || '',
    name: errorOrResponse?.name || '',
    message: errorOrResponse?.message || '',
    timestamp: new Date().toISOString(),
  };
}

function attachAttemptRecordToError(error = null, url = '') {
  if (!error || typeof error !== 'object') {
    return error;
  }

  if (Array.isArray(error.attempts) && error.attempts.length > 0) {
    return error;
  }

  error.attempts = [toRequestAttemptRecord(url, error, false)];
  return error;
}

function isApiResponseEnvelope(payload = null) {
  return payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, API_RESPONSE.ok);
}

function unwrapApiPayload(payload = null) {
  if (!isApiResponseEnvelope(payload)) {
    return payload;
  }
  if (payload?.ok === true && Object.prototype.hasOwnProperty.call(payload, API_RESPONSE.data)) {
    return payload[API_RESPONSE.data];
  }
  return payload;
}

export function withCacheBust(url, forceCacheBust = false) {
  if (!forceCacheBust) {
    return url;
  }

  try {
    const urlObject = new URL(url);
    urlObject.searchParams.set('_cacheBust', String(Date.now()));
    return urlObject.toString();
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}_cacheBust=${Date.now()}`;
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000, timeoutMessage = t('请求'), consumeResponse = (response) => response) {
  const controller = new AbortController();
  const callerSignal = options.signal;
  const cancel = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    // fetch resolves at the headers; JSON/template reads must stay inside the
    // same deadline so an incomplete body cannot leave the editor locked.
    return await consumeResponse(response);
  } catch (error) {
    let failure = error;
    if (timedOut) {
      failure = new Error(t`${timeoutMessage}超时（${Math.max(0.1, Math.round(timeoutMs / 100) / 10)} 秒）`, { cause: error });
      failure.name = 'TimeoutError';
    } else if (callerSignal?.aborted) {
      failure = callerSignal.reason;
    }
    attachAttemptRecordToError(failure, url);
    throw failure;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
}

export function extractPayloadErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload.msg === 'string' && payload.msg.trim()) {
    return payload.msg.trim();
  }
  if (typeof payload?.[API_RESPONSE.errorCode] === 'string' && payload[API_RESPONSE.errorCode].trim()) {
    return payload[API_RESPONSE.errorCode].trim();
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    if (typeof first === 'string' && first.trim()) {
      return first.trim();
    }
    if (first && typeof first === 'object' && typeof first.message === 'string' && first.message.trim()) {
      return first.message.trim();
    }
  }
  return '';
}

export function makeRequestError(response, payload, requestLabel) {
  const responseError = extractPayloadErrorMessage(payload);
  const label = requestLabel || t('请求');
  const suffix = responseError ? `${response.status}：${responseError}` : `${response.status}`;
  const headerRequestId = typeof response?.headers?.get === 'function'
    ? response.headers.get('x-request-id')
    : '';
  const payloadRequestId = payload && typeof payload === 'object'
    ? payload[API_RESPONSE.requestId]
    : '';
  const payloadErrorCode = payload && typeof payload === 'object'
    ? payload[API_RESPONSE.errorCode]
    : '';
  const error = new Error(t`${label}失败（${suffix}）`);
  error.status = response.status;
  error.payload = payload;
  error.requestId = typeof payloadRequestId === 'string' && payloadRequestId.trim()
    ? payloadRequestId.trim()
    : (typeof headerRequestId === 'string' ? headerRequestId.trim() : '');
  error.code = typeof payloadErrorCode === 'string'
    ? payloadErrorCode
    : '';
  error.statusText = response.statusText;
  error.retryAfter = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : '';
  error.attempts = [toRequestAttemptRecord(response?.url || response?.requestUrl || '', response, false)];
  return error;
}

export async function safeParseJsonResponse(response) {
  if (!response.body) return null;
  // Reading failures (including aborts) are request failures, not malformed JSON.
  const rawText = await response.text();
  try {
    const trimmedText = rawText.trim();
    if (!trimmedText) {
      return null;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json') && !/^[\[{]/.test(trimmedText)) {
      return null;
    }
    return JSON.parse(trimmedText);
  } catch {
    return null;
  }
}

export async function fetchJsonApiRequest(
  url,
  options = {},
  timeoutMs = 10000,
  requestLabel = t('请求'),
  requireJson = true,
  invalidResponseMessage = t(DEFAULT_INVALID_RESPONSE_MESSAGE),
) {
  return fetchWithTimeout(
    url,
    options,
    timeoutMs,
    requestLabel,
    async (response) => {
      const payload = await safeParseJsonResponse(response);
      const normalizedPayload = unwrapApiPayload(payload);
      if (!response.ok || (isApiResponseEnvelope(payload) && payload?.ok === false)) {
        throw makeRequestError(response, payload, requestLabel);
      }
      if (requireJson && normalizedPayload === null) {
        const error = new Error(invalidResponseMessage);
        error.status = response.status;
        error.payload = payload;
        error.attempts = [toRequestAttemptRecord(response?.url || '', response, false)];
        throw error;
      }
      return { response, payload: normalizedPayload };
    },
  );
}

export async function fetchTextApiRequest(
  url,
  options = {},
  timeoutMs = 10000,
  requestLabel = t('请求'),
) {
  return fetchWithTimeout(
    url,
    options,
    timeoutMs,
    requestLabel,
    async (response) => {
      // Preserve an authored UTF-8 BOM when copying a template into a new file.
      const rawText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
      const trimmedText = rawText.trim();
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let payload = null;
        if (trimmedText) {
          if (contentType.includes('application/json') || /^[\[{]/.test(trimmedText)) {
            try { payload = JSON.parse(trimmedText); }
            catch { payload = trimmedText; }
          } else {
            payload = trimmedText;
          }
        }
        throw makeRequestError(response, payload, requestLabel);
      }
      return { response, text: rawText };
    },
  );
}
