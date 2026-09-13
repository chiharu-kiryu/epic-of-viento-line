import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, STANDARD_ROOT as DEFAULT_STANDARD_ROOT, toPosix } from './lib/paths.mjs';
import { collectFilesRecursive, DEFAULT_SKIP_DIRS } from './lib/scan-files.mjs';

const args = process.argv.slice(2).filter((arg) => arg && !arg.startsWith('-'));
const options = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('-')));
const STANDARD_ROOT = args[0] ? path.join(PROJECT_ROOT, args[0]) : DEFAULT_STANDARD_ROOT;
const STRICT_MODE = options.has('--strict');
const COMPAT_MODE = options.has('--compat') || options.has('--loose');

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

function addIssue(issues, relPath, type, message, detail, severity = 'error') {
  issues.push({
    file: relPath,
    type,
    message,
    detail,
    severity,
  });
}

function maybeWarn(severity) {
  if (!COMPAT_MODE && !STRICT_MODE) {
    return 'error';
  }
  return severity;
}

function validateDocument(doc, relPath) {
  const issues = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    addIssue(issues, relPath, 'fatal', 'document-not-object', '文件内容不是对象 JSON');
    return issues;
  }

  if (typeof doc.schemaVersion !== 'string' || !doc.schemaVersion.trim()) {
    addIssue(
      issues,
      relPath,
      'schema',
      '缺少 schemaVersion',
      doc.schemaVersion,
      maybeWarn('warn')
    );
  } else if (STRICT_MODE && doc.schemaVersion !== 'standard-doc-v2') {
    addIssue(issues, relPath, 'schema', 'schemaVersion 非预期值', doc.schemaVersion, 'error');
  }

  if (!doc.source || typeof doc.source !== 'object') {
    addIssue(issues, relPath, 'source', 'source 缺失', undefined, maybeWarn('warn'));
  } else {
    if (typeof doc.source.path !== 'string' || !doc.source.path.trim()) {
      addIssue(issues, relPath, 'source', 'source.path 缺失', doc.source.path, maybeWarn('warn'));
    }
    if (typeof doc.source.extension !== 'string') {
      addIssue(issues, relPath, 'source', 'source.extension 缺失', undefined, maybeWarn('warn'));
    }
    if (!isFiniteNumber(doc.source.size) || doc.source.size < 0) {
      addIssue(issues, relPath, 'source', 'source.size 非法', doc.source.size, maybeWarn('warn'));
    }
    if (!isIsoDate(doc.source.modifiedAt)) {
      addIssue(issues, relPath, 'source', 'source.modifiedAt 非法', doc.source.modifiedAt, maybeWarn('warn'));
    }
  }

  if (!doc.meta || typeof doc.meta !== 'object') {
    addIssue(issues, relPath, 'meta', 'meta 缺失', undefined, maybeWarn('warn'));
  } else {
    if (!doc.meta.title || typeof doc.meta.title !== 'string') {
      addIssue(issues, relPath, 'meta', 'meta.title 缺失', undefined, maybeWarn('warn'));
    }
    if (!doc.meta.category || typeof doc.meta.category !== 'string') {
      addIssue(issues, relPath, 'meta', 'meta.category 缺失', undefined, maybeWarn('warn'));
    }
    if (!doc.meta.group || typeof doc.meta.group !== 'string') {
      addIssue(issues, relPath, 'meta', 'meta.group 缺失', undefined, maybeWarn('warn'));
    }
  }

  if (!doc.parser || typeof doc.parser !== 'object') {
    addIssue(issues, relPath, 'parser', 'parser 缺失', undefined, maybeWarn('warn'));
  } else {
    if (!doc.parser.contentType || typeof doc.parser.contentType !== 'string') {
      addIssue(issues, relPath, 'parser', 'parser.contentType 缺失', undefined, maybeWarn('warn'));
    }
    if (!doc.parser.format || typeof doc.parser.format !== 'string') {
      addIssue(issues, relPath, 'parser', 'parser.format 缺失', undefined, maybeWarn('warn'));
    }
    if (!Number.isInteger(doc.parser.lineCount) || doc.parser.lineCount < 0) {
      addIssue(issues, relPath, 'parser', 'parser.lineCount 非法', doc.parser.lineCount, maybeWarn('warn'));
    }
    if (!Number.isInteger(doc.parser.fieldCount) || doc.parser.fieldCount < 0) {
      addIssue(issues, relPath, 'parser', 'parser.fieldCount 非法', doc.parser.fieldCount, maybeWarn('warn'));
    }
    if (!Number.isInteger(doc.parser.blockCount) || doc.parser.blockCount < 0) {
      addIssue(issues, relPath, 'parser', 'parser.blockCount 非法', doc.parser.blockCount, maybeWarn('warn'));
    }
  }

  if (!doc.fields || typeof doc.fields !== 'object' || Array.isArray(doc.fields)) {
    addIssue(issues, relPath, 'fields', 'fields 必须是对象', undefined, maybeWarn('warn'));
  }
  if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
    addIssue(issues, relPath, 'sections', 'sections 不能为空数组', undefined, maybeWarn('warn'));
  }
  if (!Array.isArray(doc.blocks) || doc.blocks.length === 0) {
    addIssue(issues, relPath, 'blocks', 'blocks 不能为空数组', undefined, maybeWarn('warn'));
  }
  if (!Array.isArray(doc.outline) || doc.outline.length === 0) {
    addIssue(issues, relPath, 'outline', 'outline 不能为空数组', undefined, maybeWarn('warn'));
  }

  if (STRICT_MODE) {
    if (doc.layout !== undefined) {
      const layout = doc.layout;
      const ids = new Set();
      if (layout?.schemaVersion !== 'viento-layout-v1' || !Array.isArray(layout.sections)) {
        addIssue(issues, relPath, 'layout', '解析器布局结构无效');
      } else for (const section of layout.sections) {
        if (!section || typeof section.id !== 'string' || !section.id || ids.has(section.id)
          || typeof section.title !== 'string' || !Number.isInteger(section.level) || section.level < 1 || section.level > 6
          || !Array.isArray(section.blocks) || section.blocks.some((block) => !['kv', 'paragraph', 'list', 'table', 'code', 'json', 'image', 'video', 'audio'].includes(block?.type))) {
          addIssue(issues, relPath, 'layout', '解析器布局分节无效', section?.id);
        }
        ids.add(section?.id);
      }
    }
    if (doc.parser?.contentType?.startsWith('invalid-')) {
      addIssue(issues, relPath, 'parser', '源文档格式解析失败', doc.parser.error || doc.parser.contentType);
    }
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

    if (typeof doc.raw !== 'string') {
      addIssue(issues, relPath, 'raw', 'strict: raw 缺失');
    }
    if (STRICT_MODE && (!doc.rawPath || typeof doc.rawPath !== 'string' || !doc.rawPath.trim())) {
      addIssue(issues, relPath, 'rawPath', 'strict: rawPath 缺失');
    }
  }

  if (STRICT_MODE && doc.rawPath) {
    const expected = path.join(PROJECT_ROOT, toPosix(doc.source?.path || ''));
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

async function main() {
  const exists = fsSync.existsSync(STANDARD_ROOT);
  if (!exists) {
    console.error(`目录不存在: ${STANDARD_ROOT}`);
    process.exit(1);
  }

  const files = await collectFilesRecursive(STANDARD_ROOT, {
    relativeBase: '',
    skipDirs: DEFAULT_SKIP_DIRS,
    acceptedExtensions: new Set(['.json']),
  });
  const summary = {
    total: files.length,
    failed: 0,
    warnings: 0,
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
      const severity = COMPAT_MODE ? 'warn' : 'error';
      const issue = {
        file: relPath,
        type: 'json',
        message: '文件不是合法 JSON',
        detail: error.message,
        severity,
      };
      summary.issues.push(issue);
      if (severity === 'error') {
        summary.failed += 1;
      } else {
        summary.warnings += 1;
      }
      summary.byType.json = (summary.byType.json || 0) + 1;
      continue;
    }

    const issues = validateDocument(parsed, relPath);
    if (issues.length > 0) {
      let docHasError = false;
      for (const issue of issues) {
        summary.issues.push(issue);
        summary.byType[issue.type] = (summary.byType[issue.type] || 0) + 1;
        if (issue.severity === 'error') {
          docHasError = true;
        } else {
          summary.warnings += 1;
        }
      }
      if (docHasError) {
        summary.failed += 1;
      }
    }
  }

  if (summary.failed > 0) {
    console.error(`校验失败: 共 ${summary.total} 个文件中有 ${summary.failed} 个文件不合规。`);
    for (const issue of summary.issues) {
      const detail = missing(issue.detail) ? '' : `: ${String(issue.detail)}`;
      const prefix = issue.severity === 'warn' ? '[WARN]' : '[ERROR]';
      console.error(`${prefix} [${issue.type}] ${issue.file} -> ${issue.message}${detail}`);
    }
    process.exit(1);
  }

  const modeLabel = STRICT_MODE ? 'strict' : COMPAT_MODE ? 'compat' : 'normal';
  if (summary.warnings > 0) {
    console.log(`校验通过: 共 ${summary.total} 文件，mode=${modeLabel}，warning=${summary.warnings}`);
  } else {
    console.log(`校验通过: 共 ${summary.total} 文件，mode=${modeLabel}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
