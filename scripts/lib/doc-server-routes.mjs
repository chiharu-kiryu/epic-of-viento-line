import {
  API_PATHS,
  API_METHODS,
  API_RESPONSE,
  API_RESPONSE_DEFAULTS,
  makeCapabilitiesPayload,
  makeRebuildResponse,
} from './doc-api-contract.mjs';
import {
  readRequestJsonBody,
  sendApiResponse,
  sendApiError,
} from './doc-server.mjs';

function methodNotAllowed(response, allow = 'GET', requestId = '') {
  response.statusCode = 405;
  response.setHeader('Allow', allow);
  sendApiError(response, response.statusCode, 'method not allowed', {
    [API_RESPONSE.errorCode]: API_RESPONSE_DEFAULTS.methodErrorPrefix,
  }, requestId);
  return 405;
}

function isHttpStatus(value, fallback = 500) {
  return Number.isInteger(value) && value >= 100 && value < 600
    ? value
    : fallback;
}

function mapServiceErrorToHttp(error, response, requestId = '') {
  if (error?.statusCode) {
    const statusCode = isHttpStatus(error.statusCode, 400);
    const normalizedErrorCode = typeof error.errorCode === 'string' && error.errorCode.trim()
      ? error.errorCode.trim()
      : '';
    sendApiError(response, statusCode, error.message || 'request rejected', {
      ...(error.payload && typeof error.payload === 'object' ? error.payload : {}),
      ...(normalizedErrorCode ? { [API_RESPONSE.errorCode]: normalizedErrorCode } : {}),
    }, requestId);
    return statusCode;
  }

  const statusCode = 500;
  sendApiError(response, statusCode, error?.message || 'internal error', {
    [API_RESPONSE.errorCode]: API_RESPONSE_DEFAULTS.internalErrorPrefix,
  }, requestId);
  return statusCode;
}

async function handleApiIndex(response, service, requestId = '') {
  try {
    const indexData = await service.getDocIndex();
    sendApiResponse(response, indexData, requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiCapabilities(response, service, requestId = '') {
  try {
    const { editablePrefixes, backstoryMergeMode } = service.getRuntimeConfig();
    sendApiResponse(response, makeCapabilitiesPayload(editablePrefixes, backstoryMergeMode), requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiDocGet(response, requestUrl, service, requestId = '') {
  const rawPath = requestUrl.searchParams.get('path') || '';
  try {
    const data = await service.getDocByPath(rawPath);
    sendApiResponse(response, data, requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiDocWrite(response, request, service, requestId = '') {
  try {
    const payload = await readRequestJsonBody(request);
    const data = await service.writeDoc(payload);
    sendApiResponse(response, data, requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const statusCode = 400;
      sendApiError(response, statusCode, `invalid json: ${error?.message || 'parse error'}`, {
        [API_RESPONSE.errorCode]: API_RESPONSE_DEFAULTS.invalidJsonErrorPrefix,
      }, requestId);
      return statusCode;
    }
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiRebuild(response, request, service, requestId = '') {
  try {
    const payload = await readRequestJsonBody(request);
    const { result, sourceFilter } = await service.runRebuild(payload);
    sendApiResponse(response, makeRebuildResponse(result, sourceFilter), requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const statusCode = 400;
      sendApiError(response, statusCode, `invalid json: ${error?.message || 'parse error'}`, {
        [API_RESPONSE.errorCode]: API_RESPONSE_DEFAULTS.invalidJsonErrorPrefix,
      }, requestId);
      return statusCode;
    }
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiHealth(response, service, requestId = '') {
  try {
    const health = typeof service.getHealth === 'function'
      ? service.getHealth()
      : {
        ok: false,
        status: 'unavailable',
        timestamp: new Date().toISOString(),
      };
    sendApiResponse(response, health, requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiMetrics(response, service, requestId = '') {
  try {
    const metrics = typeof service.getRequestMetricsSnapshot === 'function'
      ? service.getRequestMetricsSnapshot()
      : {};
    sendApiResponse(response, metrics, requestId);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response, requestId);
  }
}

async function handleApiRequest({
  pathname,
  request,
  response,
  requestUrl,
  service,
}) {
  const trace = (service && typeof service.startRequest === 'function')
    ? service.startRequest(pathname, request.method)
    : null;
  const requestId = trace?.requestId || '';

  const route = {
    [API_PATHS.INDEX]: {
      [API_METHODS.GET]: () => handleApiIndex(response, service, requestId),
    },
    [API_PATHS.CAPABILITIES]: {
      [API_METHODS.GET]: () => handleApiCapabilities(response, service, requestId),
    },
    [API_PATHS.HEALTH]: {
      [API_METHODS.GET]: () => handleApiHealth(response, service, requestId),
    },
    [API_PATHS.METRICS]: {
      [API_METHODS.GET]: () => handleApiMetrics(response, service, requestId),
    },
    [API_PATHS.DOC]: {
      [API_METHODS.GET]: () => handleApiDocGet(response, requestUrl, service, requestId),
      [API_METHODS.POST]: () => handleApiDocWrite(response, request, service, requestId),
      [API_METHODS.PUT]: () => handleApiDocWrite(response, request, service, requestId),
    },
    [API_PATHS.REBUILD]: {
      [API_METHODS.POST]: () => handleApiRebuild(response, request, service, requestId),
    },
  };

  const handlers = route[pathname];
  if (!handlers) {
    return false;
  }

  let statusCode = 200;
  try {
    const methodHandler = handlers[request.method];
    if (!methodHandler) {
      const allow = Object.keys(handlers).join(', ');
      statusCode = methodNotAllowed(response, allow, requestId);
      return true;
    }
    statusCode = await methodHandler();
  } catch (error) {
    if (!response.writableEnded) {
      statusCode = 500;
      sendApiError(response, 500, error?.message || 'internal error', {
        [API_RESPONSE.errorCode]: API_RESPONSE_DEFAULTS.internalErrorPrefix,
      }, requestId);
    } else {
      statusCode = isHttpStatus(response.statusCode, 500);
    }
  } finally {
    if (service && typeof service.finishRequest === 'function') {
      service.finishRequest(trace, isHttpStatus(statusCode, response.statusCode));
    }
  }

  return true;
}

export {
  handleApiRequest,
  methodNotAllowed,
};
