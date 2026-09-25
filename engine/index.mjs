// Portable entry point. No filesystem, server, native bridge or user-data reads.
export { parseSourceContent } from './parse.mjs';
export { buildDocumentLayout, LAYOUT_VERSION } from './layout.mjs';
export { createDocumentFieldDraft } from './fields.mjs';
export { serializeFieldDraft, fieldValueValid } from './field-changes.mjs';
export { createBlockDraft, serializeBlockDraft, serializeSourceDraft } from './source-draft.mjs';
export { prepareMediaDraft, insertStructuredMedia } from './media-insertion.mjs';
export { createProjectModel, validateProjectTypes, validateParserDefinition, LEGACY_PATHS } from './project.mjs';
export { createDocumentStore } from './document-store.mjs';
export { normalizeSourcePath, sourceExtension, sourceFileName } from './source-path.mjs';
export * from './media-format.mjs';
export * from './document-model.mjs';
export * from './document-values.mjs';
export * from './document-contract.mjs';
