import fs from 'node:fs';
import { legacyDocumentDefaults } from './document-model.mjs';

export const PROJECT_DEFAULTS = JSON.parse(fs.readFileSync(new URL('./project-defaults.json', import.meta.url), 'utf8'));
export const LEGACY_PATHS = Object.freeze({ documents: 'design-data', templates: 'data-template', metadata: 'metadata' });

export function workspacePaths(manifest) {
  return manifest?.version === 3 ? { ...PROJECT_DEFAULTS.paths } : { ...LEGACY_PATHS };
}

export function validateParserDefinition(type) {
  const options = type.parserOptions;
  if (options !== undefined) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => !['allowedFieldKeys', 'multilineFieldKeys', 'boundaryFieldKeys', 'titleField'].includes(key))) throw new Error('无效的字段解析规则');
    for (const [key, value] of Object.entries(options)) {
      if (key === 'titleField') {
        if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error('标题字段无效');
      } else if (!Array.isArray(value) || value.length > 200 || new Set(value).size !== value.length
        || value.some((field) => typeof field !== 'string' || !field.trim() || field.length > 120)) throw new Error('字段解析规则需要不重复的字段名称');
    }
  }
  if (type.fieldGroups !== undefined) {
    if (!Array.isArray(type.fieldGroups) || type.fieldGroups.length > 50) throw new Error('字段分组无效');
    const fields = new Set();
    for (const group of type.fieldGroups) {
      if (!group || typeof group.title !== 'string' || !group.title.trim() || group.title.length > 120
        || !Array.isArray(group.fields) || !group.fields.length || group.fields.length > 200) throw new Error('字段分组需要名称和字段');
      for (const field of group.fields) {
        if (typeof field !== 'string' || !field.trim() || field.length > 120 || fields.has(field)) throw new Error('分组字段无效或重复');
        fields.add(field);
      }
    }
  }
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
      || (type.template !== undefined && (!relative(type.template) || (!/\.(md|txt|json|ya?ml)$/i.test(type.template) && !(manifest.version === 2 && !type.template.split('/').at(-1).includes('.')))))) throw new Error('项目文档类型、模板或目录配置无效');
    const directory = type.directory.normalize('NFC').toLowerCase();
    if (ids.has(type.id) || directories.has(directory)) throw new Error('项目文档类型或目录重复');
    ids.add(type.id); directories.add(directory);
    validateParserDefinition(type);
  }
}

export function projectDefinition(manifest) {
  const paths = workspacePaths(manifest);
  const types = manifest?.documentTypes || PROJECT_DEFAULTS.documentTypes;
  return { id: manifest?.id || '', name: manifest?.name || '', version: manifest?.version || 1, paths,
    configurable: Boolean(manifest && manifest.version >= 2), projectTypes: Boolean(manifest?.documentTypes || manifest?.version === 3),
    ...(manifest?.example ? { example: manifest.example } : {}),
    documentTypes: types.map((type) => ({ ...type,
      ...((manifest?.documentTypes || manifest?.version === 3) && type.template ? { templateSource: `${paths.templates}/${type.template}` } : {}),
      content: PROJECT_DEFAULTS.templates[type.template] || `# 新建${type.label}\n\n`,
    })) };
}

// The registered type stays stable after a move. Its project definition owns
// parsing, including when the metadata was created by an older application.
export function resolveDocumentDefinition(manifest, sourcePath, record = {}) {
  const explicit = manifest?.documentTypes || manifest?.version === 3;
  const defaults = explicit ? projectDocumentDefaults(manifest, sourcePath) : legacyDocumentDefaults(sourcePath);
  const descriptor = { ...defaults, ...record };
  const type = explicit ? projectDefinition(manifest).documentTypes.find((type) => type.id === descriptor.documentType) : null;
  return type ? { ...descriptor, parserProfile: type.parserProfile, parserOptions: type.parserOptions || {}, fieldGroups: type.fieldGroups || [], typeLabel: type.label } : descriptor;
}

export function projectDocumentDefaults(manifest, sourcePath) {
  const relative = sourcePath.replace(/^docs-standard\//, '').slice(workspacePaths(manifest).documents.length + 1);
  const types = [...(manifest?.documentTypes || PROJECT_DEFAULTS.documentTypes)].sort((a, b) => b.directory.length - a.directory.length);
  const type = types.find((type) => !type.directory || relative.startsWith(`${type.directory}/`));
  return { documentType: type?.id || 'document', parserProfile: type?.parserProfile || 'structured', relations: [] };
}
