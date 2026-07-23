import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const HERO_ROOT = path.join(PROJECT_ROOT, 'design-data', 'design-heros');
const WRITE = process.argv.includes('--write');

const CORE_ORDER = [
  '别名',
  '英文名',
  '攻击类型',
  '攻击距离',
  '基础攻击间隔',
  '基础移动速度',
  '主属性',
  '力量',
  '敏捷',
  '智力',
];

const BLOCK_ORDER = [
  '天生技能',
  '技能1',
  '技能2',
  '技能3',
  '技能4',
  '阳印',
  '阴印',
  '铸魔',
  '铸神',
];

const CORE_KEY_ALIASES = new Map(CORE_ORDER.map((key) => [key, key]));
const BLOCK_KEY_ALIASES = new Map([
  ['先天技能', '天生技能'],
  ...BLOCK_ORDER.map((key) => [key, key]),
]);

const PARAMETER_NAMES = new Set([
  '伤害',
  '基础伤害',
  '额外伤害',
  '魔法伤害',
  '物理伤害',
  '纯粹伤害',
  '距离',
  '施法距离',
  '攻击距离',
  '范围',
  '作用范围',
  '范围半径',
  '持续时间',
  '冷却',
  '魔力消耗',
  '攻击',
  '攻击力',
  '攻击速度',
  '护甲',
  '魔抗',
  '生命',
  '治疗量',
  '移动速度',
  '飞行速度',
  '几率',
  '概率',
  '比例',
  '数量',
]);

function parseKv(line) {
  const match = line.trim().match(/^(.{1,60}?)\s*[:：]\s*(.*)$/);
  if (!match) {
    return null;
  }
  return { key: match[1].trim(), value: match[2].trim() };
}

function normalizeKvLine(line) {
  const trimmed = line.trim();
  const kv = parseKv(trimmed);
  if (!kv) {
    return trimmed;
  }
  let key = kv.key;
  if (/^cd$/i.test(key)) {
    key = '冷却';
  } else if (/^mp$/i.test(key)) {
    key = '魔力消耗';
  }
  return `${key}：${kv.value}`;
}

function parseBlockMarker(line) {
  const kv = parseKv(line);
  if (!kv) {
    return null;
  }
  const key = BLOCK_KEY_ALIASES.get(kv.key);
  return key ? { key, inlineValue: kv.value } : null;
}

