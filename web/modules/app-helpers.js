import {
  appState as state,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  TAB_DEFINITIONS,
} from './app-state.js';
import { domElements } from './app-state.js';

const {
  listEl,
  searchInput,
  categoryTabsEl,
} = domElements;

function getDisplayCategory(doc) {
  const category = doc?.category || 'other';
  if (category === 'backstory') {
    return 'hero';
  }
  return category;
}

function docMatchesTab(doc, tabId) {
  if (tabId === 'all') {
    return true;
  }

  if (tabId === 'hero') {
    const category = doc?.category || 'other';
    return category === 'hero' || category === 'backstory';
  }

  if (tabId === 'item') {
    return (doc.category || 'other') === 'item';
  }

  if (tabId === 'other') {
    const category = getDisplayCategory(doc);
    return category !== 'hero' && category !== 'item';
  }

  return true;
}

function getVisibleDocs(rawDocs = state.docs) {
  const keyword = searchInput.value.trim().toLowerCase();
  return rawDocs.filter((doc) => {
    const matchesSearch = keyword ? (doc._searchText || '').includes(keyword) : true;
    return matchesSearch && docMatchesTab(doc, state.activeTab);
  });
}

function getHeroDisplayKey(doc) {
  const metaHero = normalizeValue(doc?.meta?.hero);
  if (metaHero) {
    return metaHero;
  }

  const rawName = normalizeValue(doc?.name);
  if (rawName) {
    return rawName;
  }
  return normalizeValue(doc?.path);
}

function resolveHeroBackstory(doc) {
  if (!doc || doc.category !== 'hero') {
    return null;
  }

  if (doc.backstory) {
    return doc.backstory;
  }

  if (doc._linkedBackstory) {
    return doc._linkedBackstory;
  }

  const heroKey = getHeroDisplayKey(doc);
  return state.docs.find((item) => item?.category === 'backstory' && getHeroDisplayKey(item) === heroKey) || null;
}

function getHeroDisplayDocs(rawDocs = []) {
  if (state.activeTab !== 'hero' && state.activeTab !== 'all') {
    return rawDocs;
  }

  const mergedDocs = [];
  const mergedKeys = new Set();
  const heroDocs = new Map();
  const backstoryDocs = new Map();

  for (const doc of rawDocs) {
    const displayCategory = getDisplayCategory(doc);
    if (displayCategory !== 'hero') {
      continue;
    }

    const key = getHeroDisplayKey(doc);
    if (doc?.category === 'backstory') {
      if (!backstoryDocs.has(key)) {
        backstoryDocs.set(key, doc);
      }
    } else if (!heroDocs.has(key)) {
      heroDocs.set(key, doc);
    }
  }

  for (const doc of rawDocs) {
    const displayCategory = getDisplayCategory(doc);
    if (displayCategory !== 'hero') {
      mergedDocs.push(doc);
      continue;
    }

    const key = getHeroDisplayKey(doc);
    if (mergedKeys.has(key)) {
      continue;
    }

    if (doc.category === 'hero') {
      mergedKeys.add(key);
      mergedDocs.push({
        ...doc,
        _linkedBackstory: backstoryDocs.get(key) || null,
      });
      continue;
    }

    if (!heroDocs.has(key)) {
      mergedKeys.add(key);
      mergedDocs.push(doc);
    }
  }

  return mergedDocs;
}

function getHeroCount(sourceDocs = state.docs) {
  const unique = new Set();
  for (const doc of sourceDocs) {
    if (docMatchesTab(doc, 'hero')) {
      unique.add(getHeroDisplayKey(doc));
    }
  }
  return unique.size;
}

function getTabCounts() {
  const source = state.docs;
  const allDisplayDocs = getHeroDisplayDocs(source);
  return {
    all: allDisplayDocs.length,
    hero: getHeroCount(source),
    item: source.filter((doc) => docMatchesTab(doc, 'item')).length,
    other: source.filter((doc) => docMatchesTab(doc, 'other')).length,
  };
}

