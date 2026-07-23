import {
  normalizeValue,
  normalizeLabel,
  toDisplayValue,
} from './app-helpers.js';
import {
  renderKvTableRows,
  renderListBlock,
  renderTableBlock,
} from './app-render.js';

const RENDER_PLACEHOLDERS = new Set([
  '-',
  '—',
  '——',
  '———',
  '暂无',
  '未填写',
  '无',
  '未知',
  '待补充',
  '待完善',
  'null',
  'none',
  'n/a',
  'na',
]);

function normalizeTextFingerprint(value) {
  return normalizeValue(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\[\]【】()（）]/g, '')
    .replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
}

function hasRenderableToken(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    const normalized = normalizeValue(value).replace(/\s+/g, '');
    if (!normalized) {
      return false;
    }
    const lowered = normalized.toLowerCase();
    return !RENDER_PLACEHOLDERS.has(lowered) && !RENDER_PLACEHOLDERS.has(normalized);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasRenderableToken(entry));
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'object') {
    return Object.keys(value || {}).length > 0;
  }

  return true;
}

function hasRenderableValue(label, value) {
  if (!hasRenderableToken(value) || !hasRenderableToken(label)) {
    return false;
  }
  return true;
}

function addTextFingerprint(seenTexts, value) {
  const signature = normalizeTextFingerprint(value);
  if (!signature) {
    return false;
  }
  if (seenTexts.has(signature)) {
    return false;
  }
  seenTexts.add(signature);
  return true;
}

function collectRenderableRowsFromObject(value, dedupeKeys) {
  const rows = [];
  if (!value || typeof value !== 'object') {
    return rows;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!hasRenderableToken(item)) {
        return;
      }
      const label = `项目 ${index + 1}`;
      const normalizedLabel = normalizeValue(label);
      if (dedupeKeys.has(normalizedLabel) || dedupeKeys.has(normalizeLabel(normalizedLabel))) {
        return;
      }
      dedupeKeys.add(normalizedLabel);
      rows.push([label, item]);
    });
    return rows;
  }

  for (const [key, itemValue] of Object.entries(value)) {
    if (!hasRenderableValue(key, itemValue)) {
      continue;
    }
    const normalizedKey = normalizeValue(key);
    if (dedupeKeys.has(normalizedKey) || dedupeKeys.has(normalizeLabel(normalizedKey))) {
      continue;
    }
    dedupeKeys.add(normalizedKey);
    rows.push([key, itemValue]);
  }

  return rows;
}

function renderStructuredBlocks(blocks, options = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }

  const fragment = document.createDocumentFragment();
  const dedupeKeys = options.dedupeKeys instanceof Set ? options.dedupeKeys : new Set();
  const dedupeText = options.dedupeText instanceof Set ? options.dedupeText : new Set();
  const mode = options.renderMode;

  for (const block of blocks) {
    if (!block || !block.type) {
      continue;
    }

    if (mode === 'card-only') {
      continue;
    }

    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, Number(block.level) || 1));
      const title = normalizeValue(block.title);
      if (!hasRenderableToken(title)) {
        continue;
      }
      const headingSig = normalizeTextFingerprint(title);
      if (!headingSig || dedupeText.has(headingSig) || dedupeKeys.has(title) || dedupeKeys.has(normalizeLabel(title))) {
        continue;
      }
      dedupeText.add(headingSig);
      const heading = document.createElement(`h${level}`);
      heading.textContent = title;
      fragment.appendChild(heading);
      continue;
    }

    if (block.type === 'paragraph') {
      const text = normalizeValue(block.text);
      if (!hasRenderableToken(text)) {
        continue;
      }
      if (!addTextFingerprint(dedupeText, text)) {
        continue;
      }
      const p = document.createElement('p');
      p.className = 'doc-paragraph';
      p.textContent = text;
      fragment.appendChild(p);
      continue;
    }

    if (block.type === 'kv') {
      const kvKey = normalizeValue(block.key);
      const kvValue = toDisplayValue(block.value);
      if (!hasRenderableValue(kvKey, kvValue)) {
        continue;
      }
      if (dedupeKeys.has(kvKey) || dedupeKeys.has(normalizeLabel(kvKey))) {
        continue;
      }
      dedupeKeys.add(kvKey);
      addTextFingerprint(dedupeText, kvKey);
      addTextFingerprint(dedupeText, kvValue);
      fragment.appendChild(renderKvTableRows([{ key: block.key, value: kvValue }]));
      continue;
    }

    if (block.type === 'list') {
      const entries = Array.isArray(block.items) ? block.items.filter((item) => hasRenderableToken(item)) : [];
      const hasUniqueItem = entries.some((item) => addTextFingerprint(dedupeText, item));
      if (!hasUniqueItem) {
        continue;
      }
      fragment.appendChild(renderListBlock({
        ...block,
        items: entries,
      }));
      continue;
    }

    if (block.type === 'table') {
      const header = (block.header || []).filter(hasRenderableToken);
      const rows = (block.rows || [])
        .map((row) => (Array.isArray(row) ? row.filter(hasRenderableToken) : [normalizeValue(row)].filter(hasRenderableToken)))
        .filter((row) => row.length > 0);
      if (!header.length && !rows.length) {
        continue;
      }

      let hasUniqueValue = false;
      for (const item of header) {
        if (addTextFingerprint(dedupeText, item)) {
          hasUniqueValue = true;
        }
      }
      for (const row of rows) {
        for (const item of row) {
          if (addTextFingerprint(dedupeText, item)) {
            hasUniqueValue = true;
          }
        }
      }
      if (!hasUniqueValue) {
        continue;
      }

      fragment.appendChild(renderTableBlock({
        ...block,
        header,
        rows,
      }));
      continue;
    }

    if (block.type === 'json') {
      const rows = collectRenderableRowsFromObject(block.value, dedupeKeys);
      if (rows.length > 0) {
        let hasUniqueValue = false;
        for (const [key, value] of rows) {
          if (addTextFingerprint(dedupeText, key) || addTextFingerprint(dedupeText, value)) {
            hasUniqueValue = true;
          }
        }
        if (hasUniqueValue) {
          fragment.appendChild(renderKvTableRows(rows.map(([key, value]) => ({ key, value: toDisplayValue(value) }))));
        }
      }
      continue;
    }

    const text = hasRenderableToken(block.value)
      ? toDisplayValue(block.value)
      : hasRenderableToken(JSON.stringify(block))
        ? JSON.stringify(block, null, 2)
        : '';
    if (!text) {
      continue;
    }
    if (!addTextFingerprint(dedupeText, text)) {
      continue;
    }
    const pre = document.createElement('pre');
    pre.className = 'doc-pre';
    pre.textContent = text;
    fragment.appendChild(pre);
  }

  if (fragment.childElementCount === 0) {
    return null;
  }

  return fragment;
}

export { renderStructuredBlocks, hasRenderableToken };
