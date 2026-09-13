import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { collectHeroImages } from './image-index.mjs';
import { collectFilesRecursive } from './scan-files.mjs';
import { inferCategory } from './category.mjs';
import { APPLICATION_ROOT, PROJECT_ROOT, DOCUMENTS_PATH, WORKSPACE_MANIFEST, DOC_ROOT, WEB_ROOT, SCRIPT_ROOT, STANDARD_ROOT, INDEX_OUTPUT, CACHE_ROOT, IS_MANAGED_WORKSPACE, trimName, toPosix } from './paths.mjs';
import { projectDefinition } from './project-layout.mjs';
import { resolveContainedPath } from './contained-path.mjs';
import { resolveAssetRoot, resolveAssetRequest, registeredAssetCatalog } from './workspace.mjs';
import {
  API_RESPONSE,
  API_RESPONSE_DEFAULTS,
} from './doc-api-contract.mjs';

const EDIT_ROOT_PREFIXES = [`${DOCUMENTS_PATH}/`, `docs-standard/${DOCUMENTS_PATH}/`];
const STATIC_CACHE_CONTROL_HTML_EXTENSIONS = new Set([
  '.html',
]);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/vnd.microsoft.icon'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const PROJECT_ROOT_REAL = path.resolve(PROJECT_ROOT);
const README_PATHS = ['README.md', `${DOCUMENTS_PATH}/README.md`];
const INDEX_BUILD_CONCURRENCY = normalizeNumericConfigValue('DOC_API_INDEX_BUILD_CONCURRENCY', 16, 1);

function normalizeNumericConfigValue(name, fallback, min = 0) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= min) {
    return fallback;
  }

  return parsed;
}

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_JSON_BODY_BYTES = normalizeNumericConfigValue('DOC_API_MAX_BODY_BYTES', DEFAULT_MAX_JSON_BODY_BYTES);

function resolvePort(argv = process.argv.slice(2)) {
  const envPort = process.env.PORT;
  if (envPort && Number.isInteger(Number(envPort))) {
    return Number(envPort);
  }

  const cliIndex = argv.indexOf('--port');
  if (cliIndex !== -1 && argv[cliIndex + 1]) {
    const candidate = Number(argv[cliIndex + 1]);
    if (Number.isInteger(candidate)) {
      return candidate;
    }
  }

  return 4173;
}

function sanitizePathPrefix(normalizedPath) {
  const normalized = normalizedPath.replace(/^\.\//, '');
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('.')) {
    return '';
  }
  return normalized;
}

function safePathFromQuery(rawPath) {
  if (!rawPath) {
    return '';
  }
  if (rawPath.includes('\\') || rawPath.includes('\0')) {
    return '';
  }
  if (/^[A-Za-z]:\//.test(rawPath) || path.isAbsolute(rawPath)) {
    return '';
  }

  const normalized = toPosix(rawPath.replace(/\\/g, '/'));
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  if (!segments.length) {
    return '';
  }

  const filteredSegments = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') {
      continue;
    }
    if (segment === '..') {
      return '';
    }
    filteredSegments.push(segment);
  }

  if (!filteredSegments.length) {
    return '';
  }

  return sanitizePathPrefix(filteredSegments.join('/'));
}

function normalizeLockVersion(rawVersion) {
  if (typeof rawVersion === 'number' && Number.isFinite(rawVersion)) {
    return String(rawVersion);
  }
  if (typeof rawVersion === 'string') {
    const normalized = rawVersion.trim();
    if (!normalized) {
      return '';
    }
    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      return normalized;
    }
  }
  return '';
}

