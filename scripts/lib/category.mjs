import path from 'node:path';
import { toPosix, trimName } from './paths.mjs';

function normalizeSegments(rawPath = '') {
  return toPosix(rawPath)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/+/, '/')
    .split('/')
    .filter(Boolean);
}

function normalizeDesignDataSegments(rawPath = '') {
  const segments = normalizeSegments(rawPath);
  if (segments[0] === 'docs-standard' && segments[1] === 'design-data') {
    return segments.slice(1);
  }
  return segments;
}

function normalizeValue(value) {
  return (value || '').toString().trim();
}

function inferCategory(rawPath = '') {
  const parts = normalizeDesignDataSegments(rawPath);

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
      const itemSubType = normalizeValue(parts[3]).replace(/\.json$/i, '');
      return {
        category: 'item',
        group: `物品 / ${parts[2]}/${itemSubType}`,
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
      const unitSubType = parts[3] || '';
      return {
        category: 'unit',
        group: unitSubType ? `单位 / ${unitType}/${unitSubType}` : `单位 / ${unitType}`,
      };
    }
    if (parts[1] === 'backstory' && parts.length >= 3) {
      return {
        category: 'backstory',
        group: `背景故事 / ${parts[2]}`,
        meta: {
          attribute: parts[2],
          hero: parts[3],
        },
      };
    }
    if (parts[1] === 'design-rules') {
      return { category: 'rule', group: '规则' };
    }
    if (parts[1] === 'design-building') {
      return {
        category: 'building',
        group: `建筑 / ${parts[2] || ''}`.trim().replace(/\/$/, ''),
      };
    }
    if (parts[1] === 'design-scenes') {
      return { category: 'scene', group: '场景' };
    }
    if (parts[1] === 'design-template') {
      return { category: 'template', group: '模板' };
    }
    return {
      category: 'other',
      group: parts[1] || '其他',
    };
  }

  if (rawPath === 'README.md') {
    return { category: 'root', group: '根目录' };
  }

  return { category: 'other', group: '其他' };
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
      return `物品 / ${type} / 通用`;
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
  const segments = raw.split('/').map((item) => item.trim()).filter(Boolean);

  if (segments.length >= 2) {
    return `${segments[0]} / ${segments[1]}`;
  }

  return raw || `其他 / ${category}`;
}

function buildDisplayPath(sourceCategory, sourcePath, sourceMeta = {}, name) {
  const normalizedCategory = sourceCategory || 'other';
  const normalizedName = trimName(name || '');
  const rawSegments = normalizeSegments(sourcePath || '');
  const designDataSegments = normalizeDesignDataSegments(sourcePath || '');
  const normalizedSegments = designDataSegments[0] === 'design-data'
    ? designDataSegments.slice(1)
    : designDataSegments;
  const fallbackSegments = (normalizedCategory === 'other' || normalizedCategory === 'root')
    ? rawSegments
    : normalizedSegments;

  if (normalizedCategory === 'hero') {
    const attr = normalizeValue(sourceMeta.attribute || fallbackSegments[1] || '通用');
    const hero = normalizeValue(sourceMeta.hero || normalizedName);
    return toPosix(path.join('hero', attr, hero));
  }

  if (normalizedCategory === 'backstory') {
    const attr = normalizeValue(sourceMeta.attribute || fallbackSegments[1] || '通用');
    const hero = normalizeValue(sourceMeta.hero || fallbackSegments[2] || normalizedName);
    return toPosix(path.join('hero', attr, hero, 'story'));
  }

  if (normalizedCategory === 'item') {
    return toPosix(path.join('item', ...fallbackSegments.slice(1)));
  }

  if (normalizedCategory === 'skill') {
    return toPosix(path.join('skill', ...fallbackSegments.slice(1)));
  }

  if (normalizedCategory === 'unit') {
    return toPosix(path.join('unit', ...fallbackSegments.slice(1)));
  }

  if (normalizedCategory === 'building') {
    return toPosix(path.join('building', ...fallbackSegments.slice(1)));
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

export {
  inferCategory,
  splitItemGroup,
  detectItemRole,
  inferPurposeGroup,
  buildDisplayPath,
  normalizeValue,
};
