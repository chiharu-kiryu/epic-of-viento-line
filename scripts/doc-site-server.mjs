import { createServer } from 'node:http';
import {
  PROJECT_ROOT,
  WEB_ROOT,
} from './lib/paths.mjs';
import { resolveBackstoryModeFromEnv } from './lib/rebuild-config.mjs';
import {
  resolvePort,
  EDIT_ROOT_PREFIXES,
  sendApiError,
} from './lib/doc-server.mjs';
import { createDocumentService } from './lib/doc-api-service.mjs';
import { handleApiRequest } from './lib/doc-server-routes.mjs';
import { handleStaticRequest } from './lib/doc-server-static-routes.mjs';
import { createDesktopSession } from './lib/desktop-session.mjs';

const PORT = resolvePort();
const HOST = process.env.DOC_API_HOST || '127.0.0.1';
const BACKSTORY_MERGE_MODE = resolveBackstoryModeFromEnv();
const apiState = { rebuildInProgress: false };
const TOKEN_ENV_NAMES = ['DOC_API_TOKEN', 'DOC_API_WRITE_TOKEN'];
const DEFAULT_RATE_WINDOW_MS = 60000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
const DEFAULT_RATE_BUCKET_MAX = 2048;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const desktopSession = createDesktopSession();

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const docService = createDocumentService({
  editablePrefixes: EDIT_ROOT_PREFIXES,
  backstoryMergeMode: BACKSTORY_MERGE_MODE,
  state: apiState,
});

function resolveWriteAuthMode() {
  const explicit = process.env.DOC_API_REQUIRE_WRITE_AUTH;
  if (explicit === '1') {
    return 'required';
  }
  if (explicit === '0') {
    return 'disabled';
  }
  return process.env.NODE_ENV === 'production'
    ? 'required(default)'
    : 'optional';
}

function shouldWarnProdAuthDisabled() {
  return process.env.NODE_ENV === 'production' && process.env.DOC_API_REQUIRE_WRITE_AUTH === '0';
}

function resolveEnabledTokenSource() {
  const configured = TOKEN_ENV_NAMES.filter((name) => typeof process.env?.[name] === 'string' && process.env?.[name].trim());
  return {
    hasToken: configured.length > 0,
    source: configured.join(',') || 'none',
    tokenCount: configured.reduce((count, name) => count + ((process.env?.[name] || '').split(',').filter((token) => token.trim()).length || 0), 0),
  };
}

function isLoopbackHost(host = '') {
  return host === '127.0.0.1'
    || host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || host === '';
}

