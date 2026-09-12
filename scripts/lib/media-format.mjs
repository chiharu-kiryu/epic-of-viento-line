// Shared, data-only media syntax for the parser and the editor.
export const MEDIA_MAX_BYTES = 256 * 1024 * 1024;
export const MEDIA_EXTENSIONS = Object.freeze({ png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', svg: 'image', mp4: 'video', webm: 'video', mov: 'video' });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function mediaKindForName(name = '') {
  const extension = name.split('.').at(-1).toLowerCase();
  return Object.hasOwn(MEDIA_EXTENSIONS, extension) ? MEDIA_EXTENSIONS[extension] : '';
}

export function mediaUrl(source = '') {
  if (typeof source !== 'string') return '';
  const id = source.match(new RegExp(`^asset:(?:\\/\\/)?(${UUID})$`, 'i'));
  if (id) return `/asset-files/${id[1].toLowerCase()}`;
  if (new RegExp(`^/?asset-files/${UUID}$`, 'i').test(source)) return `/${source.replace(/^\//, '')}`;
  if (!/^\/?assets\//.test(source) || /[\\\x00-\x1f\x7f]/.test(source)) return '';
  try {
    const segments = source.replace(/^\//, '').split('/').map(decodeURIComponent);
    if (segments.some((part) => !part || part === '.' || part === '..' || /[/\\\x00-\x1f\x7f]/.test(part))) return '';
    return `/${segments.map(encodeURIComponent).join('/')}`;
  } catch { return ''; }
}

export function isMediaValue(value) {
  return !!value && typeof value === 'object' && ['image', 'video'].includes(value.type) && !!mediaUrl(value.src);
}

export function splitMediaText(text = '') {
  const result = [];
  const pattern = /(!video|!)\[((?:\\.|[^\]\\\n])*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))\s*\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const src = match[3] || match[4];
    if (!mediaUrl(src)) continue;
    if (match.index > cursor) result.push({ type: 'paragraph', text: text.slice(cursor, match.index) });
    result.push({ type: match[1] === '!video' ? 'video' : 'image', src, caption: match[2].replace(/\\([\\\[\]])/g, '$1') });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) result.push({ type: 'paragraph', text: text.slice(cursor) });
  return result;
}

export function mediaMarkup(asset) {
  const caption = String(asset.name || '').replace(/[\r\n]+/g, ' ').replace(/[\\\[\]]/g, '\\$&');
  return `${asset.kind === 'video' ? '!video' : '!'}[${caption}](asset:${asset.id})`;
}
