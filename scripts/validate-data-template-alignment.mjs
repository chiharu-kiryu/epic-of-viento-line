#!/usr/bin/env node
// Templates are optional starting documents. Their fields do not constrain OC
// content; the same parser/layout contract validates templates and source data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPLICATION_ROOT, DATA_TEMPLATE_ROOT } from './lib/paths.mjs';
import { parseSourceContent } from './standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from './standardize-docs/layout.mjs';
import { collectFilesRecursive } from './lib/scan-files.mjs';

async function main() {
  const { DOC_TYPE_TEMPLATE_DEFS } = await import(pathToFileURL(path.join(APPLICATION_ROOT, 'web/modules/app-type-templates.js')).href);
  const inputs = Object.entries(DOC_TYPE_TEMPLATE_DEFS)
    .filter(([, definition]) => typeof definition.content === 'string')
    .map(([type, definition]) => ({ name: `builtin/${type}.md`, content: definition.content }));
  const exists = await fs.stat(DATA_TEMPLATE_ROOT).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (exists) {
    for (const file of await collectFilesRecursive(DATA_TEMPLATE_ROOT)) {
      if (file.split('/').some((part) => part.startsWith('.')) || !['', '.md', '.txt', '.json', '.yaml', '.yml'].includes(path.extname(file).toLowerCase())) continue;
      inputs.push({ name: file, content: await fs.readFile(path.join(DATA_TEMPLATE_ROOT, file), 'utf8') });
    }
  }
  for (const input of inputs) {
    const parsed = parseSourceContent(input.content, input.name, { parserProfile: 'structured' });
    if (parsed.parseError) throw new Error(`模板解析失败 ${input.name}: ${parsed.parseError}`);
    const layout = buildDocumentLayout(parsed);
    if (!layout.sections.length) throw new Error(`模板没有可用的文档布局：${input.name}`);
  }
  console.log(`模板解析检查通过：${inputs.length} 份；自定义字段不受类型模板限制。`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
