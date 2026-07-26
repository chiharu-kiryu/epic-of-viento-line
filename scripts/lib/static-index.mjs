import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { resolveHeroMeta, collectHeroSkillsFromSections } from '../build-static-hero-skills.mjs';
import { inferCategory, inferPurposeGroup, buildDisplayPath } from './category.mjs';
import {
  collectAssetImageRefs,
  collectFromCatalog,
  collectHeroImages,
  buildAssetImageCatalog,
  sortHeroImagesForDisplay,
} from './image-index.mjs';
import { PROJECT_ROOT, STANDARD_ROOT, toPosix, trimName } from './paths.mjs';
import { collectFilesRecursive } from './scan-files.mjs';

function normalizeStandardSourcePath(sourcePath) {
  const cleaned = toPosix((sourcePath || '').toString()).replace(/\\/g, '/');
  if (!cleaned) {
    return '';
  }
  const normalized = cleaned.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('docs-standard/design-data/')) {
    return normalized;
  }
  if (normalized.startsWith('design-data/')) {
    return `docs-standard/${normalized}`;
  }
  if (normalized.includes('/docs-standard/design-data/')) {
    const idx = normalized.indexOf('docs-standard/design-data/');
    return normalized.slice(idx);
  }
  if (normalized.includes('/design-data/')) {
    const idx = normalized.indexOf('design-data/');
    return `docs-standard/${normalized.slice(idx)}`;
  }
  const absoluteRoot = toPosix(PROJECT_ROOT);
  const withoutRoot = normalized.startsWith(`${absoluteRoot}/`) ? normalized.slice(absoluteRoot.length + 1) : normalized;
  if (withoutRoot.startsWith('docs-standard/design-data/')) {
    return withoutRoot;
  }
  if (withoutRoot.startsWith('design-data/')) {
    return `docs-standard/${withoutRoot}`;
  }
  return normalized;
}

function classify(relativePath) {
  return inferCategory(normalizeStandardSourcePath(relativePath));
}

async function collectImagesForSourceDoc(standardDoc, sourcePath, sourceCategory, sourceMeta, assetCatalog) {
  const rawText = standardDoc.raw || '';
  const normalizedName = path.basename(sourcePath);
  const baseName = trimName(normalizedName);
  const explicitPaths = collectAssetImageRefs(rawText, sourcePath);
  const matched = new Set(explicitPaths);

  const cls = sourceCategory || 'other';
  const { attribute, hero } = resolveHeroMeta(cls, sourceMeta, sourcePath);

  if (cls === 'hero') {
    if (attribute && hero) {
      const heroImages = await collectHeroImages(attribute, hero);
      heroImages.forEach((item) => matched.add(item));
    }
  }

  const byNameMatches = collectFromCatalog(cls, normalizedName, assetCatalog);
  for (const item of byNameMatches) {
    matched.add(item);
  }

  const baseNameMatches = collectFromCatalog(cls, baseName, assetCatalog);
  for (const item of baseNameMatches) {
    matched.add(item);
  }

  const fallbackByName = assetCatalog.byBaseName.get(trimName(baseName).toLowerCase()) || [];
  fallbackByName.forEach((item) => matched.add(item));

  return [...matched].sort();
}

function sourcePathFromStandardDoc(standardDoc, relativePath) {
  const sourcePath = standardDoc?.source?.path;
  if (typeof sourcePath === 'string' && sourcePath.trim()) {
    return normalizeStandardSourcePath(sourcePath);
  }
  const fallback = normalizeStandardSourcePath(relativePath);
  return fallback.replace(/\.json$/, '');
}

function normalizeBackstoryPayload(backstory) {
  if (!backstory || typeof backstory !== 'object') {
    return null;
  }

  const backstorySourcePath = normalizeStandardSourcePath(backstory.source?.path || backstory.rawPath || '');
  const normalizedRawPath = backstorySourcePath || backstory.rawPath || '';

  return {
    ...backstory,
    source: {
      ...backstory.source,
      path: backstorySourcePath || backstory.source?.path || '',
    },
    rawPath: normalizedRawPath,
    meta: {
      ...backstory.meta,
      source: backstorySourcePath || backstory.meta?.source || '',
    },
  };
}

