const statusEl = document.getElementById('status');
const listEl = document.getElementById('docList');
const searchInput = document.getElementById('searchInput');
const categoryTabsEl = document.getElementById('categoryTabs');
const titleEl = document.getElementById('docTitle');
const pathEl = document.getElementById('docPath');
const bannerEl = document.getElementById('heroBanner');
const metaEl = document.getElementById('metaCards');
const sectionEl = document.getElementById('sectionCards');
const contentEl = document.getElementById('docContent');
const galleryEl = document.getElementById('heroGallery');

const PAGE_BASE = new URL('./', location.href);
const DATA_INDEX_URL = new URL('data/index.json', PAGE_BASE).href;
const ASSET_BASE_URL = new URL('../', PAGE_BASE).href;

let docs = [];
let activePath = '';
let activeTab = 'all';
let generatedStatus = '';

const TAB_DEFINITIONS = [
  { id: 'all', label: '全部' },
  { id: 'hero', label: '英雄' },
  { id: 'item', label: '物品' },
  { id: 'other', label: '其他' },
];

const CATEGORY_LABELS = {
  hero: '英雄',
  item: '物品',
  unit: '单位',
  skill: '技能',
  building: '建筑',
  backstory: '背景故事',
  scene: '场景',
  rule: '规则',
  template: '模板',
  root: '项目文档',
  other: '其他',
};

const CATEGORY_TAG = {
  hero: 'hero',
  item: 'item',
  unit: 'unit',
  skill: 'skill',
  building: 'building',
  backstory: 'story',
  scene: 'scene',
  rule: 'rule',
  template: 'template',
  root: 'root',
  other: 'other',
};

const CATEGORY_ORDER = [
  'hero',
  'item',
  'unit',
  'skill',
  'backstory',
  'scene',
  'rule',
  'building',
  'template',
  'root',
  'other',
];

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

function getVisibleDocs(rawDocs = docs) {
  const keyword = searchInput.value.trim().toLowerCase();
  return rawDocs.filter((doc) => {
    const matchesSearch = keyword ? (doc._searchText || '').includes(keyword) : true;
    return matchesSearch && docMatchesTab(doc, activeTab);
  });
}

function getHeroDisplayKey(doc) {
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

  if (doc._linkedBackstory) {
    return doc._linkedBackstory;
  }

  const heroKey = getHeroDisplayKey(doc);
  return docs.find((item) => item?.category === 'backstory' && getHeroDisplayKey(item) === heroKey) || null;
}

function getHeroDisplayDocs(rawDocs = []) {
  if (activeTab !== 'hero' && activeTab !== 'all') {
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

function getHeroCount(sourceDocs = docs) {
  const unique = new Set();
  for (const doc of sourceDocs) {
    if (docMatchesTab(doc, 'hero')) {
      unique.add(getHeroDisplayKey(doc));
    }
  }
  return unique.size;
}

function getTabCounts() {
  const source = docs;
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
    button.className = `tab-btn ${tab.id === activeTab ? 'is-active' : ''}`;
    button.textContent = `${tab.label}（${counts[tab.id] || 0}）`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === activeTab));

    if (tab.id === activeTab) {
      button.setAttribute('tabindex', '0');
    } else {
      button.setAttribute('tabindex', '-1');
    }

    button.addEventListener('click', () => {
      if (activeTab === tab.id) {
        return;
      }
      activeTab = tab.id;
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

function collectAbilitySegmentsFromSections(sections = []) {
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
    const fromParagraph = section.key === '段落';
    const headingFromKey = isAbilityKey(key) ? splitAbilityKeyName(key) : null;
    const headingFromValue = headingFromKey ? null : (fromParagraph ? parseCapabilityHeader(value) : null);
    const heading = headingFromKey ? { ...headingFromKey, fromText: false } : headingFromValue;

    if (heading) {
      pushCurrent();
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
        current = {
          title: maybeHeading.title || (maybeHeading.kind === '主动' ? '主动效果' : '被动效果'),
          value: maybeHeading.body,
          kind: maybeHeading.kind,
        };
        continue;
      }
    }

    const content = normalizeValue(key) === '段落' ? value : `${key}: ${value}`;
    if (content) {
      appendLine(content);
    }
  }

  pushCurrent();
  return segments;
}

function createDocButton(doc) {
  const category = getDisplayCategory(doc);
  const categoryLabel = CATEGORY_LABELS[category] || category || '其他';
  const groupText = doc.group ? `${doc.group}` : '';
  const sourceText = normalizeValue(doc.path).replace(/^design-data\//, '');

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
  if (sourceText) {
    pieces.push(sourceText);
  }
  subText.textContent = pieces.join(' · ');

  button.appendChild(titleText);
  button.appendChild(subText);
  button.title = doc.path;
  button.dataset.path = doc.path;
  button.addEventListener('click', () => selectDoc(doc.path));
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
    button.classList.toggle('active', button.dataset.path === activePath);
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

function createMetaSection(title, rows) {
  const card = document.createElement('section');
  card.className = 'meta-card';

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'meta-row';

    const dt = document.createElement('div');
    dt.className = 'meta-row-key';
    dt.textContent = label;

    const dd = document.createElement('div');
    dd.className = 'meta-row-value';
    dd.textContent = toDisplayValue(value);

    row.appendChild(dt);
    row.appendChild(dd);
    card.appendChild(row);
  }

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无匹配字段';
    card.appendChild(empty);
  }

  return card;
}

function createTextSection(title, items) {
  const card = document.createElement('section');
  card.className = 'meta-card';

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无可展示内容';
    card.appendChild(empty);
    return card;
  }

  for (const [label, value] of list) {
    const item = document.createElement('div');
    item.className = 'text-item';

    const titleEl = document.createElement('div');
    titleEl.className = 'text-title';
    titleEl.textContent = label;

    const body = document.createElement('div');
    body.className = 'text-body';
    body.textContent = toDisplayValue(value);

    item.appendChild(titleEl);
    item.appendChild(body);
    card.appendChild(item);
  }

  return card;
}

