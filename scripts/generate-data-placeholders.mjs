#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, INDEX_OUTPUT } from './lib/paths.mjs';

const INDEX_PATH = INDEX_OUTPUT;
const DEFAULT_ARGS = new Set(process.argv.slice(2));

const FORCE_REGENERATE = DEFAULT_ARGS.has('--force');
const DRY_RUN = DEFAULT_ARGS.has('--dry-run');
const ALLOW_MISSING_SIPS = DEFAULT_ARGS.has('--skip-sips') || DEFAULT_ARGS.has('--dry-run');

const CATEGORY_PLACEHOLDER_ROOT = {
  item: 'assets/images/item',
  unit: 'assets/images/units',
  skill: 'assets/images/skills',
  building: 'assets/images/building',
  scene: 'assets/images/scene',
};

const CANVAS = {
  size: 768,
  topColor: '#141b2f',
  bottomColor: '#0b1122',
};

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-placeholders-'));
const cleanup = () => {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (error) {
    // ignore cleanup failure
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

function normalizePathSegment(value) {
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

function hashToHue(value) {
  const text = String(value || '').normalize('NFKC');
  if (!text) {
    return 0;
  }
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function splitLabel(value, maxLineLength = 12, maxLineCount = 2) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text) {
    return ['文档'];
  }
  if (text.length <= maxLineLength) {
    return [text];
  }

  const lines = [];
  for (let start = 0; start < text.length && lines.length < maxLineCount; start += maxLineLength) {
    lines.push(text.slice(start, start + maxLineLength));
  }
  return lines.slice(0, maxLineCount);
}

function buildPlaceholderSvg(label, subtitle) {
  const size = CANVAS.size;
  const safeLabel = normalizePathSegment(label);
  const hue = hashToHue(safeLabel);
  const hue2 = (hue + 55 + safeLabel.length * 7) % 360;
  const titleLines = splitLabel(safeLabel, 12, 2);
  const subtitleText = normalizePathSegment(subtitle || '').slice(0, 20);

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
      <stop offset="0%" stop-color="${CANVAS.topColor}" />
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
</svg>`;
}

function ensureDir(targetPath) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
}

function hasFile(targetAbsPath) {
  try {
    return fs.statSync(targetAbsPath).isFile();
  } catch {
    return false;
  }
}

function generatePngFromSvg(targetAbsPath, svgContent) {
  if (!ALLOW_MISSING_SIPS && !hasSipsBinary()) {
    return 'missing-tool';
  }

  const tempSvgPath = path.join(TEMP_DIR, `${Date.now()}-${Math.floor(Math.random() * 10000)}.svg`);
  ensureDir(targetAbsPath);
  fs.writeFileSync(tempSvgPath, svgContent, 'utf8');
  if (DRY_RUN) {
    fs.unlinkSync(tempSvgPath);
    return 'dry-run';
  }

  try {
    execFileSync('sips', ['-s', 'format', 'png', tempSvgPath, '--out', targetAbsPath], { stdio: 'ignore' });
    fs.unlinkSync(tempSvgPath);
    return 'created';
  } catch (error) {
    fs.unlinkSync(tempSvgPath);
    return `failed:${error.message}`;
  }
}

let sipsAvailable;
function hasSipsBinary() {
  if (sipsAvailable !== undefined) {
    return sipsAvailable;
  }
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
    sipsAvailable = true;
    return true;
  } catch {
    sipsAvailable = false;
    return false;
  }
}

function collectPlaceholders(docs) {
  const targets = new Map();
  const addTarget = (relativePath, label, subtitle) => {
    if (!relativePath) {
      return;
    }
    const normalized = relativePath.replace(/\\/g, '/');
    if (!targets.has(normalized)) {
      targets.set(normalized, { label, subtitle });
    }
  };

  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') {
      continue;
    }

    const sourceExt = String(doc?.source?.extension || '').toLowerCase().trim();
    const sourcePath = String(doc?.source?.path || '').toLowerCase().trim();
    if (sourceExt === '.md' || sourcePath.endsWith('.md')) {
      continue;
    }

    const category = String(doc.category || '').trim();
    const docPath = String(doc.path || '').trim();
    if (!docPath) {
      continue;
    }
    const segments = docPath.split('/').map((item) => item.trim()).filter(Boolean);
    if (segments.length < 2) {
      continue;
    }
    const docName = normalizePathSegment(doc.name || segments.at(-1) || doc.title || '文档');

    if (category === 'hero') {
      const attr = normalizePathSegment(segments[1]);
      const heroName = normalizePathSegment(segments[2] || docName);
      const heroImages = Array.isArray(doc.heroImages) ? doc.heroImages : [];
      if (heroImages.length === 0) {
        const file = path.posix.join('assets/images/heros', attr, heroName, `${heroName}.png`);
        addTarget(file, heroName, `${attr} 英雄`);
      }
      continue;
    }

    const base = CATEGORY_PLACEHOLDER_ROOT[category];
    if (!base) {
      continue;
    }

    const folderParts = segments.slice(1, -1).map((segment) => normalizePathSegment(segment));
    const file = path.posix.join(base, ...folderParts, `${docName}.png`);
    const subtitle = category === 'template' ? '模板' : '文档';
    addTarget(file, docName, subtitle);
  }

  return targets;
}

async function main() {
  const indexRaw = fs.readFileSync(INDEX_PATH, 'utf8');
  const parsed = JSON.parse(indexRaw);
  const docs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.docs) ? parsed.docs : []);
  if (!Array.isArray(docs) || docs.length === 0) {
    console.error('[placeholder] 无法读取文档数据：web/data/index.json 内 docs 为空。');
    process.exitCode = 1;
    return;
  }

  if (!hasSipsBinary() && !ALLOW_MISSING_SIPS) {
    console.error('[placeholder] 当前环境缺少 sips，无法生成 png。可加 --skip-sips 仅输出计划列表。');
    process.exitCode = 1;
    return;
  }

  const targets = collectPlaceholders(docs);
  let created = 0;
  let exists = 0;
  let skipped = 0;
  let failed = 0;
  let dryRunCount = 0;
  const failureMap = new Map();

  for (const [relative, meta] of targets.entries()) {
    const targetAbs = path.join(PROJECT_ROOT, relative);
    if (hasFile(targetAbs) && !FORCE_REGENERATE) {
      exists += 1;
      continue;
    }

    const status = DRY_RUN ? 'dry-run' : generatePngFromSvg(targetAbs, buildPlaceholderSvg(meta.label, meta.subtitle));
    if (status === 'created') {
      created += 1;
    } else if (status === 'dry-run') {
      dryRunCount += 1;
    } else if (status === 'missing-tool') {
      skipped += 1;
    } else if (typeof status === 'string' && status.startsWith('failed:')) {
      failed += 1;
      failureMap.set(relative, status.slice(7));
    }
  }

  console.log(`计划生成: ${targets.size}`);
  console.log(`已存在: ${exists}`);
  console.log(`已创建: ${created}`);
  console.log(`跳过(缺工具): ${skipped}`);
  console.log(`Dry-run: ${dryRunCount}`);
  console.log(`失败: ${failed}`);
  if (failureMap.size > 0) {
    console.log('失败明细：');
    for (const [filePath, reason] of failureMap.entries()) {
      console.log(`- ${filePath}: ${reason}`);
    }
  }

  if (!DRY_RUN && !FORCE_REGENERATE && exists > 0) {
    console.log('[placeholder] 已跳过已存在文件；如需覆盖请加 --force。');
  }
}

main().catch((error) => {
  console.error('[placeholder] 执行失败：', error?.message || error);
  process.exitCode = 1;
}).finally(() => {
  cleanup();
});
