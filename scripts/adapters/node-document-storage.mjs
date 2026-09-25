import { createRegisteredDocument } from '../lib/project-documents.mjs';
import {
  withDocumentTransaction, documentContentVersion, readDocumentSnapshot, writeDocumentAtomically,
} from '../lib/doc-file-store.mjs';

export function createNodeDocumentStorage({ root, resolvePath }) {
  return {
    transaction: withDocumentTransaction,
    async resolve(sourcePath, { create }) {
      const resolved = await resolvePath(sourcePath, { allowCreate: create });
      return resolved && { path: resolved.relativePath, exists: resolved.exists, handle: resolved.absolutePath };
    },
    async read(reference) {
      const { content, stats, version } = await readDocumentSnapshot(reference.handle);
      return { content, lastModified: stats.mtime.toISOString(), version, writeState: stats };
    },
    async write(reference, content, { create, previous, documentType }) {
      const writeSource = () => writeDocumentAtomically(reference.handle, content, {
        create, previousStats: previous?.writeState || null,
      });
      const stats = create
        ? await createRegisteredDocument(root, reference.path, documentType, writeSource)
        : await writeSource();
      return { lastModified: stats.mtime.toISOString(), version: documentContentVersion(content) };
    },
  };
}
