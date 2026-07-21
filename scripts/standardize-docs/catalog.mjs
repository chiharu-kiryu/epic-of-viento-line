import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  BACKSTORY_KEY_OVERRIDES,
  MERGE_BACKSTORY,
  PROJECT_ROOT,
  STANDARD_ROOT,
  SKIP_DIRS,
  SCHEMA_VERSION,
} from './config.mjs';
import {
  buildCategoryKey,
  inferCategory,
  inferPurposeGroup,
  toPosix,
  trimName,
  isTextLike,
} from './utils.mjs';
import { parseJsonContent, parseTextContent } from './parser.mjs';

function buildBackstoryPayload(standardDoc) {
  return {
    source: standardDoc.source?.path || '',
    category: 'backstory',
    group: standardDoc.meta?.group || '',
    title: standardDoc.meta?.title || '',
    purpose: standardDoc.meta?.purpose || '',
    meta: {
      ...(standardDoc.meta || {}),
      category: 'backstory',
    },
    fields: standardDoc.fields || {},
    sections: standardDoc.sections || [],
    outline: standardDoc.outline || [],
    blocks: standardDoc.blocks || [],
    parser: standardDoc.parser || {},
    parserStats: standardDoc.parserStats || null,
    rawPath: standardDoc.rawPath || '',
    raw: standardDoc.raw || '',
  };
}

function attachBackstory(heroDoc, backstoryDoc) {
  if (!heroDoc || !backstoryDoc || backstoryDoc.meta?.category !== 'backstory') {
    return heroDoc;
  }

  const normalizedHero = { ...heroDoc };
  normalizedHero.meta = {
    ...normalizedHero.meta,
    hasBackstory: true,
    backstorySource: backstoryDoc.source?.path || backstoryDoc.rawPath || '',
    purpose: normalizedHero.meta?.purpose,
  };
  normalizedHero.backstory = buildBackstoryPayload(backstoryDoc);
  return normalizedHero;
}

function buildStandardObject(relativePath, absolutePath, parsedContent, stats) {
  const categoryInfo = inferCategory(relativePath);
  const parsedByType = parsedContent || {};
  const title = parsedByType.title || trimName(path.basename(relativePath));

  return {
    schemaVersion: SCHEMA_VERSION,
    source: {
      path: relativePath,
      extension: path.extname(relativePath),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    },
    meta: {
      title,
      category: categoryInfo.category,
      group: categoryInfo.group,
      purpose: inferPurposeGroup(categoryInfo.category, categoryInfo.group, parsedByType.fields || {}, {
        attribute: categoryInfo.meta?.attribute,
      }),
      ...categoryInfo.meta,
    },
    parser: {
      contentType: parsedByType.type || 'text',
      format: parsedByType.format || 'text',
      profile: parsedByType.profile || 'plain',
      lineCount: parsedByType.lineCount || 0,
      fieldCount: parsedByType.fieldCount || 0,
      blockCount: parsedByType.blockStats?.blockCount || 0,
    },
    fields: parsedByType.fields || {},
    sections: parsedByType.sections || [],
    blocks: parsedByType.blocks || [],
    outline: parsedByType.outline || [],
    parserStats: parsedByType.blockStats || null,
    rawPath: toPosix(relativePath),
    raw: fsSync.readFileSync(absolutePath, 'utf8'),
  };
}

async function walkFiles(rootDir, relativeBase = '') {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = path.join(rootDir, entry.name);
    const relative = toPosix(path.join(relativeBase, entry.name));
    if (entry.isDirectory()) {
      const child = await walkFiles(absolute, relative);
      files.push(...child);
      continue;
    }
    if (!entry.isFile() || !isTextLike(entry.name)) {
      continue;
    }
    files.push(relative);
  }
  return files;
}

async function buildStandardCatalog() {
  const files = await walkFiles(PROJECT_ROOT);
  const sourceDocs = [];
  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const ext = path.extname(relPath).toLowerCase();
    const stats = await fs.stat(absolutePath);
    const raw = await fs.readFile(absolutePath, 'utf8');
    const parsed = ext === '.json' ? parseJsonContent(raw, relPath) : parseTextContent(raw, relPath);
    const normalized = buildStandardObject(relPath, absolutePath, parsed, stats);
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

    const standardRelPath = toPosix(
      path.join(path.dirname(item.relPath), `${trimName(path.basename(item.relPath))}.json`)
    );
    const standardAbsolute = path.join(STANDARD_ROOT, standardRelPath);
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
      const standardRelPath = toPosix(
        path.join(path.dirname(item.relPath), `${trimName(path.basename(item.relPath))}.json`)
      );
      const standardAbsolute = path.join(STANDARD_ROOT, standardRelPath);
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

async function cleanupStandardStaleFiles(sourcePaths) {
  if (sourcePaths.length === 0) {
    return;
  }
  const existing = await walkFiles(STANDARD_ROOT);
  const validSet = new Set(sourcePaths.map((item) =>
    toPosix(path.join(path.dirname(item.source), `${trimName(path.basename(item.source))}.json`))
  ));
  for (const relStandard of existing) {
    if (!validSet.has(relStandard)) {
      await fs.rm(path.join(STANDARD_ROOT, relStandard));
    }
  }
}

export {
  buildStandardCatalog,
  cleanupStandardStaleFiles,
};
