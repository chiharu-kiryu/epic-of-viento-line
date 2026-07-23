#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const DATA_TEMPLATE_DIR = path.join(PROJECT_ROOT, 'data-template');
const STANDARD_ROOT = path.join(PROJECT_ROOT, 'docs-standard');
const TYPE_TEMPLATE_FILE = path.join(PROJECT_ROOT, 'web/modules/app-type-templates.js');
const MIN_DOC_FREQUENCY = 2;
const SKIP_TEMPLATE_SOURCE_DIRS = new Set(['.', '..', '.DS_Store']);
const STRICT_MODE = process.argv.includes('--strict');

const DATA_TEMPLATE_DIR_TO_CATEGORY = {
  'design-heros': 'hero',
  'design-item': 'item',
  'design-units': 'unit',
  'design-building': 'building',
  'design-skills': 'skill',
  'backstory': 'backstory',
  'design-scenes': 'scene',
  'design-rules': 'rule',
  'design-template': 'template',
};

function toPosix(filePath) {
  return (filePath || '').split(path.sep).join('/');
}

function readModuleTemplateDefs() {
  const content = fs.readFileSync(TYPE_TEMPLATE_FILE, 'utf8');
  const entries = new Map();
  const matcher = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*{[\s\S]*?templateSource\s*:\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = matcher.exec(content)) !== null) {
    const category = match[1];
    const templateSource = match[2];
    entries.set(category, {
      category,
      templateSource,
    });
  }

  return entries;
}

function parseTemplateFields(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const keys = new Set();
  const nestedHints = new Set([
    '名称',
    '类型',
    '描述',
    '施法距离',
    '作用范围',
    '持续时间',
    '冷却',
    '魔力消耗',
    '形态',
    '分支',
    '附加效果',
    '子技能',
    '参数名',
    '参数值',
    '效果',
    '背景',
    '背景描述',
    '物品描述',
    '物品背景',
    '被动技能',
    '主动技能',
    '参数',
  ]);
  const ignored = new Set([
    '当前模板目录提供两份基础模板',
    '建议在模板目录提供两份基础模板',
    '建议在模板基础上补齐以下字段标签',
    '列表',
  ]);
  let inSection = false;

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (!trimmed) {
        inSection = false;
      }
      continue;
    }

    const line = trimmed
      .replace(/^[-*+]\s*/, '')
      .replace(/^\d+\.\s*/, '');

    const kv = line.match(/^(.+?)\s*[:：]\s*(.*)$/);
    if (!kv) {
      inSection = false;
      continue;
    }

    const key = kv[1].trim();
    if (!key || /^\d+$/.test(key) || ignored.has(key)) {
      inSection = false;
      continue;
    }
    if (inSection && nestedHints.has(key)) {
      continue;
    }

    keys.add(key);
    inSection = true;
  }

  return keys;
}

function collectTemplateSourceMap() {
  const dirs = fs.readdirSync(DATA_TEMPLATE_DIR, { withFileTypes: true });
  const entries = [];

  for (const dir of dirs) {
    if (!dir.isDirectory() || SKIP_TEMPLATE_SOURCE_DIRS.has(dir.name)) {
      continue;
    }

    const dirPath = path.join(DATA_TEMPLATE_DIR, dir.name);
    const files = fs.readdirSync(dirPath).filter((name) => name.includes('模板'));
    if (files.length === 0) {
      continue;
    }

    const sourceRelative = toPosix(path.join('data-template', dir.name, files[0]));
    const sourceAbsolute = path.join(PROJECT_ROOT, sourceRelative);

    entries.push({
      templateDir: dir.name,
      category: DATA_TEMPLATE_DIR_TO_CATEGORY[dir.name],
      sourceRelative,
      sourceAbsolute,
      sourceFields: parseTemplateFields(sourceAbsolute),
    });
  }

  return entries;
}