function collectSectionRows(sections, options = {}) {
  const rows = [];
  const skipKeys = options.skipKeys instanceof Set ? options.skipKeys : new Set();
  const entries = Array.isArray(sections) ? sections : [];
  let index = 1;

  for (const item of entries) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const key = item.key || '字段';
    if (skipKeys.has(key)) {
      continue;
    }

    if (!hasVisibleValue(item.value)) {
      continue;
    }

    rows.push([`${index}. ${key}`, item.value]);
    index += 1;
  }

  return rows;
}

function readOrderedPairs(fields, specs, used) {
  const rows = [];
  if (!fields) {
    return rows;
  }

  for (const spec of specs) {
    const keys = sanitizeList(spec.keys || spec.key || []);
    const label = spec.label || spec;
    let hitKey;

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        hitKey = key;
        break;
      }
    }

    if (!hitKey) {
      continue;
    }

    used.add(hitKey);
    rows.push([label, fields[hitKey]]);
  }

  return rows;
}

function collectRemainingPairs(fields, used = new Set()) {
  if (!fields) {
    return [];
  }

  const rows = [];
  const sortedKeys = Object.keys(fields).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const key of sortedKeys) {
    if (used.has(key) || key === '_header') {
      continue;
    }
    rows.push([key, fields[key]]);
  }

  return rows;
}

function renderHeroBanner(doc) {
  bannerEl.innerHTML = '';
  const category = getDisplayCategory(doc);
  const title = doc.meta?.title || doc.meta?.hero || doc.title || doc.name || doc.path;
  const fields = doc.fields || {};
  const categoryLabel = CATEGORY_LABELS[category] || '文档';
  const attr = fields['主属性'] || doc.meta?.attribute || '';
  const tagClass = attr.includes('敏捷') ? 'hero-attr-agility' : attr.includes('智力') ? 'hero-attr-intellect' : 'hero-attr-strength';

  const banner = document.createElement('div');
  banner.className = 'hero-identity';

  const cover = document.createElement('div');
  cover.className = `hero-poster ${doc.heroImages?.length ? '' : 'placeholder'}`;

  if (doc.heroImages?.length) {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.src = new URL(doc.heroImages[0], ASSET_BASE_URL).href;
    image.alt = `${title} 图像`;
    cover.appendChild(image);
  } else {
    cover.textContent = `${categoryLabel}封面`;
  }

  const info = document.createElement('div');
  const titleEl = document.createElement('h2');
  titleEl.className = 'hero-title';
  titleEl.textContent = title;

  const chips = document.createElement('div');
  chips.className = 'chips';

  const categoryTag = document.createElement('span');
  categoryTag.className = 'hero-tag';
  categoryTag.textContent = `分类：${categoryLabel}`;
  chips.appendChild(categoryTag);

  const groupTag = document.createElement('span');
  groupTag.className = 'hero-tag';
  groupTag.textContent = doc.group || '未分类';
  chips.appendChild(groupTag);

  const attrTag = document.createElement('span');
  attrTag.className = `hero-tag ${tagClass}`;
  attrTag.textContent = `主属性：${attr || '未填写'}`;
  chips.appendChild(attrTag);

  const stats = createTextSection('高亮速览', [
    ['攻击', fields.攻击 || '-'],
    ['生命', fields.生命 || fields['生命值'] || '-',],
    ['护甲', fields.护甲 || '-'],
    ['移动速度', fields.基础移动速度 || '-'],
    ['技能数', [fields.技能1, fields.技能2, fields.技能3, fields.技能4].filter((item) => item && toDisplayValue(item).trim()).length || 0],
    ['主属性组', doc.meta?.attribute || fields.主属性 || '未填写'],
  ]);

  info.appendChild(titleEl);
  info.appendChild(chips);
  info.appendChild(stats);

  banner.appendChild(cover);
  banner.appendChild(info);
  bannerEl.appendChild(banner);
}

