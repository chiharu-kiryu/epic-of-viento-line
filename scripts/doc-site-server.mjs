import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { runNodeScript } from './lib/process.mjs';
import { collectHeroImages } from './lib/image-index.mjs';
import { collectFilesRecursive } from './lib/scan-files.mjs';
import { inferCategory } from './lib/category.mjs';
import {
  PROJECT_ROOT,
  DOC_ROOT,
  WEB_ROOT,
  STANDARDIZE_SCRIPT,
  BUILD_STATIC_SCRIPT,
  trimName,
  toPosix,
} from './lib/paths.mjs';
import { resolveBackstoryModeFromEnv, resolveStandardizeArgs } from './lib/rebuild-config.mjs';

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

const PORT = resolvePort();

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
const EDIT_ROOT_PREFIXES = ['design-data/', 'docs-standard/design-data/'];
let rebuildInProgress = false;
const BACKSTORY_MERGE_MODE = resolveBackstoryModeFromEnv();
const STANDARDIZE_ARGS = resolveStandardizeArgs(BACKSTORY_MERGE_MODE);

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

function classifyEntry(relativePath) {
  const inferred = inferCategory(relativePath);
  return {
    ...inferred,
    name: trimName(path.basename(relativePath)),
  };
}

async function buildDocIndex() {
  const result = [];
  const fileList = await collectFilesRecursive(DOC_ROOT, { relativeBase: '' });

  for (const filePath of fileList) {
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

    if (classification.category === 'hero') {
      entry.heroImages = await collectHeroImages(classification.meta.attribute, classification.meta.hero);
    }

    try {
      const stats = await fs.stat(absolutePath);
      entry.lastModified = stats.mtime.toISOString();
    } catch {
      entry.lastModified = '';
    }

    result.push(entry);
  }

  const readmePaths = ['README.md', 'design-data/README.md'];
  for (const readme of readmePaths) {
    const abs = path.join(PROJECT_ROOT, readme);
    if (await fs
      .access(abs)
      .then(() => true)
      .catch(() => false)) {
      const rel = toPosix(readme);
      if (!result.some((item) => item.path === rel)) {
        result.unshift({
          path: rel,
          title: '项目说明文档',
          category: 'root',
          group: '根目录',
          name: '项目说明文档',
          lastModified: '',
          heroImages: [],
        });
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

async function sendApiError(response, statusCode, message, extra = {}) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: message, ...extra }));
}

function safePathFromQuery(rawPath) {
  if (!rawPath) {
    return '';
  }
  if (rawPath.includes('\\')) {
    return '';
  }
  if (rawPath.includes('\0')) {
    return '';
  }
  if (/^[A-Za-z]:\//.test(rawPath)) {
    return '';
  }
  if (path.isAbsolute(rawPath)) {
    return '';
  }

  const normalized = toPosix(rawPath.replace(/\\/g, '/'));
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  if (!segments.length) {
    return '';
  }

  if (segments.some((segment) => segment === '..')) {
    return '';
  }

  const filteredSegments = [];
  for (const segment of segments) {
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      return '';
    }
    filteredSegments.push(segment);
  }

  const sanitized = filteredSegments.join('/');
  if (!sanitized) {
    return '';
  }
  return sanitizePathPrefix(sanitized);
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

function isAllowedEditPath(relativePath) {
  return EDIT_ROOT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function resolveEditableFilePath(relativePath, options = {}) {
  const { allowCreate = false } = options;
  const candidates = [relativePath];
  if (relativePath.startsWith('docs-standard/')) {
    candidates.push(relativePath.replace(/^docs-standard\//, ''));
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
        return {
          relativePath: candidate,
          absolutePath,
          exists: true,
        };
      }
    } catch {
      // keep trying alternatives
    }
  }

  if (allowCreate && fallbackCandidate) {
    return {
      ...fallbackCandidate,
      exists: false,
    };
  }
  return null;
}

async function readRequestJsonBody(request) {
  return await new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });

    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    request.on('error', reject);
  });
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

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES.get(ext) || 'application/octet-stream';
}

