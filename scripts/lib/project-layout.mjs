import fs from 'node:fs';

export const PROJECT_DEFAULTS = JSON.parse(fs.readFileSync(new URL('./project-defaults.json', import.meta.url), 'utf8'));
export const LEGACY_PATHS = Object.freeze({ documents: 'design-data', templates: 'data-template', metadata: 'metadata' });

export function workspacePaths(manifest) {
  return manifest?.version === 3 ? { ...PROJECT_DEFAULTS.paths } : { ...LEGACY_PATHS };
}

export function validateProjectTypes(manifest) {
  const types = manifest.documentTypes;
  if (types === undefined) return;
  if (!Array.isArray(types) || !types.length || types.length > 100) throw new Error('项目文档类型需要包含 1 至 100 个类型');
  const ids = new Set(), directories = new Set();
  const relative = (value) => typeof value === 'string' && value.split('/').every((part) => part && !['.', '..'].includes(part)
    && !/[<>:"\\|?*\x00-\x1f\x7f-\x9f]/.test(part) && !/[. ]$/.test(part)
    && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
  for (const type of types) {
    if (!type || typeof type.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(type.id)
      || typeof type.label !== 'string' || !type.label.trim() || type.label.length > 120
      || typeof type.directory !== 'string' || (type.directory !== '' && !relative(type.directory))
      || !['structured', 'prose'].includes(type.parserProfile)
      || (type.template !== undefined && (!relative(type.template) || !/\.(md|txt|json|ya?ml)$/i.test(type.template)))) throw new Error('项目文档类型、模板或目录配置无效');
    const directory = type.directory.normalize('NFC').toLowerCase();
    if (ids.has(type.id) || directories.has(directory)) throw new Error('项目文档类型或目录重复');
    ids.add(type.id); directories.add(directory);
  }
}

export function projectDefinition(manifest) {
  const paths = workspacePaths(manifest);
  const types = manifest?.documentTypes || PROJECT_DEFAULTS.documentTypes;
  return { id: manifest?.id || '', name: manifest?.name || '', version: manifest?.version || 1, paths,
    documentTypes: types.map((type) => ({ ...type,
      ...(manifest?.version === 3 && type.template ? { templateSource: `${paths.templates}/${type.template}` } : {}),
      content: PROJECT_DEFAULTS.templates[type.template] || `# 新建${type.label}\n\n`,
    })) };
}

export function projectDocumentDefaults(manifest, sourcePath) {
  const relative = sourcePath.replace(/^docs-standard\//, '').slice(workspacePaths(manifest).documents.length + 1);
  const types = [...(manifest?.documentTypes || PROJECT_DEFAULTS.documentTypes)].sort((a, b) => b.directory.length - a.directory.length);
  const type = types.find((type) => !type.directory || relative.startsWith(`${type.directory}/`));
  return { documentType: type?.id || 'document', parserProfile: type?.parserProfile || 'structured', relations: [] };
}
