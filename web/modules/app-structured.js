import {
  normalizeValue,
  normalizeLabel,
} from './app-helpers.js';
import {
  createTextBlock,
  renderKvTableRows,
  renderListBlock,
  renderTableBlock,
} from './app-render.js';

function renderStructuredBlocks(blocks, options = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return createTextBlock('');
  }

  const fragment = document.createDocumentFragment();
  const dedupeKeys = options.dedupeKeys instanceof Set ? options.dedupeKeys : new Set();

  for (const block of blocks) {
    if (!block || !block.type) {
      continue;
    }

    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, Number(block.level) || 1));
      const heading = document.createElement(`h${level}`);
      heading.textContent = block.title || '';
      fragment.appendChild(heading);
      continue;
    }

    if (block.type === 'paragraph') {
      const p = document.createElement('p');
      p.className = 'doc-paragraph';
      p.textContent = block.text || '';
      fragment.appendChild(p);
      continue;
    }

    if (block.type === 'kv') {
      const kvKey = normalizeValue(block.key);
      if (dedupeKeys.has(kvKey) || dedupeKeys.has(normalizeLabel(kvKey))) {
        continue;
      }
      fragment.appendChild(renderKvTableRows([{ key: block.key, value: block.value || '' }]));
      continue;
    }

    if (block.type === 'list') {
      fragment.appendChild(renderListBlock(block));
      continue;
    }

    if (block.type === 'table') {
      fragment.appendChild(renderTableBlock(block));
      continue;
    }

    const pre = document.createElement('pre');
    pre.className = 'doc-pre';
    pre.textContent = typeof block.value === 'string' ? block.value : JSON.stringify(block, null, 2);
    fragment.appendChild(pre);
  }

  return fragment;
}

export { renderStructuredBlocks };
