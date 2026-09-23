import { DOCUMENTS_PATH, WORKSPACE_MANIFEST } from './paths.mjs';
import { projectDefinition } from './project-layout.mjs';
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
import { collectStandardPaths } from './standard-cache.mjs';
import { attachDocumentHierarchy } from './document-model.mjs';
import { collectDocumentMedia } from './media-format.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';

function toSafeString(value, fallback = '') {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return fallback;
  }
  return String(value);
}

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (Number.isFinite(num) && Math.trunc(num) === num) {
    return num >= 0 ? num : fallback;
  }
  return fallback;
}

function toSafeObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return fallback;
}

function toSafeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function toSafeSectionKey(value, fallback = '段落') {
  const text = toSafeString(value, fallback).trim();
  return text || fallback;
}

function toSafeSectionValue(value) {
  if (value == null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(toSafeSectionValue).join('\n');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function ensureSections(rawSections, fallbackHeader = '') {
  const sections = [];
  const appendSection = (section) => {
    if (!section || typeof section !== 'object') {
      return;
    }
    const key = toSafeSectionKey(section.key, '段落');
    const value = toSafeSectionValue(section.value);
    if (!Object.prototype.hasOwnProperty.call(section, 'key') && !Object.prototype.hasOwnProperty.call(section, 'value')) {
      return;
    }
    sections.push({ key, value });
  };

  if (Array.isArray(rawSections)) {
    for (const item of rawSections) {
      if (typeof item === 'string') {
        appendSection({ key: '段落', value: item });
        continue;
      }
      if (item && typeof item === 'object') {
        appendSection(item);
        continue;
      }
      appendSection({ key: '段落', value: String(item ?? '') });
    }
  } else if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
    for (const [key, value] of Object.entries(rawSections)) {
      sections.push({
        key: toSafeSectionKey(key, '段落'),
        value: toSafeSectionValue(value),
      });
    }
  } else if (typeof rawSections === 'string' && rawSections.trim()) {
    sections.push({ key: fallbackHeader || '段落', value: rawSections });
  }

  if (!sections.some((item) => item.key === '_header')) {
    sections.unshift({
      key: '_header',
      value: fallbackHeader || '未命名文档',
    });
  }

  return sections;
}

function ensureBlocks(rawBlocks) {
  const blocks = [];
  const addSectionBlock = (key, value) => {
    blocks.push({ type: 'kv', key, value: toSafeSectionValue(value) });
  };

  if (Array.isArray(rawBlocks)) {
    for (const block of rawBlocks) {
      if (!block || typeof block !== 'object') {
        if (String(block || '').trim()) {
          blocks.push({
            type: 'paragraph',
            text: String(block),
          });
        }
        continue;
      }
      if (typeof block.type === 'string') {
        blocks.push({
          ...block,
          type: toSafeString(block.type, 'text'),
          key: block.key ? String(block.key) : undefined,
          value: block.value === undefined ? undefined : block.value,
          text: block.text === undefined ? undefined : toSafeSectionValue(block.text),
          items: Array.isArray(block.items) ? block.items : undefined,
          rows: Array.isArray(block.rows) ? block.rows : undefined,
        });
        continue;
      }
      addSectionBlock(block.key || '段落', block.value ?? block.text ?? block);
    }
  } else if (rawBlocks && typeof rawBlocks === 'object') {
    for (const [key, value] of Object.entries(rawBlocks)) {
      addSectionBlock(key, value);
    }
  } else if (typeof rawBlocks === 'string' && rawBlocks.trim()) {
    blocks.push({ type: 'paragraph', text: rawBlocks });
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', text: '该文档当前为空，尚未补充可结构化内容。' });
  }

  return blocks;
}

function ensureOutline(rawOutline) {
  if (Array.isArray(rawOutline)) {
    return rawOutline.filter((item) => item && typeof item === 'object');
  }
  return [];
}

function normalizeParserStats(rawParserStats, fallback = {}) {
  const fallbackCount = toSafeInt(fallback.blockCount, 0);
  const parsed = toSafeObject(rawParserStats, {});
  return {
    blockCount: toSafeInt(parsed.blockCount, fallbackCount),
    headingCount: toSafeInt(parsed.headingCount, 0),
    paragraphCount: toSafeInt(parsed.paragraphCount, 0),
    listCount: toSafeInt(parsed.listCount, 0),
    tableCount: toSafeInt(parsed.tableCount, 0),
    kvCount: toSafeInt(parsed.kvCount, 0),
  };
}

function normalizeParser(rawParser, parsedParserStats, fallbackSectionCount = 0, fallbackFieldCount = 0) {
  const parser = toSafeObject(rawParser, {});
  const parserStats = normalizeParserStats(parsedParserStats, { blockCount: fallbackSectionCount });
  return {
    contentType: toSafeString(parser.contentType || parser.type || 'text', 'text'),
    format: toSafeString(parser.format || parser.typeHint || 'text', 'text'),
    profile: toSafeString(parser.profile, 'plain'),
    ...(parser.error ? { error: toSafeString(parser.error) } : {}),
    lineCount: toSafeInt(parser.lineCount, 0),
    fieldCount: toSafeInt(parser.fieldCount, fallbackFieldCount),
    blockCount: toSafeInt(parser.blockCount, parserStats.blockCount),
  };
}

function normalizeSource(rawSource, relativePath) {
  const source = toSafeObject(rawSource, {});
  const fallback = normalizeStandardSourcePath(relativePath);
  const sourcePath = toSafeString(source.path, fallback);
  const normalizedSourcePath = normalizeStandardSourcePath(sourcePath);
  return {
    path: normalizedSourcePath || fallback || toSafeString(relativePath),
    extension: toSafeString(source.extension, path.extname(source.path || relativePath)),
    size: toSafeInt(source.size, 0),
    modifiedAt: toSafeString(source.modifiedAt, ''),
  };
}

function normalizeStandardSourcePath(sourcePath) {
  const cleaned = toPosix((sourcePath || '').toString()).replace(/\\/g, '/');
  if (!cleaned) {
    return '';
  }
  const normalized = cleaned.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('docs-standard/documents/')) return normalized;
  if (normalized.startsWith('documents/')) return `docs-standard/${normalized}`;
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

function ensureStandardDocDefaults(rawDoc = {}, relativePath = '', rawText = '') {
  const parsed = toSafeObject(rawDoc, {});
  const source = normalizeSource(parsed.source, relativePath);
  const metaFromDoc = toSafeObject(parsed.meta, {});
  const rawSectionPath = normalizeStandardSourcePath(source.path || parsed.rawPath || relativePath);
  const cls = inferCategory(rawSectionPath || relativePath);
  const fallbackTitle = toSafeString(metaFromDoc.title, trimName(path.basename(rawSectionPath || relativePath || '未命名文档')));
  const fields = toSafeObject(parsed.fields, {});
  const sections = ensureSections(parsed.sections, fallbackTitle);
  const blocks = ensureBlocks(parsed.blocks);
  const outline = ensureOutline(parsed.outline);
  const parserStats = normalizeParserStats(
    parsed.parserStats || parsed.blockStats || parsed.parser,
    { blockCount: blocks.length }
  );
  const parser = normalizeParser(
    parsed.parser,
    parserStats,
    blocks.length,
    Object.keys(fields).length,
  );

  return {
    schemaVersion: toSafeString(parsed.schemaVersion, 'standard-doc-v2'),
    source,
    meta: {
      title: fallbackTitle,
      category: toSafeString(metaFromDoc.category, cls.category),
      group: toSafeString(metaFromDoc.group, cls.group),
      purpose: toSafeString(
        metaFromDoc.purpose,
        inferPurposeGroup(
          cls.category,
          metaFromDoc.group || cls.group || '其他',
          fields,
          metaFromDoc,
        ) || cls.group
      ),
      ...metaFromDoc,
    },
    parser,
    fields,
    sections,
    outline,
    blocks,
    parserStats,
    rawPath: rawSectionPath || toSafeString(parsed.rawPath, ''),
    raw: toSafeString(parsed.raw, toSafeString(rawText, '')),
    backstory: parsed.backstory || null,
    data: parsed.data ?? null,
    layout: parsed.layout || buildDocumentLayout({ title: fallbackTitle, blocks }),
  };
}

function classify(relativePath) {
  return inferCategory(normalizeStandardSourcePath(relativePath));
}

function collectRegisteredReferences(standardDoc, sourcePath, assetCatalog) {
  const registration = assetCatalog.bySource.get(sourcePath.replace(/^docs-standard\//, ''));
  const assetRefs = new Set((registration?.assetBindings || []).map((link) => link.assetId));
  const media = collectDocumentMedia(standardDoc.blocks);
  const paths = new Set(collectAssetImageRefs(media.text, sourcePath, assetCatalog));
  for (const url of media.urls) {
    if (url.startsWith('/asset-files/')) assetRefs.add(url.slice('/asset-files/'.length));
    else paths.add(url.slice(1).split('/').map(decodeURIComponent).join('/'));
  }
  const unresolvedAssetPaths = [];
  for (const file of paths) {
    const asset = assetCatalog.byPath.get(file);
    if (asset) assetRefs.add(asset.id);
    else unresolvedAssetPaths.push(file);
  }
  const images = new Set([...assetRefs].map((id) => assetCatalog.byId.get(id))
    .filter((asset) => asset?.kind === 'image').map((asset) => `assets/${asset.location.path}`));
  for (const file of unresolvedAssetPaths) if (/\.(png|jpe?g|webp|gif|svg)$/i.test(file)) images.add(file);
  return { assetRefs: [...assetRefs], unresolvedAssetPaths, images: [...images] };
}

async function collectImagesForSourceDoc(standardDoc, sourcePath, sourceCategory, sourceMeta, assetCatalog) {
  if (assetCatalog.registered) return collectRegisteredReferences(standardDoc, sourcePath, assetCatalog).images;
  const rawText = standardDoc.raw || '';
  const normalizedName = path.basename(sourcePath);
  const baseName = trimName(normalizedName);
  const explicitPaths = collectAssetImageRefs(rawText, sourcePath, assetCatalog);
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
  return fallback.replace(/\.json$/i, '');
}

function normalizeBackstoryPayload(backstory) {
  if (!backstory || typeof backstory !== 'object') {
    return null;
  }

  const source = typeof backstory.source === 'string' ? { path: backstory.source } : toSafeObject(backstory.source);
  const backstorySourcePath = normalizeStandardSourcePath(source.path || backstory.rawPath || '');
  const normalizedRawPath = backstorySourcePath || backstory.rawPath || '';

  return {
    ...backstory,
    source: {
      ...source,
      path: backstorySourcePath || '',
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
  const files = await collectStandardPaths(STANDARD_ROOT, {
    relativeBase: 'docs-standard',
  });
  const docs = [];

  for (const relPath of files) {
    const absolutePath = path.join(STANDARD_ROOT, relPath.slice('docs-standard/'.length));
    const rawStandard = await fsPromises.readFile(absolutePath, 'utf8');
    let loaded = null;
    try {
      loaded = JSON.parse(rawStandard);
    } catch (error) {
      loaded = {
        source: {
          path: relPath,
          extension: path.extname(relPath),
          size: rawStandard.length,
          modifiedAt: '',
          rawParseError: String(error?.message || 'json parse failed'),
        },
        meta: {
          title: trimName(path.basename(relPath)),
          category: 'other',
          group: '其他',
          purpose: '其他',
        },
        parser: {
          contentType: 'text',
          format: 'text',
          profile: 'invalid-json',
          lineCount: 0,
          fieldCount: 0,
          blockCount: 0,
        },
        fields: {},
        sections: [{ key: '_header', value: trimName(path.basename(relPath)) }],
        outline: [],
        blocks: [],
        parserStats: { blockCount: 0, headingCount: 0, paragraphCount: 0, listCount: 0, tableCount: 0, kvCount: 0 },
        rawPath: relPath,
        raw: rawStandard,
      };
    }

    const normalizedDoc = ensureStandardDocDefaults(loaded, relPath, rawStandard);
  const sourcePath = sourcePathFromStandardDoc(normalizedDoc, relPath);
  const sourceDocumentPath = toSafeString(normalizedDoc.source?.path, sourcePath);
  const normalizedName = trimName(path.basename(sourcePath || relPath));
    const registration = assetCatalog.bySource?.get(sourceDocumentPath.replace(/^docs-standard\//, ''));
    const sourceCategory = registration?.documentType || toSafeString(normalizedDoc.meta?.category, 'other');
    const cls = classify(sourcePath);
    const effectiveCategory = sourceCategory || cls.category || 'other';
    const sourceMeta = toSafeObject(normalizedDoc.meta, cls.meta || {});
    const projectType = WORKSPACE_MANIFEST?.version === 3 || WORKSPACE_MANIFEST?.documentTypes
      ? projectDefinition(WORKSPACE_MANIFEST).documentTypes.find((type) => type.id === effectiveCategory) : null;
    const group = projectType?.label || toSafeString(sourceMeta.group, cls.group);
    const fields = toSafeObject(normalizedDoc.fields, {});
    const title = toSafeString(sourceMeta.title, normalizedName);
    const references = assetCatalog.registered ? collectRegisteredReferences(normalizedDoc, sourcePath, assetCatalog) : null;
    const imageList = references?.images || await collectImagesForSourceDoc(
      normalizedDoc,
      sourcePath,
      effectiveCategory,
      sourceMeta,
      assetCatalog
    );
    const isCharacter = !projectType && ['hero', 'character'].includes(effectiveCategory);
    const heroSkills = isCharacter
      ? collectHeroSkillsFromSections(normalizedDoc.sections || [], imageList)
      : [];
    const orderedHeroImages = isCharacter
      ? sortHeroImagesForDisplay(imageList, heroSkills)
      : imageList;

    const displayPath = registration?.legacyId || (WORKSPACE_MANIFEST?.version === 3 ? sourcePath : buildDisplayPath(cls.category, sourcePath, sourceMeta, normalizedName));
    docs.push({
      ...(registration ? { id: registration.id } : {}),
      ...(references ? { assetRefs: references.assetRefs, unresolvedAssetPaths: references.unresolvedAssetPaths } : {}),
      path: displayPath,
      title,
      name: normalizedName,
      category: sourceCategory || cls.category || 'other',
      displayPath,
      relations: registration?.relations || [],
      layout: normalizedDoc.layout,
      group: projectType?.label || inferPurposeGroup(
        sourceCategory || cls.category || 'other',
        group || cls.group || '其他',
        fields,
        sourceMeta || cls.meta || {},
      ) || (group || cls.group),
      source: {
        ...normalizedDoc.source,
        path: sourceDocumentPath,
      },
      meta: {
        source: sourcePath,
        ...sourceMeta,
        category: sourceCategory || cls.category || 'other',
        group: group || cls.group,
        purpose: projectType?.label || inferPurposeGroup(
          sourceCategory || cls.category || 'other',
          group || cls.group || '其他',
          fields,
          sourceMeta || {},
        ),
        schemaVersion: normalizedDoc.schemaVersion || 'standard-doc-v2',
      },
      fields,
      backstory: normalizeBackstoryPayload(normalizedDoc.backstory),
      sections: normalizedDoc.sections || [],
      outline: normalizedDoc.outline || [],
      blocks: normalizedDoc.blocks || [],
      type: sourceTypeFromPath(sourcePath),
      lastModified: sourceMeta.modifiedAt || normalizedDoc.source?.modifiedAt || new Date().toISOString(),
      size: normalizedDoc.source?.size || 0,
      content: normalizedDoc.raw,
      heroImages: orderedHeroImages,
      heroSkills,
      standardPath: relPath,
      parser: normalizedDoc.parser || {},
      parserStats: normalizedDoc.parserStats || {},
    });
  }

  return attachDocumentHierarchy(docs);
}

async function buildStandardIndex() {
  const assetCatalog = await buildAssetImageCatalog();
  const shouldUseStandard = fs.existsSync(STANDARD_ROOT);
  if (shouldUseStandard) {
    const docs = await buildIndexFromStandard(assetCatalog);
    const displayGroups = new Map();
    for (const doc of docs) {
      const group = displayGroups.get(doc.path) || [];
      group.push(doc); displayGroups.set(doc.path, group);
    }
    for (const group of displayGroups.values()) {
      // Old friendly paths can collapse different source files to one title.
      // Keep those paths where unambiguous; use stable identities otherwise.
      // Duplicate copies of the same source remain errors below.
      if (group.length > 1 && new Set(group.map(doc => doc.source.path)).size === group.length) {
        for (const doc of group) doc.path = doc.displayPath = doc.id ? `document/${doc.id}` : doc.source.path;
      }
    }
    const paths = new Map();
    for (const doc of docs) {
      if (paths.has(doc.path)) {
        throw new Error(`文档标识重复 ${doc.path}: ${paths.get(doc.path)} / ${doc.standardPath}`);
      }
      paths.set(doc.path, doc.standardPath);
    }
    docs.sort((a, b) => {
      if (a.group !== b.group) {
        return a.group.localeCompare(b.group, 'zh-CN');
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    attachDocumentHierarchy(docs);
    return {
      workspace: projectDefinition(WORKSPACE_MANIFEST),
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
