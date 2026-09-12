import { normalizeValue, normalizeLabel, toDisplayValue } from './app-helpers.js';
import { renderKvTableRows, renderListBlock, renderTableBlock } from './app-render.js';
import { renderMedia, renderMediaText } from './app-media-render.js';

const RENDER_PLACEHOLDERS = new Set(['-', '—', '——', '———', '暂无', '未填写', '无', '未知', '待补充', '待完善', 'null', 'none', 'n/a', 'na']);

function hasRenderableToken(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = normalizeValue(value).replace(/\s+/g, '');
    return !!text && !RENDER_PLACEHOLDERS.has(text.toLowerCase());
  }
  if (Array.isArray(value)) return value.some(hasRenderableToken);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function renderStructuredBlocks(blocks, options = {}) {
  if (!Array.isArray(blocks) || options.renderMode === 'card-only') return null;
  const fragment = document.createDocumentFragment();
  const keys = options.dedupeKeys instanceof Set ? options.dedupeKeys : new Set();
  const texts = options.dedupeText instanceof Set ? options.dedupeText : new Set();
  const isShownKey = (key) => keys.has(key) || keys.has(normalizeLabel(key));
  // Only suppress content already shown in a metadata card. Repeated prose, headings
  // and list entries inside the source are meaningful and must keep their order.
  const isShownText = (value) => texts.has(normalizeValue(value).replace(/\r\n|\r/g, '\n'));
  const appendPre = (value, className = 'doc-pre') => {
    const pre = document.createElement('pre');
    pre.className = className;
    pre.textContent = value;
    fragment.appendChild(pre);
  };

  for (const block of blocks) {
    if (!block?.type) continue;
    if (block.type === 'heading') {
      const title = normalizeValue(block.title);
      if (!title || isShownText(title)) continue;
      const level = Math.max(1, Math.min(6, Number(block.level) || 1));
      const heading = document.createElement(`h${level}`);
      heading.textContent = title;
      if (block.anchor) heading.id = block.anchor.replace(/^#/, '');
      fragment.appendChild(heading);
    } else if (block.type === 'image' || block.type === 'video') {
      fragment.appendChild(renderMedia(block));
    } else if (block.type === 'paragraph') {
      const text = normalizeValue(block.text);
      if (!text || isShownText(text)) continue;
      const media = renderMediaText(text);
      if (media) { fragment.appendChild(media); continue; }
      const p = document.createElement('p');
      p.className = 'doc-paragraph';
      p.textContent = text;
      fragment.appendChild(p);
    } else if (block.type === 'kv') {
      const key = normalizeValue(block.key);
      if (!hasRenderableToken(key) || !hasRenderableToken(block.value) || isShownKey(key)) continue;
      fragment.appendChild(renderKvTableRows([{ key, value: toDisplayValue(block.value) }]));
    } else if (block.type === 'list') {
      const items = (Array.isArray(block.items) ? block.items : []).map(toDisplayValue);
      if (items.length && !isShownText(items.join('\n'))) fragment.appendChild(renderListBlock({ ...block, items }));
    } else if (block.type === 'table') {
      const cellValue = (value) => value == null ? '' : toDisplayValue(value);
      const header = (Array.isArray(block.header) ? block.header : []).map(cellValue);
      const rows = (Array.isArray(block.rows) ? block.rows : []).map((row) => (Array.isArray(row) ? row : [row]).map(cellValue));
      if (header.length || rows.length) fragment.appendChild(renderTableBlock({ ...block, header, rows }));
    } else if (block.type === 'json') {
      if (block.value && typeof block.value === 'object' && !Array.isArray(block.value)) {
        const rows = Object.entries(block.value).filter(([key]) => !isShownKey(key))
          .map(([key, value]) => ({ key, value: value === null ? 'null' : toDisplayValue(value) }));
        if (rows.length) fragment.appendChild(renderKvTableRows(rows));
        else if (!Object.keys(block.value).length) appendPre('{}');
      } else {
        appendPre(JSON.stringify(block.value, null, 2) ?? 'null');
      }
    } else if (block.type === 'code') {
      appendPre(block.value ?? '');
    } else {
      appendPre(block.value === undefined ? JSON.stringify(block, null, 2) : toDisplayValue(block.value));
    }
  }
  return fragment.childElementCount ? fragment : null;
}

export { renderStructuredBlocks, hasRenderableToken };