function normalizeStandardizeSourceFilter(rawPath = '') {
  if (typeof rawPath !== 'string') return null;
  if (!rawPath.trim()) return '';
  const safePath = safePathFromQuery(rawPath);
  if (!safePath) return null;
  const canonical = safePath.replace(/^docs-standard\//, '');
  if (safePath === 'docs-standard' || canonical === DOCUMENTS_PATH) return '';
  return canonical.startsWith(`${DOCUMENTS_PATH}/`) ? canonical : null;
}

function isAllowedEditPath(relativePath) {
  return EDIT_ROOT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function resolveEditableFilePath(relativePath, options = {}) {
  const { allowCreate = false } = options;
  const canonicalPath = relativePath.replace(/^docs-standard\//, '');
  const candidates = [canonicalPath];

  if (relativePath !== canonicalPath && !IS_MANAGED_WORKSPACE) {
    candidates.push(relativePath);
  }

  let fallbackCandidate = null;
  for (const candidate of candidates) {
    if (!candidate || !isAllowedEditPath(candidate)) {
      continue;
    }
    try {
      const absolutePath = await resolveContainedPath(PROJECT_ROOT, path.join(PROJECT_ROOT, candidate), { allowMissing: allowCreate });
      if (!fallbackCandidate) fallbackCandidate = { relativePath: candidate, absolutePath };
      const stat = await fs.stat(absolutePath);
      if (stat.isFile()) {
        return { relativePath: candidate, absolutePath, exists: true };
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }

  if (allowCreate && fallbackCandidate) {
    return { ...fallbackCandidate, exists: false };
  }
  return null;
}

async function readRequestJsonBody(request) {
  return await new Promise((resolve, reject) => {
    const bodyChunks = [];
    let bodyBytes = 0;
    let finished = false;
    const rawContentLength = request?.headers?.['content-length'] || request?.headers?.['Content-Length'];
    const contentLength = Number(rawContentLength);
    if (Number.isFinite(contentLength) && Number.isInteger(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      error.errorCode = API_RESPONSE_DEFAULTS.payloadTooLargeErrorPrefix;
      error.payload = {
        receivedBytes: contentLength,
        maxBytes: MAX_JSON_BODY_BYTES,
      };
      reject(error);
      request.pause();
      return;
    }

    const finishError = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      reject(error);
    };

    const onError = (error) => finishError(error || new Error('request stream error'));

    const onData = (chunk) => {
      if (finished) {
        return;
      }

      bodyBytes += chunk.length;
      if (bodyBytes > MAX_JSON_BODY_BYTES) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        error.errorCode = API_RESPONSE_DEFAULTS.payloadTooLargeErrorPrefix;
        error.payload = {
          receivedBytes: bodyBytes,
          maxBytes: MAX_JSON_BODY_BYTES,
        };
        finishError(error);
        request.pause();
        return;
      }

      bodyChunks.push(chunk);
    };

    const onEnd = () => {
      if (finished) {
        return;
      }

      const body = Buffer.concat(bodyChunks).toString('utf8');
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        finishError(error);
      }
    };

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function setSecurityHeaders(response = {}) {
  if (!response || typeof response.setHeader !== 'function') {
    return;
  }

  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "media-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Download-Options', 'noopen');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function classifyEntry(relativePath) {
  const inferred = inferCategory(relativePath);
  return {
    ...inferred,
    name: trimName(path.basename(relativePath)),
  };
}

async function mapWithConcurrency(items = [], mapper, limit = 8) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const result = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      result[index] = await mapper(items[index], index, items.length);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return result;
}

async function buildEditableDocIndex() {
  const fileList = await collectFilesRecursive(DOC_ROOT, { relativeBase: '' });
  const registry = await registeredAssetCatalog(PROJECT_ROOT);
  const result = await mapWithConcurrency(fileList, async (filePath) => {
    const rel = toPosix(path.join(DOCUMENTS_PATH, filePath));
    const absolutePath = path.join(PROJECT_ROOT, rel);
    const classification = classifyEntry(rel);
    const baseName = path.basename(absolutePath);
    const registration = registry?.bySource.get(rel);
    const registeredType = projectDefinition(WORKSPACE_MANIFEST).documentTypes.find((type) => type.id === registration?.documentType);
    const registeredImages = (registration?.assetBindings || []).map((link) => registry.byId.get(link.assetId)).filter((asset) => asset?.kind === 'image').map((asset) => `assets/${asset.location.path}`);
    const entry = {
      ...(registration ? { id: registration.id, assetRefs: registration.assetBindings.map((link) => link.assetId) } : {}),
      path: rel,
      title: trimName(baseName),
      category: registration?.documentType || classification.category,
      group: registeredType?.label || classification.group,
      name: trimName(baseName),
      fullPath: rel,
      lastModified: '',
      heroImages: [],
    };

    try {
      const [heroImages, stats] = await Promise.all([
        registry ? Promise.resolve(registeredImages) : classification.category === 'hero'
          ? collectHeroImages(classification.meta.attribute, classification.meta.hero)
          : Promise.resolve([]),
        fs.stat(absolutePath),
      ]);
      if (Array.isArray(heroImages) && heroImages.length > 0) {
        entry.heroImages = heroImages;
      }
      entry.lastModified = stats.mtime.toISOString();
    } catch {
      // keep defaults
    }

    return entry;
  }, INDEX_BUILD_CONCURRENCY);

  const readmeMeta = (await Promise.all(README_PATHS.map(async (readme) => {
    const abs = path.join(PROJECT_ROOT, readme);
    const rel = toPosix(readme);
    try {
      const stats = await fs.stat(abs);
      return {
        path: rel,
        lastModified: stats.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }))).filter(Boolean);

  const readmeSet = new Set(readmeMeta.map((item) => item.path));
  const existingPaths = new Set(result.map((item) => item.path));
  for (const readme of readmeMeta) {
    if (!existingPaths.has(readme.path)) {
      result.unshift({
        path: readme.path,
        title: '项目说明文档',
        category: 'root',
        group: '根目录',
        name: '项目说明文档',
        lastModified: readme.lastModified,
        heroImages: [],
      });
    }
  }

  if (readmeSet.size) {
    const readmeLatestByPath = new Map(readmeMeta.map((item) => [item.path, item.lastModified]));
    for (const item of result) {
      if (readmeSet.has(item.path)) {
        item.lastModified = readmeLatestByPath.get(item.path) || '';
      }
    }
  }

  result.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group.localeCompare(b.group, 'zh-CN');
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return {
    generatedAt: new Date().toISOString(),
    workspace: projectDefinition(WORKSPACE_MANIFEST),
    count: result.length,
    docs: result,
    entries: result,
  };
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES.get(ext) || 'application/octet-stream';
}

function generateEtag(stats) {
  return `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
}

function resolveStaticCacheControl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (STATIC_CACHE_CONTROL_HTML_EXTENSIONS.has(ext)) {
    return 'no-cache, no-store, must-revalidate, max-age=0';
  }
  // Source, indexes, assets and stable asset IDs can all change in place.
  return 'no-cache, must-revalidate';
}

function normalizeWeakEtag(rawEtag = '') {
  return rawEtag.toString().trim().replace(/^W\//, '').replace(/^"(.+)"$/, '$1');
}

function isNotModifiedByCacheHeaders(request, stats, etag) {
  const headers = request?.headers || {};
  if (!headers || typeof headers !== 'object') {
    return false;
  }

  const ifNoneMatch = headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim()) {
    const candidates = ifNoneMatch.split(',').map((value) => normalizeWeakEtag(value));
    const normalizedEtag = normalizeWeakEtag(etag);
    // RFC 9110 §13.1.3: this validator takes precedence over the date, even
    // when it does not match. Otherwise a changed file can receive a stale 304.
    return candidates.includes('*') || candidates.includes(normalizedEtag);
  }

  const ifModifiedSince = headers['if-modified-since'];
  if (typeof ifModifiedSince === 'string' && ifModifiedSince.trim()) {
    const parsed = Date.parse(ifModifiedSince.trim());
    if (Number.isFinite(parsed) && parsed >= Math.floor(stats.mtimeMs / 1000) * 1000) {
      return true;
    }
  }

  return false;
}

function requestedByteRange(request, stats) {
  if (request?.method?.toUpperCase() !== 'GET') return null;
  const range = request.headers?.range;
  if (typeof range !== 'string') return null;
  const ifRange = request.headers?.['if-range'];
  if (ifRange) {
    // Our ETags are weak and cannot satisfy If-Range's strong comparison.
    // A sufficiently old Last-Modified value can serve as a date validator.
    const date = Date.parse(ifRange);
    const modified = Math.floor(stats.mtimeMs / 1000) * 1000;
    if (!Number.isFinite(date) || date !== modified || Date.now() - modified < 60000) return null;
  }
  // Ignore unsupported units, malformed syntax and multipart ranges. Supporting
  // one range is sufficient for media seeking and keeps memory usage bounded.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const size = BigInt(stats.size);
  let start, end;
  if (!match[1]) {
    const length = BigInt(match[2]);
    if (length === 0n || size === 0n) return false;
    start = size > length ? size - length : 0n;
    end = size - 1n;
  } else {
    start = BigInt(match[1]);
    end = match[2] ? BigInt(match[2]) : size - 1n;
    if (match[2] && end < start) return null;
    if (start >= size) return false;
    if (end >= size) end = size - 1n;
  }
  return { start: Number(start), end: Number(end) };
}

async function sendFile(filePath, response, request = null) {
  // Open before sending headers, so missing/unreadable files follow the normal
  // request error path. An unhandled stream error used to kill the whole editor.
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('not a regular file');
    setSecurityHeaders(response);
    if (path.extname(filePath).toLowerCase() === '.svg') {
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    const etag = generateEtag(stats);
    const isHead = request?.method?.toUpperCase() === 'HEAD';
    response.setHeader('Content-Type', getMime(filePath));
    response.setHeader('Content-Length', String(stats.size));
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', stats.mtime.toUTCString());
    if (!response.getHeader('Cache-Control')) response.setHeader('Cache-Control', resolveStaticCacheControl(filePath));
    response.setHeader('Accept-Ranges', 'bytes');
    if (isNotModifiedByCacheHeaders(request, stats, etag)) {
      response.statusCode = 304;
      response.end();
      return;
    }
    const range = requestedByteRange(request, stats);
    if (range === false) {
      response.statusCode = 416;
      response.setHeader('Content-Range', `bytes */${stats.size}`);
      response.setHeader('Content-Length', '0');
      response.end();
      return;
    }
    response.statusCode = range ? 206 : 200;
    if (range) {
      response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
      response.setHeader('Content-Length', String(range.end - range.start + 1));
    }
    if (isHead) { response.end(); return; }
    try {
      await pipeline(handle.createReadStream({ autoClose: false, ...(range || {}) }), response);
    } catch (error) {
      // A disconnect or a read failure after streaming began cannot be replaced
      // with a JSON body. End this response while keeping the service alive.
      response.destroy(error);
    }
  } finally { await handle.close(); }
}

function normalizeApiPayload(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, API_RESPONSE.ok)) {
    return payload;
  }
  return {
    [API_RESPONSE.ok]: true,
    [API_RESPONSE.data]: payload,
  };
}

function sendApiResponse(response, data, requestId = '') {
  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  if (normalizedRequestId) {
    response.setHeader('X-Request-Id', normalizedRequestId);
  }
  const payload = normalizeApiPayload(data);
  if (normalizedRequestId && !Object.prototype.hasOwnProperty.call(payload, API_RESPONSE.requestId)) {
    payload[API_RESPONSE.requestId] = normalizedRequestId;
  }
  response.end(JSON.stringify(payload));
}

function sendApiError(response, statusCode, message, extra = {}, requestId = '') {
  setSecurityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
  if (normalizedRequestId) {
    response.setHeader('X-Request-Id', normalizedRequestId);
  }

  const payload = {
    [API_RESPONSE.ok]: false,
    [API_RESPONSE.error]: typeof message === 'string' ? message : 'request failed',
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
  if (normalizedRequestId) {
    payload[API_RESPONSE.requestId] = normalizedRequestId;
  }
  response.end(JSON.stringify(payload));
}

function getWebRootIndexPath() {
  return path.join(WEB_ROOT, 'index.html');
}

function getProjectFilePath(relativePath) {
  const sanitizedPath = typeof relativePath === 'string'
    ? relativePath.replace(/^\/+/, '')
    : '';
  if (sanitizedPath === 'web/data/index.json' || sanitizedPath === 'data/index.json') return INDEX_OUTPUT;
  if (sanitizedPath === 'data/assets.json') return path.join(CACHE_ROOT, 'indexes/assets.json');
  if (sanitizedPath === 'data/references.json') return path.join(CACHE_ROOT, 'indexes/references.json');
  if (sanitizedPath.startsWith('assets/') || sanitizedPath.startsWith('asset-files/')) return resolveAssetRequest(PROJECT_ROOT, sanitizedPath);
  if (sanitizedPath.startsWith('web/')) return path.resolve(WEB_ROOT, sanitizedPath.slice(4));
  if (sanitizedPath.startsWith('scripts/')) return path.resolve(SCRIPT_ROOT, sanitizedPath.slice(8));
  if (sanitizedPath.startsWith('docs-standard/')) return path.resolve(STANDARD_ROOT, sanitizedPath.slice(14));
  return path.resolve(PROJECT_ROOT_REAL, sanitizedPath);
}

async function resolveProjectFilePath(requestPath) {
  const applicationResource = /^\/(?:web|scripts)\//.test(requestPath)
    && requestPath !== '/web/data/index.json';
  let root = applicationResource ? APPLICATION_ROOT : PROJECT_ROOT;
  if (/^\/(?:assets|asset-files)\//.test(requestPath)) {
    const assets = resolveAssetRoot(PROJECT_ROOT);
    // Only an explicit external asset binding selects a separate trust root.
    if (assets !== path.join(PROJECT_ROOT, 'assets')) root = assets;
  }
  return resolveContainedPath(root, getProjectFilePath(requestPath));
}

export {
  EDIT_ROOT_PREFIXES,
  resolvePort,
  safePathFromQuery,
  normalizeLockVersion,
  normalizeStandardizeSourceFilter,
  isAllowedEditPath,
  resolveEditableFilePath,
  readRequestJsonBody,
  readTextFile,
  classifyEntry,
  buildEditableDocIndex,
  getMime,
  sendFile,
  sendApiResponse,
  sendApiError,
  getWebRootIndexPath,
  getProjectFilePath,
  resolveProjectFilePath,
};
