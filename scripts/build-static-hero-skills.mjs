import path from 'node:path';

const HERO_SKILL_KEYS = new Set([
  '天生技能',
  '先天技能',
  '技能1',
  '技能2',
  '技能3',
  '技能4',
  '阳印',
  '阴印',
  '铸魔',
  '铸神',
]);

const NEW_SKILL_MARKERS = /^(?:获得新技能|新增技能|新增被动技能|新增主动技能|新增额外技能)$/;

function isLikelySkillDescription(key, value) {
  if (normalizeMatchValue(value).length > 20 && value.length > 20) {
    return true;
  }
  if (key === '阳印' || key === '阴印' || key === '铸神' || key === '铸魔') {
    return /[，。；%]|将|会|每秒|持续|范围|伤害|提高|增加|回复/.test(value);
  }
  return false;
}

function normalizeValue(value) {
  return (value || '').toString().trim();
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function trimExtName(name) {
  return name.replace(/\.[^.]+$/i, '');
}

function stripSkillSuffixes(value) {
  return normalizeValue(value)
    .replace(/[：:]+$/u, '')
    .trim();
}

function isLikelyDescriptionPrefix(value) {
  const trimmed = stripSkillSuffixes(value);
  if (!trimmed) {
    return false;
  }
  return /^(?:伤害|持续|范围|冷却|施法距离|施法范围|魔力消耗|攻击距离|攻击速度|移动速度|护甲|魔抗|debuff|基础|间隔|回复|击退|回血|每秒|伤害间隔|作用间隔|弧线|角度|弹道速度|持续时间|减速|伤害系数|层数)/.test(trimmed);
}

function isLikelyForgedOrRuneName(key, value) {
  if (key !== '铸神' && key !== '铸魔') {
    return true;
  }

  const normalized = normalizeMatchValue(value);
  if (normalized.length > 12) {
    return false;
  }
  if (/[0-9%+]/.test(value)) {
    return false;
  }
  if (isLikelyDescriptionPrefix(value)) {
    return false;
  }
  return true;
}

function normalizeForNameCompare(value) {
  return normalizeMatchValue(value)
    .replace(/(?:持续|造成|可以|能够|并且|可以)?(?:会|期间|提高|增加|减少|获得|触发|使得)?/gu, '')
    .replace(/(?:[a-z]{1,2}\d+%?)?/giu, '')
    .replace(/\d+(?:\.\d+)?%?/gu, '')
    .replace(/[，。；:+\-/*（）()【】\[\].]/g, '');
}

function trimKnownSkillName(rawName, candidateNames = []) {
  const normalizedRaw = normalizeForNameCompare(rawName);
  if (!normalizedRaw) {
    return rawName;
  }
  for (const candidate of candidateNames) {
    const normalizedCandidate = normalizeForNameCompare(candidate);
    if (!normalizedCandidate) {
      continue;
    }
    if (normalizedRaw === normalizedCandidate) {
      return candidate;
    }
    if (normalizedRaw.startsWith(normalizedCandidate) && normalizedRaw.length > normalizedCandidate.length + 2) {
      return candidate;
    }
  }
  return rawName;
}

function parseHeroSkillHeaderFromLines(key, lines, candidateNames = []) {
  let cursor = 0;
  const normalizedKey = normalizeMatchValue(key);

  while (cursor < lines.length) {
    const current = stripSkillSuffixes(lines[cursor]);
    if (!current) {
      cursor += 1;
      continue;
    }

    if (NEW_SKILL_MARKERS.test(current) || /^新增/.test(current)) {
      cursor += 1;
      continue;
    }

    const explicitName = current.match(/^名称(?:[:：]\s*(.*))?$/);
    if (explicitName) {
      const name = stripSkillSuffixes(explicitName[1]) || key;
      const description = lines
        .slice(cursor + 1)
        .map((line) => line.replace(/^描述[:：]\s*/, ''))
        .filter((line) => !/^(?:类型|描述)[:：]\s*$/.test(line))
        .join('\n');
      return { name, description };
    }

    const passivePrefix = current.match(/^(?:被动|主动)[:：]\s*(.+)$/);
    if (passivePrefix) {
      const name = stripSkillSuffixes(passivePrefix[1]);
      return {
        name: name || key,
        description: lines.slice(cursor + 1).join('\n'),
      };
    }

    const inlineMatch = current.match(/^(.*?)[:：]\s*(.+)$/);
    if (inlineMatch) {
      const inlineName = stripSkillSuffixes(inlineMatch[1]);
      const inlineDescription = inlineMatch[2].trim();
      if (inlineName && inlineDescription && !isLikelyDescriptionPrefix(inlineName) && isLikelyForgedOrRuneName(key, inlineName)) {
        return {
          name: inlineName,
          description: [inlineDescription, ...lines.slice(cursor + 1)].join('\n'),
        };
      }
    }

    let name = current;
    if (normalizeMatchValue(name) === normalizedKey && cursor + 1 < lines.length) {
      const next = stripSkillSuffixes(lines[cursor + 1]);
      if (next && normalizeMatchValue(next) !== normalizedKey && next.length <= 24 && !/[，。；:：]/.test(next)) {
        return {
          name: stripSkillSuffixes(next),
          description: lines.slice(cursor + 2).join('\n'),
        };
      }
    }

    return {
      name: isLikelySkillDescription(key, name) || !isLikelyForgedOrRuneName(key, name) ? key : trimKnownSkillName(name, candidateNames),
      description: lines.slice(cursor + (isLikelySkillDescription(key, name) ? 0 : 1)).join('\n'),
    };
  }

  return { name: key, description: '' };
}

