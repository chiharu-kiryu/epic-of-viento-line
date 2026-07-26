import path from 'node:path';
import fs from 'node:fs/promises';
import { trimName } from './paths.mjs';
import {
  safePathFromQuery,
  normalizeLockVersion,
  normalizeStandardizeSourceFilter,
  isAllowedEditPath,
  resolveEditableFilePath,
  readRequestJsonBody,
  readTextFile,
  buildEditableDocIndex,
  sendApiResponse,
  sendApiError,
} from './doc-server.mjs';
import { rebuildIndex } from './rebuild-workflow.mjs';
import {
  API_PATHS,
  API_METHODS,
  API_ERRORS,
  normalizeRebuildRequest,
  normalizeDocWriteRequest,
  makeCapabilitiesPayload,
  makeRebuildResponse,
} from './doc-api-contract.mjs';

function methodNotAllowed(response, allow = 'GET') {
  response.statusCode = 405;
  response.setHeader('Allow', allow);
  response.end('method not allowed');
}

async function handleApiIndex(response) {
  const indexData = await buildEditableDocIndex();
  sendApiResponse(response, indexData);
}

async function handleApiDocGet(response, requestUrl) {
  const filePath = safePathFromQuery(requestUrl.searchParams.get('path') || '');
  if (!filePath || !isAllowedEditPath(filePath)) {
    await sendApiError(response, 400, API_ERRORS.badPath);
    return;
  }

  const resolved = await resolveEditableFilePath(filePath);
  if (!resolved) {
    await sendApiError(response, 404, API_ERRORS.docNotFound);
    return;
  }

  const content = await readTextFile(resolved.absolutePath);
  if (content === null) {
    await sendApiError(response, 404, API_ERRORS.docNotFound);
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

  sendApiResponse(response, {
    path: resolved.relativePath,
    type,
    title: trimName(path.basename(resolved.relativePath)),
    content,
    lastModified: modifiedAt,
    version,
  });
}

async function handleApiDocWrite(response, request) {
  let payload;
  try {
    payload = await readRequestJsonBody(request);
  } catch (error) {
    await sendApiError(response, 400, `invalid json: ${error?.message || 'parse error'}`);
    return;
  }

  const normalized = normalizeDocWriteRequest(payload);
  if (!normalized.path) {
    await sendApiError(response, 400, API_ERRORS.missingPath);
    return;
  }

  const filePath = safePathFromQuery(normalized.path);
  if (!filePath || !isAllowedEditPath(filePath)) {
    await sendApiError(response, 400, API_ERRORS.badPath);
    return;
  }

  if (typeof normalized.content !== 'string') {
    await sendApiError(response, 400, API_ERRORS.missingContent);
    return;
  }

  const createMode = normalized.create === true;
  const forceOverwrite = normalized.force === true;
  const expectedVersion = normalizeLockVersion(normalized.expectedVersion);
  const resolved = await resolveEditableFilePath(filePath, { allowCreate: createMode });
  if (!resolved) {
    await sendApiError(response, 404, API_ERRORS.docNotFound);
    return;
  }
  if (!createMode && !resolved.exists) {
    await sendApiError(response, 404, API_ERRORS.docNotFound);
    return;
  }
  if (createMode && resolved.exists) {
    await sendApiError(response, 409, API_ERRORS.alreadyExists);
    return;
  }

  const { absolutePath, relativePath } = resolved;
  if (!createMode && !expectedVersion && !forceOverwrite) {
    await sendApiError(response, 409, API_ERRORS.missingExpectedVersion);
    return;
  }

  if (!createMode && expectedVersion && !forceOverwrite) {
    try {
      const stats = await fs.stat(absolutePath);
      const currentVersion = String(stats.mtimeMs);
      if (currentVersion !== expectedVersion) {
        await sendApiError(response, 409, 'document was modified by another client', {
          currentVersion,
          lastModified: stats.mtime.toISOString(),
        });
        return;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await sendApiError(response, 404, API_ERRORS.docNotFound);
        return;
      }
      await sendApiError(response, 500, error?.message || 'failed to check version');
      return;
    }
  }

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, normalized.content, 'utf8');
    const stats = await fs.stat(absolutePath);
    sendApiResponse(response, {
      ok: true,
      path: relativePath,
      lastModified: stats.mtime.toISOString(),
      version: String(stats.mtimeMs),
    });
  } catch (error) {
    await sendApiError(response, 500, error?.message || 'failed to save');
  }
}

async function handleApiRebuild(response, request, {
  backstoryMergeMode,
  state,
}) {
  if (state.rebuildInProgress) {
    await sendApiError(response, 409, API_ERRORS.rebuildInProgress);
    return;
  }

  let payload;
  try {
    payload = await readRequestJsonBody(request);
  } catch (error) {
    await sendApiError(response, 400, `invalid json: ${error?.message || 'parse error'}`);
    return;
  }

  const rebuildRequest = normalizeRebuildRequest(payload);
  const sourceFilter = normalizeStandardizeSourceFilter(rebuildRequest.source);
  state.rebuildInProgress = true;

  try {
    const result = await rebuildIndex({
      backstoryMode: backstoryMergeMode,
      sourceFilter,
      runStandardize: rebuildRequest.runStandardize,
      runBuild: rebuildRequest.runBuild,
    });
    sendApiResponse(response, makeRebuildResponse(result, sourceFilter));
  } catch (error) {
    await sendApiError(response, 500, error?.message || 'rebuild failed');
  } finally {
    state.rebuildInProgress = false;
  }
}

async function handleApiRequest({
  pathname,
  request,
  response,
  requestUrl,
  editablePrefixes,
  backstoryMergeMode,
  state,
}) {
  if (pathname === API_PATHS.INDEX) {
    try {
      await handleApiIndex(response);
    } catch (error) {
      await sendApiError(response, 500, error?.message || 'failed to build index');
    }
    return true;
  }

  if (pathname === API_PATHS.CAPABILITIES) {
    if (request.method !== API_METHODS.GET) {
      methodNotAllowed(response, API_METHODS.GET);
      return true;
    }
    sendApiResponse(response, makeCapabilitiesPayload(editablePrefixes, backstoryMergeMode));
    return true;
  }

  if (pathname === API_PATHS.DOC) {
    if (request.method === API_METHODS.GET) {
      await handleApiDocGet(response, requestUrl);
      return true;
    }
    if (request.method === API_METHODS.POST || request.method === API_METHODS.PUT) {
      await handleApiDocWrite(response, request);
      return true;
    }
    methodNotAllowed(response, `${API_METHODS.GET}, ${API_METHODS.POST}, ${API_METHODS.PUT}`);
    return true;
  }

  if (pathname === API_PATHS.REBUILD) {
    if (request.method !== API_METHODS.POST) {
      methodNotAllowed(response, API_METHODS.POST);
      return true;
    }
    await handleApiRebuild(response, request, {
      backstoryMergeMode,
      state,
    });
    return true;
  }

  return false;
}

export {
  handleApiRequest,
  methodNotAllowed,
};
