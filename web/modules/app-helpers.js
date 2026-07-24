import {
  appState as state,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  TAB_DEFINITIONS,
  ASSET_BASE_URL,
} from './app-state.js';
import { domElements } from './app-state.js';

const {
  listEl,
  searchInput,
  categoryTabsEl,
} = domElements;

const RENDER_PLACEHOLDERS = new Set([
  '-','—','——','———','暂无','未填写','无','未知','待补充','待完善','null','none','n/a','na',
]);

const visibleNoSearchDocCache = {
  source: null,
  all: [],
  hero: [],
  item: [],
  other: [],
};
const visibleSearchDocCache = new WeakMap();
const visibleSearchIndexCache = new WeakMap();
const heroDisplayCache = new WeakMap();
const docButtonCacheByPath = new Map();
const docButtonMetaByPath = new Map();
let docButtonCacheVersion = 0;
let activeDocPath = '';
const SEARCH_INDEX_TOKEN_MAX_LENGTH = 4;
const SEARCH_INDEX_TOKEN_MIN_LENGTH = 2;
const SEARCH_QUERY_TOKEN_LENGTH = 3;

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

function buildSearchIndex(rawDocs = state.docs) {
  if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
    return {
      all: new Map(),
      hero: new Map(),
      item: new Map(),
      other: new Map(),
    };
  }

  const indexByTab = {
    all: new Map(),
    hero: new Map(),
    item: new Map(),
    other: new Map(),
  };
  const tabs = Object.keys(indexByTab);

  const addToIndex = (targetIndex, token, doc) => {
    const existing = targetIndex.get(token);
    if (existing) {
      existing.push(doc);
    } else {
      targetIndex.set(token, [doc]);
    }
  };

  for (const doc of rawDocs) {
    if (!doc || typeof doc !== 'object') {
      continue;
    }
    const text = normalizeValue(doc._searchText).toLowerCase();
    if (!text) {
      continue;
    }

    const dedupeTokens = new Set();
    const textLength = text.length;
    for (let start = 0; start < textLength; start += 1) {
      for (let tokenLength = SEARCH_INDEX_TOKEN_MIN_LENGTH; tokenLength <= SEARCH_INDEX_TOKEN_MAX_LENGTH; tokenLength += 1) {
        const end = start + tokenLength;
        if (end > textLength) {
          break;
        }
        const token = text.slice(start, end);
        if (!token) {
          continue;
        }
        if (dedupeTokens.has(token)) {
          continue;
        }
        dedupeTokens.add(token);

        for (const tab of tabs) {
          if (tab === 'all' || docMatchesTab(doc, tab)) {
            addToIndex(indexByTab[tab], token, doc);
          }
        }
      }
    }
  }

  return indexByTab;
}

function getSearchIndex(rawDocs = state.docs, forceRebuild = false) {
  if (!Array.isArray(rawDocs)) {
    return null;
  }

  const cached = visibleSearchIndexCache.get(rawDocs);
  if (cached && !forceRebuild) {
    return cached;
  }

  const index = buildSearchIndex(rawDocs);
  visibleSearchIndexCache.set(rawDocs, index);
  return index;
}

function getSearchQueryTokens(keyword = '') {
  const normalized = normalizeValue(keyword).toLowerCase();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= SEARCH_INDEX_TOKEN_MAX_LENGTH) {
    return [normalized];
  }

  const tokens = [];
  const totalTokens = normalized.length - SEARCH_QUERY_TOKEN_LENGTH + 1;
  const maxQueryTokens = 12;
  const step = Math.max(
    1,
    Math.ceil(totalTokens / maxQueryTokens),
  );
  for (let start = 0; start <= normalized.length - SEARCH_QUERY_TOKEN_LENGTH; start += step) {
    tokens.push(normalized.slice(start, start + SEARCH_QUERY_TOKEN_LENGTH));
  }
  return tokens;
}

function getSearchCandidatesFromIndex(rawDocs = state.docs, keyword = '', activeTab = 'all') {
  const normalizedKeyword = normalizeValue(keyword).toLowerCase();
  if (!normalizedKeyword || normalizedKeyword.length < SEARCH_INDEX_TOKEN_MIN_LENGTH) {
    return null;
  }

  const indexes = getSearchIndex(rawDocs, false);
  if (!indexes) {
    return null;
  }
  const index = indexes[activeTab] || indexes.all;
  if (!index) {
    return null;
  }

  const tokens = getSearchQueryTokens(normalizedKeyword);
  if (!tokens.length) {
    return null;
  }

  const postings = [];
  for (const token of tokens) {
    const docs = index.get(token);
    if (!docs || !docs.length) {
      return [];
    }
    postings.push(docs);
  }

  if (!postings.length) {
    return null;
  }
  postings.sort((a, b) => a.length - b.length);

  let candidates = new Set(postings[0]);
  for (let i = 1; i < postings.length; i += 1) {
    const current = new Set(postings[i]);
    for (const doc of candidates) {
      if (!current.has(doc)) {
        candidates.delete(doc);
      }
    }
    if (!candidates.size) {
      return [];
    }
  }

  return Array.from(candidates);
}

