import { sourceFileName } from './source-path.mjs';
import { parse as parseYaml } from 'yaml';
import { toSlug, trimName, normalizeValue } from './text-utils.mjs';
import { isMediaValue, splitMediaText } from './media-format.mjs';

function isHeaderLine(line) {
  const match = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
  return match ? { level: match[1].length, title: match[2].replace(/\s+#+\s*$/, '').trim() } : null;
}

function isListLine(line) {
  return /^ {0,3}(?:[-*+]|\d+[.)])\s+/.test(line);
}

function isKvLine(line) {
  if (!line.trim() || isListLine(line) || /^\s*(?:>|https?:\/\/)/i.test(line)) return null;
  const parts = splitMediaText(line);
  if (parts.some(isMediaValue) && (parts[0]?.type !== 'paragraph' || !/^[^：:]{1,120}[:：]/.test(parts[0].text.trim()))) return null;
  const match = line.trim().match(/^([^：:]{1,120})[:：]\s*(.*)$/);
  return match && match[1].trim() ? { key: match[1].trim(), value: match[2].trim() } : null;
}

function fenceMarker(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1], info: match[2].trim() };
}

function parseTableRow(line) {
  let text = line.trim().replace(/^\|/, '');
  if (/(?<!\\)\|$/.test(text)) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && (text[i + 1] === '|' || text[i + 1] === '\\')) {
      cell += text[++i];
    } else if (text[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += text[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const separator = parseTableRow(lines[index + 1]);
  return separator.length === parseTableRow(lines[index]).length
    && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function pushKvField(fields, key, value, sections) {
  if (Object.hasOwn(fields, key)) {
    if (!Array.isArray(fields[key])) fields[key] = [fields[key]];
    fields[key].push(value);
  } else {
    // Metadata labels are data, including names such as __proto__.
    Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true });
  }
  sections.push({ key, value });
}

function blockStats(blocks) {
  return {
    blockCount: blocks.length,
    headingCount: blocks.filter((item) => item.type === 'heading').length,
    paragraphCount: blocks.filter((item) => item.type === 'paragraph').length,
    listCount: blocks.filter((item) => item.type === 'list').length,
    tableCount: blocks.filter((item) => item.type === 'table').length,
    kvCount: blocks.filter((item) => item.type === 'kv').length,
  };
}

function parseTextContent(rawText, relPath = '', options = {}) {
  const lines = rawText.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n').split('\n');
  // Only draft editing needs offsets. Keep the normal index format unchanged.
  const sourceLines = options.captureSourceRanges ? [...rawText.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match => match[0]) : [];
  const firstIndex = lines.findIndex((line) => line.trim());
  const first = lines[firstIndex] || '';
  const firstHeading = isHeaderLine(first);
  const prose = options.keyValueMode === 'prose';
  const allowedKeys = new Set(options.allowedFieldKeys || []);
  const multilineKeys = new Set(options.multilineFieldKeys || []);
  const boundaryKeys = new Set(options.boundaryFieldKeys || []);
  const readKv = (line) => {
    const kv = isKvLine(line);
    return kv && (!prose || allowedKeys.has(kv.key)) ? kv : null;
  };
  const plainTitle = firstIndex >= 0 && !firstHeading && !readKv(first)
    && !isListLine(first) && !isTableStart(lines, firstIndex) && !fenceMarker(first)
    && !splitMediaText(first).some(isMediaValue);
  const title = firstHeading?.title || (plainTitle ? first.trim() : trimName(sourceFileName(relPath))) || '未命名文档';
  const blocks = [];
  const sections = [];
  const fields = {};
  const outline = [];
  let hasSourceHeading = false;
  const headingStack = [];
  const headingIds = new Set();
  const addHeading = (level, text) => {
    const base = toSlug(text, 'section');
    let id = base;
    for (let suffix = 2; headingIds.has(id); suffix += 1) id = `${base}-${suffix}`;
    headingIds.add(id);
    const node = { id, title: text, level, anchor: `#${id}`, children: [] };
    while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
    (headingStack.at(-1)?.children || outline).push(node);
    headingStack.push(node);
    blocks.push({ type: 'heading', level, title: text, anchor: node.anchor });
  };
  let paragraph = [];
  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    if (text) {
      blocks.push(...splitMediaText(text).filter((block) => block.type !== 'paragraph' || block.text.trim()));
      sections.push({ key: '段落', value: text });
    }
    paragraph = [];
  };
  // Plain-text documents use their first line as a title; do not repeat it as body text.
  if (!firstHeading) addHeading(1, title);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (plainTitle && i === firstIndex) { i += 1; continue; }
    const fence = fenceMarker(line);
    if (fence) {
      flushParagraph();
      const value = [];
      i += 1;
      while (i < lines.length) {
        const closing = fenceMarker(lines[i]);
        if (closing && closing.marker[0] === fence.marker[0]
          && closing.marker.length >= fence.marker.length && !closing.info) {
          i += 1;
          break;
        }
        value.push(lines[i++]);
      }
      blocks.push({ type: 'code', language: fence.info, value: value.join('\n') });
      continue;
    }
    const heading = isHeaderLine(line);
    if (heading) {
      flushParagraph();
      hasSourceHeading = true;
      addHeading(heading.level, heading.title);
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      flushParagraph();
      const start = i;
      const header = parseTableRow(lines[i]);
      const align = parseTableRow(lines[i + 1]).map((cell) => cell.startsWith(':') ? (cell.endsWith(':') ? 'center' : 'left') : (cell.endsWith(':') ? 'right' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !isHeaderLine(lines[i]) && !fenceMarker(lines[i]) && !isListLine(lines[i])) {
        rows.push(parseTableRow(lines[i++]));
      }
      blocks.push({ type: 'table', header, rows, align });
      sections.push({ key: '表格', value: lines.slice(start, i).join('\n') });
      continue;
    }
    const kv = readKv(line);
    if (kv) {
      flushParagraph();
      const startLine = i;
      const values = kv.value ? [kv.value] : [];
      i += 1;
      while (i < lines.length && lines[i].trim()) {
        if (isHeaderLine(lines[i]) || fenceMarker(lines[i]) || isListLine(lines[i]) || isTableStart(lines, i)) break;
        const nextKv = readKv(lines[i]);
        if (nextKv && (!multilineKeys.has(kv.key) || multilineKeys.has(nextKv.key) || boundaryKeys.has(nextKv.key))) break;
        values.push(lines[i++]);
      }
      const value = values.join('\n').trim();
      pushKvField(fields, kv.key, value, sections);
      const block = { type: 'kv', key: kv.key, value };
      if (options.captureSourceRanges) {
        const first = sourceLines[startLine], last = sourceLines[i - 1];
        const start = first.index + first[0].search(/[:：]/) + 1;
        const end = last.index + last[0].replace(/[\r\n]+$/, '').length;
        const rawValue = rawText.slice(start, end);
        const leading = rawValue.match(/^\s*/)[0].length;
        block.sourceRange = [start + leading, Math.max(start + leading, end - rawValue.match(/\s*$/)[0].length)];
      }
      blocks.push(block);
      continue;
    }
    if (isListLine(line)) {
      flushParagraph();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length) {
        if (isListLine(lines[i])) {
          if (/^\s*\d+[.)]\s+/.test(lines[i]) !== ordered) break;
          items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim());
        } else if (lines[i].trim() && /^(?: {2,}|\t)/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i++].trim()}`;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items });
      sections.push({ key: ordered ? '有序列表' : '列表', value: items.join('\n') });
      continue;
    }
    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  const headerValue = Array.isArray(fields._header) ? fields._header.find((value) => normalizeValue(value)) : fields._header;
  const safeTitle = normalizeValue(headerValue) || title;
  if (!firstHeading && safeTitle !== title) {
    headingIds.delete(outline[0].id);
    const base = toSlug(safeTitle, 'section');
    let id = base;
    for (let suffix = 2; headingIds.has(id); suffix += 1) id = `${base}-${suffix}`;
    Object.assign(outline[0], { id, title: safeTitle, anchor: `#${id}` });
    Object.assign(blocks[0], { title: safeTitle, anchor: `#${id}` });
  }
  if (!Object.hasOwn(fields, '_header')) fields._header = safeTitle;
  if (!sections.some((section) => section.key === '_header')) sections.unshift({ key: '_header', value: safeTitle });
  if (firstIndex < 0) blocks.push({ type: 'paragraph', text: '该文档当前为空，尚未补充可结构化内容。' });
  const stats = blockStats(blocks);
  const profile = stats.kvCount ? (hasSourceHeading ? 'markdown-like' : 'kv-text')
    : hasSourceHeading ? 'heading-text'
      : stats.listCount || stats.tableCount || blocks.some((block) => block.type === 'code') ? 'structured-block' : 'plain';
  return {
    title: safeTitle, type: 'text', fields, sections, blocks, outline,
    format: 'structured-text', lineCount: lines.length, profile,
    blockStats: stats, fieldCount: Object.keys(fields).length,
  };
}