function normalizeMatchValue(value) {
  return normalizeValue(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\uFEFF]/g, '')
    .replace(/[\s\-_.：:()（）【】\[\]]/g, '')
    .replace(/[“”‘’"']/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function resolveHeroMeta(sourceCategory, sourceMeta = {}, sourcePath = '') {
  const normalizedSourcePath = toPosixPath(sourcePath)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/^docs-standard\//, '');
  const parts = normalizedSourcePath.split('/');
  let attribute = normalizeValue(sourceMeta.attribute);
  let hero = normalizeValue(sourceMeta.hero);

  if (
    (sourceCategory === 'hero' || sourceCategory === 'backstory')
    && (!attribute || !hero)
    && parts[0] === 'design-data'
    && parts[1] === 'design-heros'
  ) {
    attribute = attribute || parts[2];
    hero = hero || normalizeValue(parts[3] || '').replace(/\.(md|txt|json|ya?ml)$/i, '');
  }
  if (
    (sourceCategory === 'hero' || sourceCategory === 'backstory')
    && (!attribute || !hero)
    && parts[0] === 'design-data'
    && parts[1] === 'backstory'
  ) {
    attribute = attribute || parts[2];
    hero = hero || normalizeValue(parts[3] || '').replace(/\.(md|txt|json|ya?ml)$/i, '');
  }

  if (!attribute || !hero) {
    return { attribute: '', hero: '' };
  }
  return { attribute, hero };
}

function parseHeroSkillFromSection(sectionKey, sectionValue, candidateNames = []) {
  const key = normalizeValue(sectionKey) === '先天技能' ? '天生技能' : normalizeValue(sectionKey);
  if (!key || !HERO_SKILL_KEYS.has(key)) {
    return null;
  }

  const lines = normalizeValue(sectionValue)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { key, name: key, description: '' };
  }

  const parsed = parseHeroSkillHeaderFromLines(key, lines, candidateNames);
  const name = stripSkillSuffixes(parsed.name) || key;
  const description = normalizeValue(parsed.description);
  return { key, name, description };
}

function buildHeroImageIndex(imagePaths = []) {
  const byBaseName = new Map();
  for (const item of imagePaths) {
    const base = trimExtName(path.basename(item));
    const normalized = normalizeMatchValue(base);
    if (!normalized) {
      continue;
    }
    const list = byBaseName.get(normalized) || [];
    list.push(item);
    byBaseName.set(normalized, list);
  }
  return { ordered: [...imagePaths], byBaseName };
}

function findHeroSkillIcon(skillName, imageIndex = { ordered: [], byBaseName: new Map() }) {
  const normalized = normalizeMatchValue(skillName);
  if (!normalized) {
    return null;
  }

  const direct = imageIndex.byBaseName.get(normalized);
  if (direct?.length) {
    return direct[0];
  }

  const candidates = new Set([normalized]);

  const compactNormalized = normalized
    .replace(/^天生技能/, '')
    .replace(/^先天技能/, '')
    .replace(/^技能\d+/, '')
    .replace(/^(?:被动|主动)[:：]?\s*/, '')
    .trim();
  if (compactNormalized) {
    candidates.add(compactNormalized);
  }

  for (const candidate of candidates) {
    const directByCandidate = imageIndex.byBaseName.get(candidate);
    if (directByCandidate?.length) {
      return directByCandidate[0];
    }
  }

  for (const candidate of imageIndex.ordered) {
    const candidateName = normalizeMatchValue(trimExtName(path.basename(candidate)));
    if (!candidateName) {
      continue;
    }
    for (const needle of candidates) {
      if (candidateName.includes(needle) || needle.includes(candidateName)) {
        return candidate;
      }
    }
  }

  return null;
}

export function collectHeroSkillsFromSections(sections = [], imagePaths = []) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return [];
  }

  const imageIndex = buildHeroImageIndex(imagePaths);
  const entries = [];
  const seen = new Set();
  const usedIcons = new Set();
  const knownSkillNames = [];

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (!section || typeof section !== 'object') {
      continue;
    }

    const rawKey = normalizeValue(section.key);
    const key = rawKey === '先天技能' ? '天生技能' : rawKey;
    if (!key || key === '_header' || key === '段落标题') {
      continue;
    }

    if (key === '天生技能' && normalizeValue(section.value) === '') {
      const next = sections[i + 1];
      const nextKey = normalizeValue(next?.key);
      const nextValue = normalizeValue(next?.value);

      if (next && nextKey && nextValue) {
        const mergedName = trimKnownSkillName(nextKey, knownSkillNames);
        const dedupeKey = normalizeMatchValue(key);
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          const mergedDesc = nextValue;
          const mergedIcon = findHeroSkillIcon(mergedName || key, imageIndex);
          entries.push({
            key,
            name: mergedName,
            icon: usedIcons.has(mergedIcon) ? null : mergedIcon,
            description: mergedDesc,
          });
          if (mergedIcon) {
            usedIcons.add(mergedIcon);
          }
          if (mergedName) {
            knownSkillNames.push(mergedName);
          }
        }
        i += 1;
        continue;
      }
    }

    const parsed = parseHeroSkillFromSection(key, section.value, knownSkillNames);
    if (!parsed) {
      continue;
    }

    const name = trimKnownSkillName(parsed.name || key, knownSkillNames);
    const dedupeKey = normalizeMatchValue(key);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const icon = findHeroSkillIcon(name || key, imageIndex);

    entries.push({
      key,
      name,
      icon: usedIcons.has(icon) ? null : icon,
      description: parsed.description || '',
    });
    if (icon) {
      usedIcons.add(icon);
    }
    knownSkillNames.push(name);
  }

  return entries;
}
