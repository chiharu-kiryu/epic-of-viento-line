import { isMediaValue } from '../lib/media-format.mjs';

export const LAYOUT_VERSION = 'viento-layout-v1';

// Preserve source order and typed values. Sections come from source headings;
// arbitrary field names and document types need no renderer configuration.
export function buildDocumentLayout(parsed) {
  const sections = [];
  let current = null;
  const start = (title = '内容', level = 1, anchor = '') => {
    current = { id: `section-${sections.length + 1}`, title, level, anchor, blocks: [] };
    sections.push(current);
  };
  for (const block of parsed.blocks || []) {
    if (block.type === 'heading') {
      if (!sections.length && block.level === 1 && block.title === parsed.title) continue;
      start(block.title, block.level || 1, block.anchor || '');
      continue;
    }
    if (block.type === 'kv' && block.key === '_header' && block.value === parsed.title) continue;
    if (!current) start();
    if (block.type === 'json' && isMediaValue(block.value)) {
      current.blocks.push(block.value);
    } else if (block.type === 'json' && block.value && typeof block.value === 'object' && !Array.isArray(block.value)) {
      current.blocks.push(...Object.entries(block.value).map(([key, value]) => ({ type: 'kv', key, value })));
    } else current.blocks.push(block);
  }
  if (!sections.length) start();
  return { schemaVersion: LAYOUT_VERSION, sections };
}
