import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { resolveHeroMeta, collectHeroSkillsFromSections } from './build-static-hero-skills.mjs';

const PROJECT_ROOT = process.cwd();
const ASSET_ROOT = path.join(PROJECT_ROOT, 'assets');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'web/data/index.json');
const OUTPUT_DIR = path.dirname(OUTPUT_PATH);
const STANDARD_ROOT = path.join(PROJECT_ROOT, 'docs-standard');
const INCLUDED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const SKIP_DIRS = new Set(['.git', '.DS_Store', 'node_modules', '.tmp']);
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

function normalizeValue(value) {
  return (value || '').toString().trim();
}

function normalizeStandardSourcePath(sourcePath) {
  const cleaned = toPosix((sourcePath || '').toString()).replace(/\\/g, '/');
  if (!cleaned) {
    return '';
  }
  const normalized = cleaned.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('docs-standard/design-data/')) {
    return normalized;
  }
  if (normalized.startsWith('design-data/')) {
    return `docs-standard/${normalized}`;
  }
  if (normalized.includes('/docs-standard/design-data/')) {
    const idx = normalized.indexOf('docs-standard/design-data/');
    return normalized.slice(idx);
  }
  if (normalized.includes('/design-data/')) {
    const idx = normalized.indexOf('design-data/');
    return `docs-standard/${normalized.slice(idx)}`;
  }
  const absoluteRoot = toPosix(PROJECT_ROOT);
  const withoutRoot = normalized.startsWith(`${absoluteRoot}/`) ? normalized.slice(absoluteRoot.length + 1) : normalized;
  if (withoutRoot.startsWith('docs-standard/design-data/')) {
    return withoutRoot;
  }
  if (withoutRoot.startsWith('design-data/')) {
    return `docs-standard/${withoutRoot}`;
  }
  return normalized;
}

function classifyPathSegments(sourcePath) {
  const segments = normalizeStandardSourcePath(sourcePath).split('/').filter(Boolean);
  if (segments[0] === 'docs-standard' && segments[1] === 'design-data') {
    return segments.slice(1);
  }
  return segments;
}

function splitItemGroup(groupText) {
  const raw = normalizeValue(groupText).replace(/^物品\s*\/\s*/, '');
  const parts = raw.split('/').map((item) => item.trim()).filter(Boolean);
  const rawSubType = parts[1] ? parts[1].replace(/\.json$/i, '') : '';
  return {
    type: parts[0] || '物品',
    subType: rawSubType || '',
  };
}

function detectItemRole(fields = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(fields, key);
  const hasValue = (key) => {
    if (!has(key)) {
      return false;
    }
    const value = normalizeValue(fields[key]);
    return value !== '' && value !== '-';
  };
  const hasKeyPattern = (pattern) => Object.keys(fields).some((key) => pattern.test(normalizeValue(key)));
  const hasValuePattern = (pattern) => Object.values(fields).some((value) => pattern.test(normalizeValue(value)));

  const hasActive = has('主动') || has('主动技能') || has('主动能力') || hasKeyPattern(/主动/);
  const hasPassive = has('被动') || has('被动技能') || has('被动能力') || hasKeyPattern(/被动/);
  const hasActiveEffect = hasValue('主动效果');
  const hasPassiveEffect = hasValue('被动效果');
  if ((hasActive || hasActiveEffect) && (hasPassive || hasPassiveEffect)) {
    return '主动·被动';
  }
  if (hasActive || hasActiveEffect) {
    return '主动';
  }
  if (hasPassive || hasPassiveEffect) {
    return '被动';
  }

  const hasDamage = hasKeyPattern(/伤害|攻击|爆发|法术伤害|物理伤害|暴击/) || hasValuePattern(/伤害|攻击|法术|暴击/);
  const hasDefense = hasKeyPattern(/护甲|魔抗|法抗|抗性|护盾|回血|生命|治疗|回血/) || hasValuePattern(/护甲|魔抗|法抗|抗性|治疗|回血|生命/);
  const hasControl = hasKeyPattern(/眩晕|沉默|减速|禁锢|控制|束缚|定身/) || hasValuePattern(/眩晕|沉默|减速|禁锢|控制|束缚|定身/);
  const hasUtility = hasKeyPattern(/消耗|冷却|位移|移动|视野|探测|回血|恢复|补给|携带/) || hasValuePattern(/消耗|冷却|位移|移动|视野|探测|恢复|补给|携带/);

  if (hasDamage) {
    return '输出';
  }
  if (hasControl) {
    return '控制';
  }
  if (hasDefense) {
    return '防御';
  }
  if (hasUtility) {
    return '功能';
  }

  return '通用';
}

