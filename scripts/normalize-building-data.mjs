import fs from 'node:fs/promises';
import path from 'node:path';
import { DOC_ROOT } from './lib/paths.mjs';
import { runTextNormalizationBatch } from './lib/normalize-runner.mjs';
import { normalizeForCompare, toUnixLineEndings } from './lib/normalize-text-utils.mjs';

const BUILDING_ROOT = path.join(DOC_ROOT, 'design-building');
const WRITE = process.argv.includes('--write');

const CORE_ORDER = [
  '攻击类型',
  '攻击距离',
  '生命',
  '攻击',
  '护甲',
  '魔抗',
  '回血',
  '攻击间隔',
  '击杀奖励',
];

const BLOCK_ORDER = [
  '被动',
  '特殊效果',
];

const CORE_KEY_ALIASES = new Map(CORE_ORDER.map((key) => [key, key]));
const BLOCK_KEY_ALIASES = new Map([
  ['被动', '被动'],
  ['特殊效果', '特殊效果'],
]);

function parseKvLine(line) {
  const match = line.match(/^(.{1,60}?)\s*[:：]\s*(.*)$/);
  if (!match) {
    return null;
  }
  return { key: match[1].trim(), value: match[2].trim() };
}

const normalizeForDiff = (text) => normalizeForCompare(text, {
  stripBomMode: 'all',
  trimMode: 'trimEnd',
});

function isSpecialEffectLine(text) {
  return /真视|视野|获得\d+范围内/.test(text);
}

function splitSpecialFromPassive(lines) {
  if (lines.length === 0) {
    return {
      passive: [],
      special: [],
    };
  }

  const passive = [];
  const special = [];
  for (const line of lines) {
    if (isSpecialEffectLine(line) && special.length === 0) {
      special.push(line);
    } else {
      passive.push(line);
    }
  }

  if (special.length > 0) {
    return { passive, special };
  }

  return { passive: lines, special: [] };
}

function normalizeBuildingText(filePath, text) {
  const lines = toUnixLineEndings(text).split('\n');
  const titleLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleLineIndex < 0) {
    throw new Error(`${filePath}: 无标题`);
  }

  const fileName = path.basename(filePath);
  const normalizedTitle = fileName;
  const fields = Object.fromEntries(CORE_ORDER.map((key) => [key, '']));
  const blocks = Object.fromEntries(BLOCK_ORDER.map((key) => [key, []]));
  let currentBlock = null;
  const looseLines = [];

  for (const rawLine of lines.slice(titleLineIndex + 1)) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) {
      continue;
    }

    const kv = parseKvLine(trimmedLine);
    if (kv) {
      const coreKey = CORE_KEY_ALIASES.get(kv.key);
      if (coreKey) {
        fields[coreKey] = kv.value;
        currentBlock = null;
        continue;
      }

      const blockKey = BLOCK_KEY_ALIASES.get(kv.key);
      if (blockKey) {
        currentBlock = blockKey;
        if (kv.value) {
          blocks[currentBlock].push(kv.value);
        }
        continue;
      }
    }

    if (currentBlock) {
      blocks[currentBlock].push(trimmedLine);
    } else {
      looseLines.push(trimmedLine);
    }
  }

  if (looseLines.length > 0) {
    for (const line of looseLines) {
      if (isSpecialEffectLine(line)) {
        blocks['特殊效果'].push(line);
      } else {
        blocks['被动'].push(line);
      }
    }
  }

  const split = splitSpecialFromPassive(blocks['被动']);
  blocks['被动'] = split.passive;
  blocks['特殊效果'] = [...blocks['特殊效果'], ...split.special];

  const outputLines = [];
  outputLines.push(normalizedTitle);
  outputLines.push('');

  for (const key of CORE_ORDER) {
    outputLines.push(`${key}：${fields[key] || ''}`);
  }

  outputLines.push('');
  outputLines.push('被动：');
  if (blocks['被动'].length > 0) {
    outputLines.push(...blocks['被动']);
  }

  outputLines.push('');
  outputLines.push('特殊效果：');
  if (blocks['特殊效果'].length > 0) {
    outputLines.push(...blocks['特殊效果']);
  }

  return outputLines.join('\n').trimEnd();
}

async function listBuildingFiles() {
  const entries = await fs.readdir(BUILDING_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(BUILDING_ROOT, entry.name))
    .sort();
}

async function main() {
  const files = await listBuildingFiles();
  const buildingResult = await runTextNormalizationBatch({
    files,
    normalizeItem: normalizeBuildingText,
    compareValue: normalizeForDiff,
    shouldWrite: WRITE,
    formatWriteValue: (normalized) => `${normalized}\n`,
  });

  console.log(`normalize-building-data: would ${WRITE ? 'normalize' : 'update'} ${buildingResult.changed}/${buildingResult.total} building files`);
  for (const item of buildingResult.results.filter((item) => item.shouldUpdate)) {
    console.log(item.file);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