function collectStandardFieldStats() {
  const docsRoot = path.join(STANDARD_ROOT, 'design-data');
  const stats = new Map();
  const counts = new Map();

  const walk = (folder) => {
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          walk(absolute);
        }
        continue;
      }

      if (!entry.name.endsWith('.json')) {
        continue;
      }

      const raw = fs.readFileSync(absolute, 'utf8');
      const doc = JSON.parse(raw);
      const category = doc?.meta?.category || 'other';
      const fields = doc?.fields || {};

      const keyMap = stats.get(category) || new Map();
      for (const [key, value] of Object.entries(fields)) {
        if (key === '_header') {
          continue;
        }
        keyMap.set(key, (keyMap.get(key) || 0) + 1);
      }

      stats.set(category, keyMap);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  };

  walk(docsRoot);
  return { stats, counts };
}

function pickTop(list, maxCount = 12) {
  return list.slice(0, maxCount).map((item) => `${item.key}(${item.count})`).join('、');
}

function main() {
  const moduleDefs = readModuleTemplateDefs();
  const templateSourceMap = collectTemplateSourceMap();
  const { stats, counts } = collectStandardFieldStats();

  let hasError = false;
  let hasWarning = false;

  const reportLine = (level, message) => {
    if (level === 'ERROR') {
      hasError = true;
    } else if (level === 'WARN') {
      hasWarning = true;
    }
    console.log(`[${level}] ${message}`);
  };

  for (const { templateDir, category, sourceRelative, sourceAbsolute, sourceFields } of templateSourceMap) {
    if (!category) {
      reportLine('WARN', `data-template 目录未映射到标准类型: ${templateDir}`);
      continue;
    }

    const def = moduleDefs.get(category);
    if (!def) {
      reportLine('WARN', `app-type-templates.js 未包含分类: ${category} (data-template/${templateDir})`);
      continue;
    }

    if (!fs.existsSync(sourceAbsolute)) {
      reportLine('ERROR', `app-type-templates 映射文件不存在: ${sourceRelative}`);
      continue;
    }

    if (def.templateSource !== sourceRelative) {
      reportLine('WARN', `分类 ${category} 映射不一致：app-type-templates -> ${def.templateSource}，当前扫描到 ${sourceRelative}`);
    }

    const docCount = counts.get(category) || 0;
    if (docCount === 0) {
      reportLine('WARN', `标准化文档中 category=${category} 无数据，无法做字段对齐检查`);
      continue;
    }

    const fieldStats = stats.get(category) || new Map();
    const docFields = [...fieldStats.entries()]
      .map(([key, count]) => ({ key, count }))
      .filter((item) => item.count >= MIN_DOC_FREQUENCY)
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    const missingInTemplate = docFields.filter((item) => !sourceFields.has(item.key));
    if (missingInTemplate.length > 0) {
      const topMissing = pickTop(missingInTemplate);
      reportLine('WARN', `分类 ${category} 标准字段覆盖不足（出现频率>=${MIN_DOC_FREQUENCY}）：缺失 ${missingInTemplate.length} 个，示例: ${topMissing || '无'}`);
    }

    const unusedTemplateFields = [...sourceFields].filter((key) => !fieldStats.has(key));
    if (unusedTemplateFields.length > 0) {
      const topUnused = unusedTemplateFields.slice(0, 12).join('、');
      reportLine('WARN', `分类 ${category} 模板字段未在标准化字段中出现：${unusedTemplateFields.length} 个，示例: ${topUnused || '无'}`);
    }
  }

  for (const category of moduleDefs.keys()) {
    const def = moduleDefs.get(category);
    const source = def?.templateSource || '';
    if (!source) {
      reportLine('ERROR', `app-type-templates.js 中 ${category} 无 templateSource`);
      continue;
    }

    const normalized = source.split('/').join(path.sep);
    if (!fs.existsSync(path.join(PROJECT_ROOT, normalized))) {
      reportLine('ERROR', `app-type-templates.js 声明源不存在: ${source} (${category})`);
      continue;
    }

    if (!source.startsWith('data-template/')) {
      reportLine('WARN', `${category} 的 templateSource 非 data-template 路径: ${source}`);
    }
  }

  console.log('---');
  if (hasError) {
    console.log('结果：存在需要修复的映射错误。');
  } else if (hasWarning) {
    console.log('结果：检查通过（含告警，建议按上方建议修正）。');
  } else {
    console.log('结果：所有模板映射都正常。');
  }

  if (STRICT_MODE && (hasError || hasWarning)) {
    process.exitCode = 1;
    return;
  }
  if (hasError) {
    process.exitCode = 1;
  }
}

main();
