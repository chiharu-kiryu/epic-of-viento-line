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
  'web',
  'docs-standard',
  'web/.parcel-cache',
  '.cache',
]);
const SCHEMA_VERSION = 'standard-doc-v2';

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

function normalizeValue(value) {
  return (value || '').toString().trim();
}

function splitItemGroup(groupText) {
  const raw = normalizeValue(groupText).replace(/^物品\s*\/\s*/, '');
  const parts = raw.split('/').map((item) => item.trim()).filter(Boolean);
  const rawSubType = parts[1] ? parts[1].replace(/\.json$/i, '') : '';
  return {
    type: parts[0] || '物品',
    subType: rawSubType || '',
  };
}

function detectItemRole(fields = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(fields, key);
  const hasValue = (key) => {
    if (!has(key)) {
      return false;
    }
    const value = normalizeValue(fields[key]);
    return value !== '' && value !== '-';
  };
  const hasKeyPattern = (pattern) => Object.keys(fields).some((key) => pattern.test(normalizeValue(key)));
  const hasValuePattern = (pattern) => Object.values(fields).some((value) => pattern.test(normalizeValue(value)));

  const hasActive = has('主动') || has('主动技能') || has('主动能力') || hasKeyPattern(/主动/);
  const hasPassive = has('被动') || has('被动技能') || has('被动能力') || hasKeyPattern(/被动/);
  const hasActiveEffect = hasValue('主动效果');
  const hasPassiveEffect = hasValue('被动效果');
  if ((hasActive || hasActiveEffect) && (hasPassive || hasPassiveEffect)) {
    return '主动·被动';
  }
  if (hasActive || hasActiveEffect) {
    return '主动';
  }
  if (hasPassive || hasPassiveEffect) {
    return '被动';
  }

  const hasDamage = hasKeyPattern(/伤害|攻击|爆发|法术伤害|物理伤害|暴击/) || hasValuePattern(/伤害|攻击|法术|暴击/);
  const hasDefense = hasKeyPattern(/护甲|魔抗|法抗|抗性|护盾|回血|生命|治疗|回血/) || hasValuePattern(/护甲|魔抗|法抗|抗性|治疗|回血|生命/);
  const hasControl = hasKeyPattern(/眩晕|沉默|减速|禁锢|控制|束缚|定身/) || hasValuePattern(/眩晕|沉默|减速|禁锢|控制|束缚|定身/);
  const hasUtility = hasKeyPattern(/消耗|冷却|位移|移动|视野|探测|回血|恢复|补给|携带/) || hasValuePattern(/消耗|冷却|位移|移动|视野|探测|恢复|补给|携带/);

  if (hasDamage) {
    return '输出';
  }
  if (hasControl) {
    return '控制';
  }
  if (hasDefense) {
    return '防御';
  }
  if (hasUtility) {
    return '功能';
  }

  return '通用';
}

function inferPurposeGroup(category, groupText, fields = {}, meta = {}) {
  const metaPurpose = normalizeValue(meta.purpose);
  if (metaPurpose) {
    return metaPurpose;
  }

  if (category === 'hero') {
    const attr = normalizeValue(meta.attribute) || normalizeValue(fields.主属性) || '其他属性';
    const rawAttackType = normalizeValue(fields.攻击类型 || fields.类型 || '');
    const attackType = normalizeValue(rawAttackType.split(/[,，]/)[0] || '未标注');
    return `英雄 / ${attr} / ${attackType}`;
  }

  if (category === 'item') {
    const { type, subType } = splitItemGroup(groupText);
    const role = detectItemRole(fields);
    const roleLabel = role === '属性型' ? '通用' : role;
    if (subType === '价格表') {
      return `物品 / ${type} / ${roleLabel}`;
    }
    if (type === '消耗品' || type === '特殊') {
      return `物品 / ${type} / ${roleLabel}`;
    }
    if (subType) {
      return `物品 / ${type} / ${subType} / ${roleLabel}`;
    }
    return `物品 / ${type} / ${roleLabel}`;
  }

  const raw = normalizeValue(groupText);
  const pieces = raw.split('/').map((item) => item.trim()).filter(Boolean);
  if (pieces.length >= 2) {
    return `${pieces[0]} / ${pieces[1]}`;
  }
  return raw || `其他 / ${category}`;
}

function normalizeKey(rawKey) {
  return rawKey.trim();
}

