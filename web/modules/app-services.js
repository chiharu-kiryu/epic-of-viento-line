export const DEFAULT_INVALID_RESPONSE_MESSAGE = '后端返回了非预期响应格式';

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

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000, timeoutMessage = '请求') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${timeoutMessage}超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
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
  const label = requestLabel || '请求';
  const suffix = responseError ? `${response.status}：${responseError}` : `${response.status}`;
  const error = new Error(`${label}失败（${suffix}）`);
  error.status = response.status;
  error.payload = payload;
  return error;
}

export async function safeParseJsonResponse(response) {
  try {
    if (!response.body) {
      return null;
    }
    const rawText = await response.text();
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
  requestLabel = '请求',
  requireJson = true,
  invalidResponseMessage = DEFAULT_INVALID_RESPONSE_MESSAGE,
) {
  const response = await fetchWithTimeout(
    url,
    options,
    timeoutMs,
    requestLabel,
  );
  const payload = await safeParseJsonResponse(response);
  if (!response.ok) {
    throw makeRequestError(response, payload, requestLabel);
  }
  if (requireJson && payload === null) {
    const error = new Error(invalidResponseMessage);
    error.status = response.status;
    error.payload = payload;
    return Promise.reject(error);
  }

  return {
    response,
    payload,
  };
}

export async function fetchTextApiRequest(
  url,
  options = {},
  timeoutMs = 10000,
  requestLabel = '请求',
) {
  const response = await fetchWithTimeout(
    url,
    options,
    timeoutMs,
    requestLabel,
  );
  const rawText = await response.text();
  const trimmedText = rawText.trim();

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let payload = null;

    if (trimmedText) {
      if (contentType.includes('application/json') || /^[\[{]/.test(trimmedText)) {
        try {
          payload = JSON.parse(trimmedText);
        } catch {
          payload = trimmedText;
        }
      } else {
        payload = trimmedText;
      }
    }

    throw makeRequestError(response, payload, requestLabel);
  }

  return {
    response,
    text: rawText,
  };
}