function parseStructuredData(data, rawText, relPath, format) {
  const title = trimName(sourceFileName(relPath)) || '未命名文档';
  const fields = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const id = toSlug(title, 'document');
  const blocks = [{ type: 'json', value: data }];
  return {
    title, type: format, data, fields,
    sections: [{ key: '_header', value: title }, ...Object.entries(fields).map(([key, value]) => ({ key, value }))],
    outline: [{ id, title, level: 1, anchor: `#${id}`, children: [] }],
    blocks, format, profile: format, lineCount: rawText.split(/\r\n|\r|\n/).length,
    fieldCount: Object.keys(fields).length, blockStats: blockStats(blocks),
  };
}

function invalidStructuredContent(rawText, relPath, format, error) {
  const parsed = parseTextContent(rawText, relPath);
  return {
    ...parsed, type: `invalid-${format}`, format, profile: `invalid-${format}`,
    invalidJsonMessage: format === 'json' ? error.message : undefined,
    parseError: error.message,
    // Show the original invalid input without guessing partial metadata values.
    fields: { _header: parsed.title }, sections: [{ key: '_header', value: parsed.title }],
    blocks: [{ type: 'code', language: format, value: rawText }],
    fieldCount: 1, blockStats: blockStats([{ type: 'code' }]),
  };
}

function parseJsonContent(rawText, relPath) {
  try {
    return parseStructuredData(JSON.parse(rawText.replace(/^\uFEFF/, '')), rawText, relPath, 'json');
  } catch (error) {
    return invalidStructuredContent(rawText, relPath, 'json', error);
  }
}

function parseYamlContent(rawText, relPath) {
  try {
    return parseStructuredData(parseYaml(rawText.replace(/^\uFEFF/, ''), { maxAliasCount: 100 }), rawText, relPath, 'yaml');
  } catch (error) {
    return invalidStructuredContent(rawText, relPath, 'yaml', error);
  }
}

export { parseTextContent, parseYamlContent, parseJsonContent };
