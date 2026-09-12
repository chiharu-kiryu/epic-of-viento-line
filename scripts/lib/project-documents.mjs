import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkspace, readRegistry, withRegistryLock, writeJson } from './workspace.mjs';
import { projectDefinition, projectDocumentDefaults } from './project-layout.mjs';
import { resolveContainedPath } from './contained-path.mjs';

// Register the chosen type before publishing a new source file. A failed
// exclusive source write removes only this operation's new descriptor.
export async function createRegisteredDocument(root, sourcePath, documentType, writeSource) {
  const manifest = readWorkspace(root);
  if (![2, 3].includes(manifest?.version) || (manifest.version === 2 && documentType === undefined)) return writeSource();
  const typeId = documentType ?? projectDocumentDefaults(manifest, sourcePath).documentType;
  const type = projectDefinition(manifest).documentTypes.find((type) => type.id === typeId);
  if (!type) throw Object.assign(new Error('当前项目没有这个文档类型，请刷新类型列表。'), { statusCode: 400, errorCode: 'invalid_document_type' });
  return withRegistryLock(root, async () => {
    const registry = await readRegistry(root);
    if (registry.documents.some((record) => record.sourcePath === sourcePath)) return writeSource();
    const id = randomUUID();
    const file = await resolveContainedPath(root, path.join(root, 'metadata/documents', `${id}.json`), { allowMissing: true });
    await writeJson(file, { format: 'viento-document', version: 1, id, sourcePath,
      documentType: type.id, parserProfile: type.parserProfile, relations: [], assetBindings: [] }, { exclusive: true });
    try { return await writeSource(); }
    catch (error) { await fs.rm(file, { force: true }); throw error; }
  });
}
