import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';

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
const PROJECT_ROOT = process.cwd();
const DOC_ROOT = path.join(PROJECT_ROOT, 'design-data');
const ASSET_ROOT = path.join(PROJECT_ROOT, 'assets');
const WEB_ROOT = path.join(PROJECT_ROOT, 'web');
const STANDARDIZE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'standardize-docs.mjs');
const BUILD_STATIC_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'build-static-doc-site.mjs');

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const IGNORE_DIRS = new Set(['.git', '.DS_Store', '.tmp', 'node_modules']);

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

function resolveBackstoryModeFromEnv() {
  const mode = process.env.DOCS_BACKSTORY_MODE;
  if (mode === 'on') {
    return 'enabled';
  }
  if (mode === 'off') {
    return 'disabled';
  }
  return 'disabled (default)';
}

function resolveStandardizeArgs(modeLabel) {
  if (modeLabel === 'enabled') {
    return ['--merge-backstory'];
  }
  if (modeLabel === 'disabled' || modeLabel.startsWith('disabled')) {
    return ['--no-merge-backstory'];
  }
  return [];
}

const BACKSTORY_MERGE_MODE = resolveBackstoryModeFromEnv();
const STANDARDIZE_ARGS = resolveStandardizeArgs(BACKSTORY_MERGE_MODE);

function normalizeSeparator(filePath) {
  return filePath.split(path.sep).join('/');
}

function trimExt(name) {
  return name.replace(/\.md$|\.txt$/i, '').replace(/\.json$/i, '');
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

function runNodeScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${path.basename(scriptPath)} interrupted: ${signal}`));
        return;
      }
      if (code !== 0) {
        const details = (stderr || stdout || 'no output').trim();
        reject(new Error(`${path.basename(scriptPath)} failed with exit code ${code}. ${details}`));
        return;
      }
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function classifyEntry(relativePath) {
  const parts = relativePath.split('/');
  if (parts[0] !== 'design-data') {
    return {
      category: 'other',
      group: '其他',
      name: parts.at(-1) || relativePath,
    };
  }

  if (parts[1] === 'design-heros' && parts.length >= 4) {
    return {
      category: 'hero',
      group: `英雄 / ${parts[2]}`,
      meta: {
        attribute: parts[2],
        hero: parts[3],
      },
    };
  }

  if (parts[1] === 'design-item' && parts.length >= 4) {
    return {
      category: 'item',
      group: `物品 / ${parts[2]} / ${parts[3]}`,
    };
  }

  if (parts[1] === 'design-skills' && parts.length >= 4) {
    return {
      category: 'skill',
      group: `技能 / ${parts[2]} / ${parts[3]}`,
    };
  }

  if (parts[1] === 'design-units' && parts.length >= 3) {
    const unitType = parts[2] || '';
    const subtype = parts[3] || '';
    return {
      category: 'unit',
      group: subtype ? `单位 / ${unitType} / ${subtype}` : `单位 / ${unitType}`,
    };
  }

  if (parts[1] === 'backstory' && parts.length >= 3) {
    return {
      category: 'backstory',
      group: `背景故事 / ${parts[2]}`,
    };
  }

  if (parts[1] === 'design-rules' && parts.length >= 3) {
    return {
      category: 'rule',
      group: '规则',
    };
  }

  if (parts[1] === 'design-building' && parts.length >= 3) {
    return {
      category: 'building',
      group: `建筑 / ${parts[2]}`,
    };
  }

  if (parts[1] === 'design-scenes' && parts.length >= 3) {
    return {
      category: 'scene',
      group: '场景',
    };
  }

  if (parts[1] === 'design-template') {
    return {
      category: 'template',
      group: '模板',
    };
  }

  return {
    category: 'other',
    group: '其他',
  };
}

function isTextFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

async function safeReadDir(dir, relativeBase = '') {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const child = await safeReadDir(full);
        files.push(...child);
      } else if (entry.isFile()) {
        if (isTextFile(entry.name)) {
          files.push(full);
        }
      }
    }
    return files;
  } catch (err) {
    return [];
  }
}

async function findHeroImages(attribute, hero) {
  const heroImageDir = path.join(ASSET_ROOT, 'images', 'heros', attribute, hero);
  try {
    const files = await fs.readdir(heroImageDir);
    return files
      .filter((item) => path.extname(item).toLowerCase() === '.png')
      .sort()
      .map((item) => normalizeSeparator(path.relative(PROJECT_ROOT, path.join(heroImageDir, item))));
  } catch {
    return [];
  }
}

async function buildDocIndex() {
  const result = [];
  const fileList = await safeReadDir(DOC_ROOT);

  for (const filePath of fileList) {
    const rel = normalizeSeparator(path.relative(PROJECT_ROOT, filePath));
    const parts = rel.split('/');
    const classification = classifyEntry(rel);
    const baseName = path.basename(filePath);

    const entry = {
      path: rel,
      title: trimExt(baseName),
      category: classification.category,
      group: classification.group,
      name: trimExt(baseName),
      fullPath: rel,
      lastModified: '',
      heroImages: [],
    };

    if (classification.category === 'hero') {
      entry.heroImages = await findHeroImages(classification.meta.attribute, classification.meta.hero);
    }

    try {
      const stats = await fs.stat(filePath);
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
      const rel = normalizeSeparator(readme);
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

async function sendApiError(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: message }));
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

  const normalized = normalizeSeparator(rawPath.replace(/\\/g, '/'));
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
      createApiResponse(res, {
        path: resolved.relativePath,
        type,
        title: trimExt(path.basename(resolved.relativePath)),
        content,
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
      const resolved = await resolveEditableFilePath(filePath, { allowCreate: createMode });
      if (!resolved) {
        await sendApiError(res, 404, 'document not found');
        return;
      }

      if (createMode && resolved.exists) {
        await sendApiError(res, 409, 'document already exists');
        return;
      }

      const { absolutePath, relativePath: resolvedPath } = resolved;
      try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, payload.content, 'utf8');
      } catch (error) {
        await sendApiError(res, 500, error?.message || 'failed to save');
        return;
      }

      createApiResponse(res, {
        ok: true,
        path: resolvedPath,
      });
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
        await runNodeScript(STANDARDIZE_SCRIPT, [...STANDARDIZE_ARGS, sourceFilter]);
      } else {
        await runNodeScript(STANDARDIZE_SCRIPT, STANDARDIZE_ARGS);
      }
      const standardResult = await runNodeScript(BUILD_STATIC_SCRIPT, []);

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