function buildCommonCards(doc) {
  const source = doc.source || {};
  const parser = doc.parser || {};
  const parserStats = doc.parserStats || {};
  const fields = doc.fields || {};
  const category = getDisplayCategory(doc);

  const metaPairs = [
    ['标题', doc.meta?.title || doc.title || doc.name],
    ['路径', doc.path],
    ['分类', CATEGORY_LABELS[category] || category || 'other'],
    ['分组', doc.group || '其他'],
    ['文件类型', doc.type || 'txt'],
    ['标准版本', doc.schemaVersion || doc.meta?.schemaVersion || 'standard-doc-v2'],
    ['最后更新', formatTime(doc.lastModified)],
    ['体积', formatSize(doc.size)],
  ];

  if (source.path) {
    metaPairs.push(['源路径', source.path]);
  }
  if (source.extension) {
    metaPairs.push(['源后缀', source.extension]);
  }
  if (source.modifiedAt) {
    metaPairs.push(['源文件更新时间', formatTime(source.modifiedAt)]);
  }

  const parserPairs = [
    ['解析类型', parser.contentType || '-'],
    ['解析格式', parser.format || '-'],
    ['解析形态', parser.profile || '-'],
    ['行数', parser.lineCount || 0],
    ['字段数', Object.keys(fields || {}).length],
    ['块数', parser.blockCount || (doc.blocks ? doc.blocks.length : 0)],
    ['段落块', parserStats.paragraphCount || 0],
    ['列表块', parserStats.listCount || 0],
    ['表格块', parserStats.tableCount || 0],
    ['KV块', parserStats.kvCount || 0],
  ];

  return [
    createMetaSection('档案标识', metaPairs),
    createMetaSection('解析信息', parserPairs),
  ];
}

function renderHeroTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  const corePairs = readOrderedPairs(fields, [
    { label: '主属性', keys: ['主属性'] },
    { label: '生命', keys: ['生命', '生命值', '基础生命', '生命值加成'] },
    { label: '攻击类型', keys: ['攻击类型'] },
    { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
    { label: '攻击间隔', keys: ['基础攻击间隔', '攻击间隔'] },
    { label: '基础移动速度', keys: ['基础移动速度', '移动速度'] },
    { label: '力量', keys: ['力量'] },
    { label: '敏捷', keys: ['敏捷'] },
    { label: '智力', keys: ['智力'] },
  ], used);

  const combatPairs = readOrderedPairs(fields, [
    { label: '护甲', keys: ['护甲', '护甲值', '护甲上限'] },
    { label: '魔抗', keys: ['魔抗', '魔法抗性', '法抗'] },
    { label: '回血', keys: ['回血', '回血速度', '基础回血'] },
    { label: '攻速', keys: ['攻击速度', '攻速'] },
    { label: '技能增益', keys: ['阳印', '阴印', '铸魔', '铸神'] },
    { label: '击杀奖励', keys: ['击杀奖励'] },
  ], used);

  const skillPairs = readOrderedPairs(fields, [
    { label: '天生技能', keys: ['天生技能'] },
    { label: '技能1', keys: ['技能1'] },
    { label: '技能2', keys: ['技能2'] },
    { label: '技能3', keys: ['技能3'] },
    { label: '技能4', keys: ['技能4'] },
    { label: '阳印', keys: ['阳印'] },
    { label: '阴印', keys: ['阴印'] },
    { label: '铸魔', keys: ['铸魔'] },
    { label: '铸神', keys: ['铸神'] },
    { label: '主动', keys: ['主动'] },
  ], used);

  cards.push(createMetaSection('英雄属性', corePairs));
  cards.push(createMetaSection('作战参数', combatPairs));
  cards.push(createTextSection('技能树', skillPairs));

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('额外字段', remainingPairs));
  }

  const sectionTimeline = collectSectionRows(doc.sections, {
    skipKeys: new Set(['_header', '段落']),
  });
  if (sectionTimeline.length > 0) {
    cards.push(createTextSection('字段解析（文档原顺序）', sectionTimeline));
  }

  return cards;
}

function renderItemTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];
  const abilitySegments = collectAbilitySegmentsFromSections(doc.sections || []);

  cards.push(createMetaSection('核心属性', readOrderedPairs(fields, [
    { label: '价格', keys: ['价格', '售价', 'Cost', 'price'] },
    { label: '合成', keys: ['合成', '合成材料', '合成消耗'] },
    { label: '属性', keys: ['属性', '技能', '词缀', '效果'] },
    { label: '物品描述', keys: ['物品描述', '描述', '说明'] },
    { label: '主动', keys: ['主动'] },
    { label: '被动', keys: ['被动'] },
  ], used)));

  const segmentsFromFields = [];
  for (const [key, value] of Object.entries(fields)) {
    const info = splitAbilityKeyName(key);
    if (!info) {
      continue;
    }
    const rowValue = toDisplayValue(value);
    if (!hasVisibleValue(value)) {
      continue;
    }
    segmentsFromFields.push([`${info.title}`, rowValue]);
    used.add(key);
  }
  if (segmentsFromFields.length > 0) {
    cards.push(createTextSection('字段化效果', segmentsFromFields));
  }

  if (abilitySegments.length > 0) {
    cards.push(createTextSection('结构化效果', abilitySegments.map((segment) => [segment.title, segment.value])));
  }

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('全部字段', remainingPairs));
  }

  return cards;
}

function renderUnitLikeTemplate(doc, title) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  cards.push(createMetaSection(title, readOrderedPairs(fields, [
    { label: '生命', keys: ['生命', '生命值', '基础生命', '生命上限'] },
    { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
    { label: '护甲', keys: ['护甲', '护甲值'] },
    { label: '魔抗', keys: ['魔抗', '魔法抗性'] },
    { label: '攻击间隔', keys: ['攻击间隔', '基础攻击间隔'] },
    { label: '移动速度', keys: ['移动速度', '基础移动速度'] },
    { label: '攻击类型', keys: ['攻击类型'] },
    { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
    { label: '回血', keys: ['回血'] },
    { label: '击杀奖励', keys: ['击杀奖励'] },
    { label: '附魔', keys: ['附魔', '特性'] },
    { label: '类型', keys: ['类型'] },
  ], used)));

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('额外字段', remainingPairs));
  }

  return cards;
}

function renderSkillTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  const headerPairs = readOrderedPairs(fields, [
    { label: '技能类型', keys: ['类型', '技能类型'] },
    { label: '伤害', keys: ['伤害', '每次伤害', '基础伤害'] },
    { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长'] },
    { label: '消耗', keys: ['魔力消耗', '魔法消耗', '魔法消耗', '法力消耗', '消耗'] },
    { label: '施法距离', keys: ['施法距离', '最大施法距离', '距离'] },
    { label: '持续时间', keys: ['持续时间', '持续'] },
    { label: '范围', keys: ['范围', '作用范围'] },
    { label: '前摇', keys: ['前摇', '前置时间'] },
  ], used);

  cards.push(createMetaSection('技能机制', headerPairs));

  const paragraphs = extractParagraphs(doc).slice(0, 12);
  if (paragraphs.length > 0) {
    cards.push(createTextSection('技能说明', paragraphs.map((paragraph) => ['说明', paragraph])));
  }

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('全部字段', remainingPairs));
  }

  return cards;
}

