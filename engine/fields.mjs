import { userError } from './user-message.mjs';
import { sourceExtension } from './source-path.mjs';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { parseTextContent } from './parser.mjs';
import { parserOptionsForSource } from './legacy-profile.mjs';
import { splitValueFields } from './document-values.mjs';

const invalid = message => userError(message, 400, 'field_draft_invalid');
const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

// Values point into the current draft, never the generated, lossy display index.
export function createDocumentFieldDraft(content, sourcePath, descriptor = {}) {
  const extension = sourceExtension(sourcePath).toLowerCase();
  const format = extension === '.json' ? 'json' : ['.yaml', '.yml'].includes(extension) ? 'yaml' : 'text';
  const fields = [];
  let omitted = 0;
  const groupFor = key => descriptor.fieldGroups?.find(group => group.fields.includes(key))?.title;
  const add = field => {
    if (fields.length >= 2000) throw invalid('字段过多，请使用源码或分段编辑。');
    fields.push({ id: String(fields.length), ...field });
  };
  if (format === 'text') {
    const parsed = parseTextContent(content, sourcePath, { ...parserOptionsForSource(sourcePath, descriptor), captureSourceRanges: true });
    let section = '';
    for (const block of parsed.blocks) {
      if (block.type === 'heading') section = block.level === 1 && block.title === parsed.title ? '' : block.title;
      if (block.type !== 'kv') continue;
      const [start, end] = block.sourceRange;
      const value = content.slice(start, end).replace(/\r\n|\r/g, '\n');
      if (splitValueFields(value)) {
        const group = groupFor(block.key) ?? (section || block.key);
        for (const line of content.slice(start, end).matchAll(/[^\r\n]+/g)) {
          if (!line[0].trim()) continue;
          const named = line[0].match(/^(\s*[^:：]+[:：]\s*)(.+?)\s*$/);
          const numeric = !named && line[0].match(/^(\s*)([+\-−]?\d\S*)\s+(.+?)\s*$/);
          const label = named ? line[0].slice(0, named[1].length).replace(/[:：]\s*$/, '').trim() : numeric[3];
          const text = named ? named[2] : numeric[2], at = start + line.index + (named ? named[1].length : numeric[1].length);
          add({ key: block.key, group, label: group === block.key ? label : `${block.key} / ${label}`,
            kind: number.test(text) ? 'number' : 'string', value: text, start: at, end: at + text.length });
        }
        continue;
      }
      const kind = number.test(value) ? 'number' : /^(true|false)$/.test(value) ? 'boolean' : 'string';
      add({ key: block.key, group: groupFor(block.key) ?? section, label: block.key, kind, value, start, end });
    }
  } else {
    const bom = content.startsWith('\uFEFF') ? 1 : 0, source = content.slice(bom);
    if (format === 'json') {
      try { JSON.parse(source); } catch { throw invalid('请先在源码中修正 JSON 语法，再编辑字段。'); }
    }
    const parsed = parseDocument(source, { keepSourceTokens: true, intAsBigInt: true, uniqueKeys: format !== 'json' });
    if (parsed.errors.length) throw invalid('请先在源码中修正 YAML 语法，再编辑字段。');
    const visit = (node, keys = [], depth = 0, mediaReference = false) => {
      if (depth > 40) throw invalid('字段层级过深，请使用源码编辑。');
      // Aliases, anchors and custom tags are shared or specially typed values.
      // Do not silently turn them into unrelated plain scalars.
      if (!node || node.anchor || node.tag) { omitted++; return; }
      if (isMap(node)) {
        if (!node.items.length) omitted++;
        for (const pair of node.items) {
          if (!isScalar(pair.key) || pair.key.value === null || pair.key.anchor || pair.key.tag) { omitted++; continue; }
          visit(pair.value, [...keys, String(pair.key.value)], depth + 1,
            pair.key.value === 'src' && ['image', 'video', 'audio'].includes(node.get('type')) ? node.get('type') : false);
        }
      } else if (isSeq(node)) {
        if (!node.items.length) omitted++;
        node.items.forEach((value, index) => visit(value, [...keys, `[${index + 1}]`], depth + 1));
      } else if (isScalar(node) && node.range && ['string', 'number', 'bigint', 'boolean'].includes(typeof node.value)) {
        const kind = typeof node.value === 'bigint' ? 'number' : typeof node.value;
        const start = node.range[0] + bom, end = node.range[1] + bom;
        const raw = content.slice(start, end);
        const value = kind === 'number' && number.test(raw) ? raw : String(node.value);
        add({ key: keys[0] || '', group: groupFor(keys[0]) ?? (keys.length > 1 ? keys[0] : ''),
          label: keys.length > 1 ? keys.slice(1).join(' / ') : keys[0] || '$', kind, value, start, end, mediaReference,
          // A block scalar consumes its final line break. Keep the following key on a new line.
          suffix: raw.match(/(?:\r\n|\r|\n)$/)?.[0] || '' });
      } else omitted++;
    };
    visit(parsed.contents);
  }
  return { format, fields, omitted };
}