function renderTabs() {
  if (!categoryTabsEl) {
    return;
  }

  const counts = getTabCounts();
  categoryTabsEl.innerHTML = '';

  for (const tab of TAB_DEFINITIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab-btn ${tab.id === state.activeTab ? 'is-active' : ''}`;
    button.textContent = `${tab.label}（${counts[tab.id] || 0}）`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === state.activeTab));

    if (tab.id === state.activeTab) {
      button.setAttribute('tabindex', '0');
    } else {
      button.setAttribute('tabindex', '-1');
    }

    button.addEventListener('click', () => {
      if (state.activeTab === tab.id) {
        return;
      }
      state.activeTab = tab.id;
      renderFilteredDocs();
    });

    categoryTabsEl.appendChild(button);
  }
}

function normalizeValue(value) {
  return (value || '').toString().trim();
}

function normalizeLabel(value) {
  return normalizeValue(value)
    .replace(/[-\u2013\u2014\uFE63\uFF0D]/g, '—')
    .replace(/\s+/g, '')
    .replace(/["“”‘’‘’《》『』「」]/g, '')
    .toLowerCase();
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
  const hasKeyPattern = (pattern) => Object.keys(fields).some((key) => pattern.test(normalizeLabel(key)));
  const hasValuePattern = (pattern) => Object.values(fields).some((value) => pattern.test(normalizeLabel(value)));

  const hasActive = has('主动') || has('主动技能') || has('主动能力') || hasKeyPattern(/主动/) || hasValue('主动效果');
  const hasPassive = has('被动') || has('被动技能') || has('被动能力') || hasKeyPattern(/被动/) || hasValue('被动效果');
  if (hasActive && hasPassive) {
    return '主动·被动';
  }
  if (hasActive) {
    return '主动';
  }
  if (hasPassive) {
    return '被动';
  }

  const hasDamage = hasKeyPattern(/伤害|攻击|爆发|法术伤害|物理伤害|暴击/)
    || hasValuePattern(/伤害|攻击|法术|暴击|爆发/);
  const hasDefense = hasKeyPattern(/护甲|魔抗|法抗|抗性|护盾|回血|生命|治疗/)
    || hasValuePattern(/护甲|魔抗|法抗|抗性|治疗|回血|生命/);
  const hasControl = hasKeyPattern(/眩晕|沉默|减速|禁锢|控制|束缚|定身/)
    || hasValuePattern(/眩晕|沉默|减速|禁锢|控制|束缚|定身/);
  const hasUtility = hasKeyPattern(/消耗|冷却|位移|移动|视野|探测|回血|恢复|补给|携带/)
    || hasValuePattern(/消耗|冷却|位移|移动|视野|探测|恢复|补给|携带|回血/);

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

function parseCapabilityHeader(text) {
  const raw = normalizeValue(text);
  if (!raw) {
    return null;
  }

  const [firstLine, ...restLines] = raw.split('\n');
  const heading = normalizeValue(firstLine).replace(/^\u3010|\u3011$/g, '');
  const match = heading.match(/^(主动|被动|主动技能|被动技能)\s*(?:——+|—+|–|-|－|:|：)?\s*(?:[“\"《『「]?\s*(.*?)\s*[”\"》』」]?\s*)?$/);
  if (!match) {
    return null;
  }

  const kind = match[1].startsWith('主动') ? '主动' : '被动';
  const name = normalizeValue(match[2]);
  const title = name ? `${kind}：${name}` : kind;
  const body = normalizeValue(restLines.join('\n'));
  return { kind, name, title, body, fromText: true };
}

function isAbilityKey(key) {
  return /^(主动|被动|主动技能|被动技能)/.test(normalizeLabel(key));
}

function splitAbilityKeyName(key) {
  const match = normalizeValue(key).match(/^(主动|被动|主动技能|被动技能)\s*(?:——+|—+|–|-|－|:|：)?\s*(.+)?$/);
  if (!match) {
    return null;
  }
  const kind = match[1].startsWith('主动') ? '主动' : '被动';
  const name = normalizeValue((match[2] || '').replace(/["“”‘’《』「」『』]/g, ''));
  const title = name ? `${kind}：${name}` : kind;
  return { kind, name, title };
}

function collectAbilitySegmentsFromSections(sections = [], usedKeys = new Set()) {
  const segments = [];
  const metadataStopKeys = new Set([
    '价格',
    '属性',
    '属性加成',
    '合成',
    '合成公式',
    '物品背景',
    '物品描述',
    '背景',
    '背景描述',
    '背景叙事',
    '合成方式',
    '说明',
  ]);
  let current = null;
  let currentIndex = 0;

  const pushCurrent = () => {
    if (!current || !normalizeValue(current.value)) {
      current = null;
      return;
    }

    currentIndex += 1;
    current.title = `${currentIndex}、${current.title}`;
    segments.push(current);
    current = null;
  };

  const appendLine = (text) => {
    const value = normalizeValue(text);
    if (!value) {
      return;
    }
    current.value = normalizeValue([current.value, value].filter(Boolean).join('\n'));
  };

  for (const section of sections) {
    if (!section || typeof section !== 'object' || section.key === '_header' || section.key === '段落标题') {
      continue;
    }

    const key = normalizeValue(section.key);
    const value = normalizeValue(section.value);
    const hasUsedKey = usedKeys.has(key) || usedKeys.has(normalizeLabel(key));
    const fromParagraph = section.key === '段落';
    const headingFromKey = isAbilityKey(key) ? splitAbilityKeyName(key) : null;
    const headingFromValue = headingFromKey ? null : (fromParagraph ? parseCapabilityHeader(value) : null);
    const heading = headingFromKey ? { ...headingFromKey, fromText: false } : headingFromValue;

    if (heading) {
      pushCurrent();
      if (hasUsedKey && !heading.fromText) {
        continue;
      }
      const title = heading.title || (heading.kind === '主动' ? '主动效果' : '被动效果');
      current = {
        title,
        value: '',
        kind: heading.kind,
      };

      if (!fromParagraph) {
        if (value && value !== key) {
          current.value = value;
        }
      } else if (heading.body) {
        appendLine(heading.body);
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (metadataStopKeys.has(key)) {
      pushCurrent();
      continue;
    }

    if (key === '段落' && value === '合成方式') {
      pushCurrent();
      continue;
    }

    if (key === '段落' && (value.startsWith('被动') || value.startsWith('主动'))) {
      const maybeHeading = parseCapabilityHeader(value);
      if (maybeHeading) {
        pushCurrent();
        if (usedKeys.has(key)) {
          continue;
        }
        current = {
          title: maybeHeading.title || (maybeHeading.kind === '主动' ? '主动效果' : '被动效果'),
          value: maybeHeading.body,
          kind: maybeHeading.kind,
        };
        continue;
      }
    }

    if (hasUsedKey && key === '段落') {
      continue;
    }
    const content = normalizeValue(key) === '段落' ? value : `${key}: ${value}`;
    if (content) {
      appendLine(content);
    }
  }

  pushCurrent();
  return segments;
}

function collectHeroAbilitySegmentsFromSections(sections = [], usedKeys = new Set()) {
  const segments = [];
  let current = null;
  let currentIndex = 0;

  const pushCurrent = () => {
    if (!current || !hasVisibleValue(current.value)) {
      current = null;
      return;
    }

    currentIndex += 1;
    segments.push({
      ...current,
      title: `${currentIndex}、${current.title}`,
    });
    current = null;
  };

  const appendLine = (text) => {
    const value = normalizeValue(text);
    if (!value) {
      return;
    }
    current.value = normalizeValue([current.value, value].filter(Boolean).join('\n'));
  };

  const parseHeroAbilityHeader = (key, value) => {
    const rawKey = normalizeValue(key);
    if (!rawKey || rawKey === '_header') {
      return null;
    }

    const normalized = normalizeLabel(rawKey).replace(/[:：]/g, '');
    const normalizedValue = normalizeValue(value);

    if (/^(技能\d+|天生技能)$/.test(normalized)) {
      const lines = normalizedValue
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const titleLine = lines.shift() || rawKey;
      const body = lines.join('\n');
      return {
        title: `${rawKey}：${titleLine === rawKey ? '' : titleLine}`.trim().replace(/^：/, ''),
        body,
      };
    }

    const split = splitAbilityKeyName(rawKey);
    if (split) {
      return {
        title: split.title,
        body: normalizedValue,
      };
    }

    if (rawKey === '段落') {
      const heading = parseCapabilityHeader(normalizedValue);
      if (heading) {
        return {
          title: heading.title || (heading.kind === '主动' ? '主动效果' : '被动效果'),
          body: heading.body,
        };
      }
    }

    return null;
  };

  for (const section of sections) {
    if (!section || typeof section !== 'object' || section.key === '_header' || section.key === '段落标题') {
      continue;
    }

    const key = normalizeValue(section.key);
    const value = normalizeValue(section.value);
    if (!hasVisibleValue(value)) {
      continue;
    }

    const header = parseHeroAbilityHeader(key, value);
    if (header) {
      pushCurrent();
      usedKeys.add(key);
      usedKeys.add(normalizeLabel(key));

      current = {
        title: header.title || key,
        value: '',
      };
      if (header.body) {
        appendLine(header.body);
      }
      continue;
    }

    if (!current) {
      continue;
    }

    const line = key === '段落' ? value : `${key}: ${value}`;
    appendLine(line);
    if (key !== '段落') {
      usedKeys.add(key);
      usedKeys.add(normalizeLabel(key));
    }
  }

  pushCurrent();
  return segments;
}

function createDocButton(doc, onSelect = () => {}) {
  const category = getDisplayCategory(doc);
  const categoryLabel = CATEGORY_LABELS[category] || category || '其他';
  const groupText = doc.group ? `${doc.group}` : '';

  const button = document.createElement('button');
  button.className = 'doc-item';
  button.type = 'button';

  const titleText = document.createElement('div');
  titleText.className = 'doc-item-main';
  titleText.textContent = doc.name;

  const subText = document.createElement('div');
  subText.className = 'doc-item-sub';
  const pieces = [categoryLabel];
  if (groupText) {
    pieces.push(groupText);
  }
  subText.textContent = pieces.join(' · ');

  button.appendChild(titleText);
  button.appendChild(subText);
  button.title = normalizeValue(`${doc.title || doc.name}`);
  button.dataset.path = doc.path;
  button.addEventListener('click', () => onSelect(doc.path));
  return button;
}

function createDetailsGroup(title, count, expanded = true) {
  const details = document.createElement('details');
  details.className = 'doc-group';
  details.open = expanded;

  const summary = document.createElement('summary');
  summary.textContent = `${title}（${count}）`;
  details.appendChild(summary);

  return details;
}

function groupDocs(filtered) {
  const itemPairCounts = new Map();
  for (const doc of filtered) {
    if (doc.category !== 'item') {
      continue;
    }
    const match = (doc.group || '').match(/^物品\s*\/\s*(.+)$/);
    if (!match) {
      continue;
    }

    const parts = match[1]
      .split('/')
      .map((item) => item.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      const key = `${parts[0]}/${parts[1]}`;
      itemPairCounts.set(key, (itemPairCounts.get(key) || 0) + 1);
    }
  }

  const groups = new Map();
  for (const doc of filtered) {
    const category = getDisplayCategory(doc);
    const rawGroup = doc.group || '其他';
    const group = getPurposeGroup(
      { category, group: rawGroup, meta: doc.meta, path: doc.path },
      itemPairCounts,
      doc.fields,
    ) || rawGroup || '其他';
    const categoryMap = groups.get(category) || new Map();
    const list = categoryMap.get(group) || [];
    list.push(doc);
    categoryMap.set(group, list);
    groups.set(category, categoryMap);
  }
  return groups;
}

function getPurposeGroup(doc, itemPairCounts = new Map(), overrideFields = null) {
  const category = getDisplayCategory(doc);
  const rawCategory = doc.category || 'other';
  const rawGroup = doc.group || '其他';
  const meta = doc.meta || {};
  const fields = overrideFields || doc.fields || {};

  if (rawCategory === 'backstory') {
    const match = rawGroup.match(/^[^\/]+\s*\/\s*([^\/]+)\/?/);
    const attr = match ? match[1].trim() : '其他';
    return `${attr} / 背景故事`;
  }

  const roleOverride = detectItemRole(fields);
  if (rawCategory !== 'backstory' && category !== 'item' && meta.purpose) {
    return meta.purpose;
  }

  if (category === 'hero') {
    const rawAttackType = normalizeValue(fields['攻击类型'] || fields.类型 || '');
    const attackType = normalizeValue(rawAttackType.split(/[,，]/)[0] || fields.攻击类型 || '未标注');
    const attr = normalizeValue(meta.attribute) || normalizeValue(fields.主属性) || '其他属性';
    return `${attr} / ${attackType || '全部'}`;
  }

  if (category === 'item') {
    const parts = splitItemGroup(rawGroup);
    if (parts.subType === '价格表') {
      return `${parts.type} / 通用`;
    }
    const role = roleOverride || '通用';
    const roleLabel = role === '属性型' ? '通用' : role;
    if (parts.type === '消耗品' || parts.type === '特殊') {
      return `${parts.type} / ${roleLabel}`;
    }
    if (parts.subType && itemPairCounts.get(`${parts.type}/${parts.subType}`) > 1) {
      return `${parts.type} / ${parts.subType} / ${roleLabel}`;
    }
    if (parts.type && parts.subType) {
      return `${parts.type} / ${roleLabel}`;
    }
    return `${parts.type} / ${roleLabel}`;
  }

  if (category === 'unit' || category === 'building' || category === 'skill' || category === 'scene' || category === 'rule') {
    const match = rawGroup.match(/^[^\/]+\s*\/\s*([^\/]+)\/?/);
    if (!match) {
      return rawGroup;
    }
    return `${rawGroup.split('/')[0].trim()} / ${match[1].trim()}`;
  }

  return rawGroup;
}

function markActiveItem() {
  for (const button of listEl.querySelectorAll('.doc-item')) {
    button.classList.toggle('active', button.dataset.path === state.activePath);
  }
}

function formatTime(value) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

function formatSize(bytes) {
  const size = Number.parseFloat(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let value = size;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${units[unitIndex]}`;
}

function hasVisibleValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasVisibleValue(item));
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (typeof value === 'number') {
    return true;
  }
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'object') {
    return Object.keys(value || {}).length > 0;
  }
  return true;
}

function toDisplayValue(value) {
  if (value === null || value === undefined) {
    return '-';
  }
  if (value === false) {
    return 'false';
  }
  if (value === true) {
    return 'true';
  }
  if (Array.isArray(value)) {
    return value.join('\n');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function sanitizeList(value) {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

export {
  getDisplayCategory,
  docMatchesTab,
  getVisibleDocs,
  getHeroDisplayKey,
  resolveHeroBackstory,
  getHeroDisplayDocs,
  getHeroCount,
  getTabCounts,
  renderTabs,
  normalizeValue,
  normalizeLabel,
  splitItemGroup,
  detectItemRole,
  parseCapabilityHeader,
  isAbilityKey,
  splitAbilityKeyName,
  collectAbilitySegmentsFromSections,
  collectHeroAbilitySegmentsFromSections,
  createDocButton,
  createDetailsGroup,
  groupDocs,
  getPurposeGroup,
  markActiveItem,
  formatTime,
  formatSize,
  hasVisibleValue,
  toDisplayValue,
  sanitizeList,
};
