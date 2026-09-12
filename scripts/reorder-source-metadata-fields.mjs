#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { DOC_ROOT, PROJECT_ROOT, toPosix } from './lib/paths.mjs';
import { collectFilesRecursive } from './lib/scan-files.mjs';

const CLI_ARGS = process.argv.slice(2).filter((value) => value.trim() !== '');
const WRITE = CLI_ARGS.includes('--write');
const SHOW_HELP = CLI_ARGS.includes('-h') || CLI_ARGS.includes('--help');
const FORCE_FULL_SCAN = CLI_ARGS.includes('--all');

// This operation moves text field blocks. Structured formats must not be split
// by line: moving JSON properties this way can leave commas in invalid positions.
const ACCEPTED_EXTENSIONS = new Set(['', '.md', '.txt']);

const DEFAULT_TARGET_ROOTS = [
  'design-item',
  'design-units',
  'design-building',
].map((dir) => path.join(DOC_ROOT, 'design-' + dir.replace('design-', '')));

const FIELD_ORDER_RULES = {
  'design-item': ['属性', '价格'],
  'design-units': ['攻击间隔', '回血'],
  'design-building': ['攻击间隔', '回血'],
};
const KNOWN_CATEGORIES = Object.keys(FIELD_ORDER_RULES);

const KEY_RE = /^([^：:]{1,80})\s*[:：]\s*(.*?)$/;

const LABEL_NORMALIZATION = new Map([
  ['价格', '价格'],
  ['属性', '属性'],
  ['攻击间隔', '攻击间隔'],
  ['回血', '回血'],
]);

function showUsage() {
  console.log('用法：');
  console.log('  node scripts/reorder-source-metadata-fields.mjs [--write] [--all] [路径1 路径2 ...]');
  console.log('  node scripts/reorder-source-metadata-fields.mjs [--write] --path 路径 [--path 路径 ...]');
  console.log('  node scripts/reorder-source-metadata-fields.mjs [--write] --type item|unit|building [其他参数...]');
  console.log('');
  console.log('参数：');
  console.log('  --write          将修正写回原文件；缺省仅扫描并输出待改列表');
  console.log('  --all            额外扫描默认目录（设计数据）');
  console.log('  --path, -p       指定手动文件/目录，支持多个');
  console.log('  --type, -t       指定数据类型（可重复，可用逗号分隔）：item|unit|building');
  console.log('  --help, -h       显示本帮助');
  console.log('  --               结束参数解析，后续均视为路径');
  console.log('');
  console.log('说明：');
  console.log('  1) 不传路径：自动扫描 design-data 下 item/unit/building 的全部源文件；');
  console.log('  2) --all 与手动路径可叠加，手动传入新建文件路径或目录，加入扫描与回写；');
  console.log('  3) 若路径不在 item/unit/building 下会被忽略。');
  console.log('  4) 写回时会直接回写到原始文件，不会改写标准化产物。');
  console.log('  5) --type 用于限制扫描范围，不传则处理全部。');
  console.log('  6) 只排序无扩展名、.md 和 .txt 文本；JSON/YAML 保持原样。');
}

function resolvePath(raw) {
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function toCategory(filePath) {
  const rel = toPosix(path.relative(DOC_ROOT, filePath));
  if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
    return null;
  }

  if (rel.startsWith('design-item/')) {
    return 'design-item';
  }
  if (rel.startsWith('design-units/')) {
    return 'design-units';
  }
  if (rel.startsWith('design-building/')) {
    return 'design-building';
  }

  return null;
}

function parseArgs() {
  const explicitTargets = [];
  const pathArgs = [];
  const typeArgs = [];

  for (let i = 0; i < CLI_ARGS.length; i += 1) {
    const arg = CLI_ARGS[i];

    if (arg === '--') {
      explicitTargets.push(...CLI_ARGS.slice(i + 1));
      break;
    }

    if (arg === '--path' || arg === '-p' || arg === '--paths') {
      const next = CLI_ARGS[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`缺少路径参数：${arg}`);
      }
      pathArgs.push(next);
      i += 1;
      continue;
    }

    if (arg === '--type' || arg === '-t') {
      const next = CLI_ARGS[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`缺少类型参数：${arg}`);
      }
      typeArgs.push(next);
      i += 1;
      continue;
    }

    if (['--write', '--all', '--help', '-h'].includes(arg)) continue;
    if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);

    explicitTargets.push(arg);
  }

  return { explicitTargets, pathArgs, typeArgs };
}