function printStartupSecuritySummary() {
  const tokenInfo = resolveEnabledTokenSource();
  const writeAuthMode = resolveWriteAuthMode();
  const isTrustProxyEnabled = process.env.DOC_API_TRUST_PROXY === '1';
  const rateWindow = parsePositiveInteger(process.env.DOC_API_RATE_WINDOW_MS, DEFAULT_RATE_WINDOW_MS);
  const rateLimit = parsePositiveInteger(process.env.DOC_API_RATE_LIMIT_MAX_REQUESTS, DEFAULT_RATE_LIMIT_MAX_REQUESTS);
  const rateBucketMax = parsePositiveInteger(process.env.DOC_API_RATE_BUCKET_MAX, DEFAULT_RATE_BUCKET_MAX);
  const maxBodyBytes = parsePositiveInteger(process.env.DOC_API_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const isAuditEnabled = process.env.DOC_API_SECURITY_AUDIT === '1';
  const hasAuditLog = typeof process.env?.DOC_API_SECURITY_AUDIT_LOG_FILE === 'string' && process.env.DOC_API_SECURITY_AUDIT_LOG_FILE.trim();
  const rateWindowSource = process.env.DOC_API_RATE_WINDOW_MS === undefined
    ? 'default'
    : Number.isFinite(Number(process.env.DOC_API_RATE_WINDOW_MS)) && Number.isInteger(Number(process.env.DOC_API_RATE_WINDOW_MS)) && Number(process.env.DOC_API_RATE_WINDOW_MS) > 0
      ? 'env'
      : 'invalid(defaulted)';
  const rateLimitSource = process.env.DOC_API_RATE_LIMIT_MAX_REQUESTS === undefined
    ? 'default'
    : Number.isFinite(Number(process.env.DOC_API_RATE_LIMIT_MAX_REQUESTS)) && Number.isInteger(Number(process.env.DOC_API_RATE_LIMIT_MAX_REQUESTS)) && Number(process.env.DOC_API_RATE_LIMIT_MAX_REQUESTS) > 0
      ? 'env'
      : 'invalid(defaulted)';
  const rateBucketMaxSource = process.env.DOC_API_RATE_BUCKET_MAX === undefined
    ? 'default'
    : Number.isFinite(Number(process.env.DOC_API_RATE_BUCKET_MAX)) && Number.isInteger(Number(process.env.DOC_API_RATE_BUCKET_MAX)) && Number(process.env.DOC_API_RATE_BUCKET_MAX) > 0
      ? 'env'
      : 'invalid(defaulted)';
  const maxBodyBytesSource = process.env.DOC_API_MAX_BODY_BYTES === undefined
    ? 'default'
    : Number.isFinite(Number(process.env.DOC_API_MAX_BODY_BYTES)) && Number.isInteger(Number(process.env.DOC_API_MAX_BODY_BYTES)) && Number(process.env.DOC_API_MAX_BODY_BYTES) > 0
      ? 'env'
      : 'invalid(defaulted)';

  console.log(`[doc-security] write auth: ${writeAuthMode}`);
  console.log(`[doc-security] write tokens: ${tokenInfo.hasToken ? `configured (${tokenInfo.tokenCount} token(s), source: ${tokenInfo.source})` : 'not configured'}`);
  console.log(`[doc-security] host binding: ${HOST}${!isLoopbackHost(HOST) ? ' (warning: not loopback)' : ''}`);
  console.log(`[doc-security] trust proxy: ${isTrustProxyEnabled ? 'enabled' : 'disabled'}`);
  console.log(`[doc-security] rate limit: ${rateLimit}/window ${rateWindow}ms (${rateLimitSource}), bucket ${rateBucketMax} (${rateBucketMaxSource})`);
  console.log(`[doc-security] request body limit: ${maxBodyBytes} bytes (${maxBodyBytesSource})`);
  console.log(`[doc-security] security audit: ${isAuditEnabled ? 'enabled' : 'disabled'}${hasAuditLog ? ` (log: ${process.env.DOC_API_SECURITY_AUDIT_LOG_FILE})` : ''}`);

  if (writeAuthMode.includes('required') && !tokenInfo.hasToken) {
    console.warn('[doc-security] warning: write auth is required but no token is configured');
  }
  if (shouldWarnProdAuthDisabled()) {
    console.warn('[doc-security] warning: production explicitly disables write auth; ensure network perimeter and auth layer are controlled');
  }
  if (!isLoopbackHost(HOST)) {
    console.warn('[doc-security] warning: host is not loopback; ensure network access control is in place');
  }
  if (rateWindowSource === 'invalid(defaulted)') {
    console.warn(`[doc-security] warning: invalid DOC_API_RATE_WINDOW_MS=${process.env.DOC_API_RATE_WINDOW_MS || '(empty)'}, fallback to ${DEFAULT_RATE_WINDOW_MS}`);
  }
  if (rateLimitSource === 'invalid(defaulted)') {
    console.warn(`[doc-security] warning: invalid DOC_API_RATE_LIMIT_MAX_REQUESTS=${process.env.DOC_API_RATE_LIMIT_MAX_REQUESTS || '(empty)'}, fallback to ${DEFAULT_RATE_LIMIT_MAX_REQUESTS}`);
  }
  if (rateBucketMaxSource === 'invalid(defaulted)') {
    console.warn(`[doc-security] warning: invalid DOC_API_RATE_BUCKET_MAX=${process.env.DOC_API_RATE_BUCKET_MAX || '(empty)'}, fallback to ${DEFAULT_RATE_BUCKET_MAX}`);
  }
  if (maxBodyBytesSource === 'invalid(defaulted)') {
    console.warn(`[doc-security] warning: invalid DOC_API_MAX_BODY_BYTES=${process.env.DOC_API_MAX_BODY_BYTES || '(empty)'}, fallback to ${DEFAULT_MAX_BODY_BYTES}`);
  }
}

function printSecurityBaselineTemplate() {
  const isProduction = process.env.NODE_ENV === 'production';
  const isTokenConfigured = resolveEnabledTokenSource().hasToken;
  const template = isProduction
    ? [
      'NODE_ENV=production',
      'DOC_API_HOST=127.0.0.1',
      'DOC_API_REQUIRE_WRITE_AUTH=1',
      `DOC_API_TOKEN=<replace_with_secure_token_1>,<replace_with_secure_token_2>`,
      'DOC_API_TRUST_PROXY=0',
      'DOC_API_RATE_WINDOW_MS=60000',
      'DOC_API_RATE_LIMIT_MAX_REQUESTS=120',
      'DOC_API_RATE_BUCKET_MAX=2048',
      'DOC_API_MAX_BODY_BYTES=1048576',
      'DOC_API_SECURITY_AUDIT=1',
      'DOC_API_SECURITY_AUDIT_LOG_FILE=./logs/doc-security-audit.jsonl',
    ]
    : [
      'NODE_ENV=development',
      'DOC_API_HOST=127.0.0.1',
      'DOC_API_REQUIRE_WRITE_AUTH=1',
      '# 本地测试可暂时关闭该项',
      '# DOC_API_REQUIRE_WRITE_AUTH=0',
      '# DOC_API_TOKEN=<replace_with_secure_token>',
      'DOC_API_TRUST_PROXY=0',
      'DOC_API_RATE_WINDOW_MS=60000',
      'DOC_API_RATE_LIMIT_MAX_REQUESTS=120',
      'DOC_API_RATE_BUCKET_MAX=2048',
      'DOC_API_MAX_BODY_BYTES=1048576',
      'DOC_API_SECURITY_AUDIT=0',
      '# DOC_API_SECURITY_AUDIT=1',
      '# DOC_API_SECURITY_AUDIT_LOG_FILE=./logs/doc-security-audit.jsonl',
    ];

  const modeTip = isTokenConfigured ? 'has_token' : 'no_token';
  const title = isProduction
    ? 'recommended production baseline'
    : 'recommended local/development baseline';

  console.log(`[doc-security] ${title} (${modeTip})`);
  console.log('[doc-security] ----');
  template.forEach((line) => {
    console.log(`[doc-security] ${line}`);
  });
  console.log('[doc-security] ----');
}

const server = createServer(async (req, res) => {
  try {
    let url;
    try { url = new URL(req.url, `http://localhost:${PORT}`); }
    catch { sendApiError(res, 400, 'bad request URL', { errorCode: 'bad_path' }); return; }
    const pathname = url.pathname;
    if (desktopSession && await desktopSession(req, res, pathname)) return;

    const handledByApi = await handleApiRequest({
      pathname,
      request: req,
      response: res,
      requestUrl: url,
      service: docService,
    });
    if (handledByApi) return;

    await handleStaticRequest({
      pathname,
      response: res,
      projectRoot: PROJECT_ROOT,
      webRoot: WEB_ROOT,
      requestMethod: req.method,
      request: req,
    });
  } catch (error) {
    if (res.headersSent || res.destroyed) res.destroy();
    else sendApiError(res, 500, '无法处理请求', { errorCode: 'internal_error' });
    console.error(`[doc-server] ${error?.message || error}`);
  }
});

if (!desktopSession) {
  printStartupSecuritySummary();
  printSecurityBaselineTemplate();
}
server.listen(PORT, HOST, () => {
  if (desktopSession) console.log(`VIENTO_EVENT ${JSON.stringify({ type: 'ready', port: server.address().port })}`);
  console.log(`Doc viewer running at http://${HOST}:${server.address().port}`);
  console.log(`Backstory merge mode: ${BACKSTORY_MERGE_MODE}`);
});
