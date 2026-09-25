import path from 'node:path';
import { userError } from './user-message.mjs';
import { readRegistry, readWorkspace } from './workspace.mjs';
import { resolveDocumentDefinition, workspacePaths } from './project-layout.mjs';
import { createDocumentFieldDraft } from '../../engine/fields.mjs';
export { createDocumentFieldDraft };
const invalid = message => userError(message, 400, 'field_draft_invalid');

export async function prepareDocumentFields(root, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('字段读取参数无效。');
  const { content, sourcePath, documentType } = payload;
  const manifest = readWorkspace(root);
  const prefix = workspacePaths(manifest).documents + '/';
  if (typeof content !== 'string' || typeof sourcePath !== 'string' || !sourcePath.startsWith(prefix)
    || sourcePath.split('/').some(part => !part || part === '.' || part === '..') || sourcePath.includes('\\')
    || !['', '.md', '.txt', '.json', '.yaml', '.yml'].includes(path.extname(sourcePath).toLowerCase())) {
    throw invalid('字段读取参数无效。');
  }
  const registry = await readRegistry(root);
  const record = registry.documents.find(record => record.sourcePath === sourcePath);
  const descriptor = resolveDocumentDefinition(manifest, sourcePath, record || (documentType ? { documentType } : {}));
  return createDocumentFieldDraft(content, sourcePath, descriptor);
}