function renderBackstoryTemplate(doc) {
  const fields = doc.fields || {};
  const pairs = collectRemainingPairs(fields, new Set());
  const used = new Set();
  const cards = [];

  const header = doc.meta?.hero ? `关联英雄：${doc.meta.hero}` : '背景故事';
  cards.push(createMetaSection('背景信息', [
    ['标签', header],
    ['关联属性', doc.meta?.attribute || '-'],
    ['主标题', fields._header || '-'],
  ]));

  const paragraphs = extractParagraphs(doc);
  if (paragraphs.length > 0) {
    cards.push(createTextSection('故事正文', paragraphs.map((text, index) => [`段落 ${index + 1}`, text])));
  }

  cards.push(createMetaSection('原始字段', pairs.filter(([key]) => {
    if (key === '从风暴中传来' && !hasVisibleValue(fields[key])) {
      return false;
    }
    used.add(key);
    return true;
  })));

  return cards;
}

function renderSceneTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  const scenePairs = readOrderedPairs(fields, [
    { label: '标题', keys: ['_header'] },
  ], used);
  cards.push(createMetaSection('场景说明', scenePairs));

  const paragraphs = extractParagraphs(doc);
  if (paragraphs.length > 0) {
    cards.push(createTextSection('场景内容', paragraphs.map((item) => ['内容', item])));
  }

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('全部字段', remainingPairs));
  }

  return cards;
}

function renderRuleTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  cards.push(createMetaSection('规则公式', readOrderedPairs(fields, [
    { label: '规则名称', keys: ['_header'] },
    { label: '基础参数', keys: ['力量', '敏捷', '智力'] },
    { label: '说明', keys: ['说明', '内容', '备注'] },
  ], used)));

  const paragraphs = extractParagraphs(doc);
  if (paragraphs.length > 0) {
    cards.push(createTextSection('规则段落', paragraphs.map((item, index) => [`规则段落 ${index + 1}`, item])));
  }

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('全部字段', remainingPairs));
  }

  return cards;
}

function renderTemplateLike(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  cards.push(createMetaSection('模板骨架', readOrderedPairs(fields, [
    { label: '攻击类型', keys: ['攻击类型'] },
    { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
    { label: '基础攻击间隔', keys: ['基础攻击间隔'] },
    { label: '基础移动速度', keys: ['基础移动速度', '移动速度'] },
    { label: '天生技能', keys: ['天生技能'] },
    { label: '技能1', keys: ['技能1'] },
    { label: '技能2', keys: ['技能2'] },
    { label: '技能3', keys: ['技能3'] },
    { label: '技能4', keys: ['技能4'] },
  ], used)));

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('全部字段', remainingPairs));
  }

  return cards;
}

function renderFallbackTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  const remainingPairs = collectRemainingPairs(fields, used);
  cards.push(createMetaSection('结构化字段', remainingPairs));

  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  if (sections.length > 0) {
    const rows = sections
      .filter((item) => item && item.key !== '_header')
      .filter((item) => hasVisibleValue(item.value))
      .map((item) => [item.key || '段落', item.value]);
    cards.push(createTextSection('文档段落', rows));
  }

  return cards;
}

function getHeroCardsByCategory(doc) {
  switch (doc.category) {
    case 'hero': {
      const cards = renderHeroTemplate(doc);
      const linkedBackstory = resolveHeroBackstory(doc);
      if (linkedBackstory) {
        cards.push(...renderBackstoryTemplate(linkedBackstory));
      }
      return cards;
    }
    case 'item':
      return renderItemTemplate(doc);
    case 'unit':
      return renderUnitLikeTemplate(doc, '单位属性');
    case 'building':
      return renderUnitLikeTemplate(doc, '建筑属性');
    case 'skill':
      return renderSkillTemplate(doc);
    case 'backstory':
      return renderBackstoryTemplate(doc);
    case 'scene':
      return renderSceneTemplate(doc);
    case 'rule':
      return renderRuleTemplate(doc);
    case 'template':
      return renderTemplateLike(doc);
    default:
      return renderFallbackTemplate(doc);
  }
}