function toSlug(value, fallback) {
  const text = (value || '').trim().toLowerCase();
  const slug = text
    .normalize('NFKD')
    .replace(/[^\u4e00-\u9fff\w\s\-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback || `section-${Math.random().toString(16).slice(2, 8)}`;
}

function isHeaderLine(line) {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  if (!match) {
    return null;
  }
  return { level: match[1].length, title: match[2].trim() };
}

function isListLine(line) {
  return /^(\s{0,3})([-*+]|\d+\.)\s+/.test(line);
}

function isKvLine(line) {
  if (!line.trim() || isListLine(line)) {
    return null;
  }
  const match = line.trim().match(/^(.*?)[:：]\s*(.*)$/);
  if (!match) {
    return null;
  }
  const key = match[1].trim();
  const value = match[2].trim();
  if (!key || key.length > 60) {
    return null;
  }
  return { key, value };
}

function isTableRow(line) {
  return line.includes('|') && line.trim().replace(/\|/g, '').trim().length > 0;
}

function parseTableRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

function buildNode(level, title, headingStack, outline) {
  const node = {
    id: toSlug(title, `${level}-${title}`),
    title,
    level,
    anchor: `#${toSlug(title, `${level}-${title}`)}`,
    children: [],
  };
  while (headingStack.length >= level) {
    headingStack.pop();
  }
  if (headingStack.length === 0) {
    outline.push(node);
  } else {
    headingStack[headingStack.length - 1].children.push(node);
  }
  headingStack.push(node);
  return node;
}

function pushKvField(fieldMap, key, value, sections) {
  const normalizedKey = normalizeKey(key);
  if (Object.prototype.hasOwnProperty.call(fieldMap, normalizedKey)) {
    if (!Array.isArray(fieldMap[normalizedKey])) {
      fieldMap[normalizedKey] = [fieldMap[normalizedKey]];
    }
    fieldMap[normalizedKey].push(value);
  } else {
    fieldMap[normalizedKey] = value;
  }
  sections.push({ key: normalizedKey, value });
}

function detectProfile(lines) {
  if (lines.length === 0) {
    return 'plain';
  }
  const hasHeading = lines.some((line) => /^#{1,6}\s+/.test(line));
  const hasKv = lines.some((line) => /[:：]/.test(line));
  const hasList = lines.some((line) => isListLine(line));
  const hasTable = lines.some((line) => isTableRow(line));
  if (hasHeading && hasKv) {
    return 'markdown-like';
  }
  if (hasHeading) {
    return 'heading-text';
  }
  if (hasKv) {
    return 'kv-text';
  }
  if (hasList || hasTable) {
    return 'structured-block';
  }
  return 'plain';
}

function cleanParagraphLines(lines) {
  return lines.join('\n').trim();
}

function parseTextContent(rawText, relPath) {
  const lines = rawText.replace(/\r/g, '').split('\n');
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const title = firstNonEmpty ? firstNonEmpty.trim() : trimName(path.basename(relPath));

  const blocks = [];
  const sections = [];
  const fields = {};
  const outline = [];
  const headingStack = [];

  let currentParagraph = [];
  let currentList = null;
  let currentListOrdered = false;

  const flushParagraph = () => {
    if (currentParagraph.length === 0) {
      return;
    }
    const text = cleanParagraphLines(currentParagraph);
    if (text) {
      blocks.push({ type: 'paragraph', text });
      sections.push({ key: '段落', value: text });
    }
    currentParagraph = [];
  };

  const flushList = () => {
    if (!currentList) {
      return;
    }
    blocks.push({
      type: 'list',
      ordered: currentListOrdered,
      items: currentList.slice(),
    });
    sections.push({ key: currentListOrdered ? '有序列表' : '列表', value: currentList.join('\n') });
    currentList = null;
    currentListOrdered = false;
  };

  const parseKvValue = (key, startIndex) => {
    const valueLines = [];
    let idx = startIndex;
    while (idx < lines.length) {
      const line = lines[idx];
      const trimmed = line.trim();
      if (!trimmed) {
        break;
      }
      if (isHeaderLine(trimmed) || isKvLine(line) || isListLine(line) || isTableRow(line)) {
        break;
      }
      valueLines.push(line);
      idx += 1;
    }
    return { value: cleanParagraphLines(valueLines), nextIndex: idx };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    const header = isHeaderLine(line);
    if (header) {
      flushParagraph();
      flushList();
      const node = buildNode(header.level, header.title, headingStack, outline);
      blocks.push({ type: 'heading', level: header.level, title: header.title, anchor: node.anchor });
      i += 1;
      continue;
    }

    const kv = isKvLine(line);
    if (kv) {
      flushParagraph();
      flushList();
      const parsedValue = parseKvValue(kv.key, i + 1);
      pushKvField(fields, kv.key, kv.value || parsedValue.value, sections);
      blocks.push({ type: 'kv', key: kv.key, value: kv.value || parsedValue.value });
      if (kv.value) {
        i += 1;
      } else {
        i = parsedValue.nextIndex;
      }
      continue;
    }

    if (isListLine(line)) {
      if (!currentList) {
        flushParagraph();
        currentList = [];
        currentListOrdered = /^\s*\d+\.\s+/.test(line);
      }
      const item = line.replace(/^(\s*(?:[-*+]|\d+\.)\s+)/, '').trim();
      currentList.push(item);
      i += 1;
      continue;
    }

    if (currentList && trimmed.length > 0 && (line.startsWith('  ') || line.startsWith('\t'))) {
      const last = currentList.length - 1;
      if (last >= 0) {
        currentList[last] = `${currentList[last]}\n${trimmed}`;
      }
      i += 1;
      continue;
    }

    if (isTableRow(line)) {
      if (currentList) {
        flushList();
      }
      flushParagraph();
      const rawRows = [];
      const parsedRows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rawRows.push(lines[i]);
        parsedRows.push(parseTableRow(lines[i]));
        i += 1;
      }
      const separatorIndex = rawRows.findIndex((raw) =>
        /^\s*\|?\s*:?-{3,}\s*:?(?:\s*\|\s*:?-{3,}\s*:?)*\s*\|?\s*$/.test(raw)
      );
      let headerRow = null;
      let rows = parsedRows;
      if (separatorIndex >= 0) {
        headerRow = parsedRows[separatorIndex - 1] || null;
        rows = parsedRows.filter((_, index) => index !== separatorIndex);
      }
      blocks.push({ type: 'table', header: headerRow, rows });
      sections.push({ key: '表格', value: rawRows.join('\n') });
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      if (currentList) {
        flushList();
      }
      i += 1;
      continue;
    }

    if (currentList) {
      flushList();
    }
    currentParagraph.push(line);
    i += 1;
  }

  flushParagraph();
  flushList();

  const hasMeaningfulContent = lines.some((line) => line.trim().length > 0);
  if (!fields._header) {
    const safeTitle = title || '未命名文档';
    fields._header = safeTitle;
  } else {
    fields._header = fields._header.trim();
  }

  if (!sections.some((item) => item.key === '_header')) {
    sections.unshift({ key: '_header', value: fields._header });
  }

  const safeTitle = fields._header || title || '未命名文档';
  const hasHeadingForHeader = blocks.some((block) => block.type === 'heading' && block.title === safeTitle);
  if (!hasHeadingForHeader) {
    blocks.unshift({
      type: 'heading',
      level: 1,
      title: safeTitle,
      anchor: `#${toSlug(safeTitle, safeTitle)}`,
    });
  }

  if (!hasMeaningfulContent) {
    if (!blocks.some((block) => block.type === 'paragraph' && block.text === '该文档当前为空，尚未补充可结构化内容。')) {
      blocks.push({ type: 'paragraph', text: '该文档当前为空，尚未补充可结构化内容。' });
    }
  }

  if (outline.length === 0) {
    outline.push({
      id: toSlug(safeTitle, safeTitle),
      title: safeTitle,
      level: 1,
      anchor: `#${toSlug(safeTitle, safeTitle)}`,
      children: [],
    });
  }

  const blockStats = {
    blockCount: blocks.length,
    headingCount: blocks.filter((item) => item.type === 'heading').length,
    paragraphCount: blocks.filter((item) => item.type === 'paragraph').length,
    listCount: blocks.filter((item) => item.type === 'list').length,
    tableCount: blocks.filter((item) => item.type === 'table').length,
    kvCount: blocks.filter((item) => item.type === 'kv').length,
  };

  return {
    title,
    type: 'text',
    fields,
    sections: sections.length > 0 ? sections : [{ key: 'content', value: rawText.trim() }],
    blocks,
    outline,
    format: 'structured-text',
    lineCount: lines.length,
    profile: detectProfile(lines),
    blockStats,
    fieldCount: Object.keys(fields).length,
  };
}

function parseJsonContent(rawText, relPath) {
  const parsed = { title: trimName(path.basename(relPath)), type: 'json', sections: [] };
  const safeTitle = parsed.title || '未命名文档';
  try {
    const data = JSON.parse(rawText);
    const entries = Object.entries(data || {});
    const outline = [
      {
        id: toSlug(safeTitle, safeTitle),
        title: safeTitle,
        level: 1,
        anchor: `#${toSlug(safeTitle, safeTitle)}`,
        children: [],
      },
    ];
    parsed.type = 'json';
    parsed.data = data;
    parsed.profile = 'json';
    parsed.fields = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    parsed.sections = [{ key: '_header', value: safeTitle }];
    parsed.outline = outline;
    parsed.blocks = [{ type: 'json', value: data }];
    parsed.fieldCount = entries.length;
    parsed.blockStats = {
      blockCount: 1,
      headingCount: 0,
      paragraphCount: 0,
      listCount: 0,
      tableCount: 0,
      kvCount: entries.length,
    };
    return parsed;
  } catch (error) {
    return {
      ...parseTextContent(rawText, relPath),
      type: 'invalid-json',
      invalidJsonMessage: error.message,
      typeHint: 'text',
      profile: 'invalid-json',
      blockStats: { blockCount: 0, headingCount: 0, paragraphCount: 0, listCount: 0, tableCount: 0, kvCount: 0 },
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
  const validSet = new Set(sourcePaths.map((item) =>
    toPosix(path.join(path.dirname(item.source), `${trimName(path.basename(item.source))}.json`))
  ));
  for (const relStandard of existing) {
    if (!validSet.has(relStandard)) {
      await fs.rm(path.join(STANDARD_ROOT, relStandard));
    }
  }
}

async function main() {
  await fs.rm(STANDARD_ROOT, { recursive: true, force: true });
  const output = await buildStandardCatalog();
  await cleanupStandardStaleFiles(output);
  console.log(`standardized ${output.length} files`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
