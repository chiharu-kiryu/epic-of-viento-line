function createRouteMetric() {
  return {
    count: 0,
    errorCount: 0,
    totalResponseTimeMs: 0,
    lastStatusCode: 0,
    lastDurationMs: 0,
    lastAt: 0,
  };
}

function getRouteKey(route, method) {
  const safeRoute = (typeof route === 'string' && route.trim()) ? route.trim() : 'unknown-route';
  const safeMethod = (typeof method === 'string' && method.trim()) ? method.trim().toUpperCase() : 'UNKNOWN';
  return `${safeMethod} ${safeRoute}`;
}

function safeDurationMs(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function roundTwoDecimals(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Number(value.toFixed(2));
}

function createApiMetrics() {
  const startedAt = Date.now();
  const statusCodeCounts = new Map();
  const routeBuckets = new Map();
  let activeRequests = 0;
  let totalRequests = 0;
  let errorRequests = 0;
  let totalResponseTimeMs = 0;

  function startRequest(route, method) {
    const routeKey = getRouteKey(route, method);
    activeRequests += 1;
    return {
      routeKey,
      route: (typeof route === 'string' && route.trim()) ? route.trim() : 'unknown-route',
      method: (typeof method === 'string' && method.trim()) ? method.trim().toUpperCase() : 'UNKNOWN',
      startedAtMs: Date.now(),
      startedAtPerf: process.hrtime.bigint(),
      routeBucket: routeBuckets.get(routeKey) || createRouteMetric(),
    };
  }

  function finishRequest(trace, statusCode = 500) {
    if (!trace || !trace.startedAtPerf || !trace.routeBucket) {
      return;
    }

    activeRequests = Math.max(0, activeRequests - 1);
    const status = typeof statusCode === 'number' && statusCode > 0 ? statusCode : 500;
    const elapsedMs = safeDurationMs(Number(process.hrtime.bigint() - trace.startedAtPerf) / 1e6);
    const normalizedRoute = getRouteKey(trace.route, trace.method);
    const bucket = routeBuckets.get(normalizedRoute) || trace.routeBucket;
    routeBuckets.set(normalizedRoute, bucket);

    totalRequests += 1;
    totalResponseTimeMs += elapsedMs;
    statusCodeCounts.set(status, (statusCodeCounts.get(status) || 0) + 1);

    bucket.count += 1;
    bucket.totalResponseTimeMs += elapsedMs;
    bucket.lastDurationMs = elapsedMs;
    bucket.lastStatusCode = status;
    bucket.lastAt = Date.now();

    if (status >= 400) {
      errorRequests += 1;
      bucket.errorCount += 1;
    }
  }

  function getSnapshot() {
    const routes = {};
    for (const [routeKey, bucket] of routeBuckets.entries()) {
      routes[routeKey] = {
        count: bucket.count,
        errorCount: bucket.errorCount,
        averageResponseMs: bucket.count > 0
          ? roundTwoDecimals(bucket.totalResponseTimeMs / bucket.count)
          : 0,
        lastStatusCode: bucket.lastStatusCode || 0,
        lastDurationMs: roundTwoDecimals(bucket.lastDurationMs),
        lastAt: bucket.lastAt ? new Date(bucket.lastAt).toISOString() : '',
      };
    }

    return {
      startedAt: new Date(startedAt).toISOString(),
      activeRequests,
      totalRequests,
      errorRequests,
      successRequests: Math.max(0, totalRequests - errorRequests),
      averageResponseMs: totalRequests > 0 ? roundTwoDecimals(totalResponseTimeMs / totalRequests) : 0,
      statusCodes: Array.from(statusCodeCounts.entries()).reduce((acc, [statusCode, count]) => {
        acc[String(statusCode)] = count;
        return acc;
      }, {}),
      routes,
    };
  }

  return {
    startRequest,
    finishRequest,
    getSnapshot,
  };
}

export {
  createApiMetrics,
};
