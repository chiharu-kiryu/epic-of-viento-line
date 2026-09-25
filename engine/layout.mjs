import { isMediaValue } from './media-format.mjs';

export const LAYOUT_VERSION = 'viento-layout-v1';

// Preserve source order and typed values. Sections come from source headings;
// arbitrary field names and document types need no renderer configuration.
export function buildDocumentLayout(parsed) {
  const sections = [];
  let current = null;
  const start = (title, level = 1, anchor = '') => {
    current = { id: `section-${sections.length + 1}`, title: title ?? '内容',
      ...(title === undefined ? { titleKey: '内容' } : {}), level, anchor, blocks: [] };
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
    } else if (block.type === 'json' && block.value && typeof block.value === 'object' && !Array.isArray(block.value) && Object.keys(block.value).length) {
      current.blocks.push(...Object.entries(block.value).map(([key, value]) => ({ type: 'kv', key, value })));
    } else current.blocks.push(block);
  }
  if (!sections.length) start();
  // Explicit groups select exact field names, preserving values and duplicates.
  // Unselected fields and every prose/media block remain in source order.
  if (parsed.fieldGroups?.length) {
    const grouped = [];
    const selected = new Set(parsed.fieldGroups.flatMap((group) => group.fields));
    for (const [index, group] of parsed.fieldGroups.entries()) {
      const blocks = group.fields.flatMap((key) => sections.flatMap((section) => section.blocks.filter((block) => block.type === 'kv' && block.key === key)));
      if (blocks.length) grouped.push({ id: `group-${index + 1}`, title: group.title, level: 2, anchor: '', blocks });
    }
    for (const section of sections) {
      section.blocks = section.blocks.filter((block) => block.type !== 'kv' || !selected.has(block.key));
      if (section.blocks.length) grouped.push(section);
    }
    return { schemaVersion: LAYOUT_VERSION, sections: grouped.length ? grouped : sections };
  }
  return { schemaVersion: LAYOUT_VERSION, sections };
}
