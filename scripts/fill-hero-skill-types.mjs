#!/usr/bin/env node
import { PROJECT_ROOT } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = PROJECT_ROOT;
const HERO_ROOT = path.join(ROOT, 'design-data', 'design-heros');
const SKILL_BLOCKS = new Set(['天生技能', '技能1', '技能2', '技能3', '技能4', '阳印', '阴印', '铸魔', '铸神']);
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const NOISE_PREFIX = ['+', '先天技能', '技能1', '技能2', '技能3', '技能4', '天生技能', '阳印', '阴印', '铸魔', '铸神'];
const LABEL = '类型：';

const TAG_CANON_MAP = new Map([
  ['强化攻击', ['强化']],
  ['被动强化', ['被动', '强化']],
  ['AOE魔法伤害', ['AOE伤害', '魔法伤害']],
  ['增伤buff', ['强化']],
  ['锁头位移', ['位移']],
  ['加速', ['位移']],
  ['充能', ['强化']],
  ['充能效果', ['恢复']],
  ['生命回复', ['恢复']],
  ['被动', ['被动']],
]);

const TAG_ORDER = [
  '被动',
  '主动',
  'AOE伤害',
  '伤害',
  '强化',
  '魔法伤害',
  '物理伤害',
  '纯粹伤害',
  '控制',
  '位移',
  '恢复',
  '驱散',
  '护盾',
  '召唤',
  '隐身',
];

function toPosix(value) {
  return String(value || '')
    .replace(/\\/g, '/');
}

function splitLines(rawText) {
  return rawText.replace(/\r/g, '').split('\n');
}

function normalizeKey(label) {
  return String(label || '').trim().replace(/[:：]\s*$/, '');
}

function isSkillHeader(line) {
  const header = normalizeKey(line);
  return SKILL_BLOCKS.has(header);
}

function findNextHeaderIndex(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i += 1) {
    if (i > startIndex && isSkillHeader(lines[i])) {
      return i;
    }
  }
  return lines.length;
}

function normalizeTypeValue(value) {
  return String(value || '').trim().replace(/^:+|：+$/g, '');
}

function toCanonicalTokens(value) {
  const raw = String(value || '')
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean);
  const expanded = [];
  for (const tag of raw) {
    const mapped = TAG_CANON_MAP.get(tag);
    if (mapped) {
      expanded.push(...mapped);
      continue;
    }
    expanded.push(tag.replace(/[\s　]+/g, ''));
  }
  return [...new Set(expanded)];
}

function normalizeTypeTokens(lineTokens, inferredMode = '') {
  if (!lineTokens.length) {
    return [];
  }
  const tokens = [...lineTokens];
  if (!tokens.includes('主动') && !tokens.includes('被动') && inferredMode) {
    tokens.unshift(inferredMode);
  }

  const ordered = [];
  for (const tag of TAG_ORDER) {
    if (tokens.includes(tag)) {
      ordered.push(tag);
    }
  }
  for (const tag of tokens) {
    if (!TAG_ORDER.includes(tag) && !ordered.includes(tag)) {
      ordered.push(tag);
    }
  }
  return ordered;
}

function inferModeFromSection(header, sectionText) {
  const hasCooldown = /(^|[^\u4e00-\u9fa5A-Za-z0-9])冷却[:：]/.test(sectionText)
    || /(^|\n)冷却[:：]/.test(sectionText)
    || /\n冷却/.test(sectionText);
  if (header === '天生技能' || header === '阳印' || header === '阴印' || header === '铸魔' || header === '铸神') {
    return '被动';
  }
  if ((/^技能[1-4]$/.test(header) || header === '铸魔' || header === '铸神') && hasCooldown) {
    return '主动';
  }
  return '';
}

function normalizeTypeLine(rawValue, inferredMode) {
  const tokens = toCanonicalTokens(rawValue);
  return normalizeTypeTokens(tokens, inferredMode).join('/');
}

function normalizeTextForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC');
}

function hasAny(text, keys) {
  const normalized = normalizeTextForMatch(text);
  return keys.some((key) => normalized.includes(normalizeTextForMatch(key)));
}

function extractSectionBody(lines, blockStart, blockEnd) {
  const body = lines.slice(blockStart + 1, blockEnd).filter((line) => line.trim() !== '');
  if (body.length === 0) {
    return [];
  }

  return body;
}

