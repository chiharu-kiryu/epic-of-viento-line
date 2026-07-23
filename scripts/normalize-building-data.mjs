import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const BUILDING_ROOT = path.join(PROJECT_ROOT, 'design-data', 'design-building');
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

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

function parseKvLine(line) {
  const match = line.match(/^(.{1,60}?)\s*[:：]\s*(.*)$/);
  if (!match) {
    return null;
  }
  return { key: match[1].trim(), value: match[2].trim() };
}

function normalizeTextForCompare(text) {
  return normalizeLineEndings(text)
    .replace(/\uFEFF/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+$/, '')
    .trimEnd();
}

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
  const lines = normalizeLineEndings(text).split('\n');
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
  const normalized = [];
  let changedCount = 0;

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const rawNormalized = normalizeTextForCompare(raw);
    const normalizedText = normalizeBuildingText(file, raw);
    const normalizedCompare = normalizeTextForCompare(normalizedText);

    if (rawNormalized !== normalizedCompare) {
      changedCount += 1;
      normalized.push({ file, normalizedText, changed: true });
    } else {
      normalized.push({ file, normalizedText, changed: false });
    }
  }

  if (WRITE) {
    for (const item of normalized) {
      if (!item.changed) continue;
      await fs.writeFile(item.file, `${item.normalizedText}\n`, 'utf8');
    }
  }

  console.log(`normalize-building-data: would ${WRITE ? 'normalize' : 'update'} ${changedCount}/${files.length} building files`);
  for (const item of normalized.filter((item) => item.changed)) {
    console.log(item.file);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
