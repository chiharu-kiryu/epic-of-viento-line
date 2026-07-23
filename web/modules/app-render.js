import {
  CATEGORY_LABELS,
  ASSET_BASE_URL,
} from './app-state.js';
import { domElements } from './app-state.js';
import {
  formatSize,
  formatTime,
  getDisplayCategory,
  normalizeLabel,
  normalizeValue,
  resolveHeroBackstory,
  splitAbilityKeyName,
  collectAbilitySegmentsFromSections,
  collectHeroAbilitySegmentsFromSections,
  hasVisibleValue,
  toDisplayValue,
  sanitizeList,
} from './app-helpers.js';

const { bannerEl } = domElements;

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

  return [
    createMetaSection('档案标识', metaPairs),
    createMetaSection('解析信息', parserPairs),
  ];
}

function renderHeroTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];
  const sections = Array.isArray(doc.sections) ? doc.sections : [];

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

  cards.push(createMetaSection('英雄属性', corePairs));
  cards.push(createMetaSection('作战参数', combatPairs));

  // 仅用于与原结构化内容去重，避免技能/段落在主面板和结构化区域重复。
  collectHeroAbilitySegmentsFromSections(sections, used);

  doc._contentDedupeKeys = used;
  return cards;
}

function renderItemTemplate(doc) {
  const fields = doc.fields || {};
  const used = new Set();
  const cards = [];
  const abilitySegments = collectAbilitySegmentsFromSections(doc.sections || [], used);
  const usedSegmentKeys = new Set();

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
    for (const [label] of segmentsFromFields) {
      usedSegmentKeys.add(label);
    }
    cards.push(createTextSection('字段化效果', segmentsFromFields));
  }

  const uniqueAbilitySegments = abilitySegments.filter((segment) => {
    if (!segment?.title || usedSegmentKeys.has(segment.title)) {
      return false;
    }
    usedSegmentKeys.add(segment.title);
    return true;
  });

  if (uniqueAbilitySegments.length > 0) {
    cards.push(createTextSection('结构化效果', uniqueAbilitySegments.map((segment) => [segment.title, segment.value])));
  }

  const remainingPairs = collectRemainingPairs(fields, used);
  if (remainingPairs.length > 0) {
    cards.push(createMetaSection('全部字段', remainingPairs));
  }

  doc._contentDedupeKeys = used;
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

  doc._contentDedupeKeys = used;
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

  doc._contentDedupeKeys = used;
  return cards;
}

function renderBackstoryTemplate(doc) {
  const fields = doc.fields || {};
  const cards = [];

  const heroTag = doc.meta?.hero ? `（关联：${doc.meta.hero}）` : '';
  const storyText = extractParagraphs(doc).join('\n\n');
  if (storyText) {
    cards.push(createTextSection(`背景故事${heroTag}`, [['内容', storyText]]));
  }

  const pairs = collectRemainingPairs(fields, new Set());
  doc._contentDedupeKeys = new Set(pairs.map(([key]) => key));
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

  doc._contentDedupeKeys = used;
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

  doc._contentDedupeKeys = used;
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

  doc._contentDedupeKeys = used;
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
      .map((item) => {
        const key = item.key || '段落';
        used.add(key);
        return [key, item.value];
      });
    cards.push(createTextSection('文档段落', rows));
  }

  doc._contentDedupeKeys = used;
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

export {
  createMetaSection,
  createTextSection,
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
