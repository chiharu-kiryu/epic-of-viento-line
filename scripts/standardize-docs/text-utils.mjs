export const normalizeValue = (value) => (value ?? '').toString().trim();
export const trimName = (name = '') => name.replace(/\.(md|txt|json|ya?ml)$/i, '');

export function toSlug(value, fallback = 'section') {
  return (value || '').trim().toLowerCase().normalize('NFKD')
    .replace(/[^\u4e00-\u9fff\w\s\-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || fallback;
}
