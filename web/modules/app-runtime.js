import {
  appState as state,
  domElements,
  DATA_INDEX_URL,
  CATEGORY_LABELS,
  CATEGORY_TAG,
  CATEGORY_ORDER,
  ASSET_BASE_URL,
} from './app-state.js';
import {
  getHeroDisplayDocs,
  getVisibleDocs,
  createDetailsGroup,
  renderTabs,
  markActiveItem,
  formatTime,
  groupDocs,
  createDocButton,
  getDisplayCategory,
} from './app-helpers.js';
import { renderHeroBanner, buildCommonCards, getHeroCardsByCategory } from './app-render.js';
import { renderStructuredBlocks } from './app-structured.js';

const {
  statusEl,
  listEl,
  searchInput,
  categoryTabsEl,
  titleEl,
  metaEl,
  sectionEl,
  contentEl,
  galleryEl,
} = domElements;

function normalizeDisplayValue(value) {
  return (value || '').toString().trim();
}

function normalizeMatchValue(value) {
  return normalizeDisplayValue(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\uFEFF]/g, '')
    .replace(/[\s\-_\.:：]/g, '')
    .replace(/[\[\]【】()（）]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

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

function stripSkillSuffixes(value) {
  return normalizeDisplayValue(value).replace(/[：:]+$/u, '').trim();
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

function trimKnownSkillName(rawName, knownNames = []) {
  const normalizedRaw = normalizeForNameCompare(rawName);
  if (!normalizedRaw) {
    return rawName;
  }
  for (const candidate of knownNames) {
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

function parseHeroSkillHeaderFromLines(key, lines = [], knownNames = []) {
  let cursor = 0;
  const normalizedKey = normalizeMatchValue(key);

  while (cursor < lines.length) {
    const current = stripSkillSuffixes(lines[cursor]);
    if (!current) {
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

    if (NEW_SKILL_MARKERS.test(current) || /^新增/.test(current)) {
      cursor += 1;
      continue;
    }

    const passivePrefix = current.match(/^(?:被动|主动)[:：]\s*(.+)$/);
    if (passivePrefix) {
      return {
        name: stripSkillSuffixes(passivePrefix[1]) || key,
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

    if (normalizeMatchValue(current) === normalizedKey && cursor + 1 < lines.length) {
      const next = stripSkillSuffixes(lines[cursor + 1]);
      if (next && normalizeMatchValue(next) !== normalizedKey && next.length <= 24 && !/[，。；:：]/.test(next)) {
        return {
          name: stripSkillSuffixes(next),
          description: lines.slice(cursor + 2).join('\n'),
        };
      }
    }

    return {
      name: isLikelySkillDescription(key, current) || !isLikelyForgedOrRuneName(key, current)
        ? key
        : trimKnownSkillName(stripSkillSuffixes(current), knownNames),
      description: lines.slice(cursor + (isLikelySkillDescription(key, current) ? 0 : 1)).join('\n'),
    };
  }

  return { name: key, description: '' };
}

function pickSkillIconFromGallery(skillName, heroImages = []) {
  const targetCandidates = [];

  const addNeedle = (value) => {
    const normalized = normalizeMatchValue(value);
    if (!normalized || targetCandidates.includes(normalized)) {
      return;
    }
    targetCandidates.push(normalized);
  };

  const compactName = normalizeDisplayValue(skillName)
    .replace(/^(?:技能\d+|天生技能|先天技能)[:：]?\s*/, '')
    .replace(/^(?:被动|主动)[:：]?\s*/, '')
    .trim();

  addNeedle(skillName);
  addNeedle(compactName);

  if (!targetCandidates.length) {
    return null;
  }

  for (const image of heroImages) {
    const base = image ? image.split('/').at(-1) : '';
    if (!base) {
      continue;
    }
    const normalized = normalizeMatchValue(base.replace(/\.[^.]+$/u, ''));
    if (!normalized) {
      continue;
    }

    if (targetCandidates.some((needle) => (
      normalized === needle
      || normalized.includes(needle)
      || needle.includes(normalized)
    ))) {
      return image;
    }
  }

  return null;
}

function buildHeroSkillsFallback(sections = []) {
  const result = [];
  const seen = new Set();
  const knownNames = [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      continue;
    }
    const key = normalizeDisplayValue(section.key);
    if (!key || !/^(天生技能|先天技能|技能[1-4]|阳印|阴印|铸神|铸魔)$/.test(key)) {
      continue;
    }

    const lines = normalizeDisplayValue(section.value)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      continue;
    }

    const parsed = parseHeroSkillHeaderFromLines(key, lines, knownNames);
    const name = trimKnownSkillName(parsed.name || key, knownNames);
    const description = parsed.description;
    const signature = normalizeMatchValue(key);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    result.push({ key, name, description });
    knownNames.push(name);
  }

  return result;
}

function buildHeroSkillCards(doc) {
  const sourceEntries = Array.isArray(doc.heroSkills) && doc.heroSkills.length > 0
    ? doc.heroSkills
    : buildHeroSkillsFallback(doc.sections || []);
  if (!sourceEntries.length) {
    return null;
  }

  const used = new Set();
  const usedIcons = new Set();
  const entries = [];
  for (const item of sourceEntries) {
    const key = normalizeDisplayValue(item.key);
    const name = normalizeDisplayValue(item.name || key);
    const signature = `${normalizeMatchValue(key)}::${normalizeMatchValue(name)}`;
    if (!signature || used.has(signature)) {
      continue;
    }
    used.add(signature);
    const icon = normalizeDisplayValue(item.icon)
      || pickSkillIconFromGallery(name, doc.heroImages || []);
    const iconUnique = icon && !usedIcons.has(icon) ? icon : null;
    if (icon) {
      usedIcons.add(icon);
    }
    entries.push({
      key,
      name,
      icon: iconUnique,
      description: normalizeDisplayValue(item.description),
    });
  }

  if (!entries.length) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'meta-card';

  const heading = document.createElement('h3');
  heading.textContent = '技能图标与说明';
  card.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'hero-skill-list';

  for (const item of entries) {
    const row = document.createElement('div');
    row.className = 'hero-skill-row';

    const media = document.createElement('div');
    media.className = 'hero-skill-media';
    if (item.icon) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = new URL(item.icon, ASSET_BASE_URL).href;
      img.alt = `${item.name || item.key || '技能'}图标`;
      media.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'hero-skill-empty';
      placeholder.textContent = '暂无图标';
      media.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'hero-skill-info';

    const title = document.createElement('div');
    title.className = 'text-title';
    title.textContent = `${item.key || '技能'}：${item.name}`;

    const body = document.createElement('div');
    body.className = 'text-body';
    body.textContent = item.description || '（暂无文字说明）';

    info.appendChild(title);
    info.appendChild(body);
    row.appendChild(media);
    row.appendChild(info);
    list.appendChild(row);
  }

  card.appendChild(list);
  return card;
}

function removeDuplicateHeroSkillCards() {
  const removeTitles = new Set(['技能树', '技能说明']);
  const cards = sectionEl.querySelectorAll('.meta-card');
  for (const card of cards) {
    const title = card.querySelector('h3');
    if (!title) {
      continue;
    }
    if (removeTitles.has(normalizeDisplayValue(title.textContent))) {
      card.remove();
    }
  }
}

function renderHeroSkillCards(doc) {
  if (doc?.category !== 'hero') {
    return;
  }
  removeDuplicateHeroSkillCards();
  const card = buildHeroSkillCards(doc);
  if (card) {
    sectionEl.appendChild(card);
  }
}

function renderSectionCards(doc) {
  sectionEl.innerHTML = '';
  const sectionCards = getHeroCardsByCategory(doc);
  for (const card of sectionCards) {
    sectionEl.appendChild(card);
  }
  if (doc?.category === 'hero') {
    renderHeroSkillCards(doc);
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
  const isHeroDoc = doc?.category === 'hero';
  contentEl.classList.toggle('is-empty', isHeroDoc);
  if (isHeroDoc) {
    contentEl.textContent = '';
    contentEl.style.display = 'none';
    return;
  }
  contentEl.style.display = '';

  if (Array.isArray(doc.blocks) && doc.blocks.length > 0) {
    contentEl.innerHTML = '';
    const dedupeFieldKeys = new Set(Object.keys(doc.fields || {}));
    if (doc._contentDedupeKeys instanceof Set) {
      for (const key of doc._contentDedupeKeys) {
        dedupeFieldKeys.add(key);
      }
    }
    contentEl.appendChild(renderStructuredBlocks(doc.blocks, {
      dedupeKeys: dedupeFieldKeys,
    }));
  } else {
    contentEl.textContent = doc.content || '';
  }
}

function renderList(filteredDocs) {
  listEl.innerHTML = '';
  if (!filteredDocs.length) {
    const msg = searchInput.value.trim() ? '未匹配到文档' : '当前标签暂无文档';
    listEl.innerHTML = `<div class=\"doc-group\">${msg}</div>`;
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
        const button = createDocButton(doc, selectDoc);
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
    statusEl.textContent = `${hasKeyword ? '未匹配到文档' : '当前标签暂无文档'} ${state.generatedStatus}`;
    if (categoryTabsEl) {
      renderTabs();
    }
    return;
  }

  const displayText = `当前显示 ${filtered.length} 个文档（共 ${state.docs.length} 个）`;
  const tabText = searchInput.value.trim() ? '（已按关键词筛选）' : '';
  statusEl.textContent = `${displayText} ${tabText} ${state.generatedStatus}`;

  if (!filtered.some((doc) => doc.path === state.activePath)) {
    selectDoc(filtered[0].path);
  } else {
    selectDoc(state.activePath);
  }

  if (categoryTabsEl) {
    renderTabs();
  }
}

function selectDoc(pathValue) {
  const doc = state.docs.find((item) => item.path === pathValue);
  if (!doc) {
    return;
  }

  state.activePath = doc.path;
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
    state.docs = payload?.docs || payload?.state?.docs || [];
    state.docs.forEach((doc) => {
      doc._searchText = collectSearchText(doc);
      doc.meta = doc.meta || {};
      doc.fields = doc.fields || {};
      doc.sections = doc.sections || [];
      doc.outline = doc.outline || [];
      doc.blocks = doc.blocks || [];
      doc.parser = doc.parser || {};
      doc.heroImages = doc.heroImages || [];
      doc.heroSkills = doc.heroSkills || [];
    });

    state.generatedStatus = `（静态生成 ${formatTime(payload.generatedAt)}）`;
    renderTabs();
    renderFilteredDocs();
  } catch (error) {
    statusEl.textContent = `加载失败：${error.message}`;
    listEl.textContent = '请先执行静态生成脚本：node scripts/build-static-doc-site.mjs';
  }
}

function initApp() {
  searchInput.addEventListener('input', () => {
    renderFilteredDocs();
  });
  loadData();
}

export { initApp };