function splitAlias(rawValue) {
  const value = rawValue.trim();
  if (!value) {
    return { alias: '', englishName: '' };
  }
  if (/^[A-Za-z][A-Za-z .'-]*$/.test(value)) {
    return { alias: '', englishName: value };
  }
  const bilingual = value.match(/^(.+?)\s+([A-Za-z][A-Za-z .'-]*)$/);
  if (bilingual) {
    return {
      alias: bilingual[1].trim(),
      englishName: bilingual[2].trim(),
    };
  }
  return { alias: value, englishName: '' };
}

function looksLikeStat(value) {
  return /^\d+(?:\.\d+)?\s*\+\s*\d+(?:\.\d+)?$/.test(value);
}

function looksLikeName(value, maximumLength = 16) {
  const text = value.trim();
  return (
    text.length > 0
    && text.length <= maximumLength
    && !/[0-9%，。；,!?！？（）()]/.test(text)
    && !/^(获得|增加|提高|降低|减少|每|当|如果|使|可以|能够|新增)/.test(text)
  );
}

function splitAbilityName(key, lines) {
  if (lines.length === 0) {
    return { name: '', remaining: [] };
  }

  const maximumLength = /^(?:阳印|阴印|铸魔|铸神)$/.test(key) ? 8 : 16;
  const first = lines[0];
  const existingName = first.match(/^名称：(.*)$/);
  if (existingName) {
    return {
      alreadyNormalized: true,
      name: existingName[1],
      remaining: lines.slice(1),
      maximumLength,
    };
  }

  const kv = parseKv(first);
  if (kv && looksLikeName(kv.key, maximumLength) && !PARAMETER_NAMES.has(kv.key)) {
    return {
      name: kv.key,
      remaining: [kv.value, ...lines.slice(1)].filter((line) => line !== ''),
    };
  }

  if (!kv && looksLikeName(first, maximumLength)) {
    return { name: first.replace(/[：:]$/, ''), remaining: lines.slice(1) };
  }

  return { name: '', remaining: lines };
}

function normalizeAbilityBlock(key, rawLines) {
  const lines = rawLines
    .map(normalizeKvLine)
    .filter((line) => line.length > 0);

  const split = splitAbilityName(key, lines);
  if (split.alreadyNormalized) {
    const remaining = split.remaining.map(normalizeKvLine);
    if (split.name && !looksLikeName(split.name, split.maximumLength)) {
      const descriptionIndex = remaining.findIndex((line) => /^描述：/.test(line));
      if (descriptionIndex >= 0) {
        const description = remaining[descriptionIndex].replace(/^描述：/, '');
        remaining[descriptionIndex] = `描述：${split.name}${description ? `\n${description}` : ''}`;
      }
      return ['名称：', ...remaining];
    }
    return [`名称：${split.name}`, ...remaining];
  }

  const supportsType = key === '天生技能' || /^技能[1-4]$/.test(key);
  const remaining = split.remaining.slice();
  let description = '';
  if (remaining.length > 0 && !parseKv(remaining[0])) {
    description = remaining.shift();
  }

  const normalized = [`名称：${split.name}`];
  if (supportsType) {
    normalized.push('类型：');
  }
  normalized.push(`描述：${description}`);
  normalized.push(...remaining);
  return normalized;
}

function parseCore(filePath, coreLines) {
  const titleIndex = coreLines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) {
    throw new Error(`${filePath}: 缺少英雄名`);
  }

  const heroName = coreLines[titleIndex].trim();
  const fields = Object.fromEntries(CORE_ORDER.map((key) => [key, '']));
  const loose = [];

  for (const rawLine of coreLines.slice(titleIndex + 1)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const kv = parseKv(line);
    const key = kv ? CORE_KEY_ALIASES.get(kv.key) : null;
    if (key) {
      fields[key] = kv.value;
    } else {
      loose.push(line);
    }
  }

  const unresolved = [];
  for (const line of loose) {
    if (!fields['攻击类型'] && /^(?:近战|远程)(?:[/／](?:近战|远程))?$/.test(line)) {
      fields['攻击类型'] = line.replace('／', '/');
      continue;
    }
    if (!fields['主属性'] && /^(?:力量|敏捷|智力)(?:[/／](?:力量|敏捷|智力))?$/.test(line)) {
      fields['主属性'] = line.replace('／', '/');
      continue;
    }
    if (looksLikeStat(line)) {
      const missingStat = ['力量', '敏捷', '智力'].find((key) => !fields[key]);
      if (missingStat) {
        fields[missingStat] = line.replace(/\s*\+\s*/, ' + ');
        continue;
      }
    }
    unresolved.push(line);
  }

  if (!fields['主属性']) {
    fields['主属性'] = path.basename(path.dirname(filePath));
  }

  if (unresolved.length > 1) {
    throw new Error(`${filePath}: 无法无损归类头部内容: ${unresolved.join(' | ')}`);
  }

  const inferredAlias = splitAlias(unresolved[0] || '');
  if (!fields['别名']) {
    fields['别名'] = inferredAlias.alias;
  }
  if (!fields['英文名']) {
    fields['英文名'] = inferredAlias.englishName;
  }

  const required = CORE_ORDER.filter((key) => !['别名', '英文名'].includes(key));
  const missing = required.filter((key) => !fields[key]);
  if (missing.length > 0) {
    throw new Error(`${filePath}: 缺少核心字段 ${missing.join(', ')}`);
  }

  return { heroName, fields };
}

function normalizeHero(filePath, raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  const markers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = parseBlockMarker(lines[index]);
    if (marker) {
      markers.push({ ...marker, index });
    }
  }

  const foundKeys = markers.map((item) => item.key);
  const missingBlocks = BLOCK_ORDER.filter((key) => !foundKeys.includes(key));
  const duplicateBlocks = BLOCK_ORDER.filter((key) => foundKeys.filter((found) => found === key).length > 1);
  if (missingBlocks.length > 0 || duplicateBlocks.length > 0) {
    throw new Error(
      `${filePath}: 技能区块异常，缺少 [${missingBlocks.join(', ')}]，重复 [${duplicateBlocks.join(', ')}]`
    );
  }

  const firstMarker = Math.min(...markers.map((item) => item.index));
  const { heroName, fields } = parseCore(filePath, lines.slice(0, firstMarker));
  const blocks = new Map();

  for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    const marker = markers[markerIndex];
    const nextIndex = markers[markerIndex + 1]?.index ?? lines.length;
    const payload = [
      marker.inlineValue,
      ...lines.slice(marker.index + 1, nextIndex),
    ].filter((line, index) => index > 0 || line !== '');
    blocks.set(marker.key, normalizeAbilityBlock(marker.key, payload));
  }

  const output = [heroName];
  for (const key of CORE_ORDER) {
    output.push(`${key}：${fields[key]}`);
  }
  for (const key of BLOCK_ORDER) {
    output.push('', `${key}：`, ...blocks.get(key));
  }
  return `${output.join('\n').trimEnd()}\n`;
}

async function listHeroFiles() {
  const attributes = await fs.readdir(HERO_ROOT, { withFileTypes: true });
  const files = [];
  for (const attribute of attributes) {
    if (!attribute.isDirectory()) {
      continue;
    }
    const attributeDir = path.join(HERO_ROOT, attribute.name);
    const entries = await fs.readdir(attributeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith('.')) {
        files.push(path.join(attributeDir, entry.name));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

const files = await listHeroFiles();
let changed = 0;
for (const filePath of files) {
  const raw = await fs.readFile(filePath, 'utf8');
  const normalized = normalizeHero(filePath, raw);
  if (normalized === raw) {
    continue;
  }
  changed += 1;
  if (WRITE) {
    await fs.writeFile(filePath, normalized, 'utf8');
  }
}

console.log(`${WRITE ? 'normalized' : 'would normalize'} ${changed}/${files.length} hero files`);