function extractParagraphs(doc) {
  const fromSections = Array.isArray(doc.sections)
    ? doc.sections.filter((item) => item?.key === '段落' && hasVisibleValue(item.value)).map((item) => item.value)
    : [];

  if (fromSections.length > 0) {
    return fromSections;
  }

  if (typeof doc.content !== 'string') {
    return [];
  }

  return doc.content
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function createTextBlock(text) {
  const node = document.createElement('div');
  node.className = 'doc-block';
  node.style.whiteSpace = 'pre-wrap';
  node.textContent = text;
  return node;
}

function renderKvTableRows(blocks) {
  const blockEl = document.createElement('div');
  blockEl.className = 'doc-kv-block';

  for (const item of blocks) {
    const row = document.createElement('div');
    row.className = 'doc-row';

    const key = document.createElement('div');
    key.className = 'doc-key';
    key.textContent = item.key;

    const value = document.createElement('div');
    value.className = 'doc-value';
    value.textContent = item.value;

    row.appendChild(key);
    row.appendChild(value);
    blockEl.appendChild(row);
  }

  return blockEl;
}

function renderListBlock(block) {
  const list = document.createElement(block.ordered ? 'ol' : 'ul');
  for (const item of block.items || []) {
    const line = document.createElement('li');
    line.textContent = item;
    list.appendChild(line);
  }
  return list;
}

function renderTableBlock(block) {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-table-wrap';

  const table = document.createElement('table');
  table.className = 'doc-table';

  const header = block.header || [];
  if (header.length > 0) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of header) {
      const th = document.createElement('th');
      th.textContent = cell;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const body = document.createElement('tbody');
  for (const row of block.rows || []) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);

  wrapper.appendChild(table);
  return wrapper;
}

function renderStructuredBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return createTextBlock('');
  }

  const fragment = document.createDocumentFragment();
  for (const block of blocks) {
    if (!block || !block.type) {
      continue;
    }

    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, Number(block.level) || 1));
      const heading = document.createElement(`h${level}`);
      heading.textContent = block.title || '';
      fragment.appendChild(heading);
      continue;
    }

    if (block.type === 'paragraph') {
      const p = document.createElement('p');
      p.className = 'doc-paragraph';
      p.textContent = block.text || '';
      fragment.appendChild(p);
      continue;
    }

    if (block.type === 'kv') {
      fragment.appendChild(renderKvTableRows([{ key: block.key, value: block.value || '' }]));
      continue;
    }

    if (block.type === 'list') {
      fragment.appendChild(renderListBlock(block));
      continue;
    }

    if (block.type === 'table') {
      fragment.appendChild(renderTableBlock(block));
      continue;
    }

    const pre = document.createElement('pre');
    pre.className = 'doc-pre';
    pre.textContent = typeof block.value === 'string' ? block.value : JSON.stringify(block, null, 2);
    fragment.appendChild(pre);
  }

  return fragment;
}

function renderSectionCards(doc) {
  sectionEl.innerHTML = '';
  const sectionCards = getHeroCardsByCategory(doc);
  for (const card of sectionCards) {
    sectionEl.appendChild(card);
  }
}

function renderGallery(images) {
  galleryEl.innerHTML = '';
  if (!images || images.length === 0) {
    return;
  }

  for (const url of images) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = new URL(url, ASSET_BASE_URL).href;
    img.alt = url;
    galleryEl.appendChild(img);
  }
}

function renderMeta(doc) {
  metaEl.innerHTML = '';
  const category = getDisplayCategory(doc);
  titleEl.textContent = doc.meta?.title || doc.title || doc.name;
  pathEl.textContent = `${doc.path} · ${doc.type || 'txt'}`;

  const title = doc.meta?.title || doc.name || '未命名';
  const bannerText = category === 'hero'
    ? `${title}`
    : `${CATEGORY_LABELS[category] || '文档'} · ${title}`;

  const bannerTitle = document.createElement('h2');
  bannerTitle.className = 'hero-title';
  bannerTitle.textContent = bannerText;
  const tags = document.createElement('div');
  const tag = document.createElement('span');
  tag.className = `hero-tag ${CATEGORY_TAG[category] || 'other'}`;
  tag.textContent = `类型：${CATEGORY_LABELS[category] || '其他'}`;
  tags.appendChild(tag);
  metaEl.appendChild(bannerTitle);
  metaEl.appendChild(tags);

  const baseCards = buildCommonCards(doc);
  for (const card of baseCards) {
    metaEl.appendChild(card);
  }
}

function renderContent(doc) {
  if (Array.isArray(doc.blocks) && doc.blocks.length > 0) {
    contentEl.innerHTML = '';
    contentEl.appendChild(renderStructuredBlocks(doc.blocks));
  } else {
    contentEl.textContent = doc.content || '';
  }
}

