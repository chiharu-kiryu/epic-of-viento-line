import path from 'node:path';
import { TARGET_EXTENSIONS } from './config.mjs';

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function isTextLike(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '') {
    return true;
  }
  return TARGET_EXTENSIONS.has(extension);
}

function trimName(name) {
  return name.replace(/\.(md|txt|json|ya?ml)$/i, '');
}

function inferCategory(relPath) {
  const parts = relPath.split('/');
  if (parts[0] === 'design-data') {
    if (parts[1] === 'design-heros' && parts.length >= 4) {
      return {
        category: 'hero',
        group: `英雄 / ${parts[2]}`,
        meta: {
          attribute: parts[2],
          hero: parts[3],
        },
      };
    }
    if (parts[1] === 'design-item' && parts.length >= 4) {
      return { category: 'item', group: `物品 / ${parts[2]}/${parts[3]}` };
    }
    if (parts[1] === 'design-skills' && parts.length >= 4) {
      return { category: 'skill', group: `技能 / ${parts[2]}/${parts[3]}` };
    }
    if (parts[1] === 'design-units' && parts.length >= 3) {
      return {
        category: 'unit',
        group: `单位 / ${parts[2]}/${parts[3] || ''}`.trim().replace(/\/$/, ''),
      };
    }
    if (parts[1] === 'backstory' && parts.length >= 3) {
      return {
        category: 'backstory',
        group: `背景故事 / ${parts[2]}`,
        meta: {
          attribute: parts[2],
          hero: trimName(parts[3] || ''),
        },
      };
    }
    if (parts[1] === 'design-rules') {
      return { category: 'rule', group: '规则' };
    }
    if (parts[1] === 'design-building') {
      return { category: 'building', group: `建筑 / ${parts[2] || ''}`.trim().replace(/\/$/, '') };
    }
    if (parts[1] === 'design-scenes') {
      return { category: 'scene', group: '场景' };
    }
    if (parts[1] === 'design-template') {
      return { category: 'template', group: '模板' };
    }
  }
  if (relPath === 'README.md') {
    return { category: 'root', group: '根目录', meta: {} };
  }
  return { category: 'other', group: '其他', meta: {} };
}

function normalizeValue(value) {
  return (value || '').toString().trim();
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

function inferPurposeGroup(category, groupText, fields = {}, meta = {}) {
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
    const { type, subType } = splitItemGroup(groupText);
    const role = detectItemRole(fields);
    const roleLabel = role === '属性型' ? '通用' : role;
    if (subType === '价格表') {
      return `物品 / ${type} / ${roleLabel}`;
    }
    if (type === '消耗品' || type === '特殊') {
      return `物品 / ${type} / ${roleLabel}`;
    }
    if (subType) {
      return `物品 / ${type} / ${subType} / ${roleLabel}`;
    }
    return `物品 / ${type} / ${roleLabel}`;
  }

  const raw = normalizeValue(groupText);
  const pieces = raw.split('/').map((item) => item.trim()).filter(Boolean);
  if (pieces.length >= 2) {
    return `${pieces[0]} / ${pieces[1]}`;
  }
  return raw || `其他 / ${category}`;
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