function parseTypeFilter(rawTypeArgs = []) {
  if (rawTypeArgs.length === 0) {
    return KNOWN_CATEGORIES.slice();
  }

  const requested = new Set();
  for (const item of rawTypeArgs) {
    const tokens = String(item || '')
      .split(',')
      .map((token) => token.trim().toLowerCase());
    for (const token of tokens) {
      if (!token) {
        continue;
      }
      if (token === 'item' || token === 'unit' || token === 'building') {
        requested.add({ item: 'design-item', unit: 'design-units', building: 'design-building' }[token]);
        continue;
      }

      const normalized = token.startsWith('design-') ? token : `design-${token}`;
      if (KNOWN_CATEGORIES.includes(normalized)) {
        requested.add(normalized);
      } else {
        throw new Error(`无效的 --type 值：${token}，支持 item、unit、building`);
      }
    }
  }

  const allKnown = KNOWN_CATEGORIES.slice();
  if (requested.size === 0) {
    throw new Error('无效的 --type 值，支持 item、unit、building');
  }

  return allKnown.filter((category) => requested.has(category));
}

function normalizeLabel(line) {
  const match = line.match(KEY_RE);
  if (!match) {
    return null;
  }

  const rawKey = match[1].trim();
  return LABEL_NORMALIZATION.get(rawKey) || rawKey;
}

function splitSegments(lines) {
  const segments = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const label = normalizeLabel(line);

    if (label) {
      let end = index + 1;
      while (end < lines.length && !normalizeLabel(lines[end])) {
        end += 1;
      }
      segments.push({ label, lines: lines.slice(index, end) });
      index = end;
      continue;
    }

    let end = index + 1;
    while (end < lines.length && !normalizeLabel(lines[end])) {
      end += 1;
    }
    segments.push({ label: null, lines: lines.slice(index, end) });
    index = end;
  }

  return segments;
}

function moveFieldBefore(segs, firstLabel, secondLabel) {
  const firstIndex = segs.findIndex((seg) => seg.label === firstLabel);
  const secondIndex = segs.findIndex((seg) => seg.label === secondLabel);

  if (firstIndex === -1 || secondIndex === -1) {
    return false;
  }

  if (firstIndex < secondIndex) {
    return false;
  }

  const firstSeg = segs[firstIndex];
  const secondSeg = segs[secondIndex];
  const removeIndices = [firstIndex, secondIndex].sort((a, b) => b - a);

  for (const removeIndex of removeIndices) {
    segs.splice(removeIndex, 1);
  }

  const insertIndex = Math.min(firstIndex, secondIndex);
  segs.splice(insertIndex, 0, firstSeg, secondSeg);
  return true;
}

function rewriteBody(lines, category) {
  const rule = FIELD_ORDER_RULES[category];
  if (!rule || rule.length < 2) {
    return { changed: false, lines };
  }

  const [firstLabel, secondLabel] = rule;
  const output = [];
  let chunk = [];
  let changed = false;
  let fence = null;
  const flush = () => {
    const segments = splitSegments(chunk);
    changed = moveFieldBefore(segments, firstLabel, secondLabel) || changed;
    output.push(...segments.flatMap((segment) => segment.lines));
    chunk = [];
  };
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker || /^ {0,3}#{1,6}\s/.test(line)) {
      flush();
      output.push(line);
      if (marker) fence = marker[1];
    } else chunk.push(line);
  }
  flush();
  return { changed, lines: output };
}