function getVisibleDocs(rawDocs = state.docs, keyword = searchInput.value, activeTab = state.activeTab) {
  const normalizedKeyword = normalizeValue(keyword).toLowerCase();
  const searchSource = typeof rawDocs === 'object' && rawDocs !== null ? rawDocs : [];
  if (!Array.isArray(searchSource)) {
    return [];
  }
  if (!normalizedKeyword && rawDocs === state.docs) {
    if (visibleNoSearchDocCache.source !== rawDocs) {
      const all = [];
      const hero = [];
      const item = [];
      const other = [];
      for (const doc of rawDocs) {
        all.push(doc);
        if (docMatchesTab(doc, 'hero')) {
          hero.push(doc);
        }
        if (docMatchesTab(doc, 'item')) {
          item.push(doc);
        }
        if (docMatchesTab(doc, 'other')) {
          other.push(doc);
        }
      }
      visibleNoSearchDocCache.source = rawDocs;
      visibleNoSearchDocCache.all = all;
      visibleNoSearchDocCache.hero = hero;
      visibleNoSearchDocCache.item = item;
      visibleNoSearchDocCache.other = other;
    }

    if (activeTab === 'hero') {
      return visibleNoSearchDocCache.hero;
    }
    if (activeTab === 'item') {
      return visibleNoSearchDocCache.item;
    }
    if (activeTab === 'other') {
      return visibleNoSearchDocCache.other;
    }
    return visibleNoSearchDocCache.all;
  }

  if (searchSource.length && normalizedKeyword) {
    const cacheKey = `${activeTab}::${normalizedKeyword}`;
    const cachedBySource = visibleSearchDocCache.get(searchSource);
    const cached = cachedBySource?.get(cacheKey);
    if (cached) {
      return cached;
    }

    let baseQuery = '';
    let baseList = null;
    if (cachedBySource) {
      const prefix = `${activeTab}::`;
      for (const key of cachedBySource.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const previousQuery = key.slice(prefix.length);
        if (!previousQuery || previousQuery.length >= normalizedKeyword.length) {
          continue;
        }
        if (normalizedKeyword.startsWith(previousQuery) && previousQuery.length > baseQuery.length) {
          baseQuery = previousQuery;
          baseList = cachedBySource.get(key) || null;
        }
      }
    }

    const sourceForSearch = baseList
      || getSearchCandidatesFromIndex(searchSource, normalizedKeyword, activeTab)
      || searchSource;
    const results = sourceForSearch.filter((doc) => {
      const matchesSearch = (doc._searchText || '').includes(normalizedKeyword);
      return matchesSearch && docMatchesTab(doc, activeTab);
    });

    const nextCache = cachedBySource || new Map();
    nextCache.set(cacheKey, results);
    if (nextCache.size > 60) {
      const firstKey = nextCache.keys().next().value;
      if (firstKey !== undefined) {
        nextCache.delete(firstKey);
      }
    }
    visibleSearchDocCache.set(searchSource, nextCache);
    return results;
  }

  return searchSource.filter((doc) => {
    const matchesSearch = normalizedKeyword ? (doc._searchText || '').includes(normalizedKeyword) : true;
    return matchesSearch && docMatchesTab(doc, activeTab);
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

function getHeroDisplayDocs(rawDocs = [], activeTab = state.activeTab) {
  if (activeTab !== 'hero' && activeTab !== 'all') {
    return rawDocs;
  }

  if (typeof rawDocs === 'object' && rawDocs !== null) {
    const cached = heroDisplayCache.get(rawDocs);
    if (cached?.[activeTab]) {
      return cached[activeTab];
    }
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

  if (typeof rawDocs === 'object' && rawDocs !== null) {
    const cached = heroDisplayCache.get(rawDocs) || {};
    cached[activeTab] = mergedDocs;
    heroDisplayCache.set(rawDocs, cached);
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

function getTabCounts(source = state.docs) {
  const allDisplayDocs = getHeroDisplayDocs(source, 'all');
  return {
    all: allDisplayDocs.length,
    hero: getHeroCount(source),
    item: source.filter((doc) => docMatchesTab(doc, 'item')).length,
    other: source.filter((doc) => docMatchesTab(doc, 'other')).length,
  };
}

function renderTabs(onTabChange = () => {}, counts = null) {
  if (!categoryTabsEl) {
    return;
  }

  const tabCounts = counts || getTabCounts();
  categoryTabsEl.innerHTML = '';

  for (const tab of TAB_DEFINITIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab-btn ${tab.id === state.activeTab ? 'is-active' : ''}`;
    button.textContent = `${tab.label}（${tabCounts[tab.id] || 0}）`;
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
      onTabChange();
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

const HERO_PORTRAIT_KEYWORDS = ['原画', '立绘', '封面', '头像', 'hero', 'portrait', 'cover', '原画图', '立绘图'];

function normalizeMatchValue(value) {
  return normalizeValue(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\uFEFF]/g, '')
    .replace(/[\s\-_.:：()（）【】\[\]]/g, '')
    .replace(/[“”‘’"']/g, '')
    .replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
}

function normalizeAssetFilename(value) {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return '';
  }
  const base = normalized.split('/').at(-1);
  return base.replace(/\.[^.]+$/u, '');
}

function isHeroPortraitImage(imagePath) {
  const base = normalizeAssetFilename(imagePath);
  if (!base) {
    return false;
  }
  const text = normalizeValue(base).toLowerCase();
  if (!text) {
    return false;
  }

  return HERO_PORTRAIT_KEYWORDS.some((keyword) => {
    const normalizedKeyword = keyword.toLowerCase();
    return text.includes(normalizedKeyword);
  });
}

function extractHeroSkillImageNames(skillEntries = []) {
  const names = [];
  const seen = new Set();

  for (const skill of skillEntries) {
    const sourceName = normalizeValue(skill?.name || skill?.key);
    if (!sourceName) {
      continue;
    }
    const normalized = normalizeMatchValue(sourceName);
    if (normalized && !seen.has(normalized) && normalized.length > 1) {
      seen.add(normalized);
      names.push(normalized);
    }
  }

  return names;
}

function isImageNameMatchSkillToken(fileName, skillTokens = []) {
  const target = normalizeMatchValue(fileName);
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
  if (!Array.isArray(rawImages) || !rawImages.length) {
    return [];
  }

  const uniqueImages = [];
  const seenImages = new Set();
  for (const image of rawImages) {
    const path = normalizeValue(image);
    if (!path || seenImages.has(path)) {
      continue;
    }
    seenImages.add(path);
    uniqueImages.push(path);
  }

  if (!uniqueImages.length) {
    return [];
  }

  const output = [];
  const used = new Set();
  const imageSet = new Set(uniqueImages);
  const markUsed = (path) => {
    const normalizedPath = normalizeValue(path);
    if (!normalizedPath || used.has(normalizedPath)) {
      return;
    }
    used.add(normalizedPath);
    output.push(normalizedPath);
  };

  const portrait = uniqueImages.find((image) => isHeroPortraitImage(image));
  if (portrait) {
    markUsed(portrait);
  }

  const skillIcons = Array.isArray(heroSkills) ? heroSkills.map((skill) => normalizeValue(skill?.icon || '')) : [];
  for (const icon of skillIcons) {
    if (!icon) {
      continue;
    }
    if (imageSet.has(icon)) {
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

function pickHeroPortraitImage(heroImages = [], heroSkills = []) {
  const ordered = sortHeroImagesForDisplay(heroImages, heroSkills);
  return ordered.length ? ordered[0] : null;
}

function getHeroImagesForDisplay(doc = {}, heroSkills = []) {
  if (!doc || typeof doc !== 'object') {
    return [];
  }

  if (Array.isArray(doc._heroImagesOrdered)) {
    return doc._heroImagesOrdered;
  }

  const ordered = sortHeroImagesForDisplay(
    Array.isArray(doc.heroImages) ? doc.heroImages : [],
    heroSkills.length ? heroSkills : (doc.heroSkills || []),
  );
  doc._heroImagesOrdered = ordered;
  return ordered;
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
      const explicitName = lines[0]?.match(/^名称[:：]\s*(.*)$/);
      const titleLine = explicitName ? (explicitName[1] || rawKey) : (lines.shift() || rawKey);
      if (explicitName) {
        lines.shift();
      }
      const bodyLines = lines
        .map((line) => line.replace(/^描述[:：]\s*/, ''))
        .filter((line) => !/^(?:类型|描述)[:：]\s*$/.test(line));
      const body = bodyLines.join('\n');
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

function createDocButton(doc, onSelect = () => {}, options = {}) {
  const showEditAccess = options.showEditAccess === true;
  const isEditable = options.isEditable === true;
  const category = getDisplayCategory(doc);
  const categoryLabel = CATEGORY_LABELS[category] || category || '其他';
  const groupText = doc.group ? `${doc.group}` : '';
  const isHeroDoc = category === 'hero' || doc.category === 'hero';
  const isBackstory = category === 'backstory' || doc.category === 'backstory';
  const orderedHeroImages = getHeroImagesForDisplay(doc, doc.heroSkills || []);

  const button = document.createElement('button');
  button.className = `doc-item ${isHeroDoc ? 'is-hero' : ''} ${isBackstory ? 'is-backstory' : ''} ${isEditable ? 'doc-item-editable' : showEditAccess ? 'doc-item-readonly' : ''}`.trim();
  button.type = 'button';

  if (isHeroDoc && orderedHeroImages[0]) {
    const avatar = document.createElement('div');
    avatar.className = 'doc-item-avatar';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = new URL(orderedHeroImages[0], ASSET_BASE_URL).href;
    img.alt = `${doc.name} 缩略图`;
    avatar.appendChild(img);
    button.appendChild(avatar);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'doc-item-avatar doc-item-avatar--placeholder';
    avatar.textContent = normalizeValue(categoryLabel).slice(0, 2) || '文档';
    button.appendChild(avatar);
  }

  const textWrap = document.createElement('div');
  textWrap.className = 'doc-item-body';

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

  const hint = document.createElement('div');
  hint.className = 'doc-item-hint';
  const rawAttrHint = normalizeValue(doc?.meta?.attribute || doc?.fields?.主属性 || '');
  const normalizedAttrHint = rawAttrHint.replace(/\s+/g, '');
  if (normalizedAttrHint && !RENDER_PLACEHOLDERS.has(normalizedAttrHint.toLowerCase()) && !RENDER_PLACEHOLDERS.has(rawAttrHint)) {
    hint.textContent = `属性：${rawAttrHint}`;
    textWrap.appendChild(titleText);
    textWrap.appendChild(subText);
    textWrap.appendChild(hint);
  } else {
    textWrap.appendChild(titleText);
    textWrap.appendChild(subText);
  }

  let permissionTag = null;
  if (showEditAccess) {
    permissionTag = document.createElement('div');
    permissionTag.className = isEditable ? 'doc-item-edit-access is-editable' : 'doc-item-edit-access is-readonly';
    permissionTag.textContent = isEditable ? '可编辑' : '不可编辑';
    textWrap.appendChild(permissionTag);
  }

  button.appendChild(textWrap);
  button.title = normalizeValue(`${doc.title || doc.name}`);
  button.dataset.path = doc.path;
  button.dataset.editPermission = showEditAccess
    ? (isEditable ? 'editable' : 'readonly')
    : 'hidden';
  cacheDocListButton(doc.path, button, permissionTag, textWrap);
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
  const nextPath = state.activePath || '';
  if (activeDocPath === nextPath) {
    return;
  }

  if (activeDocPath) {
    const previousButton = docButtonCacheByPath.get(activeDocPath);
    if (previousButton) {
      previousButton.classList.remove('active');
    }
  }

  if (nextPath) {
    const nextButton = docButtonCacheByPath.get(nextPath);
    if (nextButton) {
      nextButton.classList.add('active');
    }
  }

  activeDocPath = nextPath;
}

function cacheDocListButton(pathValue, button, permissionTag = null, textWrap = null) {
  if (!pathValue || !button) {
    return;
  }
  const normalizedPath = String(pathValue);
  docButtonCacheByPath.set(normalizedPath, button);
  if (!docButtonMetaByPath.has(normalizedPath)) {
    docButtonMetaByPath.set(normalizedPath, {
      permissionTag: null,
      textWrap: null,
    });
  }
  const existingMeta = docButtonMetaByPath.get(normalizedPath);
  existingMeta.permissionTag = permissionTag || null;
  existingMeta.textWrap = textWrap || null;
  existingMeta.button = button;
}

function resetDocListButtonCache() {
  docButtonCacheByPath.clear();
  docButtonMetaByPath.clear();
  activeDocPath = '';
  docButtonCacheVersion += 1;
}

function getDocListButtonMeta(pathValue) {
  if (!pathValue) {
    return null;
  }
  return docButtonMetaByPath.get(String(pathValue)) || null;
}

function setDocListButtonMeta(pathValue, patch = {}) {
  if (!pathValue || !patch || typeof patch !== 'object') {
    return;
  }
  const normalizedPath = String(pathValue);
  const existingMeta = docButtonMetaByPath.get(normalizedPath);
  if (existingMeta) {
    Object.assign(existingMeta, patch);
  }
}

function getRenderedDocListButtons() {
  return docButtonCacheByPath.values();
}

function getDocListButtonCacheVersion() {
  return docButtonCacheVersion;
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
  getSearchIndex,
  splitItemGroup,
  detectItemRole,
  normalizeMatchValue,
  sortHeroImagesForDisplay,
  pickHeroPortraitImage,
  getHeroImagesForDisplay,
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
  cacheDocListButton,
  resetDocListButtonCache,
  getRenderedDocListButtons,
  getDocListButtonCacheVersion,
  getDocListButtonMeta,
  setDocListButtonMeta,
  formatTime,
  formatSize,
  hasVisibleValue,
  toDisplayValue,
  sanitizeList,
};
