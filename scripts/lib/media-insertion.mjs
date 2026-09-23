import path from 'node:path';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { readRegistry, readWorkspace } from './workspace.mjs';
import { resolveDocumentDefinition } from './project-layout.mjs';
import { MEDIA_KINDS, isMediaValue, splitMediaText } from './media-format.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';

const invalid = (message) => Object.assign(new Error(message), { statusCode: 400, errorCode: 'media_insertion_invalid' });

// Patch the source ranges instead of serializing the user's whole JSON/YAML.
// Existing values, comments, BOM and line endings remain byte-for-byte intact.
export function insertStructuredMedia(source, extension, media) {
  if (source.startsWith('\uFEFF')) return '\uFEFF' + insertStructuredMedia(source.slice(1), extension, media);
  const json = extension === '.json';
  if (json && source.trim()) {
    try { JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw invalid('请先修正 JSON 语法，再插入素材。'); }
  }
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length) throw invalid('请先修正 YAML 语法，再插入素材。');
  const root = document.contents;
  const newline = source.match(/\r\n|\r|\n/)?.[0] || '\n';
  const entries = media.map((value) => JSON.stringify(value));
  if (!root || (isScalar(root) && root.value === null && root.source === '' && !root.tag && !root.anchor)) {
    // An empty YAML document may have directives, comments and an end marker.
    // Insert after its comments but before the marker; explicit scalar values
    // still require the user to choose an object or list first.
    const at = root?.range[2] ?? source.length;
    const prefix = source.slice(0, at);
    return prefix + (prefix && !/[\r\n]$/.test(prefix) ? newline : '')
      + (json ? JSON.stringify({ 媒体: media }, null, 2).replace(/\n/g, newline) + newline
        : `媒体:${newline}${entries.map((entry) => `  - ${entry}${newline}`).join('')}`) + source.slice(at);
  }
  if (!isMap(root) && !isSeq(root)) throw invalid('素材需要插入到对象或列表中，请先将当前文档整理为对象或列表。');
  let target = root;
  let key = '媒体';
  if (isMap(root)) {
    while (root.has(key) && !isSeq(root.get(key, true))) key += '附件';
    if (root.has(key)) target = root.get(key, true);
  }
  const addProperty = isMap(target);
  const value = addProperty ? `${JSON.stringify(key)}: [${entries.join(', ')}]` : entries.join(', ');
  const end = target.range[1];
  if (target.flow) {
    const close = target.srcToken.end.find((token) => ['flow-map-end', 'flow-seq-end'].includes(token.type)).offset;
    // Flow continuations must stay inside the surrounding YAML block.
    const indentation = ' '.repeat(target.srcToken.start.indent);
    let output = source.slice(0, close) + `${newline}${indentation}  ${value}${newline}${indentation}` + source.slice(close);
    const trailing = target.srcToken.items.at(-1);
    const hasComma = !trailing?.key && !trailing?.value && trailing?.start.some((token) => token.type === 'comma');
    if (target.items.length && !hasComma) {
      const last = target.items.at(-1);
      const node = isMap(target) ? last.value || last.key : last;
      const at = node.range?.[1];
      if (!Number.isInteger(at)) throw invalid('当前列表格式无法直接插入素材，请先将其展开为普通列表。');
      output = output.slice(0, at) + ',' + output.slice(at);
    }
    if (parseDocument(output).errors.length) throw invalid('当前列表格式无法直接插入素材，请先将其展开为普通列表。');
    return output;
  }
  const lineStart = source.lastIndexOf('\n', target.range[0] - 1) + 1;
  const indentation = source.slice(lineStart, target.range[0]).match(/^ */)[0];
  const inserted = (end && !/[\r\n]$/.test(source.slice(0, end)) ? newline : '')
    + (addProperty ? `${indentation}${key}:${newline}${entries.map((entry) => `${indentation}  - ${entry}${newline}`).join('')}`
      : entries.map((entry) => `${indentation}- ${entry}${newline}`).join(''));
  const output = source.slice(0, end) + inserted + source.slice(end);
  if (parseDocument(output).errors.length) throw invalid('当前列表格式无法直接插入素材，请先将其展开为普通列表。');
  return output;
}

function collectMedia(value, result = [], visited = new WeakSet()) {
  if (result.length >= 100) return result;
  if (value && typeof value === 'object') {
    if (visited.has(value)) return result;
    visited.add(value);
  }
  if (isMediaValue(value)) result.push({ type: value.type, src: value.src, caption: typeof value.caption === 'string' ? value.caption : '' });
  else if (typeof value === 'string') result.push(...splitMediaText(value).filter(isMediaValue));
  else if (Array.isArray(value)) value.forEach((child) => collectMedia(child, result, visited));
  else if (value && typeof value === 'object' && value.type !== 'code') {
    for (const child of Object.values(value)) collectMedia(child, result, visited);
  }
  return result;
}

export async function prepareMediaInsertion(root, { content, sourcePath, assetIds = [], documentType } = {}) {
  if (typeof content !== 'string' || typeof sourcePath !== 'string' || !Array.isArray(assetIds) || assetIds.length > 100) throw invalid('素材插入参数无效。');
  const registry = await readRegistry(root);
  const assets = assetIds.map((id) => {
    const asset = registry.assets.find((item) => item.id === id && MEDIA_KINDS.includes(item.kind));
    if (!asset) throw invalid('所选素材未登记，请刷新素材列表。');
    return { type: asset.kind, src: `asset:${asset.id}`, caption: asset.name };
  });
  const extension = path.extname(sourcePath).toLowerCase();
  let updated = content;
  if (assets.length) {
    if (!['.json', '.yaml', '.yml'].includes(extension)) throw invalid('此操作仅用于 JSON 或 YAML；正文素材应在光标处插入。');
    updated = insertStructuredMedia(content, extension, assets);
  }
  const record = registry.documents.find((record) => record.sourcePath === sourcePath);
  const descriptor = resolveDocumentDefinition(readWorkspace(root), sourcePath, record || (documentType ? { documentType } : {}));
  const parsed = parseSourceContent(updated, sourcePath, descriptor);
  return { content: updated, media: collectMedia(parsed.blocks).slice(0, 100) };
}
