import { normalizeSourcePath, sourceExtension, sourceFileName } from './source-path.mjs';
import { trimName } from './text-utils.mjs';
import { createError } from './service-error.mjs';
import {
  API_ERRORS, API_RESPONSE_DEFAULTS, normalizeDocWriteRequest,
  normalizeDocumentVersion, getCreatePathError,
} from './document-contract.mjs';

// The host owns resolution, access permissions, transactions and durable writes.
// Reference handles and snapshot writeState are opaque to this shared workflow.
export function createDocumentStore({ storage, editablePrefixes, onWrite = () => {} }) {
  const prefixes = [...editablePrefixes];
  const allowed = (value) => value && prefixes.some((prefix) => value.startsWith(prefix));

  async function getDocByPath(rawPath = '') {
    const filePath = normalizeSourcePath(rawPath);
    if (!allowed(filePath)) throw createError(400, API_ERRORS.badPath, {}, API_ERRORS.badPath);
    return storage.transaction(filePath, async () => {
      const reference = await storage.resolve(filePath, { create: false });
      if (!reference || !reference.exists) throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
      const { content, lastModified, version } = await storage.read(reference);
      return {
        path: reference.path,
        type: sourceExtension(reference.path).replace('.', '') || 'txt',
        title: trimName(sourceFileName(reference.path)),
        content, lastModified, version,
      };
    });
  }

  async function writeDoc(rawPayload = {}) {
    const normalized = normalizeDocWriteRequest(rawPayload);
    if (!normalized.path) throw createError(400, API_ERRORS.missingPath, {}, API_ERRORS.missingPath);
    const filePath = normalizeSourcePath(normalized.path);
    if (!allowed(filePath)) throw createError(400, API_ERRORS.badPath, {}, API_ERRORS.badPath);
    if (typeof normalized.content !== 'string') throw createError(400, API_ERRORS.missingContent, {}, API_ERRORS.missingContent);
    const create = normalized.create === true;
    const pathError = create && getCreatePathError(filePath);
    if (pathError) throw createError(400, pathError, {}, API_ERRORS.badPath);
    const force = normalized.force === true;
    const expectedVersion = normalizeDocumentVersion(normalized.expectedVersion);

    return storage.transaction(filePath, async () => {
      const reference = await storage.resolve(filePath, { create });
      if (!reference || (!create && !reference.exists)) throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
      if (create && reference.exists) throw createError(409, API_ERRORS.alreadyExists, {}, API_ERRORS.alreadyExists);
      if (!create && !expectedVersion && !force) throw createError(409, API_ERRORS.missingExpectedVersion, {}, API_ERRORS.missingExpectedVersion);

      let previous = null;
      if (!create) {
        try {
          previous = await storage.read(reference);
          if (!force && previous.version !== expectedVersion) {
            throw createError(409, API_ERRORS.conflict, {
              currentVersion: previous.version, lastModified: previous.lastModified,
            }, API_ERRORS.conflict);
          }
        } catch (error) {
          if (error?.statusCode) throw error;
          if (error?.code === 'ENOENT') throw createError(404, API_ERRORS.docNotFound, {}, API_ERRORS.docNotFound);
          throw createError(500, 'failed to check version', {}, API_RESPONSE_DEFAULTS.internalErrorPrefix);
        }
      }

      try {
        const { lastModified, version } = await storage.write(reference, normalized.content, {
          create, previous, documentType: normalized.documentType,
        });
        await onWrite(reference.path);
        return { ok: true, path: reference.path, lastModified, version };
      } catch (error) {
        if (error?.statusCode) throw error;
        if (create && error?.code === 'EEXIST') throw createError(409, API_ERRORS.alreadyExists, {}, API_ERRORS.alreadyExists);
        throw createError(500, 'failed to save', {}, API_RESPONSE_DEFAULTS.internalErrorPrefix);
      }
    });
  }

  return { getDocByPath, writeDoc };
}