function inferPurposeGroup(category, sourcePath, rawGroup, fields = {}, meta = {}) {
  const metaPurpose = normalizeValue(meta.purpose);
  if (metaPurpose) {
    return metaPurpose;
  }

  if (category === 'hero') {
    const attr = normalizeValue(meta.attribute) || normalizeValue(fields.主属性) || '其他属性';
    const rawAttackType = normalizeValue(fields.攻击类型 || fields.类型 || '');
    const attackType = normalizeValue(rawAttackType.split(/[,，]/)[0] || '未标注');
    return `英雄 / ${attr} / ${attackType}`;
  }

  if (category === 'item') {
    const { type, subType } = splitItemGroup(rawGroup);
    if (subType === '价格表') {
      return `物品 / ${type} / 通用`;
    }
    const role = detectItemRole(fields);
    const roleLabel = role === '属性型' ? '通用' : role;
    if (type === '消耗品' || type === '特殊') {
      return `物品 / ${type} / ${roleLabel}`;
    }
    if (subType) {
      return `物品 / ${type} / ${subType} / ${roleLabel}`;
    }
    return `物品 / ${type} / ${roleLabel}`;
  }

  const raw = normalizeValue(rawGroup);
  const segments = raw.split('/').map((item) => item.trim()).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[0]} / ${segments[1]}`;
  }
  return raw || `其他 / ${category}`;
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

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function trimExt(name) {
  return name.replace(/\.md$|\.txt$|\.json$|\.yml$|\.yaml$/i, '');
}

function isTextPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '' || INCLUDED_EXTENSIONS.has(ext);
}

function classify(relativePath) {
  const parts = classifyPathSegments(relativePath);
  if (parts.length >= 2 && parts[0] === 'design-data') {
    if (parts[1] === 'design-heros' && parts.length >= 4) {
      return {
        category: 'hero',
        group: `英雄 / ${parts[2]}`,
        meta: { attribute: parts[2], hero: parts[3] },
      };
    }
    if (parts[1] === 'design-item' && parts.length >= 4) {
      return {
        category: 'item',
        group: `物品 / ${parts[2]}/${parts[3]}`,
      };
    }
    if (parts[1] === 'design-skills' && parts.length >= 4) {
      return {
        category: 'skill',
        group: `技能 / ${parts[2]}/${parts[3]}`,
      };
    }
    if (parts[1] === 'design-units' && parts.length >= 3) {
      const unitType = parts[2] || '';
      const unitSub = parts[3] || '';
      return {
        category: 'unit',
        group: unitSub ? `单位 / ${unitType}/${unitSub}` : `单位 / ${unitType}`,
      };
    }
    if (parts[1] === 'backstory' && parts.length >= 3) {
      return {
        category: 'backstory',
        group: `背景故事 / ${parts[2]}`,
        meta: { attribute: parts[2], hero: parts[3] },
      };
    }
    if (parts[1] === 'design-rules') {
      return { category: 'rule', group: '规则' };
    }
    if (parts[1] === 'design-building') {
      return { category: 'building', group: `建筑 / ${parts[2] || ''}` };
    }
    if (parts[1] === 'design-scenes') {
      return { category: 'scene', group: '场景' };
    }
    if (parts[1] === 'design-template') {
      return { category: 'template', group: '模板' };
    }
    return { category: 'other', group: parts[1] || '其他' };
  }
  return { category: 'other', group: '其他' };
}

function toDisplayPath(sourceCategory, sourcePath, sourceMeta = {}, name) {
  const normalizedCategory = sourceCategory || 'other';
  const normalizedName = trimExt(name || '');
  const rawSegments = classifyPathSegments(sourcePath);
  const startIndex = rawSegments[0] === 'design-data' ? 1 : 0;
  const normalizedSegments = rawSegments.slice(startIndex);
  const fallbackSegments = (normalizedCategory === 'other' || normalizedCategory === 'root')
    ? rawSegments
    : normalizedSegments;

  if (normalizedCategory === 'hero') {
    const attr = normalizeValue(sourceMeta.attribute || normalizedSegments[1] || '通用');
    const hero = normalizeValue(sourceMeta.hero || normalizedName);
    return toPosix(path.join('hero', attr, hero));
  }

  if (normalizedCategory === 'backstory') {
    const attr = normalizeValue(sourceMeta.attribute || normalizedSegments[1] || '通用');
    const hero = normalizeValue(sourceMeta.hero || normalizedSegments[2] || normalizedName);
    return toPosix(path.join('hero', attr, hero, 'story'));
  }

  if (normalizedCategory === 'item') {
    return toPosix(path.join('item', ...normalizedSegments.slice(1)));
  }

  if (normalizedCategory === 'skill') {
    return toPosix(path.join('skill', ...normalizedSegments.slice(1)));
  }

  if (normalizedCategory === 'unit') {
    return toPosix(path.join('unit', ...normalizedSegments.slice(1)));
  }

  if (normalizedCategory === 'building') {
    return toPosix(path.join('building', ...normalizedSegments.slice(1)));
  }

  if (normalizedCategory === 'scene') {
    return toPosix(path.join('scene', normalizedName));
  }

  if (normalizedCategory === 'rule') {
    return toPosix(path.join('rule', normalizedName));
  }

  if (normalizedCategory === 'template') {
    return toPosix(path.join('template', normalizedName));
  }

  if (normalizedName) {
    if (fallbackSegments.length > 0) {
      const fullSegments = fallbackSegments.slice(0, -1).concat([normalizedName]);
      return toPosix(path.join(normalizedCategory, ...fullSegments));
    }
    return toPosix(path.join(normalizedCategory, normalizedName));
  }

  if (fallbackSegments.length > 0) {
    return toPosix(path.join(normalizedCategory, ...fallbackSegments));
  }

  return '';
}

function trimImageExt(fileName) {
  return fileName.replace(/\.[^.]+$/i, '');
}

function toSourceDirPosix(relativePath) {
  return toPosix(path.dirname(relativePath));
}

async function collectImageFiles(rootDir, relativeBase = '') {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const absolute = path.join(rootDir, entry.name);
    const relative = toPosix(path.join(relativeBase, entry.name));

    if (entry.isDirectory()) {
      const nested = await collectImageFiles(absolute, relative);
      files.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(relative);
    }
  }

  return files;
}

async function buildAssetImageCatalog() {
  const files = await collectImageFiles(ASSET_ROOT, 'assets');
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
      if (!assetMeta.byBaseName.size) {
        continue;
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

async function collectImagesForSourceDoc(standardDoc, sourcePath, sourceCategory, sourceMeta, assetCatalog) {
  const rawText = standardDoc.raw || '';
  const normalizedName = path.basename(sourcePath);
  const baseName = trimExt(normalizedName);
  const explicitPaths = collectAssetImageRefs(rawText, sourcePath);
  const matched = new Set(explicitPaths);

  const cls = sourceCategory || 'other';
  const { attribute, hero } = resolveHeroMeta(cls, sourceMeta, sourcePath);

  if (cls === 'hero') {
    if (attribute && hero) {
      const heroImages = await collectHeroImages(attribute, hero);
      heroImages.forEach((item) => matched.add(item));
    }
  }

  const byNameMatches = collectFromCatalog(cls, normalizedName, assetCatalog);
  for (const item of byNameMatches) {
    matched.add(item);
  }

  const baseNameMatches = collectFromCatalog(cls, baseName, assetCatalog);
  for (const item of baseNameMatches) {
    matched.add(item);
  }

  const fallbackByName = assetCatalog.byBaseName.get(trimImageExt(baseName).toLowerCase()) || [];
  fallbackByName.forEach((item) => matched.add(item));

  return [...matched].sort();
}

async function findFiles(rootDir, relativeBase = '') {
  if (!fsSync.existsSync(rootDir)) {
    return [];
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const list = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = path.join(rootDir, entry.name);
    const relative = toPosix(path.join(relativeBase, entry.name));
    if (entry.isDirectory()) {
      const nested = await findFiles(absolute, relative);
      list.push(...nested);
      continue;
    }
    if (entry.isFile() && isTextPath(entry.name)) {
      list.push(relative);
    }
  }
  return list;
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

function sourcePathFromStandardDoc(standardDoc, relativePath) {
  const sourcePath = standardDoc?.source?.path;
  if (typeof sourcePath === 'string' && sourcePath.trim()) {
    return normalizeStandardSourcePath(sourcePath);
  }
  const fallback = normalizeStandardSourcePath(relativePath);
  return fallback.replace(/\.json$/, '');
}

function normalizeBackstoryPayload(backstory) {
  if (!backstory || typeof backstory !== 'object') {
    return null;
  }

  const backstorySourcePath = normalizeStandardSourcePath(backstory.source?.path || backstory.rawPath || '');
  const normalizedRawPath = backstorySourcePath || backstory.rawPath || '';

  return {
    ...backstory,
    source: {
      ...backstory.source,
      path: backstorySourcePath || backstory.source?.path || '',
    },
    rawPath: normalizedRawPath,
    meta: {
      ...backstory.meta,
      source: backstorySourcePath || backstory.meta?.source || '',
    },
  };
}

function sourceTypeFromPath(sourcePath) {
  const extension = path.extname(sourcePath);
  if (!extension) {
    return 'txt';
  }
  return extension.replace('.', '');
}

async function buildIndexFromStandard(assetCatalog) {
  const files = await findFiles(STANDARD_ROOT, 'docs-standard');
  const docs = [];

  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const rawStandard = await fs.readFile(absolutePath, 'utf8');
    const standardDoc = JSON.parse(rawStandard);
    const sourcePath = sourcePathFromStandardDoc(standardDoc, relPath);
    const normalizedName = trimExt(path.basename(sourcePath));
    const sourceCategory = standardDoc.meta?.category || 'other';
    const cls = classify(sourcePath);
    const effectiveCategory = sourceCategory || cls.category;
    const sourceMeta = standardDoc.meta || cls.meta || {};
    const fileName = path.basename(sourcePath);
      const group = sourceCategory && sourceCategory !== 'other' ? standardDoc.meta?.group || cls.group : cls.group;
      const fields = standardDoc.fields || {};
      const title = standardDoc.meta?.title || normalizedName;
    const imageList = await collectImagesForSourceDoc(
      standardDoc,
      sourcePath,
      effectiveCategory,
      sourceMeta,
      assetCatalog
    );
    const heroSkills = effectiveCategory === 'hero'
      ? collectHeroSkillsFromSections(standardDoc.sections || [], imageList)
      : [];

    docs.push({
      path: toDisplayPath(effectiveCategory, sourcePath, sourceMeta, normalizedName),
      title,
      name: normalizedName,
      category: sourceCategory || cls.category,
      displayPath: toDisplayPath(effectiveCategory, sourcePath, sourceMeta, normalizedName),
      group: inferPurposeGroup(
        sourceCategory || cls.category,
        sourcePath,
        group || cls.group,
        fields,
        standardDoc.meta || cls.meta || {},
      ) || (group || cls.group),
      source: {
        ...standardDoc.source,
        path: sourcePath,
      },
      meta: {
        source: sourcePath,
        ...standardDoc.meta,
        category: sourceCategory || cls.category,
        group: group || cls.group,
        purpose: inferPurposeGroup(
          sourceCategory || cls.category,
          sourcePath,
          group || cls.group,
          fields,
          standardDoc.meta || cls.meta || {},
        ),
        schemaVersion: standardDoc.schemaVersion || 'standard-doc-v1',
      },
      fields,
      backstory: normalizeBackstoryPayload(standardDoc.backstory),
      sections: standardDoc.sections || [],
      outline: standardDoc.outline || [],
      blocks: standardDoc.blocks || [],
      type: sourceTypeFromPath(sourcePath),
      lastModified: standardDoc.source?.modifiedAt || new Date().toISOString(),
      size: standardDoc.source?.size || 0,
      content: standardDoc.raw || JSON.stringify(standardDoc.data || standardDoc, null, 2),
      heroImages: imageList,
      heroSkills,
      standardPath: relPath,
      parser: standardDoc.parser || {},
      parserStats: standardDoc.parserStats || standardDoc.blockStats || {},
    });
  }

  return docs;
}

async function buildIndex() {
  const assetCatalog = await buildAssetImageCatalog();
  const shouldUseStandard = fsSync.existsSync(STANDARD_ROOT);
  if (shouldUseStandard) {
    const docs = await buildIndexFromStandard(assetCatalog);
    docs.sort((a, b) => {
      if (a.group !== b.group) {
        return a.group.localeCompare(b.group, 'zh-CN');
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return {
      generatedAt: new Date().toISOString(),
      count: docs.length,
      docs,
    };
  }

  throw new Error(`未检测到标准化目录：${path.relative(PROJECT_ROOT, STANDARD_ROOT)}`);
}

async function main() {
  const index = await buildIndex();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(index)}\n`, 'utf8');
  console.log(`Static index created: ${OUTPUT_PATH}`);
  console.log(`docs=${index.count}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
