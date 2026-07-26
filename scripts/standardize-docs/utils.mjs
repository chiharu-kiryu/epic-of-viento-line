import path from 'node:path';
import {
  detectItemRole,
  inferCategory,
  inferPurposeGroup,
  normalizeValue,
  splitItemGroup,
} from '../lib/category.mjs';
import { toPosix, trimName } from '../lib/paths.mjs';

import { TARGET_EXTENSIONS } from './config.mjs';

function isTextLike(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '') {
    return true;
  }
  return TARGET_EXTENSIONS.has(extension);
}

function buildCategoryKey(categoryInfo = {}, relPath = '') {
  const category = normalizeValue(categoryInfo.category || '');
  if (category !== 'hero' && category !== 'backstory') {
    return null;
  }

  const attribute = normalizeValue(
    categoryInfo.attribute || categoryInfo.meta?.attribute || ''
  );
  const hero = normalizeValue(
    categoryInfo.hero || categoryInfo.meta?.hero || trimName(path.basename(relPath))
  );
  if (!hero) {
    return null;
  }

  if (attribute) {
    return `${attribute}||${hero}`;
  }
  return hero;
}

function normalizeKey(rawKey) {
  return rawKey.trim();
}

function toSlug(value, fallback) {
  const text = (value || '').trim().toLowerCase();
  const slug = text
    .normalize('NFKD')
    .replace(/[^\u4e00-\u9fff\w\s\-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback || `section-${Math.random().toString(16).slice(2, 8)}`;
}

export {
  toPosix,
  isTextLike,
  trimName,
  inferCategory,
  normalizeValue,
  splitItemGroup,
  detectItemRole,
  inferPurposeGroup,
  buildCategoryKey,
  normalizeKey,
  toSlug,
};
