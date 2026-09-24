import { serializeSourceDraft } from './app-editor-draft.js';

export function fieldValueValid(field, value) {
  if (value === field.value || field.kind === 'string') return true;
  if (field.kind === 'boolean') return value === 'true' || value === 'false';
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim());
}

export function serializeFieldDraft(source, model, values) {
  // Apply from the end; duplicate names and nested keys retain independent spans.
  const patches = model.fields.map((field, index) => ({ field, value: values[index] ?? field.value }))
    .filter(({ field, value }) => value !== field.value).sort((a, b) => b.field.start - a.field.start);
  let output = source;
  for (const { field, value } of patches) {
    const replacement = model.format === 'text' ? serializeSourceDraft(source.slice(field.start, field.end), value, source.match(/\r\n|\r|\n/)?.[0])
      : (field.kind === 'string' ? JSON.stringify(value) : value.trim()) + (field.suffix || '');
    output = output.slice(0, field.start) + replacement + output.slice(field.end);
  }
  return output;
}
