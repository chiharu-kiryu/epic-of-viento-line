import path from 'node:path';
import fs from 'node:fs/promises';
import {
  sendFile,
  sendApiError,
  getWebRootIndexPath,
  resolveProjectFilePath,
} from './doc-server.mjs';
import { resolveContainedPath } from './contained-path.mjs';
import { API_RESPONSE, API_RESPONSE_DEFAULTS } from './doc-api-contract.mjs';

const STATIC_ALLOWED_METHODS = ['GET', 'HEAD'];

function safeDecodePath(pathname) {
  if (/%2f|%2F|%5c|%5C/.test(pathname)) {
    return '';
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return '';
  }
}

function isApiPath(pathname) {
  return pathname.startsWith('/api/');
}

function isRootPath(pathname) {
  return pathname === '/' || pathname === '/index.html' || pathname === '/web' || pathname === '/web/';
}

function isIndexFallbackPath(pathname) {
  return pathname === '/' || pathname === '/web' || pathname === '/web/';
}

function isWebAssetPath(pathname) {
  return pathname.startsWith('/web/');
}

function isFaviconPath(pathname) {
  return pathname === '/favicon.ico' || pathname === '/web/favicon.ico';
}

function isManagedAssetPath(pathname) {
  return pathname.startsWith('/assets/')
    || pathname.startsWith('/asset-files/')
    || pathname.startsWith('/documents/')
    || pathname.startsWith('/templates/')
    || pathname.startsWith('/data-template/')
    || pathname.startsWith('/design-data/')
    || pathname.startsWith('/docs-standard/');
}

function isSafeStaticAssetPath(pathname) {
  return pathname === '/favicon.ico'
    || pathname === '/web/favicon.ico'
    || pathname === '/scripts/lib/doc-api-contract.mjs'
    || pathname === '/scripts/lib/media-format.mjs'
    || pathname.startsWith('/assets/')
    || pathname.startsWith('/asset-files/')
    || pathname.startsWith('/web/')
    || pathname.startsWith('/data/')
    || pathname.startsWith('/documents/')
    || pathname.startsWith('/templates/')
    || pathname.startsWith('/data-template/')
    || pathname.startsWith('/design-data/')
    || pathname.startsWith('/docs-standard/');
}

function isPathTraversalPath(pathname) {
  return pathname.includes('/../')
    || pathname.includes('/..')
    || pathname.includes('..\\')
    || pathname.includes('\\..');
}

function isAllowedStaticMethod(method = '') {
  const normalizedMethod = method.toString().trim().toUpperCase();
  return STATIC_ALLOWED_METHODS.includes(normalizedMethod);
}

function sendStaticJsonError(response, statusCode, message, errorCode = '') {
  const payload = {};
  if (errorCode && typeof errorCode === 'string') {
    payload[API_RESPONSE.errorCode] = errorCode;
  }
  sendApiError(response, statusCode, message, payload);
}

function buildFaviconCandidates(projectRoot, webRoot) {
  return [
    { root: path.dirname(webRoot), file: path.join(webRoot, '..', 'favicon.ico') },
    { root: projectRoot, file: path.join(projectRoot, 'favicon.ico') },
    { root: path.dirname(webRoot), file: path.join(webRoot, 'favicon.ico') },
  ];
}

async function handleFavicon({ response, projectRoot, webRoot, request }) {
  const candidates = buildFaviconCandidates(projectRoot, webRoot);

  for (const candidate of candidates) {
    try {
      const file = await resolveContainedPath(candidate.root, candidate.file);
      await sendFile(file, response, request);
      return true;
    } catch {
      // continue
    }
  }

  await sendStaticJsonError(response, 404, 'favicon not found', 'favicon_not_found');
  return true;
}

async function handleProjectFileRequest({ response, pathname, projectRoot, request }) {
  const decodedPath = safeDecodePath(pathname);
  if (!decodedPath) {
    await sendStaticJsonError(response, 400, 'bad path', 'bad_path');
    return true;
  }

  if (isPathTraversalPath(decodedPath) || !isSafeStaticAssetPath(decodedPath)) {
    await sendStaticJsonError(response, 404, 'not found', 'not_found');
    return true;
  }

  let candidatePath;
  try { candidatePath = await resolveProjectFilePath(decodedPath); }
  catch (error) {
    const forbidden = error.statusCode === 403;
    await sendStaticJsonError(response, forbidden ? 403 : 404,
      forbidden ? 'forbidden' : 'Not found', forbidden ? 'path_forbidden' : 'not_found');
    return true;
  }

  try {
    const stat = await fs.lstat(candidatePath);
    if (stat.isSymbolicLink()) {
      await sendStaticJsonError(response, 403, 'forbidden', 'path_forbidden');
      return true;
    }
    if (stat.isDirectory()) {
      if (isIndexFallbackPath(pathname)) {
        const indexPath = getWebRootIndexPath();
        await sendFile(indexPath, response, request);
        return true;
      }
      await sendStaticJsonError(response, 403, 'directory access disabled', 'directory_access_disabled');
      return true;
    }

    if (!stat.isFile()) {
      await sendStaticJsonError(response, 403, 'forbidden', 'path_forbidden');
      return true;
    }

    await sendFile(candidatePath, response, request, stat);
    return true;
  } catch {
    const normalizedPath = decodedPath || pathname;
    if (isWebAssetPath(normalizedPath) || isManagedAssetPath(normalizedPath)) {
      await sendStaticJsonError(response, 404, 'Not found', 'not_found');
      return true;
    }

    const indexPath = getWebRootIndexPath();
    await sendFile(indexPath, response, request);
    return true;
  }
}

async function handleStaticRequest({
  pathname,
  response,
  projectRoot,
  webRoot,
  requestMethod = '',
  request,
}) {
  if (!isAllowedStaticMethod(requestMethod)) {
    response.setHeader('Allow', STATIC_ALLOWED_METHODS.join(', '));
    await sendStaticJsonError(response, 405, 'method not allowed', API_RESPONSE_DEFAULTS.methodErrorPrefix || 'method_not_allowed');
    return true;
  }

  if (isFaviconPath(pathname)) {
    return handleFavicon({ response, projectRoot, webRoot, request });
  }

  if (isApiPath(pathname)) {
    await sendStaticJsonError(response, 404, 'not found', 'api_not_found');
    return true;
  }

  if (isRootPath(pathname)) {
    const indexPath = getWebRootIndexPath();
    await sendFile(indexPath, response, request);
    return true;
  }

  return handleProjectFileRequest({ response, pathname, projectRoot, request });
}

export {
  handleStaticRequest,
  isRootPath,
  isFaviconPath,
  isWebAssetPath,
};
