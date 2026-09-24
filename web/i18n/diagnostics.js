import { t, uiMessage } from './index.js';
import { hasMessage } from './messages.js';

function descriptor(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object' || !hasMessage(value.key)
    || !Array.isArray(value.values) || value.values.length > 20) return null;
  const values = [];
  for (const item of value.values) {
    if (['string', 'number', 'boolean'].includes(typeof item) || item === null) values.push(item);
    else {
      const nested = descriptor(item, depth + 1);
      if (!nested) return null;
      values.push(nested);
    }
  }
  return uiMessage(value.key, ...values);
}

// Only server-designated UI descriptors are recursive. Raw diagnostics and
// document-derived arguments are never scanned or split to find translations.
export function diagnosticMessage(value, fallback = '') {
  return descriptor(value) || uiMessage(fallback);
}

export function translateDiagnostic(value, fallback = '') {
  return t(diagnosticMessage(value, fallback));
}
