import path from 'node:path';
import { collectFilesRecursive } from './lib/scan-files.mjs';
import { DOC_ROOT } from './lib/paths.mjs';
import { runTextNormalizationBatch } from './lib/normalize-runner.mjs';
import { normalizeForCompare, toUnixLineEndings } from './lib/normalize-text-utils.mjs';

const UNIT_ROOT = path.join(DOC_ROOT, 'design-units');
const WRITE = process.argv.includes('--write');

const CORE_ORDER = [
  '攻击类型',
  '生命',
  '攻击',
  '护甲',
  '魔抗',
  '回血',
  '攻击间隔',
  '攻击距离',
  '攻击范围',
  '移动速度',
  '状态抗性',
  '击杀奖励',
];

const BLOCK_ORDER = ['被动', '主动', '技能'];
const SKILL_KEEP_IN_BLOCK_KEYS = new Set(['冷却', '持续', '持续时间', '施法距离', '施法范围', '伤害', '消耗', 'cd', 'CD']);

const CORE_KEY_ALIASES = new Map(CORE_ORDER.map((key) => [key, key]));
const KEY_ALIASES = new Map([
  ['攻击（远程）', '攻击'],
  ...CORE_ORDER.map((key) => [key, key]),
]);

function parseLineKv(line) {
  const match = line.match(/^(.{1,60}?)\s*[:：]\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

const normalizeForDiff = (text) => normalizeForCompare(text, {
  stripBomMode: 'leading',
  trimMode: 'trim',
});

function normalizeLabelLine(line) {
  return line.trim()
    .replace(/\bcd\b/i, 'cd')
    .replace(/\bmp\b/i, 'mp');
}

function isBlockHeader(line) {
  return /^(被动|主动|技能)[:：]?\s*$/.test(line);
}

function parseBlockMarker(line) {
  const match = line.match(/^(.+?)\s*[:：]\s*(.*)$/);
  if (!match) return null;
  const key = KEY_ALIASES.get(match[1]) || CORE_KEY_ALIASES.get(match[1]) || match[1];
  return { key, value: match[2].trim(), inline: true };
}

function appendValue(target, piece) {
  if (target === '') {
    return piece;
  }
  return `${target}\n${piece}`;
}

function formatSectionLines(label, lines) {
  const output = [`${label}：`];
  output.push(...lines);
  return output;
}

function emitKvLine(label, value) {
  if (!value) {
    return `${label}：`;
  }
  const parts = value.split('\n');
  return `${label}：${parts[0]}${parts.length > 1 ? `\n${parts.slice(1).join('\n')}` : ''}`;
}

function normalizeUnitText(filePath, text) {
  const lines = toUnixLineEndings(text)
    .replace(/^\uFEFF/, '')
    .split('\n');
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) {
    throw new Error(`${filePath}: 无标题`);
  }

  const header = lines[titleIndex].trim();
  const fields = Object.fromEntries(CORE_ORDER.map((key) => [key, '']));
  const blocks = Object.fromEntries(BLOCK_ORDER.map((key) => [key, []]));
  const blockHasContent = Object.fromEntries(BLOCK_ORDER.map((key) => [key, false]));

  const extras = new Map();
  const paras = [];
  let currentBlock = null;
  let pendingInlineKey = null;

  for (const rawLine of lines.slice(titleIndex + 1)) {
    const line = normalizeLabelLine(rawLine).trim();
    if (!line) {
      continue;
    }

    if (isBlockHeader(line)) {
      const marker = line.replace(/[:：]\s*$/, '');
      if (BLOCK_ORDER.includes(marker)) {
        currentBlock = marker;
        blockHasContent[currentBlock] = false;
        pendingInlineKey = null;
        const markerKv = parseBlockMarker(line);
        if (markerKv && markerKv.value) {
          blocks[currentBlock].push(markerKv.value);
          blockHasContent[currentBlock] = true;
        }
        continue;
      }
    }

    const kv = parseLineKv(line);
    if (kv) {
      const canonicalKey = KEY_ALIASES.get(kv.key) || kv.key;

    if (canonicalKey === '段落') {
      currentBlock = null;
      pendingInlineKey = null;
      if (!kv.value) {
        pendingInlineKey = '段落';
      } else {
        paras.push(kv.value);
      }
      continue;
    }

      if (currentBlock) {
        const isSkillBlock = currentBlock === '技能';
        if (
          isSkillBlock
          && !kv.value
          || !isSkillBlock
          || SKILL_KEEP_IN_BLOCK_KEYS.has(canonicalKey)
          || blockHasContent[currentBlock]
        ) {
          blocks[currentBlock].push(line);
          blockHasContent[currentBlock] = true;
          pendingInlineKey = null;
          continue;
        }

        currentBlock = null;
        if (!extras.has(canonicalKey)) {
          extras.set(canonicalKey, '');
        }
        const previous = extras.get(canonicalKey);
        const nextValue = previous ? appendValue(previous, kv.value) : kv.value;
        extras.set(canonicalKey, nextValue);
        if (!kv.value) {
          pendingInlineKey = canonicalKey;
        }
        continue;
      }

      pendingInlineKey = null;

      const coreKey = CORE_KEY_ALIASES.get(canonicalKey);
      if (coreKey) {
        fields[coreKey] = kv.value;
        if (!kv.value) {
          pendingInlineKey = coreKey;
        }
        continue;
      }

      if (!extras.has(canonicalKey)) {
        extras.set(canonicalKey, '');
      }
      const previous = extras.get(canonicalKey);
      const nextValue = previous ? appendValue(previous, kv.value) : kv.value;
      extras.set(canonicalKey, nextValue);
      if (!kv.value) {
        pendingInlineKey = canonicalKey;
      }
      continue;
    }

    if (pendingInlineKey) {
      const current = CORE_KEY_ALIASES.has(pendingInlineKey)
        ? fields[pendingInlineKey]
        : (extras.get(pendingInlineKey) || '');
      if (pendingInlineKey === '段落') {
        paras.push(line);
        pendingInlineKey = null;
        continue;
      }

      if (CORE_KEY_ALIASES.has(pendingInlineKey)) {
        fields[pendingInlineKey] = appendValue(current, line);
      } else {
        extras.set(pendingInlineKey, appendValue(current, line));
      }
      pendingInlineKey = null;
      continue;
    }

    if (currentBlock) {
      blocks[currentBlock].push(line);
      continue;
    }

    paras.push(line);
  }

  const output = [];
  output.push(header);
  output.push('');

  for (const key of CORE_ORDER) {
    output.push(emitKvLine(key, fields[key] || ''));
  }

  for (const blockKey of BLOCK_ORDER) {
    output.push('');
    output.push(...formatSectionLines(blockKey, blocks[blockKey]));
  }

  for (const [key, value] of extras.entries()) {
    output.push('');
    output.push(emitKvLine(key, value || ''));
  }

  if (paras.length > 0) {
    output.push('');
    output.push('段落：');
    output.push(...paras);
  }

  return output.join('\n').trimEnd();
}

async function main() {
  const files = (await collectFilesRecursive(UNIT_ROOT, {
    relativeBase: '',
    acceptedExtensions: new Set(['', '.md', '.txt', '.json', '.yml', '.yaml']),
  })).map((file) => path.join(UNIT_ROOT, file)).sort();
  const unitResult = await runTextNormalizationBatch({
    files,
    normalizeItem: normalizeUnitText,
    compareValue: normalizeForDiff,
    shouldWrite: WRITE,
    formatWriteValue: (normalized) => `${normalized}\n`,
  });

  console.log(`normalize-unit-data: would ${WRITE ? 'normalize' : 'update'} ${unitResult.changed}/${unitResult.total} unit files`);
  for (const item of unitResult.results.filter((item) => item.shouldUpdate)) {
    console.log(item.file);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
