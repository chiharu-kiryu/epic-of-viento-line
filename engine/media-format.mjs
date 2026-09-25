// Shared, data-only media syntax for the parser and the editor.
export const MEDIA_MAX_BYTES = 256 * 1024 * 1024;
export const MEDIA_KINDS = Object.freeze(['image', 'video', 'audio']);
export const MEDIA_EXTENSIONS = Object.freeze({
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
});
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function mediaKindForName(name = '') {
  const extension = name.match(/\.([^./\\]+)$/)?.[1].toLowerCase() || '';
  return Object.hasOwn(MEDIA_EXTENSIONS, extension) ? MEDIA_EXTENSIONS[extension] : '';
}

export function mediaUrl(source = '') {
  if (typeof source !== 'string') return '';
  const id = source.match(new RegExp(`^asset:(?:\\/\\/)?(${UUID})$`, 'i'));
  if (id) return `/asset-files/${id[1].toLowerCase()}`;
  const fileId = source.match(new RegExp(`^/?asset-files/(${UUID})$`, 'i'));
  if (fileId) return `/asset-files/${fileId[1].toLowerCase()}`;
  if (!/^\/?assets\//.test(source) || /[\\\x00-\x1f\x7f]/.test(source)) return '';
  try {
    const segments = source.replace(/^\//, '').split('/').map(decodeURIComponent);
    if (segments.some((part) => !part || part === '.' || part === '..' || /[/\\\x00-\x1f\x7f]/.test(part))) return '';
    return `/${segments.map(encodeURIComponent).join('/')}`;
  } catch { return ''; }
}

export function isMediaValue(value) {
  return !!value && typeof value === 'object' && MEDIA_KINDS.includes(value.type) && !!mediaUrl(value.src);
}

export function splitMediaText(text = '') {
  const result = [];
  const pattern = /(!audio|!video|!)\[((?:\\.|[^\]\\\n])*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))\s*\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const src = match[3] || match[4];
    if (!mediaUrl(src)) continue;
    if (match.index > cursor) result.push({ type: 'paragraph', text: text.slice(cursor, match.index) });
    result.push({ type: match[1] === '!' ? 'image' : match[1].slice(1), src, caption: match[2].replace(/\\([\\\[\]])/g, '$1') });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) result.push({ type: 'paragraph', text: text.slice(cursor) });
  return result;
}

// Read parser values instead of scanning source syntax: code fences and YAML
// comments are not references, while nested fields and lists can contain media.
export function collectDocumentMedia(blocks = []) {
  const urls = new Set(), text = [], visited = new WeakSet();
  const declaredId = new RegExp(`(?:^|[^\\w:/-])(asset:(?:\\/\\/)?${UUID})(?![\\w-])`, 'gi');
  function visit(value) {
    if (typeof value === 'string') {
      text.push(value);
      for (const part of splitMediaText(value)) if (isMediaValue(part)) urls.add(mediaUrl(part.src));
      for (const match of value.matchAll(declaredId)) urls.add(mediaUrl(match[1]));
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (isMediaValue(value)) { urls.add(mediaUrl(value.src)); return; }
    for (const item of Object.values(value)) visit(item);
  }
  for (const block of blocks) {
    if (block?.type === 'code') continue;
    // The generic text parser represents a standalone asset:UUID declaration
    // as a key/value field. Preserve that existing reference syntax as well.
    if (block?.type === 'kv' && typeof block.value === 'string') {
      const url = mediaUrl(`${block.key}:${block.value.trim()}`);
      if (url) urls.add(url);
    }
    visit(block);
  }
  return { urls: [...urls], text: text.join('\n') };
}

export function mediaMarkup(asset) {
  const caption = String(asset.name || '').replace(/[\r\n]+/g, ' ').replace(/[\\\[\]]/g, '\\$&');
  return `${asset.kind === 'image' ? '!' : `!${asset.kind}`}[${caption}](asset:${asset.id})`;
}
