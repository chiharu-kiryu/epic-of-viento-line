import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readWorkspace, readRegistry, withRegistryLock, writeJson } from './workspace.mjs';
import { PROJECT_DEFAULTS, projectDefinition, workspacePaths, validateProjectTypes } from './project-layout.mjs';
import { resolveContainedPath } from './contained-path.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { parserOptionsForSource } from '../standardize-docs/legacy-profile.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { writeDocumentAtomically } from './doc-file-store.mjs';
import { getCreatePathError } from './doc-api-contract.mjs';

const hash = (content) => createHash('sha256').update(content).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, errorCode: 'project_configuration' });
const formats = ['md', 'txt', 'json', 'yaml', 'yml'];
const formatOf = (file = '') => path.extname(file).slice(1).toLowerCase() || 'txt';

// Adopting an older workspace makes its existing notation explicit once. No
// source, UUID, relation or attachment is rewritten by template management.
async function definitions(root, manifest) {
  if (manifest.documentTypes || manifest.version === 3) return structuredClone(manifest.documentTypes || PROJECT_DEFAULTS.documentTypes);
  const records = (await readRegistry(root)).documents;
  const types = PROJECT_DEFAULTS.documentTypes.map(({ template, ...type }) => ({ ...type }));
  for (const id of new Set(records.map((record) => record.documentType))) {
    const record = records.find((record) => record.documentType === id);
    let type = types.find((type) => type.id === id);
    if (!type) { type = { id, label: id, directory: id }; types.push(type); }
    const { keyValueMode, ...parserOptions } = parserOptionsForSource(record.sourcePath, record);
    type.parserProfile = record.parserProfile === 'prose' ? 'prose' : 'structured';
    type.parserOptions = parserOptions;
  }
  return types;
}

export function previewProjectTemplate(manifest, { type, content, format = 'md' } = {}) {
  if (!type || typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024 || !formats.includes(format)) throw fail('模板内容或格式无效（最多 1 MB）');
  validateProjectTypes({ ...manifest, documentTypes: [type] });
  const directory = type.directory ? `${type.directory}/` : '';
  const pathError = getCreatePathError(`${workspacePaths(manifest).documents}/${directory}document.${format}`);
  if (pathError) throw fail(pathError);
  const parsed = parseSourceContent(content, `template.${format}`, { ...type, parserOptions: type.parserOptions || {} });
  if (parsed.parseError) throw fail(`模板解析失败：${parsed.parseError}`);
  return { title: parsed.title, layout: buildDocumentLayout(parsed), parser: parsed.profile };
}

export async function readProjectConfiguration(root) {
  const manifest = readWorkspace(root);
  if (!manifest || manifest.version < 2) throw fail('请先登记项目，再管理类型和模板');
  const types = await definitions(root, manifest);
  // Version the same manifest that supplies the displayed settings. Re-reading
  // the file here can attach a newer revision to an older form during a change.
  const revision = createHash('sha256').update(JSON.stringify(manifest));
  const warnings = [];
  const entries = [];
  for (const type of types) {
    let content = projectDefinition({ ...manifest, documentTypes: [type] }).documentTypes[0].content;
    let problem = '';
    const format = type.template ? formatOf(type.template) : 'md';
    if (type.template) {
      revision.update(type.template);
      try {
        const file = await resolveContainedPath(root, path.join(root, workspacePaths(manifest).templates, type.template));
        if ((await fs.stat(file)).size > 1024 * 1024) throw fail('模板超过 1 MB');
        content = await fs.readFile(file, 'utf8'); revision.update(content);
      } catch (error) { problem = `${type.label}：${error.code === 'ENOENT' ? '模板文件缺失' : error.message}`; content = ''; revision.update(problem); }
    }
    if (!problem) try { previewProjectTemplate(manifest, { type, content, format }); }
    catch (error) { problem = `${type.label}：${error.message}`; }
    if (problem) warnings.push(problem);
    entries.push({ type, content, format, problem });
  }
  const registered = await readRegistry(root);
  for (const record of registered.documents) {
    if (!types.some((type) => type.id === record.documentType)) warnings.push(`文档类型未定义：${record.documentType} (${record.sourcePath})`);
  }
  return { workspace: projectDefinition(manifest), revision: revision.digest('hex'), entries, warnings };
}

export async function saveProjectTemplate(root, payload = {}) {
  return withRegistryLock(root, async () => {
    const current = await readProjectConfiguration(root);
    if (payload.revision !== current.revision) throw fail('项目配置或模板已改变，请重新打开后再保存', 409);
    const manifest = readWorkspace(root);
    const preview = previewProjectTemplate(manifest, payload);
    const oldType = current.entries.find((entry) => entry.type.id === payload.type.id)?.type;
    if (payload.create === true && oldType) throw fail('类型标识已存在，请使用其他标识。', 409);
    const type = { ...oldType, ...payload.type };
    // Publish the template first under an immutable content address, then
    // atomically switch one manifest. An interruption cannot leave it pointing
    // at a partially written or missing template.
    type.template = `types/${type.id}/${hash(payload.content)}.${payload.format || 'md'}`;
    const types = current.entries.map((entry) => entry.type.id === type.id ? type : entry.type);
    if (!oldType) types.push(type);
    const next = { ...manifest, documentTypes: types };
    validateProjectTypes(next);
    const templateRoot = workspacePaths(manifest).templates;
    const destination = await resolveContainedPath(root, path.join(root, templateRoot, type.template), { allowMissing: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    let created = false;
    try {
      await writeDocumentAtomically(destination, payload.content, { create: true }); created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fs.readFile(destination, 'utf8') !== payload.content) throw fail('模板文件内容冲突，请检查项目模板');
    }
    try { await writeJson(path.join(root, 'workspace.json'), next); }
    catch (error) { if (created) await fs.rm(destination, { force: true }); throw error; }
    // Only prune an unreferenced, unmodified template created by this writer.
    // Imported and hand-authored files remain available in the project.
    if (oldType?.template && oldType.template !== type.template && !types.some((item) => item.template === oldType.template)) {
      const match = oldType.template.match(new RegExp(`^types/${type.id}/([a-f0-9]{64})\\.(md|txt|json|ya?ml)$`));
      if (match) try {
        const previous = await resolveContainedPath(root, path.join(root, templateRoot, oldType.template));
        if (hash(await fs.readFile(previous)) === match[1]) await fs.rm(previous);
      } catch { /* A committed configuration stays successful if cleanup fails. */ }
    }
    return { ...await readProjectConfiguration(root), preview };
  });
}
