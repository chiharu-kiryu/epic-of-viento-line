// Source paths are project-relative identifiers using '/', never native paths
// or Android document URIs. The platform adapter resolves them to its handles.
export function sourceFileName(value) {
  return value.replace(/\/+$/, '').split('/').at(-1);
}

export function sourceExtension(value) {
  const name = sourceFileName(value);
  const at = name.lastIndexOf('.');
  return at > 0 && name !== '..' ? name.slice(at) : '';
}

export function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !value || /[\\\0]/.test(value)
    || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return '';
  const segments = value.split('/').filter((part) => part && part !== '.');
  if (segments.includes('..')) return '';
  const normalized = segments.join('/');
  return normalized.startsWith('.') ? '' : normalized;
}
