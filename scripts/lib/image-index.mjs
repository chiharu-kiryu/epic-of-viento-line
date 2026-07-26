import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_ROOT,
  ASSET_ROOT,
  toPosix,
} from './paths.mjs';
import { collectFiles } from './scan-files.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const CATEGORY_IMAGE_DIRS = {
  backstory: ['assets/images/heros'],
  hero: ['assets/images/heros'],
  unit: ['assets/images/units'],
  item: ['assets/images/item'],
  skill: ['assets/images/skills'],
  scene: ['assets/images/scenes'],
  building: ['assets/images/building'],
  rule: ['assets/images/rules'],
  template: ['assets/images/template'],
};
const HERO_PORTRAIT_KEYWORDS = ['原画', '立绘', '封面', '头像', 'hero', 'portrait', 'cover', '原画图', '立绘图'];

function toSourceDirPosix(relativePath) {
  return toPosix(path.dirname(relativePath));
}

function trimImageExt(fileName = '') {
  return fileName.replace(/\.[^.]+$/i, '');
}

function normalizeAssetFilename(value) {
  const normalized = (value || '').toString().trim();
  if (!normalized) {
    return '';
  }
  const base = normalized.split('/').at(-1);
  return base ? base.replace(/\.[^.]+$/u, '') : '';
}

function normalizeImageMatchValue(value) {
  return (value || '').toString()
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\uFEFF]/g, '')
    .replace(/[\s\-_.:：()（）【】\[\]]/g, '')
    .replace(/[“”‘’"']/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

async function buildAssetImageCatalog() {
  const files = await collectFiles(ASSET_ROOT, {
    relativeBase: 'assets',
    isAccepted: (name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()),
  });
  const byBaseName = new Map();

  for (const file of files) {
    const baseName = trimImageExt(path.basename(file)).toLowerCase();
    const list = byBaseName.get(baseName) || [];
    list.push(file);
    byBaseName.set(baseName, list);
  }

  return { files, byBaseName };
}

function collectAssetImageRefs(rawText, sourcePath) {
  if (!rawText) {
    return [];
  }

  const result = new Set();
  const relativeDir = toSourceDirPosix(sourcePath);
  const cleanPath = (url) => {
    if (!url) {
      return null;
    }
    const withoutQuery = url.split('?')[0].split('#')[0].trim();
    if (!withoutQuery) {
      return null;
    }
    if (/^https?:\/\//i.test(withoutQuery)) {
      return null;
    }
    return withoutQuery;
  };

  const patterns = [
    /!\[[^\]]*\]\(([^\)\s]+)\)/g,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
    /\[(?:[^\]]*)\]\(([^\)\s]+)\)/g,
    /assets\/images\/.+?\.(?:png|jpg|jpeg|webp|gif|svg)/gi,
  ];

  for (const pattern of patterns) {
    const matches = rawText.matchAll(pattern);
    for (const match of matches) {
      const candidate = cleanPath(match[1] || match[0]);
      if (!candidate) {
        continue;
      }

      let normalized = candidate;

      if (!normalized.includes('assets/')) {
        continue;
      }

      const assetIndex = candidate.indexOf('assets/images/');
      if (assetIndex > -1) {
        normalized = candidate.slice(assetIndex);
      }

      if (candidate.startsWith('/')) {
        normalized = candidate.slice(1);
      }
      if (candidate.startsWith('./') || candidate.startsWith('../')) {
        normalized = toPosix(path.join(relativeDir, candidate));
      }

      normalized = normalized.replace(/^\.\//, '').replace(/\/+/, '/');

      if (!normalized.includes('assets/images/')) {
        normalized = toPosix(path.join('assets', 'images', normalized));
      }

      if (!IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
        continue;
      }

      const absolutePath = path.join(PROJECT_ROOT, normalized);
      if (fsSync.existsSync(absolutePath)) {
        result.add(toPosix(normalized));
      }
    }
  }

  return [...result];
}

function normalizeImagePathList(imageFiles, name) {
  if (!name) {
    return imageFiles;
  }

  const lc = trimImageExt(name).toLowerCase();
  return imageFiles.filter((imagePath) => {
    const base = trimImageExt(path.basename(imagePath)).toLowerCase();
    return base === lc || base.includes(lc) || lc.includes(base);
  });
}