function renderList(filteredDocs) {
  listEl.innerHTML = '';
  if (!filteredDocs.length) {
    const msg = searchInput.value.trim() ? '未匹配到文档' : '当前标签暂无文档';
    listEl.innerHTML = `<div class="doc-group">${msg}</div>`;
    return;
  }

  const groups = groupDocs(filteredDocs);
  const categoryNames = [...groups.keys()].sort((a, b) => {
    const aIndex = CATEGORY_ORDER.indexOf(a);
    const bIndex = CATEGORY_ORDER.indexOf(b);
    if (aIndex !== -1 || bIndex !== -1) {
      return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
    }
    return a.localeCompare(b, 'zh-CN');
  });
  for (const categoryName of categoryNames) {
    const categoryMap = groups.get(categoryName) || new Map();
    const totalCount = [...categoryMap.values()].reduce((acc, arr) => acc + arr.length, 0);
    const categoryNode = createDetailsGroup(`分类 ${CATEGORY_LABELS[categoryName] || categoryName}`, totalCount, true);

    const groupNames = [...categoryMap.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const groupName of groupNames) {
      const docsInGroup = categoryMap.get(groupName);
      const groupNode = createDetailsGroup(groupName, docsInGroup.length, true);
      for (const doc of docsInGroup) {
        const button = createDocButton(doc);
        groupNode.appendChild(button);
      }
      categoryNode.appendChild(groupNode);
    }

    listEl.appendChild(categoryNode);
  }

  markActiveItem();
}

function renderFilteredDocs() {
  const filtered = getHeroDisplayDocs(getVisibleDocs());
  renderList(filtered);

  if (!filtered.length) {
    const hasKeyword = searchInput.value.trim();
    statusEl.textContent = `${hasKeyword ? '未匹配到文档' : '当前标签暂无文档'} ${generatedStatus}`;
    if (categoryTabsEl) {
      renderTabs();
    }
    return;
  }

  const displayText = `当前显示 ${filtered.length} 个文档（共 ${docs.length} 个）`;
  const tabText = searchInput.value.trim() ? '（已按关键词筛选）' : '';
  statusEl.textContent = `${displayText} ${tabText} ${generatedStatus}`;

  if (!filtered.some((doc) => doc.path === activePath)) {
    selectDoc(filtered[0].path);
  } else {
    selectDoc(activePath);
  }

  if (categoryTabsEl) {
    renderTabs();
  }
}

function selectDoc(pathValue) {
  const doc = docs.find((item) => item.path === pathValue);
  if (!doc) {
    return;
  }

  activePath = doc.path;
  renderHeroBanner(doc);
  renderMeta(doc);
  renderSectionCards(doc);
  renderGallery(doc.heroImages || []);
  renderContent(doc);
  markActiveItem();
}

function collectSearchText(doc) {
  const base = `${doc.name} ${doc.path} ${doc.group} ${doc.category} ${doc.type || ''}`;
  const fields = doc.fields ? Object.entries(doc.fields).map(([key, value]) => `${key} ${value}`).join(' ') : '';
  const sections = Array.isArray(doc.sections)
    ? doc.sections.map((item) => `${item.key || ''} ${item.value || ''}`).join(' ')
    : '';
  const blocks = Array.isArray(doc.blocks)
    ? doc.blocks.map((item) => `${item.type || ''} ${item.title || ''} ${item.key || ''} ${item.value || ''}`).join(' ')
    : '';
  const outline = Array.isArray(doc.outline)
    ? doc.outline.map((item) => `${item.title || ''} ${item.anchor || ''}`).join(' ')
    : '';

  return `${base} ${fields} ${sections} ${blocks} ${outline}`.toLowerCase();
}

async function loadData() {
  try {
    const response = await fetch(DATA_INDEX_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    docs = payload.docs || [];
    docs.forEach((doc) => {
      doc._searchText = collectSearchText(doc);
      doc.meta = doc.meta || {};
      doc.fields = doc.fields || {};
      doc.sections = doc.sections || [];
      doc.outline = doc.outline || [];
      doc.blocks = doc.blocks || [];
      doc.parser = doc.parser || {};
      doc.heroImages = doc.heroImages || [];
    });

    generatedStatus = `（静态生成 ${formatTime(payload.generatedAt)}）`;
    renderTabs();
    renderFilteredDocs();
  } catch (error) {
    statusEl.textContent = `加载失败：${error.message}`;
    listEl.textContent = '请先执行静态生成脚本：node scripts/build-static-doc-site.mjs';
  }
}

searchInput.addEventListener('input', () => {
  renderFilteredDocs();
});

loadData();
