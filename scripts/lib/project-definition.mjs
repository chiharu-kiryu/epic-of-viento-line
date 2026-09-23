import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkspace, readRegistry, withRegistryLock, writeJson } from './workspace.mjs';
import { projectDefinition, validateProjectTypes, workspacePaths } from './project-layout.mjs';
import { previewProjectTemplate } from './project-service.mjs';
import { resolveContainedPath } from './contained-path.mjs';

// Definitions contain declarative data only. Applying one never moves source
// files or changes document identities, ownership, or asset registrations.
export async function applyProjectDefinition(root, definition, { write = false } = {}) {
  return withRegistryLock(root, async () => {
    const before = readWorkspace(root);
    if (!before || before.version < 2) throw new Error('请先登记项目');
    if (definition?.format !== 'viento-project-definition' || definition.version !== 1 || !definition.documentTypes) throw new Error('项目定义格式无效');
    const after = { ...before, documentTypes: definition.documentTypes, ...(definition.example ? { example: definition.example } : {}) };
    validateProjectTypes(after);
    const registry = await readRegistry(root);
    const unknown = registry.documents.filter((record) => !definition.documentTypes.some((type) => type.id === record.documentType));
    if (unknown.length) throw new Error(`项目定义缺少现有文档类型：${[...new Set(unknown.map((record) => record.documentType))].join(', ')}`);
    for (const type of definition.documentTypes) {
      let content = projectDefinition({ ...after, documentTypes: [type] }).documentTypes[0].content;
      let format = 'md';
      if (type.template) {
        const file = await resolveContainedPath(root, path.join(root, workspacePaths(after).templates, type.template));
        if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('模板超过 1 MB');
        content = await fs.readFile(file, 'utf8');
        format = path.extname(file).slice(1).toLowerCase() || 'txt';
      }
      previewProjectTemplate(after, { type, content, format });
    }
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    let journal = null;
    if (write && changed) {
      journal = `.viento/migrations/project-definition-${Date.now()}-${randomUUID()}.json`;
      const file = await resolveContainedPath(root, path.join(root, journal), { allowMissing: true });
      await writeJson(file, { version: 1, before, after }, { exclusive: true });
      await writeJson(path.join(root, 'workspace.json'), after);
    }
    return { write, changed, types: after.documentTypes.length, documents: registry.documents.length, assets: registry.assets.length, journal };
  });
}