function sourceTypeFromPath(sourcePath) {
  const extension = path.extname(sourcePath);
  if (!extension) {
    return 'txt';
  }
  return extension.replace('.', '');
}

async function buildIndexFromStandard(assetCatalog) {
  const files = await collectFilesRecursive(STANDARD_ROOT, {
    relativeBase: 'docs-standard',
  });
  const docs = [];

  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const rawStandard = await fsPromises.readFile(absolutePath, 'utf8');
    const standardDoc = JSON.parse(rawStandard);
    const sourcePath = sourcePathFromStandardDoc(standardDoc, relPath);
    const normalizedName = trimName(path.basename(sourcePath));
    const sourceCategory = standardDoc.meta?.category || 'other';
    const cls = classify(sourcePath);
    const effectiveCategory = sourceCategory || cls.category;
    const sourceMeta = standardDoc.meta || cls.meta || {};
    const group = sourceCategory && sourceCategory !== 'other' ? standardDoc.meta?.group || cls.group : cls.group;
    const fields = standardDoc.fields || {};
    const title = standardDoc.meta?.title || normalizedName;
    const imageList = await collectImagesForSourceDoc(
      standardDoc,
      sourcePath,
      effectiveCategory,
      sourceMeta,
      assetCatalog
    );
    const heroSkills = effectiveCategory === 'hero'
      ? collectHeroSkillsFromSections(standardDoc.sections || [], imageList)
      : [];
    const orderedHeroImages = effectiveCategory === 'hero'
      ? sortHeroImagesForDisplay(imageList, heroSkills)
      : imageList;

    docs.push({
      path: buildDisplayPath(effectiveCategory, sourcePath, sourceMeta, normalizedName),
      title,
      name: normalizedName,
      category: sourceCategory || cls.category,
      displayPath: buildDisplayPath(effectiveCategory, sourcePath, sourceMeta, normalizedName),
      group: inferPurposeGroup(
        sourceCategory || cls.category,
        sourcePath,
        group || cls.group,
        fields,
        standardDoc.meta || cls.meta || {},
      ) || (group || cls.group),
      source: {
        ...standardDoc.source,
        path: sourcePath,
      },
      meta: {
        source: sourcePath,
        ...standardDoc.meta,
        category: sourceCategory || cls.category,
        group: group || cls.group,
        purpose: inferPurposeGroup(
          sourceCategory || cls.category,
          sourcePath,
          group || cls.group,
          fields,
          standardDoc.meta || cls.meta || {},
        ),
        schemaVersion: standardDoc.schemaVersion || 'standard-doc-v1',
      },
      fields,
      backstory: normalizeBackstoryPayload(standardDoc.backstory),
      sections: standardDoc.sections || [],
      outline: standardDoc.outline || [],
      blocks: standardDoc.blocks || [],
      type: sourceTypeFromPath(sourcePath),
      lastModified: standardDoc.source?.modifiedAt || new Date().toISOString(),
      size: standardDoc.source?.size || 0,
      content: standardDoc.raw || JSON.stringify(standardDoc.data || standardDoc, null, 2),
      heroImages: orderedHeroImages,
      heroSkills,
      standardPath: relPath,
      parser: standardDoc.parser || {},
      parserStats: standardDoc.parserStats || standardDoc.blockStats || {},
    });
  }

  return docs;
}

async function buildStandardIndex() {
  const assetCatalog = await buildAssetImageCatalog();
  const shouldUseStandard = fs.existsSync(STANDARD_ROOT);
  if (shouldUseStandard) {
    const docs = await buildIndexFromStandard(assetCatalog);
    docs.sort((a, b) => {
      if (a.group !== b.group) {
        return a.group.localeCompare(b.group, 'zh-CN');
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return {
      generatedAt: new Date().toISOString(),
      count: docs.length,
      docs,
    };
  }

  throw new Error(`未检测到标准化目录：${path.relative(PROJECT_ROOT, STANDARD_ROOT)}`);
}

export {
  buildStandardIndex,
  buildIndexFromStandard,
  normalizeStandardSourcePath,
  sourceTypeFromPath,
  normalizeBackstoryPayload,
  sourcePathFromStandardDoc,
  collectImagesForSourceDoc,
  classify,
};
