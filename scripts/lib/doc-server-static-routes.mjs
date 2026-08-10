import path from 'node:path';
import fs from 'node:fs/promises';
import {
  sendFile,
  sendApiError,
  getWebRootIndexPath,
  getProjectFilePath,
  isProjectFilePathSafe,
} from './doc-server.mjs';
import { API_RESPONSE } from './doc-api-contract.mjs';

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
    || pathname.startsWith('/data-template/')
    || pathname.startsWith('/design-data/')
    || pathname.startsWith('/docs-standard/');
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
    path.join(projectRoot, 'favicon.ico'),
    path.join(webRoot, 'favicon.ico'),
  ];
}

async function handleFavicon({ response, projectRoot, webRoot }) {
  const candidates = buildFaviconCandidates(projectRoot, webRoot);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      await sendFile(candidate, response);
      return true;
    } catch {
      // continue
    }
  }

  await sendStaticJsonError(response, 404, 'favicon not found', 'favicon_not_found');
  return true;
}

async function handleProjectFileRequest({ response, pathname, projectRoot }) {
  const decodedPath = safeDecodePath(pathname);
  if (!decodedPath) {
    await sendStaticJsonError(response, 400, 'bad path', 'bad_path');
    return true;
  }

  const candidatePath = path.normalize(getProjectFilePath(decodedPath));
  if (!isProjectFilePathSafe(candidatePath)) {
    await sendStaticJsonError(response, 403, 'forbidden', 'path_forbidden');
    return true;
  }

  try {
    const stat = await fs.stat(candidatePath);
    if (stat.isDirectory()) {
      if (isIndexFallbackPath(pathname)) {
        const indexPath = getWebRootIndexPath();
        await sendFile(indexPath, response);
        return true;
      }
      await sendStaticJsonError(response, 403, 'directory access disabled', 'directory_access_disabled');
      return true;
    }

    await sendFile(candidatePath, response);
    return true;
  } catch {
    const normalizedPath = decodedPath || pathname;
    if (isWebAssetPath(normalizedPath) || isManagedAssetPath(normalizedPath)) {
      await sendStaticJsonError(response, 404, 'Not found', 'not_found');
      return true;
    }

    const indexPath = getWebRootIndexPath();
    await sendFile(indexPath, response);
    return true;
  }
}

async function handleStaticRequest({ pathname, response, projectRoot, webRoot }) {
  if (isFaviconPath(pathname)) {
    return handleFavicon({ response, projectRoot, webRoot });
  }

  if (isApiPath(pathname)) {
    await sendStaticJsonError(response, 404, 'not found', 'api_not_found');
    return true;
  }

  if (isRootPath(pathname)) {
    const indexPath = getWebRootIndexPath();
    await sendFile(indexPath, response);
    return true;
  }

  return handleProjectFileRequest({ response, pathname, projectRoot });
}

export {
  handleStaticRequest,
  isRootPath,
  isFaviconPath,
  isWebAssetPath,
};
