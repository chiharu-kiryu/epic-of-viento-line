import path from 'node:path';
import { toSlug, trimName, normalizeValue } from './utils.mjs';

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
  const normalizedKey = normalizeValue(key);
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

  const parseKvValue = (_key, startIndex) => {
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

export { parseTextContent, parseJsonContent };
