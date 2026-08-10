import path from 'node:path';
import { SCHEMA_VERSION } from './config.mjs';
import { inferCategory, inferPurposeGroup } from './utils.mjs';
import { toPosix, trimName } from '../lib/paths.mjs';
import { parseJsonContent, parseTextContent, parseYamlContent } from './parser.mjs';

function parseSourceContent(rawText, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.json') {
    return parseJsonContent(rawText, relPath);
  }
  if (ext === '.yml' || ext === '.yaml') {
    return parseYamlContent(rawText, relPath);
  }
  return parseTextContent(rawText, relPath);
}

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

function buildStandardOutputPath(sourceRelativePath) {
  return toPosix(path.join(
    path.dirname(sourceRelativePath),
    `${trimName(path.basename(sourceRelativePath))}.json`
  ));
}

function buildStandardObject(relativePath, raw, parsedContent, stats) {
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
    },
    parser: {
      contentType: parserContentType,
      format: parserFormat,
      profile: parserProfile,
      lineCount,
      fieldCount: toSafeInt(parsedByType.fieldCount, Object.keys(fields).length),
      blockCount: toSafeInt(parsedByType.blockCount, parserStats.blockCount),
    },
    fields,
    sections,
    blocks,
    outline,
    parserStats,
    rawPath: toPosix(relativePath),
    raw,
  };
}

export {
  parseSourceContent,
  buildStandardOutputPath,
  buildStandardObject,
};
