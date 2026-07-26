import path from 'node:path';
import fs from 'node:fs/promises';
import {
  sendFile,
  sendApiError,
  getWebRootIndexPath,
  getProjectFilePath,
  isProjectFilePathSafe,
} from './doc-server.mjs';

function safeDecodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return '';
  }
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

  await sendApiError(response, 404, 'favicon not found');
  return true;
}

async function handleProjectFileRequest({ response, pathname, projectRoot }) {
  const decodedPath = safeDecodePath(pathname);
  if (!decodedPath) {
    await sendApiError(response, 400, 'bad path');
    return true;
  }

  const candidatePath = path.normalize(getProjectFilePath(decodedPath));
  if (!isProjectFilePathSafe(candidatePath)) {
    await sendApiError(response, 403, 'forbidden');
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
      response.statusCode = 403;
      response.end('Directory access disabled');
      return true;
    }

    await sendFile(candidatePath, response);
    return true;
  } catch {
    if (isWebAssetPath(pathname)) {
      response.statusCode = 404;
      response.end('Not found');
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
