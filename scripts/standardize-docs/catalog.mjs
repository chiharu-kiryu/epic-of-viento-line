import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, STANDARD_ROOT } from './config.mjs';
import {
  buildStandardObject,
  buildStandardOutputPath,
  parseSourceContent,
} from './doc-factory.mjs';
import { collectSourcePaths } from './sources.mjs';
import { normalizeFilterPath } from '../lib/path-filter.mjs';
import { projectDocumentDefaults } from '../lib/project-layout.mjs';
import { IS_MANAGED_WORKSPACE, DOCUMENTS_PATH, WORKSPACE_MANIFEST } from '../lib/paths.mjs';
import { readRegistry } from '../lib/workspace.mjs';

async function buildStandardCatalog(sourceFilters = [], options = {}) {
  const outputRoot = options.outputRoot || STANDARD_ROOT;
  const normalizedFilters = sourceFilters.map(normalizeFilterPath);
  let files = await collectSourcePaths(PROJECT_ROOT, {
    sourceFilters: normalizedFilters,
    excludedRoots: [outputRoot],
  });
  if (IS_MANAGED_WORKSPACE) {
    files = files.filter((file) => file.startsWith(`${DOCUMENTS_PATH}/`));
  }
  const sourceDocs = [];
  const registry = await readRegistry(PROJECT_ROOT);
  const bySource = new Map(registry.documents.map((record) => [record.sourcePath, record]));
  const outputSources = new Map();
  for (const relPath of files) {
    const outputPath = buildStandardOutputPath(relPath);
    if (outputSources.has(outputPath)) {
      throw new Error(`标准化输出路径冲突 ${outputPath}: ${outputSources.get(outputPath)} / ${relPath}`);
    }
    outputSources.set(outputPath, relPath);
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const stats = await fs.stat(absolutePath);
    const raw = await fs.readFile(absolutePath, 'utf8');
    const descriptor = bySource.get(relPath) || (WORKSPACE_MANIFEST?.version === 3 ? projectDocumentDefaults(WORKSPACE_MANIFEST, relPath) : {});
    const parsed = parseSourceContent(raw, relPath, descriptor);
    const normalized = buildStandardObject(relPath, raw, parsed, stats, descriptor);
    sourceDocs.push({
      relPath,
      raw,
      normalized,
    });
  }

  const output = [];
  for (const item of sourceDocs) {
    const toWrite = item.normalized;
    const standardRelPath = buildStandardOutputPath(item.relPath);
    const standardAbsolute = path.join(outputRoot, standardRelPath);
    await fs.mkdir(path.dirname(standardAbsolute), { recursive: true });
    await fs.writeFile(standardAbsolute, `${JSON.stringify(toWrite)}\n`, 'utf8');
    output.push({
      source: item.relPath,
      standard: standardRelPath,
      category: toWrite.meta.category,
      title: toWrite.meta.title,
      size: item.raw.length,
    });
  }

  return output;
}

async function cleanupStandardStaleFiles(sourcePaths, options = {}) {
  const outputRoot = options.outputRoot || STANDARD_ROOT;
  const { scope = [] } = options;
  const normalizedScope = scope.map(normalizeFilterPath);
  const existing = await collectSourcePaths(outputRoot, { sourceFilters: normalizedScope });
  const validSet = new Set(sourcePaths.map((item) =>
    buildStandardOutputPath(item.source)
  ));
  for (const relStandard of existing) {
    if (!validSet.has(relStandard)) {
      await fs.rm(path.join(outputRoot, relStandard));
    }
  }
}

export {
  buildStandardCatalog,
  cleanupStandardStaleFiles,
};