function isHeroPortraitImage(imagePath) {
  const base = normalizeAssetFilename(imagePath);
  if (!base) {
    return false;
  }
  const text = base.toString().trim().toLowerCase();
  return HERO_PORTRAIT_KEYWORDS.some((keyword) => text.includes(keyword));
}

function extractHeroSkillImageNames(skillEntries = []) {
  const names = [];
  const seen = new Set();

  for (const skill of skillEntries) {
    const sourceName = (skill?.name || skill?.key || '').toString().trim();
    if (!sourceName) {
      continue;
    }
    const normalized = normalizeImageMatchValue(sourceName);
    if (normalized && !seen.has(normalized) && normalized.length > 1) {
      seen.add(normalized);
      names.push(normalized);
    }
  }

  return names;
}

function isImageNameMatchSkillToken(fileName, skillTokens = []) {
  const target = normalizeImageMatchValue(fileName);
  if (!target) {
    return false;
  }
  for (const token of skillTokens) {
    if (!token) {
      continue;
    }
    if (target === token || target.includes(token) || token.includes(target)) {
      return true;
    }
  }
  return false;
}

function sortHeroImagesForDisplay(rawImages = [], heroSkills = []) {
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    return [];
  }

  const uniqueImages = [];
  const seenImages = new Set();
  for (const image of rawImages) {
    const current = (image || '').toString().trim();
    if (!current || seenImages.has(current)) {
      continue;
    }
    seenImages.add(current);
    uniqueImages.push(current);
  }

  if (!uniqueImages.length) {
    return [];
  }

  const output = [];
  const used = new Set();
  const markUsed = (imagePath) => {
    const current = (imagePath || '').toString().trim();
    if (!current || used.has(current)) {
      return;
    }
    used.add(current);
    output.push(current);
  };

  const portrait = uniqueImages.find((image) => isHeroPortraitImage(image));
  if (portrait) {
    markUsed(portrait);
  }

  const skillIcons = Array.isArray(heroSkills)
    ? heroSkills.map((skill) => (skill?.icon || '').toString().trim())
    : [];
  for (const icon of skillIcons) {
    if (!icon) {
      continue;
    }
    if (uniqueImages.includes(icon)) {
      markUsed(icon);
    }
  }

  const skillTokens = extractHeroSkillImageNames(heroSkills);
  for (const image of uniqueImages) {
    if (used.has(image)) {
      continue;
    }
    if (isImageNameMatchSkillToken(image, skillTokens)) {
      markUsed(image);
    }
  }

  for (const image of uniqueImages) {
    if (!used.has(image)) {
      markUsed(image);
    }
  }

  return output;
}

function collectFromCatalog(category, name, assetMeta) {
  const results = [];
  const normalizedCategory = category || 'other';

  if (CATEGORY_IMAGE_DIRS[normalizedCategory]) {
    const preferredDirs = CATEGORY_IMAGE_DIRS[normalizedCategory];
    for (const dir of preferredDirs) {
      const prefix = `${dir}/`;
      const sameName = normalizeImagePathList(assetMeta.files, name);
      for (const candidate of sameName) {
        if (candidate.startsWith(prefix)) {
          results.push(candidate);
        }
      }

      const baseCandidates = assetMeta.byBaseName.get(trimImageExt(name).toLowerCase()) || [];
      for (const candidate of baseCandidates) {
        if (candidate.startsWith(prefix)) {
          results.push(candidate);
        }
      }
    }
  }

  return dedupeItems(results).sort();
}

async function collectHeroImages(attribute, hero) {
  const heroDir = path.join(ASSET_ROOT, 'images', 'heros', attribute, hero);
  try {
    const items = await fs.readdir(heroDir);
    return items
      .filter((name) => path.extname(name).toLowerCase() === '.png')
      .sort()
      .map((name) => toPosix(path.join('assets', 'images', 'heros', attribute, hero, name)));
  } catch {
    return [];
  }
}

export {
  IMAGE_EXTENSIONS,
  CATEGORY_IMAGE_DIRS,
  buildAssetImageCatalog,
  collectAssetImageRefs,
  collectFromCatalog,
  collectHeroImages,
  sortHeroImagesForDisplay,
  extractHeroSkillImageNames,
  normalizeImageMatchValue,
  normalizeImagePathList,
  isHeroPortraitImage,
  isImageNameMatchSkillToken,
};
