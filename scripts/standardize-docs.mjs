import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const STANDARD_ROOT = path.join(PROJECT_ROOT, 'docs-standard');
const TARGET_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  '.tmp',
  'web/data',
  'web/.parcel-cache',
  '.cache',
]);
const SCHEMA_VERSION = 'standard-doc-v1';

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function isTextLike(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '') {
    return true;
  }
  return TARGET_EXTENSIONS.has(extension);
}

function trimName(name) {
  return name.replace(/\.(md|txt|json|ya?ml)$/i, '');
}

function inferCategory(relPath) {
  const parts = relPath.split('/');
  if (parts[0] === 'design-data') {
    if (parts[1] === 'design-heros' && parts.length >= 4) {
      return {
        category: 'hero',
        group: `英雄 / ${parts[2]}`,
        meta: {
          attribute: parts[2],
          hero: parts[3],
        },
      };
    }
    if (parts[1] === 'design-item' && parts.length >= 4) {
      return { category: 'item', group: `物品 / ${parts[2]}/${parts[3]}` };
    }
    if (parts[1] === 'design-skills' && parts.length >= 4) {
      return { category: 'skill', group: `技能 / ${parts[2]}/${parts[3]}` };
    }
    if (parts[1] === 'design-units' && parts.length >= 3) {
      return {
        category: 'unit',
        group: `单位 / ${parts[2]}/${parts[3] || ''}`.trim().replace(/\/$/, ''),
      };
    }
    if (parts[1] === 'backstory' && parts.length >= 3) {
      return { category: 'backstory', group: `背景故事 / ${parts[2]}` };
    }
    if (parts[1] === 'design-rules') {
      return { category: 'rule', group: '规则' };
    }
    if (parts[1] === 'design-building') {
      return { category: 'building', group: `建筑 / ${parts[2] || ''}`.trim().replace(/\/$/, '') };
    }
    if (parts[1] === 'design-scenes') {
      return { category: 'scene', group: '场景' };
    }
    if (parts[1] === 'design-template') {
      return { category: 'template', group: '模板' };
    }
  }
  if (relPath === 'README.md') {
    return { category: 'root', group: '根目录', meta: {} };
  }
  return { category: 'other', group: '其他', meta: {} };
}

function normalizeKey(rawKey) {
  return rawKey.trim();
}

function parseTextContent(rawText, relPath) {
  const lines = rawText.replace(/\r/g, '').split('\n');
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const title = firstNonEmpty ? firstNonEmpty.trim() : trimName(path.basename(relPath));

  const entries = [];
  const fieldMap = {};
  const preamble = [];
  let currentKey = null;
  let currentLines = [];

  const colonPattern = /^(.+?)[：:]\s*(.*)$/;
  const finalizeCurrent = () => {
    if (!currentKey) {
      return;
    }
    const value = currentLines.join('\n').trim();
    if (Object.prototype.hasOwnProperty.call(fieldMap, currentKey)) {
      if (!Array.isArray(fieldMap[currentKey])) {
        fieldMap[currentKey] = [fieldMap[currentKey]];
      }
      fieldMap[currentKey].push(value);
    } else {
      fieldMap[currentKey] = value;
    }
    entries.push({ key: currentKey, value });
    currentKey = null;
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const colonMatch = trimmed.match(colonPattern);
    if (colonMatch) {
      finalizeCurrent();
      currentKey = normalizeKey(colonMatch[1]);
      if (colonMatch[2] !== '') {
        currentLines.push(colonMatch[2]);
      }
      continue;
    }
    if (!currentKey && trimmed.length === 0) {
      continue;
    }
    if (!currentKey) {
      preamble.push(line);
      continue;
    }
    if (currentKey) {
      currentLines.push(line);
    }
  }
  finalizeCurrent();

  if (preamble.length > 0) {
    const preambleValue = preamble.join('\n').trim();
    fieldMap._header = preambleValue;
    entries.unshift({ key: '_header', value: preambleValue });
  }

  const fields = { ...fieldMap };
  const values = Object.keys(fields);
  if (values.length === 0) {
    return {
      title,
      type: 'text',
      fields: {},
      sections: [{ key: 'content', value: rawText.trim() }],
      format: 'plain',
      lineCount: lines.length,
    };
  }
  return {
    title,
    type: 'text',
    fields,
    sections: entries,
    format: 'structured-text',
    lineCount: lines.length,
  };
}

function parseJsonContent(rawText, relPath) {
  const parsed = { title: trimName(path.basename(relPath)), type: 'json', sections: [] };
  try {
    const data = JSON.parse(rawText);
    parsed.type = 'json';
    parsed.data = data;
    return parsed;
  } catch (error) {
    return {
      ...parseTextContent(rawText, relPath),
      type: 'invalid-json',
      invalidJsonMessage: error.message,
      typeHint: 'text',
      lineCount: rawText.split('\n').length,
    };
  }
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
      ...categoryInfo.meta,
    },
    parser: {
      contentType: parsedByType.type || 'text',
      format: parsedByType.format || 'text',
      lineCount: parsedByType.lineCount || 0,
    },
    fields: parsedByType.fields || {},
    sections: parsedByType.sections || [],
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
  const output = [];
  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const ext = path.extname(relPath).toLowerCase();
    const stats = await fs.stat(absolutePath);
    const raw = await fs.readFile(absolutePath, 'utf8');
    const parsed = ext === '.json' ? parseJsonContent(raw, relPath) : parseTextContent(raw, relPath);
    const normalized = buildStandardObject(relPath, absolutePath, parsed, stats);
    const standardRelPath = toPosix(
      path.join(path.dirname(relPath), `${trimName(path.basename(relPath))}.json`)
    );
    const standardAbsolute = path.join(STANDARD_ROOT, standardRelPath);
    await fs.mkdir(path.dirname(standardAbsolute), { recursive: true });
    await fs.writeFile(standardAbsolute, `${JSON.stringify(normalized)}\n`, 'utf8');
    output.push({
      source: relPath,
      standard: standardRelPath,
      category: normalized.meta.category,
      title: normalized.meta.title,
      size: raw.length,
    });
  }
  return output;
}

async function cleanupStandardStaleFiles(sourcePaths) {
  const existing = await walkFiles(STANDARD_ROOT);
  const validSet = new Set(sourcePaths.map((item) => {
    return toPosix(path.join(path.dirname(item.source), `${trimName(path.basename(item.source))}.json`));
  }));
  for (const relStandard of existing) {
    if (!validSet.has(relStandard)) {
      await fs.rm(path.join(STANDARD_ROOT, relStandard));
    }
  }
}

async function main() {
  await fs.rm(STANDARD_ROOT, { recursive: true, force: true });
  const output = await buildStandardCatalog();
  console.log(`standardized ${output.length} files`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
