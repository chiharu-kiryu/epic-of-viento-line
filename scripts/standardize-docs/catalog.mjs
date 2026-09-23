import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, STANDARD_ROOT } from './config.mjs';
import {
  buildStandardObject,
  buildStandardOutputPath,
  parseSourceContent,
} from './doc-factory.mjs';
import { collectSourcePaths } from './sources.mjs';
import { normalizeFilterPath, inSourceScopes } from '../lib/path-filter.mjs';
import { resolveDocumentDefinition } from '../lib/project-layout.mjs';
import { IS_MANAGED_WORKSPACE, DOCUMENTS_PATH, WORKSPACE_MANIFEST } from '../lib/paths.mjs';
import { readRegistry } from '../lib/workspace.mjs';
import { DEFAULT_SKIP_DIRS } from '../lib/scan-files.mjs';
import { collectStandardPaths } from '../lib/standard-cache.mjs';
import { resolveContainedPath } from '../lib/contained-path.mjs';

async function buildStandardCatalog(sourceFilters = [], options = {}) {
  const outputRoot = options.outputRoot || STANDARD_ROOT;
  const normalizedFilters = sourceFilters.map(normalizeFilterPath);
  const sourceRoot = IS_MANAGED_WORKSPACE ? path.join(PROJECT_ROOT, DOCUMENTS_PATH) : PROJECT_ROOT;
  const files = await collectSourcePaths(sourceRoot, {
    ...(IS_MANAGED_WORKSPACE ? { relativeBase: DOCUMENTS_PATH, skipDirs: DEFAULT_SKIP_DIRS } : {}),
    sourceFilters: normalizedFilters,
    excludedRoots: [outputRoot],
  });
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
    const descriptor = resolveDocumentDefinition(WORKSPACE_MANIFEST, relPath, bySource.get(relPath));
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
    const standardAbsolute = await resolveContainedPath(outputRoot, path.join(outputRoot, standardRelPath), { allowMissing: true });
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
  const existing = await collectStandardPaths(outputRoot);
  const validSet = new Set(sourcePaths.map((item) =>
    buildStandardOutputPath(item.source)
  ));
  for (const relStandard of existing) {
    if (!validSet.has(relStandard)) {
      if (normalizedScope.length) {
        // Recorded source paths let mirrored and hashed caches coexist without
        // touching another format or a document outside the requested scope.
        // An exact source filter can also clean its damaged/deleted cache.
        let source = normalizedScope.find((filter) => buildStandardOutputPath(filter) === relStandard)
          || relStandard.replace(/\.json$/i, '');
        try {
          const cached = JSON.parse(await fs.readFile(path.join(outputRoot, relStandard), 'utf8'));
          const recorded = typeof cached.source === 'string' ? cached.source : cached.source?.path;
          if (typeof recorded === 'string' && recorded) source = recorded.replace(/^docs-standard\//, '');
        } catch { /* A damaged cache can still be matched by its filename. */ }
        if (!inSourceScopes(source, normalizedScope)) continue;
      }
      await fs.rm(path.join(outputRoot, relStandard));
    }
  }
}

export {
  buildStandardCatalog,
  cleanupStandardStaleFiles,
};
