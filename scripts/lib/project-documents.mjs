import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkspace, readRegistry, withRegistryLock, writeJson } from './workspace.mjs';
import { projectDefinition, projectDocumentDefaults } from './project-layout.mjs';
import { resolveContainedPath } from './contained-path.mjs';
import { API_ERRORS } from './doc-api-contract.mjs';

const portableKey = (value) => value.normalize('NFC').toLowerCase();
const pathConflict = (sourcePath) => Object.assign(new Error(`新建位置与已有文档或目录冲突：${sourcePath}`), {
  statusCode: 409, errorCode: API_ERRORS.alreadyExists,
});

function conflictsWithRegisteredPath(sourcePath, existing) {
  const parts = sourcePath.split('/'), previous = existing.split('/');
  for (let i = 0; i < Math.min(parts.length, previous.length); i++) {
    if (portableKey(parts[i]) !== portableKey(previous[i])) return false;
    if (parts[i] !== previous[i]) return true;
  }
  // A descriptor still reserves its identity when its source is missing. It
  // also cannot be reused as a directory, or replaced by an ancestor file.
  return true;
}

async function checkFilesystemLocation(root, sourcePath) {
  const parts = sourcePath.split('/');
  let directory = root;
  for (const [index, part] of parts.entries()) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const matches = entries.filter((entry) => portableKey(entry.name) === portableKey(part));
    if (!matches.length) return;
    if (matches.some((entry) => entry.name !== part) || index === parts.length - 1 || !matches[0].isDirectory()) {
      throw pathConflict([...parts.slice(0, index), matches[0].name].join('/'));
    }
    directory = path.join(directory, part);
  }
}

// Register the chosen type before publishing a new source file. A failed
// exclusive source write removes only this operation's new descriptor.
export async function createRegisteredDocument(root, sourcePath, documentType, writeSource) {
  return withRegistryLock(root, async () => {
    // Read the type definition only after pending configuration writes finish.
    const manifest = readWorkspace(root);
    const managed = [2, 3].includes(manifest?.version);
    const registry = managed ? await readRegistry(root) : { documents: [] };
    const reserved = registry.documents.find((record) => conflictsWithRegisteredPath(sourcePath, record.sourcePath));
    if (reserved) throw pathConflict(reserved.sourcePath);
    await checkFilesystemLocation(root, sourcePath);
    if (!managed || (manifest.version === 2 && documentType === undefined)) return writeSource();
    const typeId = documentType ?? projectDocumentDefaults(manifest, sourcePath).documentType;
    const type = projectDefinition(manifest).documentTypes.find((entry) => entry.id === typeId);
    if (!type) throw Object.assign(new Error('当前项目没有这个文档类型，请刷新类型列表。'), { statusCode: 400, errorCode: 'invalid_document_type' });
    const id = randomUUID();
    const file = await resolveContainedPath(root, path.join(root, 'metadata/documents', `${id}.json`), { allowMissing: true });
    await writeJson(file, { format: 'viento-document', version: 1, id, sourcePath,
      documentType: type.id, parserProfile: type.parserProfile, relations: [], assetBindings: [] }, { exclusive: true });
    try { return await writeSource(); }
    catch (error) { await fs.rm(file, { force: true }); throw error; }
  });
}