function getSectionText(lines, blockStart, blockEnd) {
  return extractSectionBody(lines, blockStart, blockEnd).join('\n');
}

function findTypeLineIndex(lines) {
  return lines.findIndex((line) => /^类型：/.test(line.trim()));
}

function extractName(lines) {
  const nameLine = lines.find((line) => /^名称：/.test(line.trim()));
  if (nameLine) {
    return nameLine.replace(/^名称：\s*/, '').trim();
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^描述：/.test(trimmed) || /^类型：/.test(trimmed)) {
      continue;
    }
    if (trimmed.length > 0 && trimmed.length <= 18 && !NOISE_PREFIX.includes(trimmed)) {
      return trimmed;
    }
  }
  return '';
}

function stripTypePrefix(typeText) {
  return normalizeTypeValue(typeText.replace(/^类型：/, ''));
}

function inferType(blockHeader, sectionText, sectionLines) {
  const raw = normalizeTextForMatch(sectionText);
  const isCore = blockHeader === '天生技能' || blockHeader === '阳印' || blockHeader === '阴印' || blockHeader === '铸魔' || blockHeader === '铸神';
  const hasCooldown = /(^|[^\u4e00-\u9fa5A-Za-z0-9])冷却[:：]/.test(sectionText) || /(^|\n)冷却[:：]/.test(sectionText) || /\n冷却/.test(sectionText);
  const hasDamage = /伤害/.test(sectionText) || /造成/.test(sectionText);
  const hasPhysical = /物理伤害|物理/.test(sectionText);
  const hasMagic = /魔法伤害|魔法/.test(sectionText);
  const hasPure = /纯(?:粹|粹)/.test(sectionText);
  const hasHeal = /治疗|回血|回复/.test(sectionText);
  const hasShield = /护盾|格挡|吸收护盾|伤害吸收/.test(sectionText);
  const hasControl = /沉默|眩(?:晕|晃)|击晕|击退|定身|禁锢|束缚|控制|嘲讽|眩惑/.test(sectionText);
  const hasSlow = /减速|束缚|禁锢|定身/.test(sectionText);
  const hasDash = /闪现|突进|冲刺|位移|跳跃|移动速度|冲锋|吸附/.test(sectionText);
  const hasStealth = /隐身|隐形|匿踪/.test(sectionText);
  const hasSummon = /召唤|分身/.test(sectionText);
  const hasDispel = /驱散|净化/.test(sectionText);
  const hasAura = /每次攻击|每次|持续|持续时间|提高|增加|额外|减免|加速|吸血/.test(sectionText);
  const hasAOE = /范围|半径|周围|周边|区域|半场|范围半径|群/.test(sectionText);
  const tags = [];

  if (isCore) {
    tags.push('被动');
  } else if (hasCooldown && sectionText.trim()) {
    tags.push('主动');
  } else {
    tags.push('被动');
  }

  const secondary = [];
  if (hasAOE && hasDamage) {
    secondary.push('AOE伤害');
  } else if (hasDamage) {
    if (hasMagic) {
      secondary.push('魔法伤害');
    } else if (hasPhysical) {
      secondary.push('物理伤害');
    } else if (hasPure) {
      secondary.push('纯粹伤害');
    } else {
      secondary.push('伤害');
    }
  }

  if (hasControl || hasSlow) {
    secondary.push('控制');
  }
  if (hasHeal) {
    secondary.push('恢复');
  }
  if (hasShield) {
    secondary.push('护盾');
  }
  if (hasDash) {
    secondary.push('位移');
  }
  if (hasStealth) {
    secondary.push('隐身');
  }
  if (hasSummon) {
    secondary.push('召唤');
  }
  if (hasDispel) {
    secondary.push('驱散');
  }
  if (hasAura && secondary.length === 0) {
    secondary.push('强化');
  }

  for (const tag of secondary) {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags;
}

function collectHeroFiles() {
  const files = [];
  const attrs = fs.readdirSync(HERO_ROOT, { withFileTypes: true });
  for (const attr of attrs) {
    if (!attr.isDirectory()) {
      continue;
    }
    const attrDir = path.join(HERO_ROOT, attr.name);
    const entries = fs.readdirSync(attrDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) {
        continue;
      }
      files.push(path.join(attrDir, entry.name));
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function fillFile(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = splitLines(raw);
  const output = [...lines];
  let changed = false;
  const updates = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!isSkillHeader(lines[i])) {
      continue;
    }
    const header = normalizeKey(lines[i]);
    const nextHeaderIndex = findNextHeaderIndex(lines, i + 1);
    const blockLines = lines.slice(i + 1, nextHeaderIndex);
    const sectionText = getSectionText(lines, i, nextHeaderIndex);

    const typeLineIndex = blockLines.findIndex((line) => /^类型：/.test(line.trim()));
    const typeValue = typeLineIndex >= 0 ? stripTypePrefix(blockLines[typeLineIndex]) : '';
    const inferredType = inferType(header, sectionText, blockLines);
    const inferredMode = inferModeFromSection(header, sectionText);

    if (typeLineIndex >= 0) {
      const absoluteTypeIndex = i + 1 + typeLineIndex;
      if (typeValue) {
        const candidateValue = normalizeTypeLine(typeValue, inferredMode);
        if (!candidateValue) {
          continue;
        }
        const candidate = `${LABEL}${candidateValue}`;
        if (output[absoluteTypeIndex] !== candidate) {
          updates.push({
            block: header,
            name: extractName(blockLines),
            old: output[absoluteTypeIndex],
            value: candidate,
          });
          changed = true;
          if (!DRY_RUN) {
            output[absoluteTypeIndex] = candidate;
          }
        }
        continue;
      }

      if (!inferredType.length) {
        continue;
      }
      const candidate = `${LABEL}${normalizeTypeTokens(inferredType, inferredMode).join('/')}`;
      if (output[absoluteTypeIndex] !== candidate) {
        updates.push({
          block: header,
          name: extractName(blockLines),
          old: output[absoluteTypeIndex],
          value: candidate,
        });
        changed = true;
        if (!DRY_RUN) {
          output[absoluteTypeIndex] = candidate;
        }
      }
      continue;
    }

    const insertIndex = blockLines.findIndex((line) => /^名称：/.test(line.trim()));
    if (!output[i + 1] && insertIndex < 0) {
      continue;
    }

    if (!inferredType.length) {
      continue;
    }

    const absoluteInsertIndex = i + 1 + (insertIndex >= 0 ? insertIndex + 1 : 0);
    const candidate = `${LABEL}${normalizeTypeTokens(inferredType, inferredMode).join('/')}`;
    updates.push({
      block: header,
      name: extractName(blockLines),
      old: '(缺失)',
      value: candidate,
    });
    changed = true;
    if (!DRY_RUN) {
      output.splice(absoluteInsertIndex, 0, candidate);
    }
  }

  return {
    filePath,
    changed,
    updates,
    resultText: output.join('\n'),
  };
}

const heroFiles = collectHeroFiles();
let updatedFiles = 0;
let updatedTypes = 0;
let unchanged = 0;
const plan = [];
const examples = [];

for (const file of heroFiles) {
  const filled = fillFile(file);
  if (filled.updates.length > 0) {
    updatedFiles += 1;
    updatedTypes += filled.updates.length;
    plan.push({
      file: toPosix(path.relative(ROOT, file)),
      updates: filled.updates.map((item) => `${item.block}: ${item.name || '（未识别）'} -> ${item.value}`),
    });
    if (examples.length < 20) {
      examples.push({
        file: path.relative(ROOT, file),
        updates: filled.updates,
      });
    }
    if (!DRY_RUN && filled.changed) {
      fs.writeFileSync(file, filled.resultText, 'utf8');
    }
  } else {
    unchanged += 1;
  }
}

if (DRY_RUN) {
  console.log(`待更新文件: ${updatedFiles}`);
  console.log(`待填充类型行: ${updatedTypes}`);
  console.log(`已具备类型的文件: ${unchanged}`);
  for (const item of plan.slice(0, 40)) {
    console.log(`- ${item.file}`);
    for (const row of item.updates) {
      console.log(`  ${row}`);
    }
  }
} else {
  console.log(`已更新文件: ${updatedFiles}`);
  console.log(`已填充类型行: ${updatedTypes}`);
  for (const item of plan.slice(0, 40)) {
    console.log(`- ${item.file}`);
    for (const row of item.updates) {
      console.log(`  ${row}`);
    }
  }
}

if (VERBOSE) {
  console.log('示例：');
  for (const item of examples) {
    console.log(item.file, '=>', item.updates.map((u) => `${u.block}:${u.name}->${u.value}`).join('；'));
  }
}
