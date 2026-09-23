import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ASSET_ROOT,
  PROJECT_ROOT,
  toPosix,
} from './paths.mjs';
import { collectFiles } from './scan-files.mjs';
import { registeredAssetCatalog } from './workspace.mjs';

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
const HERO_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const HERO_IMAGE_CACHE = new Map();
const ASSET_REFERENCE_PATTERNS = [
  /!\[[^\]]*\]\(([^)\s]+)\)/g,
  /<img[^>]+src=['"]([^'"]+)['"][^>]*>/gi,
  /\[(?:[^\]]*)\]\(([^)\s]+)\)/g,
  /(?:^|[\s"'(])((?:\.?\.?\/)*\/?assets\/[^\r\n"'<>]*?\.(?:png|jpg|jpeg|webp|gif|svg))/gim,
];

function toSourceDirPosix(relativePath) {
  // A preview's virtual prefix is not part of the original document location.
  return toPosix(path.dirname(relativePath.replace(/^docs-standard\//, '')));
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
  const registered = await registeredAssetCatalog(PROJECT_ROOT);
  if (registered) return registered;
  const files = await collectFiles(ASSET_ROOT, {
    relativeBase: 'assets',
    isAccepted: (name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()),
  });
  const fileSet = new Set(files.map((filePath) => toPosix(filePath)));
  const byBaseName = new Map();

  for (const file of files) {
    const baseName = trimImageExt(path.basename(file)).toLowerCase();
    const list = byBaseName.get(baseName) || [];
    list.push(file);
    byBaseName.set(baseName, list);
  }

  return {
    files,
    byBaseName,
    fileSet,
  };
}

function normalizeCandidateImagePath(rawCandidate, sourceDir) {
  if (!rawCandidate) {
    return '';
  }

  let normalized = rawCandidate;
  if (!normalized.includes('assets/')) {
    return '';
  }

  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    normalized = toPosix(path.join(sourceDir, normalized));
  }

  normalized = normalized.replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!normalized.startsWith('assets/') || normalized.split('/').includes('..') || normalized.includes('\\')) {
    return '';
  }

  if (!IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    return '';
  }

  return toPosix(normalized);
}

function collectAssetImageRefs(rawText, sourcePath, assetCatalog = null) {
  if (!rawText) {
    return [];
  }

  const result = new Set();
  const relativeDir = toSourceDirPosix(sourcePath);
  const fileSet = assetCatalog?.fileSet;
  const hasFileSet = fileSet instanceof Set;
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
    // Decode URL syntax once so the catalog is queried with actual filenames.
    // Literal file names containing #/% remain addressable with %23/%25.
    try { return decodeURIComponent(withoutQuery); } catch { return null; }
  };

  for (const pattern of ASSET_REFERENCE_PATTERNS) {
    const matches = rawText.matchAll(pattern);
    for (const match of matches) {
      const candidate = cleanPath(match[1] || match[0]);
      if (!candidate) {
        continue;
      }

      const normalized = normalizeCandidateImagePath(candidate, relativeDir);
      if (!normalized) {
        continue;
      }

      if (!hasFileSet || assetCatalog?.registered || fileSet.has(normalized)) {
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
  const normalizedAttribute = typeof attribute === 'string' ? attribute.trim() : '';
  const normalizedHero = typeof hero === 'string' ? hero.trim() : '';
  if (!normalizedAttribute || !normalizedHero) {
    return [];
  }

  const cacheKey = `${normalizedAttribute}::${normalizedHero}`;
  const now = Date.now();
  const cached = HERO_IMAGE_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.paths;
  }

  const heroDir = path.join(ASSET_ROOT, 'images', 'heros', normalizedAttribute, normalizedHero);
  try {
    const items = await fs.readdir(heroDir);
    const result = items
      .filter((name) => path.extname(name).toLowerCase() === '.png')
      .sort()
      .map((name) => toPosix(path.join('assets', 'images', 'heros', normalizedAttribute, normalizedHero, name)));

    HERO_IMAGE_CACHE.set(cacheKey, {
      paths: result,
      expiresAt: now + HERO_IMAGE_CACHE_TTL_MS,
    });
    return result;
  } catch {
    return [];
  }
}

function clearHeroImageCache() {
  HERO_IMAGE_CACHE.clear();
}

export {
  IMAGE_EXTENSIONS,
  CATEGORY_IMAGE_DIRS,
  buildAssetImageCatalog,
  collectAssetImageRefs,
  collectFromCatalog,
  collectHeroImages,
  clearHeroImageCache,
  sortHeroImagesForDisplay,
  extractHeroSkillImageNames,
  normalizeImageMatchValue,
  normalizeImagePathList,
  isHeroPortraitImage,
  isImageNameMatchSkillToken,
};
