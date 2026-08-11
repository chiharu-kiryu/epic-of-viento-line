import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { collectHeroImages } from './image-index.mjs';
import { collectFilesRecursive } from './scan-files.mjs';
import { inferCategory } from './category.mjs';
import { PROJECT_ROOT, DOC_ROOT, WEB_ROOT, trimName, toPosix } from './paths.mjs';
import {
  API_RESPONSE,
  API_RESPONSE_DEFAULTS,
} from './doc-api-contract.mjs';

const EDIT_ROOT_PREFIXES = ['design-data/', 'docs-standard/design-data/'];
const STATIC_CACHE_CONTROL_STATIC_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.json',
  '.txt',
  '.md',
]);
const STATIC_CACHE_CONTROL_HTML_EXTENSIONS = new Set([
  '.html',
]);
const DEFAULT_STATIC_CACHE_SECONDS = 3600;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

const PROJECT_ROOT_REAL = path.resolve(PROJECT_ROOT);
const README_PATHS = ['README.md', 'design-data/README.md'];
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
  const safePath = safePathFromQuery(rawPath);
  if (!safePath) {
    return '';
  }
  if (safePath === 'docs-standard' || safePath === 'design-data') {
    return '';
  }
  if (safePath.startsWith('design-data/')) {
    return safePath;
  }
  if (safePath.startsWith('docs-standard/design-data/')) {
    return safePath.replace(/^docs-standard\/design-data\//, 'design-data/');
  }
  if (safePath.startsWith('docs-standard/')) {
    return '';
  }
  return '';
}

function isAllowedEditPath(relativePath) {
  return EDIT_ROOT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function resolveEditableFilePath(relativePath, options = {}) {
  const { allowCreate = false } = options;
  const canonicalPath = relativePath.startsWith('docs-standard/design-data/')
    ? relativePath.replace(/^docs-standard\/design-data\//, 'design-data/')
    : relativePath;
  const candidates = [canonicalPath];

  if (relativePath !== canonicalPath) {
    candidates.push(relativePath);
  }

  let fallbackCandidate = null;
  for (const candidate of candidates) {
    if (!candidate || !isAllowedEditPath(candidate)) {
      continue;
    }
    if (!fallbackCandidate) {
      const fallbackAbsolutePath = path.join(PROJECT_ROOT, candidate);
      fallbackCandidate = { relativePath: candidate, absolutePath: fallbackAbsolutePath };
    }
    const absolutePath = path.join(PROJECT_ROOT, candidate);
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isFile()) {
        return { relativePath: candidate, absolutePath, exists: true };
      }
    } catch {
      // keep trying
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
  const result = await mapWithConcurrency(fileList, async (filePath) => {
    const rel = toPosix(path.join('design-data', filePath));
    const absolutePath = path.join(PROJECT_ROOT, rel);
    const classification = classifyEntry(rel);
    const baseName = path.basename(absolutePath);
    const entry = {
      path: rel,
      title: trimName(baseName),
      category: classification.category,
      group: classification.group,
      name: trimName(baseName),
      fullPath: rel,
      lastModified: '',
      heroImages: [],
    };

    try {
      const [heroImages, stats] = await Promise.all([
        classification.category === 'hero'
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
  if (STATIC_CACHE_CONTROL_STATIC_EXTENSIONS.has(ext)) {
    return `public, max-age=${DEFAULT_STATIC_CACHE_SECONDS}, immutable`;
  }
  return `public, max-age=${DEFAULT_STATIC_CACHE_SECONDS}, must-revalidate`;
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
    if (candidates.includes('*') || candidates.includes(normalizedEtag)) {
      return true;
    }
  }

  const ifModifiedSince = headers['if-modified-since'];
  if (typeof ifModifiedSince === 'string' && ifModifiedSince.trim()) {
    const parsed = Date.parse(ifModifiedSince.trim());
    if (Number.isFinite(parsed) && parsed >= stats.mtimeMs) {
      return true;
    }
  }

  return false;
}

async function sendFile(filePath, response, request = null, fileStats = null) {
  setSecurityHeaders(response);
  const stats = fileStats || await fs.stat(filePath);
  const etag = generateEtag(stats);
  const isHead = request?.method?.toUpperCase() === 'HEAD';

  response.setHeader('Content-Type', getMime(filePath));
  response.setHeader('Content-Length', String(stats.size));
  response.setHeader('ETag', etag);
  response.setHeader('Last-Modified', stats.mtime.toUTCString());
  response.setHeader('Cache-Control', resolveStaticCacheControl(filePath));
  if (isNotModifiedByCacheHeaders(request, stats, etag)) {
    response.statusCode = 304;
    response.end();
    return;
  }

  response.statusCode = 200;
  if (isHead) {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.pipe(response);
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

async function sendApiError(response, statusCode, message, extra = {}, requestId = '') {
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
  return path.resolve(PROJECT_ROOT_REAL, sanitizedPath);
}

function isProjectFilePathSafe(candidatePath) {
  const absoluteCandidate = path.resolve(candidatePath);
  const relativeToProject = path.relative(PROJECT_ROOT_REAL, absoluteCandidate);
  return relativeToProject === '' || (
    !relativeToProject.startsWith('..')
    && !path.isAbsolute(relativeToProject)
  );
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
  isProjectFilePathSafe,
};