async function collectFilesFromPaths(targetPaths = [], typeFilter = KNOWN_CATEGORIES) {
  const absoluteTargets = targetPaths.length === 0 ? DEFAULT_TARGET_ROOTS : targetPaths;
  const collected = [];

  for (const rawTarget of absoluteTargets) {
    const target = resolvePath(rawTarget);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const rels = await collectFilesRecursive(target, {
        relativeBase: '',
        acceptedExtensions: ACCEPTED_EXTENSIONS,
      });
      for (const rel of rels) {
        collected.push(path.join(target, rel));
      }
      continue;
    }

    if (stat.isFile()) {
      collected.push(target);
    }
  }

  const filtered = [];
  for (const filePath of collected) {
    const category = toCategory(filePath);
    if (!category) {
      continue;
    }

    if (!typeFilter.includes(category)) {
      continue;
    }

    if (!FIELD_ORDER_RULES[category]) {
      continue;
    }

    if (!ACCEPTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      continue;
    }

    filtered.push(filePath);
  }

  return [...new Set(filtered)];
}

async function loadManualTargets(pathsArg) {
  const collected = [];

  for (const rawTarget of pathsArg) {
    const target = resolvePath(rawTarget);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        const rels = await collectFilesRecursive(target, {
          relativeBase: '',
          acceptedExtensions: ACCEPTED_EXTENSIONS,
        });
        for (const rel of rels) {
          collected.push(path.join(target, rel));
        }
        continue;
      }
      if (stat.isFile()) {
        collected.push(target);
        continue;
      }
    } catch (error) {
      console.error(`路径不存在或不可读：${rawTarget}`);
    }
  }

  return collected;
}

function normalizeUniquePaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = (value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function main() {
  const { explicitTargets, pathArgs, typeArgs } = parseArgs();
  const typeFilter = parseTypeFilter(typeArgs);
  const manualTargets = normalizeUniquePaths([...explicitTargets, ...pathArgs]);

  if (SHOW_HELP) {
    showUsage();
    return;
  }

  const files = FORCE_FULL_SCAN || manualTargets.length === 0
    ? await collectFilesFromPaths([], typeFilter)
    : await collectFilesFromPaths(await loadManualTargets(manualTargets), typeFilter);

  const additionalFiles = manualTargets.length > 0
    ? await collectFilesFromPaths(await loadManualTargets(manualTargets), typeFilter)
    : [];

  const merged = FORCE_FULL_SCAN && manualTargets.length > 0
    ? [...new Set([...files, ...additionalFiles])]
    : files;

  if (merged.length === 0) {
    console.log('未检测到可处理的目标文件（请确认路径是否落在 design-data/design-item, design-data/design-units, design-data/design-building 下）。');
    return;
  }

  let total = 0;
  let changedCount = 0;
  const changedFiles = [];

  for (const filePath of merged) {
    total += 1;
    const raw = await fs.readFile(filePath, 'utf8');
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const parts = raw.slice(bom.length).split(/(\r\n|\r|\n)/);
    const lines = parts.filter((_, index) => index % 2 === 0);
    const endings = parts.filter((_, index) => index % 2 === 1);
    if (lines.at(-1) === '' && endings.length) lines.pop();
    const titleIndex = lines.findIndex((line) => line.trim() !== '');
    if (titleIndex < 0) {
      continue;
    }

    const category = toCategory(filePath);
    if (!category) {
      continue;
    }

    const bodyStart = normalizeLabel(lines[titleIndex]) ? titleIndex : titleIndex + 1;
    const bodyLines = lines.slice(bodyStart);
    const { changed, lines: normalizedBody } = rewriteBody(bodyLines, category);

    if (!changed) {
      continue;
    }

    changedCount += 1;
    const output = [...lines.slice(0, bodyStart), ...normalizedBody];
    const nextText = bom + output.map((line, index) => line + (endings[index] || '')).join('');
    if (WRITE) {
      await fs.writeFile(filePath, nextText, 'utf8');
    }
    changedFiles.push(path.relative(process.cwd(), filePath));
  }

  console.log(`meta-order: ${WRITE ? 'repaired' : 'would repair'} ${changedCount}/${total} 文件`);
  for (const name of changedFiles) {
    console.log(name);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
