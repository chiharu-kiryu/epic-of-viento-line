import { userError } from './user-message.mjs';
import { readRegistry, readWorkspace } from './workspace.mjs';
import { resolveDocumentDefinition } from './project-layout.mjs';
import { MEDIA_KINDS } from './media-format.mjs';
import { prepareMediaDraft } from '../../engine/media-insertion.mjs';
export { insertStructuredMedia } from '../../engine/media-insertion.mjs';

const invalid = message => userError(message, 400, 'media_insertion_invalid');

export async function prepareMediaInsertion(root, { content, sourcePath, assetIds = [], documentType } = {}) {
  if (typeof content !== 'string' || typeof sourcePath !== 'string' || !Array.isArray(assetIds) || assetIds.length > 100) throw invalid('素材插入参数无效。');
  const registry = await readRegistry(root);
  const assets = assetIds.map((id) => {
    const asset = registry.assets.find((item) => item.id === id && MEDIA_KINDS.includes(item.kind));
    if (!asset) throw invalid('所选素材未登记，请刷新素材列表。');
    return { type: asset.kind, src: `asset:${asset.id}`, caption: asset.name };
  });
  const record = registry.documents.find((record) => record.sourcePath === sourcePath);
  const descriptor = resolveDocumentDefinition(readWorkspace(root), sourcePath, record || (documentType ? { documentType } : {}));
  return prepareMediaDraft(content, sourcePath, assets, descriptor);
}
