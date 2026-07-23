import {
  CATEGORY_LABELS,
  ASSET_BASE_URL,
} from './app-state.js';
import { domElements } from './app-state.js';
import {
  formatSize,
  formatTime,
  getDisplayCategory,
  getHeroImagesForDisplay,
  normalizeLabel,
  normalizeValue,
  resolveHeroBackstory,
  splitAbilityKeyName,
  collectAbilitySegmentsFromSections,
  collectHeroAbilitySegmentsFromSections,
  toDisplayValue,
  sanitizeList,
} from './app-helpers.js';
import { getDocTemplate } from './app-type-templates.js';

const { bannerEl } = domElements;

const RENDER_PLACEHOLDERS = new Set([
  '-',
  '—',
  '——',
  '———',
  '暂无',
  '未填写',
  '无',
  '未知',
  '待补充',
  '待完善',
  'null',
  'none',
  'n/a',
  'na',
]);

const CONTENT_RENDER_MODES = {
  CARD_ONLY: 'card-only',
  HYBRID: 'hybrid',
};

const TYPE_METRIC_DEFINITIONS = {
  hero: [
    { label: '主属性', keys: ['主属性'] },
    { label: '攻击类型', keys: ['攻击类型'] },
    { label: '攻击间隔', keys: ['基础攻击间隔', '攻击间隔'] },
    { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
    { label: '生命', keys: ['生命', '生命值', '基础生命', '生命上限'] },
    { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
    { label: '护甲', keys: ['护甲', '护甲值', '护甲上限'] },
    { label: '移动速度', keys: ['基础移动速度', '移动速度'] },
    { label: '技能数', keys: ['技能1', '技能2', '技能3', '技能4'], type: 'count' },
    { label: '天赋数', keys: ['阳印', '阴印', '铸神', '铸魔'], type: 'count' },
  ],
  item: [
    { label: '价格', keys: ['价格', '售价', 'Cost', 'price'] },
    { label: '类型', keys: ['类型', '物品类型', '所属类型'] },
    { label: '属性加成', keys: ['属性加成', '属性', '加成'] },
    { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长'] },
    { label: '消耗', keys: ['消耗', '魔力消耗', '法力消耗', '魔法消耗'] },
    { label: '最大库存', keys: ['最大存货数量', '上限', '库存上限'] },
  ],
  unit: [
    { label: '生命', keys: ['生命', '生命值', '基础生命', '生命上限'] },
    { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
    { label: '攻击间隔', keys: ['攻击间隔', '基础攻击间隔'] },
    { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
    { label: '护甲', keys: ['护甲', '护甲值'] },
    { label: '魔抗', keys: ['魔抗', '魔法抗性', '法抗'] },
    { label: '移动速度', keys: ['移动速度', '基础移动速度'] },
    { label: '状态抗性', keys: ['状态抗性', '状态抗性值'] },
    { label: '击杀奖励', keys: ['击杀奖励'], type: 'numeric' },
    { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长'], type: 'numeric' },
  ],
  building: [
    { label: '生命', keys: ['生命', '生命值', '基础生命', '生命上限'] },
    { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
    { label: '攻击间隔', keys: ['攻击间隔', '基础攻击间隔'] },
    { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
    { label: '护甲', keys: ['护甲', '护甲值'] },
    { label: '魔抗', keys: ['魔抗', '魔法抗性', '法抗'] },
    { label: '击杀奖励', keys: ['击杀奖励'] },
  ],
};

function hasRenderableToken(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    const normalized = normalizeValue(value).replace(/\s+/g, '');
    if (!normalized) {
      return false;
    }
    const lowered = normalized.toLowerCase();
    return !RENDER_PLACEHOLDERS.has(lowered) && !RENDER_PLACEHOLDERS.has(normalized);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasRenderableToken(entry));
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'object') {
    return Object.keys(value || {}).length > 0;
  }

  return true;
}

function hasRenderableValue(label, value) {
  if (!hasRenderableToken(value)) {
    return false;
  }

  if (!hasRenderableToken(label)) {
    return false;
  }

  return true;
}

function setContentRenderMode(doc, mode) {
  doc._contentRenderMode = mode;
}

function dedupeItems(items = []) {
  const seen = new Set();
  const list = [];

  for (const item of items) {
    if (!Array.isArray(item) || item.length < 2) {
      continue;
    }

    const key = `${normalizeValue(item[0])}||${toDisplayValue(item[1])}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    list.push(item);
  }

  return list;
}

function compactCards(cards = []) {
  const result = [];
  const seen = new Set();

  for (const card of cards) {
    if (!card || typeof card.querySelector !== 'function') {
      continue;
    }

    const title = card.querySelector('h3')?.textContent?.trim() || '';
    const text = normalizeValue(card.textContent);
    if (!text || !title) {
      continue;
    }

    const signature = `${normalizeValue(title)}|${text}`;
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    result.push(card);
  }

  return result;
}

function normalizeMetricValue(value) {
  return toDisplayValue(value);
}

function parseMetricNumber(value) {
  const text = normalizeMetricValue(value).replace(/,/g, '');
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function collectMetricRows(fields, defs = [], usedKeys = new Set()) {
  const metricRows = [];
  const seenLabels = new Set();

  for (const metric of defs) {
    if (!metric || !metric.label) {
      continue;
    }

    const label = normalizeValue(metric.label);
    if (!label || seenLabels.has(normalizeLabel(label))) {
      continue;
    }
    seenLabels.add(normalizeLabel(label));

    const keys = sanitizeList(metric.keys || []);
    if (!keys.length) {
      continue;
    }

    if (metric.type === 'count') {
      const presentValues = [];
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) {
          continue;
        }
        const value = fields[key];
        if (hasRenderableToken(value)) {
          presentValues.push(value);
          usedKeys.add(key);
        }
      }

      if (presentValues.length === 0) {
        continue;
      }

      metricRows.push({
        label,
        value: String(presentValues.length),
        usedKey: presentValues[0] ? keys.find((key) => Object.prototype.hasOwnProperty.call(fields, key) && hasRenderableToken(fields[key])) : null,
      });
      continue;
    }

    let chosen;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) {
        continue;
      }
      const value = fields[key];
      if (!hasRenderableValue(metric.label, value)) {
        continue;
      }
      chosen = [key, value];
      usedKeys.add(key);
      break;
    }

    if (!chosen) {
      continue;
    }

    metricRows.push({
      label,
      value: normalizeMetricValue(chosen[1]),
      usedKey: chosen[0],
    });
  }

  return metricRows;
}

function createMetricStripSection(title, metricRows, options = {}) {
  const rows = Array.isArray(metricRows) ? metricRows : [];
  const visibleRows = rows.filter((item) => item && hasRenderableToken(item.value));
  if (visibleRows.length === 0) {
    return null;
  }

  const uniqueRows = dedupeItems(visibleRows.map((item) => [item.label, item.value]));
  const normalizedRows = uniqueRows.map(([label, value]) => ({ label, value: normalizeMetricValue(value) }));
  const numericValues = normalizedRows
    .map((item) => parseMetricNumber(item.value))
    .filter((value) => typeof value === 'number' && Number.isFinite(value));

  const minValue = numericValues.length > 0 ? Math.min(...numericValues) : 0;
  const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : 0;

  const card = document.createElement('section');
  const cardClass = normalizeValue(options.cardClass || '');
  card.className = `meta-card metrics-card ${cardClass}`.trim();

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  const track = document.createElement('div');
  track.className = 'metric-strip';

  for (const { label, value } of normalizedRows) {
    const itemEl = document.createElement('div');
    itemEl.className = 'metric-item';

    const top = document.createElement('div');
    top.className = 'metric-item-top';

    const metricLabel = document.createElement('span');
    metricLabel.className = 'metric-item-label';
    metricLabel.textContent = label;

    const metricValue = document.createElement('span');
    metricValue.className = 'metric-item-value';
    metricValue.textContent = toDisplayValue(value);

    top.appendChild(metricLabel);
    top.appendChild(metricValue);

    const meter = document.createElement('div');
    meter.className = 'metric-item-meter';

    const fill = document.createElement('span');
    fill.className = 'metric-item-fill';

    const numeric = parseMetricNumber(value);
    let percent = 26;
    if (typeof numeric === 'number' && numericValues.length > 1 && maxValue > minValue) {
      percent = ((numeric - minValue) / (maxValue - minValue)) * 84 + 8;
    } else if (typeof numeric === 'number') {
      percent = Math.max(16, Math.min(88, Math.abs(numeric) > 0 ? 60 : 26));
    }

    fill.style.setProperty('--fill', `${percent.toFixed(1)}%`);
    meter.appendChild(fill);
    itemEl.appendChild(top);
    itemEl.appendChild(meter);
    track.appendChild(itemEl);
  }

  card.appendChild(track);
  return card;
}

function buildTemplateCardsFromDefinition(doc, category, usedKeys) {
  const template = getDocTemplate(category);
  if (!template || !Array.isArray(template.sections)) {
    return [];
  }

  const fields = doc.fields || {};
  const cards = [];

  for (const section of template.sections) {
    const rows = readOrderedPairs(fields, section.fields || [], usedKeys);
    const card = createMetaSection(section.title || '字段', rows, { cardClass: `meta-card--${category}` });
    if (card) {
      cards.push(card);
    }
  }

  if (template.includeRemaining) {
    const remaining = collectRemainingPairs(fields, usedKeys);
    if (remaining.length > 0) {
      cards.push(createMetaSection('全部字段', remaining, { cardClass: `meta-card--${category}` }));
    }
  }

  return cards;
}

function getTypeMetricTitle(category) {
  if (category === 'hero') {
    return '核心属性';
  }
  if (category === 'item') {
    return '关键参数';
  }
  if (category === 'unit') {
    return '单位指标';
  }
  if (category === 'building') {
    return '建筑指标';
  }
  return '关键指标';
}

function buildTypeMetricCard(category, fields, usedKeys) {
  const defs = TYPE_METRIC_DEFINITIONS[category] || [];
  const rows = collectMetricRows(fields || {}, defs, usedKeys);
  if (rows.length === 0) {
    return null;
  }

  return createMetricStripSection(getTypeMetricTitle(category), rows, { cardClass: `meta-card--${category}` });
}

function createMetaSection(title, rows, options = {}) {
  const card = document.createElement('section');
  const cardClass = normalizeValue(options.cardClass || '');
  card.className = `meta-card ${cardClass}`.trim();

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  const visibleRows = (Array.isArray(rows) ? rows : []).filter((item) => Array.isArray(item) && hasRenderableValue(item[0], item[1]));
  const uniqueRows = dedupeItems(visibleRows);
  if (uniqueRows.length === 0) {
    return null;
  }

  for (const [label, value] of uniqueRows) {
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

  return card;
}

function createTextSection(title, items, options = {}) {
  const card = document.createElement('section');
  const cardClass = normalizeValue(options.cardClass || '');
  card.className = `meta-card ${cardClass}`.trim();

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  const list = Array.isArray(items) ? items : [];
  const visibleList = list.filter((item) => Array.isArray(item) && hasRenderableValue(item[0], item[1]));
  const uniqueList = dedupeItems(visibleList);
  if (uniqueList.length === 0) {
    return null;
  }

  for (const [label, value] of uniqueList) {
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

function createNarrativeSection(title, paragraphs, options = {}) {
  const lines = (Array.isArray(paragraphs) ? paragraphs : [])
    .map((line) => normalizeValue(line))
    .filter((line) => hasRenderableToken(line));

  if (lines.length === 0) {
    return null;
  }

  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const key = normalizeValue(line);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(line);
  }

  const card = document.createElement('section');
  const cardClass = normalizeValue(options.cardClass || '');
  card.className = `meta-card narrative-card ${cardClass}`.trim();

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  const list = document.createElement('ol');
  list.className = 'narrative-list';
  for (const line of deduped) {
    const li = document.createElement('li');
    li.textContent = line;
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

function collectSectionRows(sections, options = {}) {
  const rows = [];
  const skipKeys = options.skipKeys instanceof Set ? options.skipKeys : new Set();
  const usedKeys = options.usedKeys instanceof Set ? options.usedKeys : new Set();
  const entries = Array.isArray(sections) ? sections : [];
  let index = 1;

  for (const item of entries) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const key = item.key || '字段';
    const normalizedKey = normalizeValue(key);
    if (skipKeys.has(key)) {
      continue;
    }
    if (usedKeys.has(key) || usedKeys.has(normalizeLabel(key))) {
      continue;
    }

    if (!hasRenderableValue(key, item.value)) {
      continue;
    }

    rows.push([`${index}. ${key}`, item.value]);
    index += 1;
  }

  return rows;
}

function readOrderedPairs(fields, specs, used = new Set()) {
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

    if (!hasRenderableValue(spec.label, fields[hitKey])) {
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
    if (used.has(key) || used.has(normalizeLabel(key)) || key === '_header') {
      continue;
    }
    if (!hasRenderableValue(key, fields[key])) {
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
  const heroImages = getHeroImagesForDisplay(doc, doc.heroSkills || []);
  const coverImage = heroImages[0] || null;
  const categoryLabel = CATEGORY_LABELS[category] || '文档';
  const attr = normalizeValue(fields['主属性'] || doc.meta?.attribute || '');
  const hasAttr = hasRenderableValue('主属性', attr);
  const tagClass = hasAttr
    ? (attr.includes('敏捷')
      ? 'hero-attr-agility'
      : attr.includes('智力')
        ? 'hero-attr-intellect'
        : 'hero-attr-strength')
    : '';

  const banner = document.createElement('div');
  banner.className = 'hero-identity';
  banner.style.setProperty('--hero-bg', 'linear-gradient(140deg, rgba(7, 21, 45, 0.78) 0%, rgba(6, 15, 34, 0.78) 58%, rgba(7, 13, 29, 0.85) 100%)');
  banner.style.setProperty('--hero-cover', 'none');

  const cover = document.createElement('div');
  cover.className = `hero-poster ${doc.heroImages?.length ? '' : 'placeholder'}`;

  if (coverImage) {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.src = new URL(coverImage, ASSET_BASE_URL).href;
    image.alt = `${title} 图像`;
    banner.style.setProperty('--hero-cover', `url("${image.src}")`);
    cover.appendChild(image);
  } else {
    cover.textContent = `${categoryLabel}封面`;
  }

  const info = document.createElement('div');
  info.className = 'hero-identity-meta';
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
  if (doc.group) {
    groupTag.textContent = doc.group;
    chips.appendChild(groupTag);
  }

  const attrTag = document.createElement('span');
  attrTag.className = 'hero-tag';
  if (hasAttr) {
    if (tagClass) {
      attrTag.classList.add(tagClass);
    }
    attrTag.textContent = `主属性：${attr}`;
    chips.appendChild(attrTag);
  }

  const metaRows = [
    ['攻击', fields.攻击 || '-'],
    ['生命', fields.生命 || fields['生命值'] || '-',],
    ['护甲', fields.护甲 || '-'],
    ['移动速度', fields.基础移动速度 || '-'],
    ['技能数', [fields.技能1, fields.技能2, fields.技能3, fields.技能4].filter((item) => item && toDisplayValue(item).trim()).length || 0],
  ];
  const stats = createTextSection('高亮速览', metaRows);

  info.appendChild(titleEl);
  info.appendChild(chips);
  info.appendChild(stats);

  banner.appendChild(cover);
  banner.appendChild(info);
  bannerEl.appendChild(banner);
}

function buildCommonCards(doc) {
  const parser = doc.parser || {};
  const parserStats = doc.parserStats || {};
  const fields = doc.fields || {};
  const category = getDisplayCategory(doc);

  const metaPairs = [
    ['标题', doc.meta?.title || doc.title || doc.name],
    ['分类', CATEGORY_LABELS[category] || category || 'other'],
    ['分组', doc.group || '其他'],
    ['文件类型', doc.type || 'txt'],
    ['标准版本', doc.schemaVersion || doc.meta?.schemaVersion || 'standard-doc-v2'],
    ['最后更新', formatTime(doc.lastModified)],
    ['体积', formatSize(doc.size)],
  ];

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

  const cards = [
    createMetaSection('档案标识', metaPairs, { cardClass: 'meta-card--meta' }),
    createMetaSection('解析信息', parserPairs, { cardClass: 'meta-card--meta' }),
  ];
  return compactCards(cards);
}

function renderHeroTemplate(doc) {
  const used = new Set();
  const fields = doc.fields || {};
  const cards = [];
  const metricCard = buildTypeMetricCard('hero', fields, used);
  if (metricCard) {
    cards.push(metricCard);
  }
  cards.push(...buildTemplateCardsFromDefinition(doc, 'hero', used));
  collectHeroAbilitySegmentsFromSections(Array.isArray(doc.sections) ? doc.sections : [], used);

  setContentRenderMode(doc, CONTENT_RENDER_MODES.CARD_ONLY);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderItemTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];
  const metricCard = buildTypeMetricCard('item', fields, used);
  if (metricCard) {
    cards.push(metricCard);
  }
  cards.push(...buildTemplateCardsFromDefinition(doc, 'item', used));
  const abilitySegments = collectAbilitySegmentsFromSections(doc.sections || [], used);
  const usedSegmentKeys = new Set();

  const segmentsFromFields = [];
  for (const [key, value] of Object.entries(fields)) {
    const info = splitAbilityKeyName(key);
    if (!info) {
      continue;
    }
    const rowValue = toDisplayValue(value);
    if (!hasRenderableValue(`${info.title}`, rowValue)) {
      continue;
    }
    segmentsFromFields.push([`${info.title}`, rowValue]);
    used.add(key);
  }
  if (segmentsFromFields.length > 0) {
    for (const [label] of segmentsFromFields) {
      usedSegmentKeys.add(label);
    }
    cards.push(createTextSection('字段化效果', segmentsFromFields, { cardClass: 'meta-card--item' }));
  }

  const uniqueAbilitySegments = abilitySegments.filter((segment) => {
    if (!segment?.title || usedSegmentKeys.has(segment.title)) {
      return false;
    }
    usedSegmentKeys.add(segment.title);
    return true;
  });

  if (uniqueAbilitySegments.length > 0) {
    cards.push(createTextSection('结构化效果', uniqueAbilitySegments.map((segment) => [segment.title, segment.value]), { cardClass: 'meta-card--item' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.HYBRID);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderUnitLikeTemplate(doc) {
  const used = new Set();
  const category = doc?.category || 'unit';
  const fields = doc.fields || {};
  const cards = [];
  const metricCard = buildTypeMetricCard(category, fields, used);
  if (metricCard) {
    cards.push(metricCard);
  }
  cards.push(...buildTemplateCardsFromDefinition(doc, category, used));

  setContentRenderMode(doc, CONTENT_RENDER_MODES.HYBRID);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderSkillTemplate(doc) {
  const used = new Set();
  const cards = buildTemplateCardsFromDefinition(doc, 'skill', used);
  const paragraphs = extractParagraphs(doc).slice(0, 12);
  if (paragraphs.length > 0) {
    used.add('段落');
    cards.push(createNarrativeSection('技能说明', paragraphs, { cardClass: 'meta-card--skill' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.HYBRID);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderBackstoryTemplate(doc) {
  const used = new Set();
  const cards = buildTemplateCardsFromDefinition(doc, 'backstory', used);
  const paragraphs = extractParagraphs(doc).join('\n\n');

  const heroTag = doc.meta?.hero ? `（关联：${doc.meta.hero}）` : '';
  if (paragraphs) {
    used.add('段落');
    cards.push(createNarrativeSection(`背景故事${heroTag}`, paragraphs.split('\n\n').filter(Boolean), { cardClass: 'meta-card--backstory' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.CARD_ONLY);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderSceneTemplate(doc) {
  const used = new Set();
  const cards = buildTemplateCardsFromDefinition(doc, 'scene', used);

  const paragraphs = extractParagraphs(doc);
  if (paragraphs.length > 0) {
    used.add('段落');
    cards.push(createNarrativeSection('场景内容', paragraphs, { cardClass: 'meta-card--scene' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.CARD_ONLY);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderRuleTemplate(doc) {
  const used = new Set();
  const cards = buildTemplateCardsFromDefinition(doc, 'rule', used);

  const paragraphs = extractParagraphs(doc);
  if (paragraphs.length > 0) {
    used.add('段落');
    cards.push(createNarrativeSection('规则段落', paragraphs, { cardClass: 'meta-card--rule' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.CARD_ONLY);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderTemplateLike(doc) {
  const used = new Set();
  const cards = buildTemplateCardsFromDefinition(doc, 'template', used);
  if (cards.length === 0) {
    cards.push(createMetaSection('模板骨架', collectRemainingPairs(doc.fields || {}, used), { cardClass: 'meta-card--template' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.HYBRID);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function renderFallbackTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];

  const remainingPairs = collectRemainingPairs(fields, used);
  cards.push(createMetaSection('结构化字段', remainingPairs, { cardClass: 'meta-card--template' }));

  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  if (sections.length > 0) {
    const rows = sections
      .filter((item) => item && item.key !== '_header')
      .filter((item) => hasRenderableValue(item.key, item.value))
      .map((item) => {
        const key = item.key || '段落';
        used.add(key);
        return [key, item.value];
      });
    cards.push(createTextSection('文档段落', rows, { cardClass: 'meta-card--template' }));
  }

  setContentRenderMode(doc, CONTENT_RENDER_MODES.HYBRID);
  doc._contentDedupeKeys = used;
  return compactCards(cards);
}

function getHeroCardsByCategory(doc) {
  switch (doc.category) {
    case 'hero': {
      const cards = renderHeroTemplate(doc);
      const linkedBackstory = resolveHeroBackstory(doc);
      if (linkedBackstory) {
        cards.push(...renderBackstoryTemplate(linkedBackstory));
      }
      return compactCards(cards);
    }
    case 'item':
      return renderItemTemplate(doc);
    case 'unit':
      return renderUnitLikeTemplate(doc);
    case 'building':
      return renderUnitLikeTemplate(doc);
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
    ? doc.sections.filter((item) => item?.key === '段落' && hasRenderableValue(item.key, item.value)).map((item) => item.value)
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
    .filter((line) => hasRenderableToken(line));
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

export {
  createMetaSection,
  createTextSection,
  createNarrativeSection,
  collectSectionRows,
  readOrderedPairs,
  collectRemainingPairs,
  renderHeroBanner,
  buildCommonCards,
  renderHeroTemplate,
  renderItemTemplate,
  renderUnitLikeTemplate,
  renderSkillTemplate,
  renderBackstoryTemplate,
  renderSceneTemplate,
  renderRuleTemplate,
  renderTemplateLike,
  renderFallbackTemplate,
  getHeroCardsByCategory,
  extractParagraphs,
  createTextBlock,
  renderKvTableRows,
  renderListBlock,
  renderTableBlock,
};
