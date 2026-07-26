import path from 'node:path';
import { SCHEMA_VERSION } from './config.mjs';
import { inferCategory, inferPurposeGroup } from './utils.mjs';
import { toPosix, trimName } from '../lib/paths.mjs';
import { parseJsonContent, parseTextContent } from './parser.mjs';

function parseSourceContent(rawText, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return ext === '.json' ? parseJsonContent(rawText, relPath) : parseTextContent(rawText, relPath);
}

function buildStandardOutputPath(sourceRelativePath) {
  return toPosix(path.join(
    path.dirname(sourceRelativePath),
    `${trimName(path.basename(sourceRelativePath))}.json`
  ));
}

function buildStandardObject(relativePath, raw, parsedContent, stats) {
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
    raw,
  };
}

export {
  parseSourceContent,
  buildStandardOutputPath,
  buildStandardObject,
};
