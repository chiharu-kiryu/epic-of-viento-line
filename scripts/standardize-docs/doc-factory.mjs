import path from 'node:path';
import { SCHEMA_VERSION } from './config.mjs';
import { inferCategory, inferPurposeGroup } from './utils.mjs';
import { toPosix, trimName } from '../lib/paths.mjs';
import { parseSourceContent } from '../../engine/parse.mjs';
import { buildDocumentLayout } from './layout.mjs';
import { buildStandardOutputPath } from '../lib/standard-cache.mjs';

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
  return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : fallback;
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeParserStats(parserStats, fallback = {}) {
  const rawStats = normalizeObject(parserStats, fallback);
  return {
    blockCount: toSafeInt(rawStats.blockCount, toSafeInt(fallback.blockCount, 0)),
    headingCount: toSafeInt(rawStats.headingCount, 0),
    paragraphCount: toSafeInt(rawStats.paragraphCount, 0),
    listCount: toSafeInt(rawStats.listCount, 0),
    tableCount: toSafeInt(rawStats.tableCount, 0),
    kvCount: toSafeInt(rawStats.kvCount, 0),
  };
}

function buildStandardObject(relativePath, raw, parsedContent, stats, descriptor = {}) {
  const categoryInfo = inferCategory(relativePath);
  const parsedByType = normalizeObject(parsedContent || {});
  const parsedTitle = toSafeString(parsedByType.title, '');
  const fields = normalizeObject(parsedByType.fields, {});
  const sections = normalizeArray(parsedByType.sections);
  const blocks = normalizeArray(parsedByType.blocks);
  const outline = normalizeArray(parsedByType.outline);
  const lineCount = toSafeInt(parsedByType.lineCount, 0);
  const parserContentType = toSafeString(parsedByType.type, parsedByType.parser?.contentType || 'text');
  const parserFormat = toSafeString(parsedByType.format, parsedByType.parser?.format || parserContentType);
  const parserProfile = toSafeString(parsedByType.profile, parsedByType.parser?.profile || 'plain');
  const parserStats = normalizeParserStats(parsedByType.blockStats || parsedByType.parserStats || parsedByType.parser, {
    blockCount: blocks.length,
  });
  const title = parsedTitle || trimName(path.basename(relativePath));

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
      purpose: inferPurposeGroup(categoryInfo.category, categoryInfo.group, fields, {
        attribute: categoryInfo.meta?.attribute,
      }),
      ...categoryInfo.meta,
      ...(descriptor.documentType ? { category: descriptor.documentType } : {}),
      ...(descriptor.typeLabel ? { group: descriptor.typeLabel, purpose: descriptor.typeLabel } : {}),
    },
    parser: {
      contentType: parserContentType,
      format: parserFormat,
      profile: parserProfile,
      ...(parsedByType.parseError ? { error: parsedByType.parseError } : {}),
      lineCount,
      fieldCount: toSafeInt(parsedByType.fieldCount, Object.keys(fields).length),
      blockCount: toSafeInt(parsedByType.blockCount, parserStats.blockCount),
    },
    fields,
    sections,
    blocks,
    outline,
    parserStats,
    layout: buildDocumentLayout({ ...parsedByType, title }),
    rawPath: toPosix(relativePath),
    raw,
  };
}

export {
  parseSourceContent,
  buildStandardOutputPath,
  buildStandardObject,
};