async function sendFile(filePath, response) {
  response.statusCode = 200;
  response.setHeader('Content-Type', getMime(filePath));
  const stream = createReadStream(filePath);
  stream.pipe(response);
}

function createApiResponse(response, data) {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/api/index') {
    try {
      const indexData = await buildDocIndex();
      createApiResponse(res, indexData);
    } catch (error) {
      await sendApiError(res, 500, error?.message || 'failed to build index');
    }
    return;
  }

  if (pathname === '/api/capabilities') {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end('method not allowed');
      return;
    }

    createApiResponse(res, {
      ok: true,
      mode: 'edit',
      editablePrefixes: EDIT_ROOT_PREFIXES,
      endpoints: ['/api/doc', '/api/rebuild', '/api/index', '/api/capabilities'],
      backstoryMergeMode: BACKSTORY_MERGE_MODE,
      version: process?.version || 'node',
      capabilities: {
        edit: true,
        create: true,
        rebuild: true,
      },
    });
    return;
  }

  if (pathname === '/api/doc') {
    if (req.method === 'GET') {
      const filePath = safePathFromQuery(url.searchParams.get('path') || '');
      if (!filePath || !isAllowedEditPath(filePath)) {
        await sendApiError(res, 400, 'bad path');
        return;
      }

      const resolved = await resolveEditableFilePath(filePath);
      if (!resolved) {
        await sendApiError(res, 404, 'document not found');
        return;
      }

      const content = await readTextFile(resolved.absolutePath);
      if (content === null) {
        await sendApiError(res, 404, 'document not found');
        return;
      }

      const type = path.extname(resolved.relativePath).replace('.', '') || 'txt';
      let modifiedAt = '';
      let version = '';
      try {
        const stats = await fs.stat(resolved.absolutePath);
        modifiedAt = stats.mtime.toISOString();
        version = String(stats.mtimeMs);
      } catch {
        // keep defaults
      }
      createApiResponse(res, {
        path: resolved.relativePath,
        type,
        title: trimName(path.basename(resolved.relativePath)),
        content,
        lastModified: modifiedAt,
        version,
      });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      let payload;
      try {
        payload = await readRequestJsonBody(req);
      } catch (error) {
        await sendApiError(res, 400, `invalid json: ${error?.message || 'parse error'}`);
        return;
      }

      const requestedPath = payload?.path;
      if (typeof requestedPath !== 'string') {
        await sendApiError(res, 400, 'missing path');
        return;
      }

      const filePath = safePathFromQuery(requestedPath);
      if (!filePath || !isAllowedEditPath(filePath)) {
        await sendApiError(res, 400, 'bad path');
        return;
      }

      if (typeof payload?.content !== 'string') {
        await sendApiError(res, 400, 'missing content');
        return;
      }

      const createMode = payload?.create === true;
      const forceOverwrite = payload?.force === true;
      const expectedVersion = normalizeLockVersion(payload?.expectedVersion || payload?.expectedLastModified);
      const resolved = await resolveEditableFilePath(filePath, { allowCreate: createMode });
      if (!resolved) {
        await sendApiError(res, 404, 'document not found');
        return;
      }

      if (!createMode && !resolved.exists) {
        await sendApiError(res, 404, 'document not found');
        return;
      }

      if (createMode && resolved.exists) {
        await sendApiError(res, 409, 'document already exists');
        return;
      }

      const { absolutePath, relativePath: resolvedPath } = resolved;

      if (!createMode && !expectedVersion && !forceOverwrite) {
        await sendApiError(res, 409, 'missing expectedLastModified for existing doc');
        return;
      }

      if (!createMode && expectedVersion && !forceOverwrite) {
        try {
          const stats = await fs.stat(absolutePath);
          const currentVersion = String(stats.mtimeMs);
          if (currentVersion !== expectedVersion) {
            await sendApiError(res, 409, 'document was modified by another client', {
              currentVersion,
              lastModified: stats.mtime.toISOString(),
            });
            return;
          }
        } catch (error) {
          if (error?.code === 'ENOENT') {
            await sendApiError(res, 404, 'document not found');
            return;
          }
          await sendApiError(res, 500, error?.message || 'failed to check version');
          return;
        }
      }

      try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, payload.content, 'utf8');
        const stats = await fs.stat(absolutePath);
        createApiResponse(res, {
          ok: true,
          path: resolvedPath,
          lastModified: stats.mtime.toISOString(),
          version: String(stats.mtimeMs),
        });
      } catch (error) {
        await sendApiError(res, 500, error?.message || 'failed to save');
        return;
      }
      return;
    }

    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST, PUT');
    res.end('method not allowed');
    return;
  }

  if (pathname === '/api/rebuild') {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('method not allowed');
      return;
    }

    if (rebuildInProgress) {
      await sendApiError(res, 409, 'rebuild already in progress');
      return;
    }

    let payload;
    try {
      payload = await readRequestJsonBody(req);
    } catch (error) {
      await sendApiError(res, 400, `invalid json: ${error?.message || 'parse error'}`);
      return;
    }

    const requestedSource = typeof payload?.source === 'string'
      ? payload.source
      : (typeof payload?.path === 'string' ? payload.path : '');
    const sourceFilter = normalizeStandardizeSourceFilter(requestedSource);
    const startedAt = Date.now();
    rebuildInProgress = true;

    try {
      if (sourceFilter) {
        await runNodeScript(STANDARDIZE_SCRIPT, [...STANDARDIZE_ARGS, sourceFilter], { cwd: PROJECT_ROOT });
      } else {
        await runNodeScript(STANDARDIZE_SCRIPT, STANDARDIZE_ARGS, { cwd: PROJECT_ROOT });
      }
      const standardResult = await runNodeScript(BUILD_STATIC_SCRIPT, [], { cwd: PROJECT_ROOT });

      const elapsedMs = Date.now() - startedAt;
      createApiResponse(res, {
        ok: true,
        mode: sourceFilter ? 'partial' : 'full',
        source: sourceFilter || null,
        generatedAt: new Date().toISOString(),
        elapsedMs,
        message: `rebuild finished in ${elapsedMs}ms`,
        stdout: standardResult.stdout || '',
      });
    } catch (error) {
      await sendApiError(res, 500, error?.message || 'rebuild failed');
    } finally {
      rebuildInProgress = false;
    }
    return;
  }

  if (pathname === '/favicon.ico' || pathname === '/web/favicon.ico') {
    const faviconCandidates = [
      path.join(PROJECT_ROOT, 'favicon.ico'),
      path.join(WEB_ROOT, 'favicon.ico'),
    ];

    for (const faviconPath of faviconCandidates) {
      try {
        await fs.access(faviconPath);
        await sendFile(faviconPath, res);
        return;
      } catch {
        // continue to next candidate
      }
    }

    await sendApiError(res, 404, 'favicon not found');
    return;
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/web' || pathname === '/web/') {
    const indexPath = path.join(WEB_ROOT, 'index.html');
    await sendFile(indexPath, res);
    return;
  }

  const rel = decodeURIComponent(pathname);
  const candidatePath = path.join(PROJECT_ROOT, rel.startsWith('/') ? rel.slice(1) : rel);
  const normalizedCandidate = path.normalize(candidatePath);
  if (!normalizedCandidate.startsWith(PROJECT_ROOT)) {
    await sendApiError(res, 403, 'forbidden');
    return;
  }

  try {
    const stat = await fs.stat(normalizedCandidate);
    if (stat.isDirectory()) {
      if (pathname === '/') {
        const indexPath = path.join(WEB_ROOT, 'index.html');
        await sendFile(indexPath, res);
        return;
      }
      res.statusCode = 403;
      res.end('Directory access disabled');
      return;
    }
    await sendFile(normalizedCandidate, res);
  } catch {
    if (pathname.startsWith('/web/')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    // SPA fallback
    const indexPath = path.join(WEB_ROOT, 'index.html');
    await sendFile(indexPath, res);
  }
});

server.listen(PORT, () => {
  console.log(`Doc viewer running at http://localhost:${PORT}`);
  console.log(`Backstory merge mode: ${BACKSTORY_MERGE_MODE}`);
});
