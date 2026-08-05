import {
  API_PATHS,
  API_METHODS,
  makeCapabilitiesPayload,
  makeRebuildResponse,
} from './doc-api-contract.mjs';
import {
  readRequestJsonBody,
  sendApiResponse,
  sendApiError,
} from './doc-server.mjs';

function methodNotAllowed(response, allow = 'GET') {
  response.statusCode = 405;
  response.setHeader('Allow', allow);
  response.end('method not allowed');
  return 405;
}

function isHttpStatus(value, fallback = 500) {
  return Number.isInteger(value) && value >= 100 && value < 600
    ? value
    : fallback;
}

function mapServiceErrorToHttp(error, response) {
  if (error?.statusCode) {
    const statusCode = isHttpStatus(error.statusCode, 400);
    sendApiError(response, statusCode, error.message || 'request rejected', error.payload || {});
    return statusCode;
  }

  const statusCode = 500;
  sendApiError(response, statusCode, error?.message || 'internal error');
  return statusCode;
}

async function handleApiIndex(response, service) {
  try {
    const indexData = await service.getDocIndex();
    sendApiResponse(response, indexData);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiCapabilities(response, service) {
  try {
    const { editablePrefixes, backstoryMergeMode } = service.getRuntimeConfig();
    sendApiResponse(response, makeCapabilitiesPayload(editablePrefixes, backstoryMergeMode));
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiDocGet(response, requestUrl, service) {
  const rawPath = requestUrl.searchParams.get('path') || '';
  try {
    const data = await service.getDocByPath(rawPath);
    sendApiResponse(response, data);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiDocWrite(response, request, service) {
  try {
    const payload = await readRequestJsonBody(request);
    const data = await service.writeDoc(payload);
    sendApiResponse(response, data);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const statusCode = 400;
      sendApiError(response, statusCode, `invalid json: ${error?.message || 'parse error'}`);
      return statusCode;
    }
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiRebuild(response, request, service) {
  try {
    const payload = await readRequestJsonBody(request);
    const { result, sourceFilter } = await service.runRebuild(payload);
    sendApiResponse(response, makeRebuildResponse(result, sourceFilter));
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const statusCode = 400;
      sendApiError(response, statusCode, `invalid json: ${error?.message || 'parse error'}`);
      return statusCode;
    }
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiHealth(response, service) {
  try {
    const health = typeof service.getHealth === 'function'
      ? service.getHealth()
      : {
        ok: false,
        status: 'unavailable',
        timestamp: new Date().toISOString(),
      };
    sendApiResponse(response, health);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiMetrics(response, service) {
  try {
    const metrics = typeof service.getRequestMetricsSnapshot === 'function'
      ? service.getRequestMetricsSnapshot()
      : {};
    sendApiResponse(response, metrics);
    return isHttpStatus(response.statusCode, 200);
  } catch (error) {
    return mapServiceErrorToHttp(error, response);
  }
}

async function handleApiRequest({
  pathname,
  request,
  response,
  requestUrl,
  service,
}) {
  const route = {
    [API_PATHS.INDEX]: {
      [API_METHODS.GET]: () => handleApiIndex(response, service),
    },
    [API_PATHS.CAPABILITIES]: {
      [API_METHODS.GET]: () => handleApiCapabilities(response, service),
    },
    [API_PATHS.HEALTH]: {
      [API_METHODS.GET]: () => handleApiHealth(response, service),
    },
    [API_PATHS.METRICS]: {
      [API_METHODS.GET]: () => handleApiMetrics(response, service),
    },
    [API_PATHS.DOC]: {
      [API_METHODS.GET]: () => handleApiDocGet(response, requestUrl, service),
      [API_METHODS.POST]: () => handleApiDocWrite(response, request, service),
      [API_METHODS.PUT]: () => handleApiDocWrite(response, request, service),
    },
    [API_PATHS.REBUILD]: {
      [API_METHODS.POST]: () => handleApiRebuild(response, request, service),
    },
  };

  const handlers = route[pathname];
  if (!handlers) {
    return false;
  }

  const trace = (service && typeof service.startRequest === 'function')
    ? service.startRequest(pathname, request.method)
    : null;
  let statusCode = 200;
  try {
    const methodHandler = handlers[request.method];
    if (!methodHandler) {
      const allow = Object.keys(handlers).join(', ');
      statusCode = methodNotAllowed(response, allow);
      return true;
    }
    statusCode = await methodHandler();
  } catch (error) {
    if (!response.writableEnded) {
      statusCode = 500;
      sendApiError(response, 500, error?.message || 'internal error');
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
