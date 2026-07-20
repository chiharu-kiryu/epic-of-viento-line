import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const args = process.argv.slice(2).filter((arg) => arg && !arg.startsWith('-'));
const options = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('-')));
const STANDARD_ROOT = path.join(PROJECT_ROOT, args[0] || 'docs-standard');
const STRICT_MODE = options.has('--strict');
const SKIP_DIRS = new Set(['.git', '.DS_Store', 'node_modules', '.tmp']);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function isTextFileLike(fileName) {
  return fileName.endsWith('.json');
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) && value === d.toISOString();
}

function missing(value) {
  return value === undefined || value === null || value === '';
}

function addIssue(issues, relPath, type, message, detail) {
  issues.push({
    file: relPath,
    type,
    message,
    detail,
  });
}

function validateDocument(doc, relPath) {
  const issues = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    addIssue(issues, relPath, 'fatal', 'document-not-object', '文件内容不是对象 JSON');
    return issues;
  }

  if (typeof doc.schemaVersion !== 'string' || !doc.schemaVersion.trim()) {
    addIssue(issues, relPath, 'schema', '缺少 schemaVersion', doc.schemaVersion);
  } else if (STRICT_MODE && doc.schemaVersion !== 'standard-doc-v2') {
    addIssue(issues, relPath, 'schema', 'schemaVersion 非预期值', doc.schemaVersion);
  }

  if (!doc.source || typeof doc.source !== 'object') {
    addIssue(issues, relPath, 'source', 'source 缺失');
  } else {
    if (typeof doc.source.path !== 'string' || !doc.source.path.trim()) {
      addIssue(issues, relPath, 'source', 'source.path 缺失', doc.source.path);
    }
    if (typeof doc.source.extension !== 'string') {
      addIssue(issues, relPath, 'source', 'source.extension 缺失');
    }
    if (!isFiniteNumber(doc.source.size) || doc.source.size < 0) {
      addIssue(issues, relPath, 'source', 'source.size 非法', doc.source.size);
    }
    if (!isIsoDate(doc.source.modifiedAt)) {
      addIssue(issues, relPath, 'source', 'source.modifiedAt 非法', doc.source.modifiedAt);
    }
  }

  if (!doc.meta || typeof doc.meta !== 'object') {
    addIssue(issues, relPath, 'meta', 'meta 缺失');
  } else {
    if (!doc.meta.title || typeof doc.meta.title !== 'string') {
      addIssue(issues, relPath, 'meta', 'meta.title 缺失');
    }
    if (!doc.meta.category || typeof doc.meta.category !== 'string') {
      addIssue(issues, relPath, 'meta', 'meta.category 缺失');
    }
    if (!doc.meta.group || typeof doc.meta.group !== 'string') {
      addIssue(issues, relPath, 'meta', 'meta.group 缺失');
    }
  }

  if (!doc.parser || typeof doc.parser !== 'object') {
    addIssue(issues, relPath, 'parser', 'parser 缺失');
  } else {
    if (!doc.parser.contentType || typeof doc.parser.contentType !== 'string') {
      addIssue(issues, relPath, 'parser', 'parser.contentType 缺失');
    }
    if (!doc.parser.format || typeof doc.parser.format !== 'string') {
      addIssue(issues, relPath, 'parser', 'parser.format 缺失');
    }
    if (!Number.isInteger(doc.parser.lineCount) || doc.parser.lineCount < 0) {
      addIssue(issues, relPath, 'parser', 'parser.lineCount 非法', doc.parser.lineCount);
    }
    if (!Number.isInteger(doc.parser.fieldCount) || doc.parser.fieldCount < 0) {
      addIssue(issues, relPath, 'parser', 'parser.fieldCount 非法', doc.parser.fieldCount);
    }
    if (!Number.isInteger(doc.parser.blockCount) || doc.parser.blockCount < 0) {
      addIssue(issues, relPath, 'parser', 'parser.blockCount 非法', doc.parser.blockCount);
    }
  }

  if (!doc.fields || typeof doc.fields !== 'object' || Array.isArray(doc.fields)) {
    addIssue(issues, relPath, 'fields', 'fields 必须是对象');
  }
  if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
    addIssue(issues, relPath, 'sections', 'sections 不能为空数组');
  }
  if (!Array.isArray(doc.blocks) || doc.blocks.length === 0) {
    addIssue(issues, relPath, 'blocks', 'blocks 不能为空数组');
  }
  if (!Array.isArray(doc.outline) || doc.outline.length === 0) {
    addIssue(issues, relPath, 'outline', 'outline 不能为空数组');
  }

  if (STRICT_MODE) {
    if (!doc.parserStats || typeof doc.parserStats !== 'object' || Array.isArray(doc.parserStats)) {
      addIssue(issues, relPath, 'parserStats', 'strict: parserStats 必须为对象');
    } else {
      const expected = ['blockCount', 'headingCount', 'paragraphCount', 'listCount', 'tableCount', 'kvCount'];
      for (const key of expected) {
        const value = doc.parserStats[key];
        if (!Number.isInteger(value) || value < 0) {
          addIssue(issues, relPath, 'parserStats', `strict: parserStats.${key} 非法`, value);
        }
      }
    }

    if (!doc.raw || typeof doc.raw !== 'string') {
      addIssue(issues, relPath, 'raw', 'strict: raw 缺失');
    }
    if (STRICT_MODE && (!doc.rawPath || typeof doc.rawPath !== 'string' || !doc.rawPath.trim())) {
      addIssue(issues, relPath, 'rawPath', 'strict: rawPath 缺失');
    }
  }

  if (STRICT_MODE && doc.rawPath) {
    const expected = path.join(PROJECT_ROOT, doc.source?.path || '');
    const rawExists = fsSync.existsSync(expected);
    if (!rawExists) {
      addIssue(issues, relPath, 'rawPath', 'strict: rawPath 未指向真实源文件', doc.rawPath);
    }
  }

  if (STRICT_MODE && doc.blocks && doc.blocks.length) {
    const invalidBlocks = doc.blocks.filter((block) => !block || typeof block !== 'object');
    if (invalidBlocks.length > 0) {
      addIssue(issues, relPath, 'blocks', 'strict: 存在非对象 block', invalidBlocks.length);
    }
  }

  return issues;
}

