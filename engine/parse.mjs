import { sourceExtension } from './source-path.mjs';
import { parseJsonContent, parseTextContent, parseYamlContent } from './parser.mjs';
import { parserOptionsForSource } from './legacy-profile.mjs';

export function parseSourceContent(rawText, relPath, descriptor = {}) {
  const ext = sourceExtension(relPath).toLowerCase();
  let parsed;
  if (ext === '.json') {
    parsed = parseJsonContent(rawText, relPath);
  } else if (ext === '.yml' || ext === '.yaml') {
    parsed = parseYamlContent(rawText, relPath);
  } else parsed = parseTextContent(rawText, relPath, parserOptionsForSource(relPath, descriptor));
  const key = descriptor.parserOptions?.titleField;
  const title = key && Object.hasOwn(parsed.fields, key) ? parsed.fields[key] : undefined;
  if (['string', 'number', 'boolean'].includes(typeof title) && String(title).trim()) parsed.title = String(title);
  if (descriptor.fieldGroups?.length) parsed.fieldGroups = descriptor.fieldGroups;
  return parsed;
}
