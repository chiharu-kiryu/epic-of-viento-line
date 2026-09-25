import { isMediaValue, splitMediaText } from './media-format.mjs';

// The editor and exports show multi-line named/numeric values as separate rows.
// Ordinary prose, mixed lines and embedded media keep their original structure.
export function splitValueFields(value) {
  if (typeof value !== 'string' || splitMediaText(value).some(isMediaValue)) return null;
  const lines = value.split(/\r\n?|\n/).filter((line) => line.trim());
  if (lines.length < 2) return null;
  const pairs = lines.map((line) => {
    const named = line.trim().match(/^([^:：]+)[:：]\s*(.+)$/);
    if (named) return [named[1].trim(), named[2].trim()];
    const leading = line.trim().match(/^([+\-−]?\d\S*)\s+(.+)$/);
    return leading ? [leading[2], leading[1]] : null;
  });
  return pairs.every(Boolean) ? pairs : null;
}