async function walkFiles(rootDir, relativeBase = '') {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const absolute = path.join(rootDir, entry.name);
    const relative = toPosix(path.join(relativeBase, entry.name));

    if (entry.isDirectory()) {
      const nested = await walkFiles(absolute, relative);
      out.push(...nested);
      continue;
    }
    if (!entry.isFile() || !isTextFileLike(entry.name)) {
      continue;
    }
    out.push(relative);
  }

  return out;
}

async function main() {
  const exists = fsSync.existsSync(STANDARD_ROOT);
  if (!exists) {
    console.error(`目录不存在: ${STANDARD_ROOT}`);
    process.exit(1);
  }

  const files = await walkFiles(STANDARD_ROOT);
  const summary = {
    total: files.length,
    failed: 0,
    byType: {},
    issues: [],
  };

  for (const relPath of files) {
    const absolutePath = path.join(STANDARD_ROOT, relPath);
    let parsed;
    try {
      const raw = await fs.readFile(absolutePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (error) {
      summary.failed += 1;
      addIssue(summary.issues, relPath, 'json', '文件不是合法 JSON', error.message);
      continue;
    }

    const issues = validateDocument(parsed, relPath);
    if (issues.length > 0) {
      summary.failed += 1;
      summary.issues.push(...issues);
      for (const issue of issues) {
        summary.byType[issue.type] = (summary.byType[issue.type] || 0) + 1;
      }
    }
  }

  if (summary.failed > 0) {
    console.error(`校验失败: 共 ${summary.total} 个文件中有 ${summary.failed} 个文件不合规。`);
    if (!STRICT_MODE) {
      console.error('建议使用 --strict 获取更严格策略。');
    }
    for (const issue of summary.issues) {
      const detail = missing(issue.detail) ? '' : `: ${String(issue.detail)}`;
      console.error(`[${issue.type}] ${issue.file} -> ${issue.message}${detail}`);
    }
    process.exit(1);
  }

  console.log(`校验通过: 共 ${summary.total} 个文件，strict=${STRICT_MODE ? 'on' : 'off'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
