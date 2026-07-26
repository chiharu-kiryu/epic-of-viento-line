import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSET_ROOT, DOC_ROOT } from './lib/paths.mjs';
import { collectFilesRecursive } from './lib/scan-files.mjs';
import { toUnixLineEndings } from './lib/normalize-text-utils.mjs';

const HERO_DOC_ROOT = path.join(DOC_ROOT, 'design-heros');
const HERO_IMAGE_ROOT = path.join(ASSET_ROOT, 'images', 'heros');
const VIDEO_ROOT = path.join(ASSET_ROOT, 'videos');

const SECTION_HEADERS = new Set([
  '天生技能：',
  '技能1：',
  '技能2：',
  '技能3：',
  '技能4：',
]);

function normalizeHeader(text) {
  return text.trim().replaceAll(':', '：');
}

function sortLocale(a, b) {
  return a.localeCompare(b, 'zh-Hans-CN');
}

async function walkHeroDocs() {
  const files = await collectFilesRecursive(HERO_DOC_ROOT, {
    relativeBase: '',
    acceptedExtensions: new Set(['', '.md', '.txt']),
  });
  return files
    .map((relativePath) => {
      const parts = relativePath.split('/');
      if (parts.length !== 2) {
        return null;
      }
      const [attr, hero] = parts;
      if (!attr || !hero) {
        return null;
      }
      return {
        attr,
        hero,
        full: path.join(HERO_DOC_ROOT, relativePath),
      };
    })
    .filter(Boolean)
    .sort((left, right) => sortLocale(`${left.attr}/${left.hero}`, `${right.attr}/${right.hero}`));
}

async function readLines(filePath) {
  const rawText = await fs.readFile(filePath, 'utf8');
  return toUnixLineEndings(rawText.replace(/^\uFEFF/, '')).split('\n');
}

function parseExpectedImageNames(lines) {
  const expected = ['原画.png'];
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeHeader(lines[index]);
    if (!SECTION_HEADERS.has(line)) {
      continue;
    }
    const next = lines.slice(index + 1).map((value) => value.trim()).find(Boolean);
    if (!next) {
      continue;
    }

    const imageName = next
      .replace(/[：:].*$/, '')
      .trim();

    if (!imageName) {
      continue;
    }

    const fileName = `${imageName}.png`;
    if (!expected.includes(fileName)) {
      expected.push(fileName);
    }
  }

  return expected;
}

async function listFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        names.push(entry.name);
      }
    }
    return names.sort(sortLocale);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function inspectHeroImages(heroMeta) {
  const { attr, hero, full } = heroMeta;
  const heroDir = path.join(HERO_IMAGE_ROOT, attr, hero);
  await fs.mkdir(heroDir, { recursive: true });

  const expected = parseExpectedImageNames(await readLines(full));
  const existing = await listFiles(heroDir);
  const existingPng = existing.filter((name) => name.toLowerCase().endsWith('.png'));
  const expectedSet = new Set(expected);

  const matched = expected.filter((name) => existingPng.includes(name));
  const missing = expected.filter((name) => !existingPng.includes(name));
  const unexpected = existingPng.filter((name) => !expectedSet.has(name));

  let status = '空目录';
  if (missing.length === 0 && expected.length > 0) {
    status = unexpected.length > 0 ? '已就绪（含额外文件）' : '已就绪';
  } else if (matched.length > 0 || existing.length > 0) {
    status = '部分完成';
  }

  const video = await fileExists(path.join(VIDEO_ROOT, `${hero}.mp4`));

  return {
    attr,
    hero,
    status,
    expected,
    existing,
    matched,
    missing,
    unexpected,
    video,
  };
}

const readme = `# Hero Images\n\n` +
`英雄图片资源沿用当前仓库已有格式：\n\n` +
`- 路径：\`assets/images/heros/<属性>/<英雄名>/\`\n` +
`- 原画文件：\`原画.png\`\n` +
`- 技能图文件：按英雄设计文档中的“天生技能 / 技能1-技能4”名称命名，例如 \`星空祈唤.png\`\n` +
`- 视频资源：与图片并列保存在 \`assets/videos/<英雄名>.mp4\`\n\n` +
`资源清单见 [资源对照表.md](/assets/images/heros/资源对照表.md)。\n`;

const heroes = await walkHeroDocs();
const rows = [];
let totalHeroes = 0;
let readyHeroes = 0;
let partialHeroes = 0;
let emptyHeroes = 0;
let videoCount = 0;

for (const hero of heroes) {
  const row = await inspectHeroImages(hero);
  totalHeroes += 1;
  if (row.status === '已就绪' || row.status === '已就绪（含额外文件）') {
    readyHeroes += 1;
  } else if (row.status === '部分完成') {
    partialHeroes += 1;
  } else {
    emptyHeroes += 1;
  }

  if (row.video) {
    videoCount += 1;
  }

  rows.push(row);
}

await fs.mkdir(HERO_IMAGE_ROOT, { recursive: true });

const summaryLines = [
  '# 英雄图片资源对照表',
  '',
  '## 汇总',
  '',
  `- 英雄总数：${totalHeroes}`,
  `- 已就绪：${readyHeroes}`,
  `- 部分完成：${partialHeroes}`,
  `- 空目录：${emptyHeroes}`,
  `- 已有视频：${videoCount}`,
  '',
  '## 说明',
  '',
  '- 期望文件名根据英雄设计文档自动提取，规则为 `原画.png + 天生技能名.png + 技能1-4名.png`。',
  '- `已就绪（含额外文件）` 表示核心图片已齐，但目录中还有额外命名文件。',
  '- 宙灵兽等特殊角色可能存在多形态原画，额外文件会保留，不做重命名。',
  '',
  '## 明细',
  '',
  '| 属性 | 英雄 | 状态 | 已有文件 | 缺失文件 | 视频 |',
  '| --- | --- | --- | --- | --- | --- |',
];

for (const row of rows) {
  summaryLines.push(
    `| ${row.attr} | ${row.hero} | ${row.status} | ${row.existing.length ? row.existing.join('<br>') : '-'} | ${row.missing.length ? row.missing.join('<br>') : '-'} | ${row.video ? '有' : '-'} |`,
  );
}

await fs.writeFile(path.join(HERO_IMAGE_ROOT, 'README.md'), `${readme}`, 'utf8');
await fs.writeFile(path.join(HERO_IMAGE_ROOT, '资源对照表.md'), `${summaryLines.join('\n')}\n`, 'utf8');
