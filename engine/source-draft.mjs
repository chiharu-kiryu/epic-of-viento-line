const normalizeNewlines = (text) => text.replace(/\r\n|\r/g, '\n');

// Textarea values always use LF. Keep the source's untouched lines byte-exact.
function serializeSourceDraft(source, value, preferredNewline) {
  const original = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) || [];
  const edited = normalizeNewlines(value).match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
  let start = 0;
  while (start < original.length && start < edited.length && normalizeNewlines(original[start]) === edited[start]) start += 1;
  let end = 0;
  while (end < original.length - start && end < edited.length - start
    && normalizeNewlines(original[original.length - 1 - end]) === edited[edited.length - 1 - end]) end += 1;
  const newline = source.match(/\r\n|\r|\n/)?.[0] || preferredNewline || '\n';
  return original.slice(0, start).join('')
    + edited.slice(start, edited.length - end).join('').replace(/\n/g, newline)
    + original.slice(original.length - end).join('');
}

function blockType(text) {
  if (/^\s*(`{3,}|~{3,})/.test(text)) return 'code';
  if (/^\s*(?:!audio|!video|!)\[/.test(text)) return 'media';
  if (/^#{1,6}\s/.test(text)) return 'heading';
  if (/^\s*(?:[-*+] |\d+[.)] )/.test(text)) return 'list';
  if (/^\s*\|/.test(text)) return 'table';
  if (!text.includes('\n') && /^[^：:]+[：:]/.test(text)) return 'kv';
  return 'text';
}

// Editing must use the current source, never the lossy display/index parser.
function createBlockDraft(source = '') {
  const blocks = [];
  let prefix = '';
  let body = '';
  let fence = null;
  const flush = () => {
    if (!body) return;
    const ending = body.match(/(?:\r\n|\r|\n)$/)?.[0] || '';
    const original = ending ? body.slice(0, -ending.length) : body;
    const value = normalizeNewlines(original);
    blocks.push({ type: blockType(value), prefix, original, value, ending });
    prefix = '';
    body = '';
  };
  for (const line of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []) {
    if (!line) continue;
    if (!fence && /^[\t ]*(?:\r\n|\r|\n)$/.test(line)) {
      flush();
      prefix += line;
      continue;
    }
    body += line;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
  }
  flush();
  if (!blocks.length) {
    blocks.push({ type: 'text', prefix, original: '', value: '', ending: '' });
    prefix = '';
  }
  return {
    blocks,
    trailing: prefix,
    newline: source.match(/\r\n|\r|\n/)?.[0] || '\n',
  };
}

function serializeBlockDraft(draft, values = draft.blocks.map((block) => block.value)) {
  return draft.blocks.map((block, index) => {
    const value = values[index] ?? block.value;
    const content = value === block.value ? block.original : normalizeNewlines(value).replace(/\n/g, draft.newline);
    return block.prefix + content + block.ending;
  }).join('') + draft.trailing;
}

export { createBlockDraft, serializeBlockDraft, serializeSourceDraft };
