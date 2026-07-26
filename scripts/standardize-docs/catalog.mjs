import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BACKSTORY_KEY_OVERRIDES,
  MERGE_BACKSTORY,
  PROJECT_ROOT,
  STANDARD_ROOT,
} from './config.mjs';
import {
  buildCategoryKey,
} from './utils.mjs';
import { attachBackstory } from './backstory.mjs';
import {
  buildStandardObject,
  buildStandardOutputPath,
  parseSourceContent,
} from './doc-factory.mjs';
import { collectSourcePaths } from './sources.mjs';
import { normalizeFilterPath } from '../lib/path-filter.mjs';

async function buildStandardCatalog(sourceFilters = [], options = {}) {
  const outputRoot = options.outputRoot || STANDARD_ROOT;
  const normalizedFilters = sourceFilters.map(normalizeFilterPath);
  const files = await collectSourcePaths(PROJECT_ROOT, { sourceFilters: normalizedFilters });
  const sourceDocs = [];
  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const stats = await fs.stat(absolutePath);
    const raw = await fs.readFile(absolutePath, 'utf8');
    const parsed = parseSourceContent(raw, relPath);
    const normalized = buildStandardObject(relPath, raw, parsed, stats);
    sourceDocs.push({
      relPath,
      raw,
      normalized,
      category: normalized.meta.category,
      key: buildCategoryKey(normalized.meta, relPath),
    });
  }

  const backstoryByKey = new Map();
  for (const item of sourceDocs) {
    if (!item.key) {
      continue;
    }
    if (item.category === 'backstory') {
      backstoryByKey.set(item.key, item);
    }
  }

  const usedBackstoryKeys = new Set();
  const output = [];

  for (const item of sourceDocs) {
    if (!MERGE_BACKSTORY && item.category === 'backstory') {
      // keep original backstory documents
    } else if (MERGE_BACKSTORY && item.category === 'backstory') {
      // merged into matching hero documents later
      continue;
    }

    let toWrite = item.normalized;
    if (item.category === 'hero' && MERGE_BACKSTORY) {
      const overrideBackstoryKey = item.key && BACKSTORY_KEY_OVERRIDES[item.key];
      const heroBackstoryKey = item.key?.includes('||') ? item.key.split('||')[1] : null;
      const backstory = backstoryByKey.get(item.key)
        || (heroBackstoryKey ? backstoryByKey.get(heroBackstoryKey) : null)
        || (overrideBackstoryKey ? backstoryByKey.get(overrideBackstoryKey) : null);
      if (backstory) {
        toWrite = attachBackstory(item.normalized, backstory.normalized);
        usedBackstoryKeys.add(backstory.key);
      }
    }

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

  if (MERGE_BACKSTORY) {
    for (const item of sourceDocs) {
      if (item.category !== 'backstory' || usedBackstoryKeys.has(item.key)) {
        continue;
      }
      const standardRelPath = buildStandardOutputPath(item.relPath);
      const standardAbsolute = path.join(outputRoot, standardRelPath);
      await fs.mkdir(path.dirname(standardAbsolute), { recursive: true });
      await fs.writeFile(standardAbsolute, `${JSON.stringify(item.normalized)}\n`, 'utf8');
      output.push({
        source: item.relPath,
        standard: standardRelPath,
        category: item.normalized.meta.category,
        title: item.normalized.meta.title,
        size: item.raw.length,
      });
    }
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
