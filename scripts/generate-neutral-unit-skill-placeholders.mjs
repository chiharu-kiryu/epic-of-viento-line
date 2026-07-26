#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const UNIT_ROOT = path.join(ROOT, 'design-data', 'design-units');
const UNIT_IMAGE_ROOT = path.join(ROOT, 'assets', 'images', 'units');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const SKIP_SIPS = process.argv.includes('--skip-sips') || process.argv.includes('--dry-run');

const TARGET_SECTIONS = new Set(['被动', '主动', '技能']);
const SKIP_KEYS = new Set([
  '冷却',
  '持续',
  '持续时间',
  '施法距离',
  '施法范围',
  '攻击',
  '攻击间隔',
  '攻击距离',
  '攻击范围',
  '攻击类型',
  '伤害',
  '每秒伤害',
  '生命',
  '回血',
  '移动速度',
  '护甲',
  '魔抗',
  '状态抗性',
  '击杀奖励',
  '魔力涌动',
  '段落',
  '技能',
  '技能列表',
  '技能1',
  '技能2',
  '技能3',
  '技能4',
  '冷却时间',
  '冷却时长',
  '类型',
]);

const META_NOISE_PATTERNS = [
  /^(?:\d+|[0-9]+)/,
  /^[%+\-/*a-zA-Z0-9]+$/,
  /[,，。；;!！?？:.：]/,
  /(持续|技能|冷却|施法|攻击|伤害|击杀|回血|状态|生命|护甲|魔抗|移动|击退|伤害)|技能$/,
];

const DESC_PREFIX_PATTERNS = [
  /^(?:对|将|并且|并|并且|如果|若|当|持续|每|使|造成|召唤|攻击|受到|触发|进入|提高|获得|提升|持续|效果|闪避|附带)/,
  /^效果(?:是不叠加|叠加)?$/,
];

let hasSips = null;

function hasSipsBinary() {
  if (hasSips !== null) {
    return hasSips;
  }

  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    hasSips = true;
    return true;
  } catch {
    hasSips = false;
    return false;
  }
}

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-skill-placeholders-'));
const cleanup = () => {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
};
process.once('exit', cleanup);
process.once('SIGINT', () => {
  cleanup();
  process.exit();
});
process.once('uncaughtException', (error) => {
  cleanup();
  throw error;
});

function normalizeSegment(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '')
    .trim();
  if (!normalized) {
    return '占位';
  }
  return normalized
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\.\.+/g, '.')
    .trim();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashToHue(text) {
  const safe = String(text || '').normalize('NFKC');
  if (!safe) {
    return 0;
  }
  let hash = 0;
  for (let i = 0; i < safe.length; i += 1) {
    hash = ((hash << 5) - hash) + safe.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function splitLongLabel(text, maxLineLength = 12, maxLineCount = 2) {
  const safe = String(text || '').normalize('NFKC').trim();
  if (!safe) {
    return ['占位'];
  }
  if (safe.length <= maxLineLength) {
    return [safe];
  }
  const lines = [];
  for (let start = 0; start < safe.length && lines.length < maxLineCount; start += maxLineLength) {
    lines.push(safe.slice(start, start + maxLineLength));
  }
  return lines;
}

function buildPlaceholderSvg(label, subtitle) {
  const size = 768;
  const safeLabel = normalizeSegment(label);
  const hue = hashToHue(safeLabel);
  const hue2 = (hue + 55 + safeLabel.length * 7) % 360;
  const titleLines = splitLongLabel(safeLabel, 12, 2);
  const subtitleText = normalizeSegment(subtitle || '').slice(0, 20);

  const lineHeights = 40;
  const firstY = 360;
  const linesMarkup = titleLines
    .map((line, index) => {
      const y = firstY + index * lineHeights;
      return `<text x="384" y="${y}" text-anchor="middle" fill="#eef4ff" font-size="56" font-family="Arial, Helvetica, sans-serif" font-weight="700" dominant-baseline="middle">${escapeXml(line)}</text>`;
    })
    .join('\n');

  const subtitleMarkup = subtitleText
    ? `<text x="384" y="520" text-anchor="middle" fill="#c9d6f0" font-size="36" font-family="Arial, Helvetica, sans-serif" dominant-baseline="middle">${escapeXml(subtitleText)}</text>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141b2f" />
      <stop offset="100%" stop-color="hsl(${hue2}, 52%, 12%)" />
    </linearGradient>
    <radialGradient id="halo" cx="0.18" cy="0.08" r="0.72">
      <stop offset="0%" stop-color="hsl(${(hue + 80) % 360}, 85%, 72%)" stop-opacity="0.2" />
      <stop offset="100%" stop-color="hsl(${(hue + 80) % 360}, 90%, 18%)" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="36" fill="url(#bg)" />
  <rect x="0" y="${Math.floor(size * 0.55)}" width="${size}" height="${Math.floor(size * 0.45)}" fill="url(#halo)" />
  <circle cx="120" cy="120" r="110" fill="hsl(${hue}, 78%, 42%)" opacity="0.18" />
  <circle cx="680" cy="620" r="138" fill="hsl(${hue2}, 82%, 28%)" opacity="0.24" />
  ${linesMarkup}
  ${subtitleMarkup}
  <text x="384" y="666" text-anchor="middle" fill="#eef4ff" font-size="36" font-family="Arial, Helvetica, sans-serif" dominant-baseline="middle">PLACEHOLDER</text>
</svg>`;
}

function hasExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function generatePngFromSvg(targetAbsPath, svgContent) {
  if (!hasSipsBinary() && !SKIP_SIPS) {
    return 'missing-tool';
  }

  const svgPath = path.join(TEMP_DIR, `${Date.now()}-${Math.floor(Math.random() * 10000)}.svg`);
  fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
  fs.writeFileSync(svgPath, svgContent, 'utf8');
  if (DRY_RUN) {
    fs.unlinkSync(svgPath);
    return 'dry-run';
  }

  try {
    execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', targetAbsPath], { stdio: 'ignore' });
    fs.unlinkSync(svgPath);
    return 'created';
  } catch (error) {
    fs.unlinkSync(svgPath);
    return `failed:${error.message}`;
  }
}

function collectUnitFiles(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const items = fs.readdirSync(current, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) {
        continue;
      }
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(full);
      } else if (item.isFile()) {
        entries.push(full);
      }
    }
  }
  return entries;
}

function normalizeSectionHeader(line = '') {
  return String(line || '').trim().replace(/[:：]\s*$/, '');
}

function shouldSkipKey(key = '') {
  const safe = String(key || '').trim();
  if (!safe || safe.length < 2) {
    return true;
  }
  if (SKIP_KEYS.has(safe)) {
    return true;
  }
  return false;
}

function isLikelySkillNameFromText(line = '', fromNoColon = false, fromSkillPair = false) {
  const text = String(line || '').trim();
  if (!text || text.length < 2 || text.length > 18) {
    return false;
  }
  if (/^\d/.test(text)) return false;
  if (/\d/.test(text)) {
    return false;
  }
  if (fromNoColon && text.includes(':')) {
    return false;
  }
  if (fromSkillPair) {
    return true;
  }
  if (/[，。、；;:：!！?？]/.test(text)) {
    return false;
  }
  for (const pattern of DESC_PREFIX_PATTERNS) {
    if (pattern.test(text)) {
      return false;
    }
  }
  for (const pattern of META_NOISE_PATTERNS) {
    if (pattern.test(text)) {
      return false;
    }
  }
  return true;
}

function parseUnitSkills(lines = []) {
  let section = '';
  const names = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) {
      continue;
    }

    const header = normalizeSectionHeader(line);
    if (TARGET_SECTIONS.has(header)) {
      section = header;
      continue;
    }

    if (!TARGET_SECTIONS.has(section)) {
      continue;
    }

    const kv = line.match(/^(.*?)\s*[:：]\s*(.*)$/);
    if (kv) {
      const key = normalizeSegment(kv[1].trim());
      if (!shouldSkipKey(key) && isLikelySkillNameFromText(key, false, true)) {
        if (!seen.has(key)) {
          names.push(key);
          seen.add(key);
        }
      }
      continue;
    }

    if (!isLikelySkillNameFromText(line, true)) {
      continue;
    }

    if (!seen.has(line)) {
      names.push(line);
      seen.add(line);
    }
  }

  return names;
}

function getUnitPathSegments(filePath) {
  const relative = path.relative(UNIT_ROOT, filePath);
  const parts = relative.split(path.sep).filter(Boolean);
  // design-units/<subtype>/<name>
  if (parts.length >= 2 && parts[0] === '中立') {
    return {
      faction: normalizeSegment(parts[0]),
      subtype: normalizeSegment(parts[1]),
      name: normalizeSegment(parts[2] ? path.basename(parts[1]) : parts.at(-1)),
      category: normalizeSegment(parts[0]),
    };
  }
  return null;
}

function main() {
  if (!hasSipsBinary() && !SKIP_SIPS) {
    console.error('[neutral-unit-placeholder] 当前环境缺少 sips，无法生成 png。可加 --skip-sips 仅输出计划。');
    process.exitCode = 1;
    return;
  }

  const unitFiles = collectUnitFiles(UNIT_ROOT)
    .filter((file) => {
      const rel = path.relative(UNIT_ROOT, file);
      return rel.startsWith(`中立${path.sep}`);
    })
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const targets = [];
  const copyTargets = [];
  for (const file of unitFiles) {
    const rel = path.relative(UNIT_ROOT, file);
    const parts = rel.split(path.sep);
    if (parts.length < 2) {
      continue;
    }
    const subtype = parts[1];
    const name = normalizeSegment(path.basename(parts.at(-1)));
    const faction = '中立';
    const unitDir = path.join(UNIT_IMAGE_ROOT, faction, subtype, name);
    const srcIcon = path.join(UNIT_IMAGE_ROOT, faction, subtype, `${name}.png`);
    const dstIcon = path.join(unitDir, `${name}.png`);
    if (hasExistingFile(srcIcon) && !hasExistingFile(dstIcon)) {
      copyTargets.push({ srcIcon, dstIcon });
    }

    const content = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
    const skills = parseUnitSkills(content.split('\n'));
    for (const skill of skills) {
      const target = path.join(unitDir, `${skill}.png`);
      targets.push({ source: file, target, label: skill });
    }
  }

  if (copyTargets.length > 0) {
    for (const { srcIcon, dstIcon } of copyTargets) {
      if (DRY_RUN) {
        console.log(`[计划] 拷贝单位主图: ${path.relative(ROOT, srcIcon)} -> ${path.relative(ROOT, dstIcon)}`);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dstIcon), { recursive: true });
        if (!hasExistingFile(dstIcon) || FORCE) {
          fs.copyFileSync(srcIcon, dstIcon);
        }
      } catch (error) {
        console.error(`单位主图拷贝失败: ${srcIcon}`, error.message);
      }
    }
  }

  const uniqueTargets = [];
  const seenTargets = new Set();
  for (const item of targets) {
    if (!item.target) {
      continue;
    }
    if (seenTargets.has(item.target)) {
      continue;
    }
    seenTargets.add(item.target);
    uniqueTargets.push(item);
  }

  let created = 0;
  let exists = 0;
  let skipped = 0;
  let dryRunCount = 0;
  let failed = 0;
  const failureMap = new Map();

  for (const target of uniqueTargets) {
    if (hasExistingFile(target.target) && !FORCE) {
      exists += 1;
      continue;
    }
    const status = DRY_RUN ? 'dry-run' : generatePngFromSvg(target.target, buildPlaceholderSvg(target.label, `技能 · ${path.basename(path.dirname(target.target))}`));
    if (status === 'created') {
      created += 1;
    } else if (status === 'dry-run') {
      dryRunCount += 1;
      console.log(`[计划] 生成占位图: ${path.relative(ROOT, target.target)}（技能：${target.label}）`);
    } else if (status === 'missing-tool') {
      skipped += 1;
    } else if (typeof status === 'string' && status.startsWith('failed:')) {
      failed += 1;
      failureMap.set(path.relative(ROOT, target.target), status.slice(7));
    }
  }

  console.log(`待处理单位目录: ${copyTargets.length}`);
  console.log(`待处理技能占位: ${uniqueTargets.length}`);
  console.log(`已存在: ${exists}`);
  console.log(`已创建: ${created}`);
  console.log(`dry-run: ${dryRunCount}`);
  console.log(`跳过(缺工具): ${skipped}`);
  console.log(`失败: ${failed}`);

  if (failureMap.size > 0) {
    console.log('失败明细：');
    for (const [filePath, reason] of failureMap.entries()) {
      console.log(`- ${filePath}: ${reason}`);
    }
  }
}

main();
