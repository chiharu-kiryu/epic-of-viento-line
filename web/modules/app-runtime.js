import {
  appState as state,
  domElements,
  DATA_INDEX_URL,
  DOC_API_URL,
  DOC_REBUILD_URL,
  CATEGORY_LABELS,
  CATEGORY_TAG,
  CATEGORY_ORDER,
  ASSET_BASE_URL,
  EDITABLE_SOURCE_PREFIXES,
  APP_ERROR_MESSAGES,
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
  toDisplayValue,
  sortHeroImagesForDisplay,
  pickHeroPortraitImage,
} from './app-helpers.js';
import { renderHeroBanner, buildCommonCards, getHeroCardsByCategory } from './app-render.js';
import { renderStructuredBlocks, hasRenderableToken } from './app-structured.js';

const {
  statusEl,
  listEl,
  searchInput,
  categoryTabsEl,
  searchClearEl,
  titleEl,
  subtitleEl,
  typeChipEl,
  groupChipEl,
  pathChipEl,
  metaEl,
  sectionEl,
  contentEl,
  galleryEl,
  editActionsEl,
  editCreateBtnEl,
  editBtnEl,
  editSaveBtnEl,
  editCancelBtnEl,
  editRebuildBtnEl,
  editPathEl,
  createPathWrapEl,
  createPathInputEl,
  editStatusEl,
  editEditorEl,
  editPanelEl,
  docEditorWrapEl,
  leftTotalStatEl,
  leftVisibleStatEl,
  leftLegendBodyEl,
} = domElements;

const REBUILD_TEXT = '重建索引';
let rebuildProgressTimer = null;
let rebuildProgressStart = 0;

function formatElapsedSeconds(startAt) {
  const elapsed = Math.max(0, Date.now() - startAt);
  return `${(elapsed / 1000).toFixed(1)}s`;
}

function normalizeCreatePathValue(rawPath) {
  return normalizeDisplayValue(rawPath).replace(/\\\\/g, '/');
}

function getCreateBaseDirectory(sourcePath) {
  const normalizedPath = normalizeCreatePathValue(sourcePath);
  if (!normalizedPath.startsWith('design-data/')) {
    return 'design-data/';
  }
  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash === -1) {
    return 'design-data/';
  }
  return `${normalizedPath.slice(0, lastSlash + 1)}`;
}

function ensureMarkdownLikeExtension(sourcePath) {
  const trimmed = normalizeDisplayValue(sourcePath);
  if (!trimmed) {
    return '';
  }
  if (/\.[A-Za-z0-9]+$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.txt`;
}

function getSuggestedCreatePath(sourcePath = '') {
  const base = getCreateBaseDirectory(sourcePath) || 'design-data/';
  const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').replace(/Z$/, '');
  return `${base}新建文档_${timestamp}.txt`;
}

function getCreateInputPath() {
  if (!createPathInputEl) {
    return '';
  }
  return normalizeCreatePathValue(createPathInputEl.value);
}

function isInvalidCreatePath(pathValue) {
  const normalizedPath = normalizeCreatePathValue(pathValue);
  if (!normalizedPath) {
    return APP_ERROR_MESSAGES.createPathRequired;
  }
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath)) {
    return '路径不能是绝对路径';
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return '路径不能包含 . 或 .. 路径段';
  }
  if (!normalizedPath.startsWith('design-data/')
    && !normalizedPath.startsWith('docs-standard/design-data/')) {
    return '路径必须以 design-data/ 或 docs-standard/design-data/ 开头';
  }
  if (normalizedPath.endsWith('/')) {
    return '路径不能以 / 结尾';
  }
  if (/[<>:"|?*]/.test(normalizedPath)) {
    return '路径包含非法字符';
  }
  return '';
}

function validateCreatePath(rawPath) {
  const normalizedPath = normalizeCreatePathValue(rawPath);
  const errorMessage = isInvalidCreatePath(normalizedPath);
  if (errorMessage) {
    return {
      isValid: false,
      value: normalizedPath,
      message: `${APP_ERROR_MESSAGES.createPathInvalid}：${errorMessage}`,
    };
  }
  return {
    isValid: true,
    value: normalizedPath,
    message: '',
  };
}

function setCreatePath(pathValue, fallback = '', ensureExt = false) {
  if (!createPathInputEl) {
    return '';
  }
  const rawValue = normalizeCreatePathValue(pathValue || fallback || getCreateInputPath());
  const value = ensureExt ? ensureMarkdownLikeExtension(rawValue) : rawValue;
  const validation = validateCreatePath(value);

  createPathInputEl.value = value;
  state.isCreatePathValid = validation.isValid;
  createPathInputEl.classList.toggle('is-invalid', !validation.isValid);
  return value;
}

function updateCreatePathValidation(showStatus = false) {
  if (!state.isCreating || !createPathInputEl) {
    return {
      isValid: state.isCreating ? state.isCreatePathValid : true,
      value: getCreateInputPath(),
      message: '',
    };
  }
  const validation = validateCreatePath(createPathInputEl.value);
  setCreatePath(validation.value);
  if (showStatus) {
    if (!validation.isValid) {
      setEditorStatus(validation.message);
    } else {
      setEditorStatus('');
    }
  }
  if (editSaveBtnEl && state.isCreating) {
    editSaveBtnEl.disabled = !validation.isValid || state.isRebuilding;
  }
  return validation;
}

function startRebuildProgressIndicator() {
  if (rebuildProgressTimer) {
    clearInterval(rebuildProgressTimer);
  }
  rebuildProgressStart = Date.now();

  if (editRebuildBtnEl && !editRebuildBtnEl.dataset.rebuildText) {
    editRebuildBtnEl.dataset.rebuildText = editRebuildBtnEl.textContent || REBUILD_TEXT;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.classList.add('is-loading');
  }

  const refreshProgress = () => {
    const elapsedText = formatElapsedSeconds(rebuildProgressStart);
    if (editRebuildBtnEl && editRebuildBtnEl.hidden === false) {
      editRebuildBtnEl.textContent = `重建中 ${elapsedText}`;
    }
    setEditorStatus(`${APP_ERROR_MESSAGES.rebuildStarting} ${formatElapsedSeconds(rebuildProgressStart)}`);
  };
  refreshProgress();
  rebuildProgressTimer = setInterval(refreshProgress, 300);
}

function stopRebuildProgressIndicator() {
  if (rebuildProgressTimer) {
    clearInterval(rebuildProgressTimer);
    rebuildProgressTimer = null;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.classList.remove('is-loading');
    editRebuildBtnEl.textContent = editRebuildBtnEl.dataset.rebuildText || REBUILD_TEXT;
  }
}

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
    .replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '');
}

function normalizeContentFingerprint(value) {
  return normalizeMatchValue(value)
    .toLowerCase();
}

function collectDedupeValuesByUsedKeys(doc, dedupeKeys) {
  const values = new Set();
  const fields = doc?.fields || {};
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];

  for (const [key, rawValue] of Object.entries(fields)) {
    if (!dedupeKeys.has(key) && !dedupeKeys.has(normalizeMatchValue(key))) {
      continue;
    }
    const value = toDisplayValue(rawValue);
    const signature = normalizeContentFingerprint(value);
    if (signature) {
      values.add(signature);
    }
  }

  for (const item of sections) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const key = normalizeDisplayValue(item.key);
    if (!key || !dedupeKeys.has(key) && !dedupeKeys.has(normalizeMatchValue(key))) {
      continue;
    }
    const value = toDisplayValue(item.value);
    const signature = normalizeContentFingerprint(value);
    if (signature) {
      values.add(signature);
    }
  }

  if (doc?._contentDedupeValues instanceof Set) {
    for (const value of doc._contentDedupeValues) {
      const signature = normalizeContentFingerprint(value);
      if (signature) {
        values.add(signature);
      }
    }
  }

  return values;
}

function getContentRenderMode(doc) {
  return doc?._contentRenderMode || 'hybrid';
}

function getSourcePath(doc) {
  const source = doc?.meta?.source || doc?.source?.path || doc?.sourcePath;
  return normalizeDisplayValue(source);
}

function toRebuildFilter(sourcePath) {
  const normalized = normalizeDisplayValue(sourcePath).replace(/^[/\\]+/, '');
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('design-data/')) {
    return normalized;
  }
  if (normalized.startsWith('docs-standard/design-data/')) {
    return normalized.replace(/^docs-standard\/design-data\//, 'design-data/');
  }
  return '';
}

function isEditableSourcePath(sourcePath) {
  return (
    typeof sourcePath === 'string'
    && EDITABLE_SOURCE_PREFIXES.some((prefix) => sourcePath.startsWith(prefix))
  );
}

function getEditableFallbackContent(doc) {
  if (typeof doc?.content === 'string' && doc.content.trim()) {
    return doc.content;
  }

  if (Array.isArray(doc?.sections) && doc.sections.length > 0) {
    return doc.sections
      .map((item) => `${normalizeDisplayValue(item?.key || '')}: ${normalizeDisplayValue(item?.value || '')}`.trim())
      .filter(Boolean)
      .join('\\n\\n');
  }

  if (Array.isArray(doc?.blocks) && doc.blocks.length > 0) {
    return doc.blocks
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        if (block.type === 'paragraph' || block.type === 'heading') {
          return normalizeDisplayValue(block.text || block.title || '');
        }
        if (block.type === 'json' && block.value && typeof block.value === 'object') {
          return JSON.stringify(block.value, null, 2);
        }
        if (block.type === 'table' && Array.isArray(block.rows)) {
          return JSON.stringify(block.rows, null, 2);
        }
        if (block.type === 'list' && Array.isArray(block.items)) {
          return block.items.join('\\n');
        }
        if (block.type === 'kv' && block.key) {
          return `${block.key}: ${toDisplayValue(block.value)}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\\n\\n');
  }

  return '';
}

function resetDocEditorState() {
  state.isEditing = false;
  state.isCreating = false;
  state.isCreatePathValid = true;
  state.activeEditPath = '';
  state.activeEditSource = '';
  state.activeCreatePath = '';
  if (editStatusEl) {
    editStatusEl.textContent = '';
  }
  if (docEditorWrapEl) {
    docEditorWrapEl.hidden = true;
  }
  if (editBtnEl) {
    editBtnEl.hidden = false;
    editBtnEl.disabled = false;
    editBtnEl.textContent = '编辑';
  }
  if (editSaveBtnEl) {
    editSaveBtnEl.hidden = true;
  }
  if (editCancelBtnEl) {
    editCancelBtnEl.hidden = true;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.hidden = true;
    editRebuildBtnEl.disabled = false;
  }
  if (editCreateBtnEl) {
    editCreateBtnEl.hidden = false;
    editCreateBtnEl.disabled = false;
  }
  if (createPathWrapEl) {
    createPathWrapEl.classList.add('is-hidden');
  }
  if (createPathInputEl) {
    createPathInputEl.value = '';
    createPathInputEl.placeholder = APP_ERROR_MESSAGES.createPathPlaceholder;
    createPathInputEl.classList.remove('is-invalid');
  }
}

const NEW_SKILL_MARKERS = /^(?:获得新技能|新增技能|新增被动技能|新增主动技能|新增额外技能)$/;

function updateSearchClearState() {
  if (!searchClearEl) {
    return;
  }
  searchClearEl.classList.toggle('is-visible', searchInput.value.trim().length > 0);
}

function categoryLabel(category) {
  return CATEGORY_LABELS[getDisplayCategory({ category })] || CATEGORY_LABELS[category] || category || '其他';
}

function updateLeftPanelStats(filtered = []) {
  if (leftTotalStatEl) {
    leftTotalStatEl.textContent = String(state.docs.length);
  }

  if (leftVisibleStatEl) {
    leftVisibleStatEl.textContent = String(filtered.length);
  }

  if (!leftLegendBodyEl) {
    return;
  }

  const countMap = new Map();
  for (const doc of filtered) {
    const key = getDisplayCategory(doc);
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }

  if (countMap.size === 0) {
    leftLegendBodyEl.innerHTML = '<span class="left-legend-item">暂无命中文档</span>';
    return;
  }

  const items = [...countMap.entries()]
    .sort((a, b) => b[1] - a[1]);

  leftLegendBodyEl.innerHTML = '';
  for (const [key, count] of items) {
    const pill = document.createElement('span');
    pill.className = 'left-legend-item';
    pill.textContent = `${categoryLabel(key)} (${count})`;
    leftLegendBodyEl.appendChild(pill);
  }
}

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

function pickSkillIconFromGallery(skillName, heroImages = [], excludedImages = new Set()) {
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

    if (excludedImages.has(image)) {
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

  const portraitImage = pickHeroPortraitImage(doc.heroImages || [], doc.heroSkills || []);
  const excludeIcons = new Set();
  if (portraitImage) {
    excludeIcons.add(portraitImage);
  }

  const used = new Set();
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
      || pickSkillIconFromGallery(name, doc.heroImages || [], excludeIcons);
    entries.push({
      key,
      name,
      icon,
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
      media.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'hero-skill-info';

    const title = document.createElement('div');
    title.className = 'text-title';
    title.textContent = `${item.key || '技能'}：${item.name}`;

    const body = document.createElement('div');
    body.className = 'text-body';
    if (item.description) {
      body.textContent = item.description;
      info.appendChild(body);
    }

    info.appendChild(title);
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
    if (card) {
      sectionEl.appendChild(card);
    }
  }
  if (doc?.category === 'hero') {
    renderHeroSkillCards(doc);
  }
}

function renderGallery(images, heroSkills = []) {
  galleryEl.innerHTML = '';
  if (!images || images.length === 0) {
    return;
  }

  const ordered = sortHeroImagesForDisplay(images, heroSkills);
  for (const url of ordered) {
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

  if (typeChipEl) {
    typeChipEl.textContent = `类型：${CATEGORY_LABELS[category] || category || '其他'}`;
    typeChipEl.className = `doc-chip ${CATEGORY_TAG[category] || 'other'}`;
  }

  if (groupChipEl) {
    if (doc.group) {
      groupChipEl.textContent = `分组：${doc.group}`;
      groupChipEl.hidden = false;
    } else {
      groupChipEl.textContent = '';
      groupChipEl.hidden = true;
    }
  }

  if (pathChipEl) {
    pathChipEl.textContent = `路径：${doc.path || '-'}`;
  }

  if (subtitleEl) {
    const sourceCategory = CATEGORY_LABELS[category] || category || '其他';
    const parts = [sourceCategory];
    if (doc.group) {
      parts.push(doc.group);
    }
    parts.push(doc.type || 'txt');
    subtitleEl.textContent = parts.join(' · ');
  }

  const tags = document.createElement('div');
  const tag = document.createElement('span');
  tag.className = `hero-tag ${CATEGORY_TAG[category] || 'other'}`;
  tag.textContent = `类型：${CATEGORY_LABELS[category] || '其他'}`;
  tags.appendChild(tag);
  metaEl.appendChild(tags);

  const baseCards = buildCommonCards(doc);
  for (const card of baseCards) {
    metaEl.appendChild(card);
  }
}

function setEditorPanelVisibility(visible) {
  if (!editPanelEl) {
    return;
  }
  editPanelEl.classList.toggle('is-hidden', !visible);
}

function setEditorStatus(message = '') {
  if (editStatusEl) {
    editStatusEl.textContent = message;
    editStatusEl.className = message ? 'doc-edit-status is-visible' : 'doc-edit-status';
  }
}

function setEditButtons({ isEditing, isCreating, canEdit }) {
  const isCreateMode = !!isCreating;
  const saveText = isCreateMode ? '创建' : '保存';
  const isEditorVisible = isEditing || isCreateMode;

  if (editCreateBtnEl) {
    editCreateBtnEl.hidden = isCreateMode || isEditorVisible;
    editCreateBtnEl.disabled = false;
  }

  if (editBtnEl) {
    editBtnEl.hidden = isCreateMode || !canEdit;
    editBtnEl.disabled = !canEdit;
    editBtnEl.textContent = isEditing ? '返回' : '编辑';
  }

  if (editSaveBtnEl) {
    editSaveBtnEl.hidden = !isEditorVisible;
    editSaveBtnEl.textContent = saveText;
    const createPathBlocked = isCreateMode && state.isCreatePathValid === false;
    editSaveBtnEl.disabled = !isEditorVisible || state.isRebuilding || createPathBlocked;
    editSaveBtnEl.classList.toggle('doc-btn-success', isEditorVisible);
  }

  if (editCancelBtnEl) {
    editCancelBtnEl.hidden = !isEditorVisible;
  }

  if (editRebuildBtnEl) {
    editRebuildBtnEl.hidden = !canEdit || isEditing || isCreateMode;
    editRebuildBtnEl.disabled = !canEdit || isEditorVisible || state.isRebuilding;
  }

  if (createPathWrapEl) {
    createPathWrapEl.classList.toggle('is-hidden', !isCreateMode);
  }

  if (docEditorWrapEl) {
    docEditorWrapEl.hidden = !isEditorVisible;
  }

  if (editEditorEl) {
    editEditorEl.disabled = !isEditorVisible;
  }

  if (editCreateBtnEl && isCreateMode) {
    editCreateBtnEl.disabled = true;
  }

  if (!isCreateMode && isEditorVisible) {
    editCreateBtnEl.hidden = true;
  }
}

function applyEditMode(doc, isEditing) {
  state.isEditing = isEditing;
  state.isCreating = false;
  state.isCreatePathValid = true;
  setEditButtons({
    isEditing,
    isCreating: false,
    canEdit: isEditableSourcePath(getSourcePath(doc)),
  });
  if (!isEditing) {
    state.activeEditPath = '';
    state.activeEditSource = '';
    if (editEditorEl) {
      editEditorEl.value = '';
    }
    contentEl.classList.remove('is-hidden');
    contentEl.hidden = false;
  } else if (editEditorEl) {
    contentEl.classList.add('is-hidden');
    contentEl.hidden = true;
    editEditorEl.focus();
  }
  contentEl.classList.toggle('is-empty', false);
}

function enterCreateMode() {
  if (state.isEditing && state.isCreating) {
    return;
  }
  if (state.isEditing) {
    exitEditMode();
  }

  const activeDoc = state.docs.find((item) => item.path === state.activePath);
  const baseSourcePath = isEditableSourcePath(getSourcePath(activeDoc || {}))
    ? getSourcePath(activeDoc || {})
    : 'design-data/';
  const suggestedPath = getSuggestedCreatePath(baseSourcePath);

  state.isEditing = true;
  state.isCreating = true;
  state.activeEditPath = '__new__';
  state.activeCreatePath = suggestedPath;
  setEditButtons({
    isEditing: false,
    isCreating: true,
    canEdit: true,
  });
  if (editPathEl) {
    editPathEl.textContent = `新建源：${suggestedPath}`;
  }
  if (editEditorEl) {
    editEditorEl.value = '';
  }
  setCreatePath(suggestedPath);
  updateCreatePathValidation();
  contentEl.classList.add('is-hidden');
  contentEl.hidden = true;
  contentEl.classList.toggle('is-empty', false);
  setEditorStatus('输入新建路径与内容后，点击“创建”');
}

async function fetchEditableSource(pathValue) {
  const response = await fetch(`${DOC_API_URL}?path=${encodeURIComponent(pathValue)}`);
  if (!response.ok) {
    const message = `读取源码失败（HTTP ${response.status}）`;
    return { error: message };
  }

  const payload = await response.json();
  const content = typeof payload?.content === 'string' ? payload.content : '';
  return { content };
}

function fillSourcePreview(doc, sourcePath) {
  const sourceContent = typeof doc._sourceCachedText === 'string' ? doc._sourceCachedText : getEditableFallbackContent(doc);
  if (editPathEl) {
    editPathEl.textContent = sourcePath ? `可编辑源：${sourcePath}` : '可编辑源：—';
  }
  if (editEditorEl) {
    editEditorEl.value = sourceContent || '';
  }
}

function enterEditMode() {
  const doc = state.docs.find((item) => item.path === state.activePath);
  if (!doc) {
    return;
  }
  const sourcePath = getSourcePath(doc);
  if (!isEditableSourcePath(sourcePath)) {
    return;
  }

  state.activeEditPath = doc.path;
  state.activeEditSource = sourcePath;
  if (doc._sourceCachedText === undefined) {
    doc._sourceCachedText = getEditableFallbackContent(doc);
  }
  applyEditMode(doc, true);
  if (editEditorEl) {
    editEditorEl.value = typeof doc._sourceCachedText === 'string' ? doc._sourceCachedText : '';
  }
}

async function saveCurrentDoc() {
  if (!editEditorEl) {
    return;
  }

  if (state.isCreating) {
    await saveNewDoc();
    return;
  }

  await saveExistingDoc();
}

async function saveNewDoc() {
  const validation = updateCreatePathValidation(true);
  if (!validation.isValid) {
    return;
  }
  const sourcePath = ensureMarkdownLikeExtension(validation.value);
  setCreatePath(sourcePath, '', true);
  if (!sourcePath) {
    setEditorStatus(APP_ERROR_MESSAGES.createPathRequired);
    return;
  }

  const content = editEditorEl.value;
  setEditorStatus(APP_ERROR_MESSAGES.savingSource);
  if (editSaveBtnEl) {
    editSaveBtnEl.disabled = true;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.disabled = true;
  }

  try {
    const response = await fetch(DOC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: sourcePath,
        content,
        create: true,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const extra = payload?.error ? `：${payload.error}` : '';
      setEditorStatus(`新建失败（HTTP ${response.status}）${extra}`);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }

    await response.json();
    const createdSource = sourcePath;
    state.activeCreatePath = createdSource;
    state.isCreating = false;
    state.isEditing = false;
    state.activeEditPath = '';
    state.activeEditSource = '';
    setEditorStatus(APP_ERROR_MESSAGES.createSuccess);
    await rebuildIndexForDoc({
      path: createdSource,
      meta: {},
      sourcePath: createdSource,
    }, {
      preferredPath: createdSource,
    });
    await loadData(createdSource);
  } catch (error) {
    setEditorStatus(`新建失败：${error?.message || '未知错误'}`);
  } finally {
    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = state.isRebuilding;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
  }
}

async function saveExistingDoc() {
  const doc = state.docs.find((item) => item.path === state.activePath);
  if (!doc || !isEditableSourcePath(getSourcePath(doc))) {
    return;
  }

  const sourcePath = getSourcePath(doc);
  if (!editEditorEl) {
    return;
  }

  const content = editEditorEl.value;
  setEditorStatus(APP_ERROR_MESSAGES.savingSource);
  if (editSaveBtnEl) {
    editSaveBtnEl.disabled = true;
  }
  if (editRebuildBtnEl) {
    editRebuildBtnEl.disabled = true;
  }

  try {
    const response = await fetch(DOC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: sourcePath,
        content,
      }),
    });

    if (!response.ok) {
      const message = `保存失败（HTTP ${response.status}）`;
      setEditorStatus(message);
      if (editSaveBtnEl) {
        editSaveBtnEl.disabled = false;
      }
      if (editRebuildBtnEl) {
        editRebuildBtnEl.disabled = false;
      }
      return;
    }

    await response.json();
    doc._sourceCachedText = content;
    doc._sourceRenderedText = content;
    setEditorStatus(APP_ERROR_MESSAGES.saveSuccess);

    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = false;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
    applyEditMode(doc, true);
    renderContent(doc);
    renderMeta(doc);
    await rebuildIndexForDoc(doc);
  } catch (error) {
    const message = `保存失败：${error?.message || '未知错误'}`;
    setEditorStatus(message);
    if (editSaveBtnEl) {
      editSaveBtnEl.disabled = false;
    }
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
  }
}

async function rebuildIndexForDoc(doc, options = {}) {
  if (!doc) {
    return;
  }

  const sourcePath = getSourcePath(doc);
  if (!isEditableSourcePath(sourcePath)) {
    return;
  }

  const rebuildFilter = toRebuildFilter(sourcePath);
  state.isRebuilding = true;
  const preferredPath = options.preferredPath || state.activePath;
  const isCurrentDocEditing = state.isEditing && !state.isCreating && state.activeEditPath === doc.path;
  setEditButtons({
    isEditing: isCurrentDocEditing,
    isCreating: false,
    canEdit: true,
  });
  startRebuildProgressIndicator();

  try {
    const response = await fetch(DOC_REBUILD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: rebuildFilter,
      }),
    });

    if (!response.ok) {
      const message = `重建失败（HTTP ${response.status}）`;
      const payload = await response.json().catch(() => null);
      const extra = payload?.error ? `：${payload.error}` : '';
      setEditorStatus(`${message}${extra}`);
      stopRebuildProgressIndicator();
      return;
    }

    await response.json();
    await loadData(preferredPath);
    if (!state.isEditing && isCurrentDocEditing) {
      enterEditMode();
    } else if (state.isEditing && state.activeEditPath === doc.path) {
      const activeDoc = state.docs.find((item) => item.path === state.activePath);
      if (activeDoc) {
        syncDocEditorSource(activeDoc).then(() => {
          if (state.activePath === activeDoc.path) {
            fillSourcePreview(activeDoc, getSourcePath(activeDoc));
          }
        });
      }
    }
    const elapsed = formatElapsedSeconds(rebuildProgressStart);
    setEditorStatus(`${APP_ERROR_MESSAGES.rebuildSuccess}（耗时 ${elapsed}）`);
  } catch (error) {
    setEditorStatus(`重建失败：${error?.message || '未知错误'}`);
  } finally {
    stopRebuildProgressIndicator();
    state.isRebuilding = false;
    const currentDoc = state.docs.find((item) => item.path === state.activePath);
    setEditButtons({
      isEditing: state.isEditing && state.activeEditPath === (currentDoc?.path || ''),
      isCreating: state.isCreating,
      canEdit: isEditableSourcePath(getSourcePath(currentDoc || {})),
    });
    if (editRebuildBtnEl) {
      editRebuildBtnEl.disabled = false;
    }
  }
}

function exitEditMode() {
  if (state.isCreating) {
    state.isCreating = false;
    state.activeEditPath = '';
    state.activeEditSource = '';
    if (state.activePath) {
      const currentDoc = state.docs.find((item) => item.path === state.activePath);
      if (currentDoc) {
        setEditorStatus('');
        applyEditMode(currentDoc, false);
        return;
      }
    }
  }

  const doc = state.docs.find((item) => item.path === state.activePath);
  if (doc) {
    renderContent(doc);
  }
  setEditorStatus('');
  applyEditMode(doc, false);
}

async function syncDocEditorSource(doc) {
  const sourcePath = getSourcePath(doc);
  if (!sourcePath) {
    return null;
  }
  const sourceInfo = await fetchEditableSource(sourcePath);
  if (sourceInfo?.error) {
    return { error: sourceInfo.error };
  }
  doc._editorSource = sourcePath;
  doc._sourceCachedText = sourceInfo.content;
  return { sourcePath, content: sourceInfo.content };
}

function updateEditorForDoc(doc) {
  const sourcePath = getSourcePath(doc);
  const canEdit = isEditableSourcePath(sourcePath);

  setEditorPanelVisibility(true);
  setEditorStatus('');

  if (canEdit) {
    fillSourcePreview(doc, sourcePath);
  } else {
    if (editPathEl) {
      editPathEl.textContent = '可编辑源：当前文档不可直接编辑';
    }
    if (editEditorEl) {
      editEditorEl.value = '';
    }
  }

  setEditButtons({
    isEditing: state.isEditing && state.activeEditPath === doc.path,
    isCreating: false,
    canEdit,
  });
}

function renderContent(doc) {
  if (typeof doc?._sourceRenderedText === 'string') {
    contentEl.classList.remove('is-empty');
    contentEl.style.display = '';
    contentEl.textContent = doc._sourceRenderedText;
    return;
  }

  const mode = getContentRenderMode(doc);
  contentEl.style.display = '';
  contentEl.innerHTML = '';

  if (mode === 'card-only') {
    contentEl.classList.add('is-empty');
    contentEl.style.display = 'none';
    return;
  }

  contentEl.classList.remove('is-empty');

  if (Array.isArray(doc.blocks) && doc.blocks.length > 0) {
    const dedupeFieldKeys = new Set(Object.keys(doc.fields || {}));
    if (doc._contentDedupeKeys instanceof Set) {
      for (const key of doc._contentDedupeKeys) {
        dedupeFieldKeys.add(key);
      }
    }
    const dedupeTextValues = collectDedupeValuesByUsedKeys(doc, dedupeFieldKeys);
    const rendered = renderStructuredBlocks(doc.blocks, {
      dedupeKeys: dedupeFieldKeys,
      dedupeText: dedupeTextValues,
      renderMode: mode,
    });

    if (rendered) {
      contentEl.appendChild(rendered);
    } else if (mode === 'full') {
      contentEl.classList.add('is-empty');
      contentEl.style.display = 'none';
      return;
    }
  } else {
    const content = typeof doc.content === 'string' ? doc.content : '';
    const dedupeText = collectDedupeValuesByUsedKeys(doc, new Set(Object.keys(doc.fields || {})));
    const contentText = content
      .split(/\n{2,}/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!hasRenderableToken(line)) {
          return false;
        }
        const signature = normalizeContentFingerprint(line);
        if (!signature || dedupeText.has(signature)) {
          return false;
        }
        dedupeText.add(signature);
        return true;
      })
      .join('\n\n');
    contentEl.textContent = contentText;
  }

  if (!normalizeDisplayValue(contentEl.textContent || '').trim() && contentEl.children.length === 0) {
    contentEl.textContent = '';
    contentEl.classList.add('is-empty');
    contentEl.style.display = 'none';
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

function renderFilteredDocs(preferredPath = '') {
  const filtered = getHeroDisplayDocs(getVisibleDocs());
  updateLeftPanelStats(filtered);
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

  const desiredPath = preferredPath && filtered.some((doc) => doc.path === preferredPath) ? preferredPath : state.activePath;
  if (!filtered.some((doc) => doc.path === desiredPath)) {
    selectDoc(filtered[0].path);
  } else {
    selectDoc(desiredPath);
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

  const isDifferentDoc = state.activePath !== pathValue;
  state.activePath = doc.path;

  if (isDifferentDoc) {
    applyEditMode(null, false);
    setEditorStatus('');
  }

  if (isEditableSourcePath(getSourcePath(doc))) {
    if (doc._sourceCachedText === undefined) {
      setEditorStatus(APP_ERROR_MESSAGES.loadingSource);
      syncDocEditorSource(doc)
        .then((result) => {
          if (state.activePath !== doc.path) {
            return;
          }
          if (result?.error) {
            setEditorStatus(result.error);
            return;
          }
          fillSourcePreview(doc, getSourcePath(doc));
          setEditorStatus('');
        })
        .catch((error) => {
          if (state.activePath === doc.path) {
            setEditorStatus(`读取源码失败：${error?.message || '未知错误'}`);
          }
        });
    }
  }

  renderHeroBanner(doc);
  renderMeta(doc);
  renderSectionCards(doc);
  renderGallery(doc.heroImages || [], doc.heroSkills || []);
  renderContent(doc);
  updateEditorForDoc(doc);
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

async function loadData(preferredPath = '') {
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
      doc.sourcePath = getSourcePath(doc);
      doc.fields = doc.fields || {};
      doc.sections = doc.sections || [];
      doc.outline = doc.outline || [];
      doc.blocks = doc.blocks || [];
      doc.parser = doc.parser || {};
      doc.heroSkills = doc.heroSkills || [];
      doc.heroImages = sortHeroImagesForDisplay(doc.heroImages || [], doc.heroSkills || []);
      doc._sourceRenderedText = undefined;
      doc._sourceCachedText = undefined;
    });

    state.generatedStatus = `（静态生成 ${formatTime(payload.generatedAt)}）`;
    renderTabs();
    renderFilteredDocs(preferredPath || state.activePath);
    updateSearchClearState();
  } catch (error) {
    statusEl.textContent = `加载失败：${error.message}`;
    listEl.textContent = '请先执行静态生成脚本：node scripts/build-static-doc-site.mjs';
  }
}

function initApp() {
  searchInput.addEventListener('input', () => {
    updateSearchClearState();
    renderFilteredDocs();
  });

  if (searchClearEl) {
    searchClearEl.addEventListener('click', () => {
      searchInput.value = '';
      updateSearchClearState();
      renderFilteredDocs();
      searchInput.focus();
    });
  }

  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      if (state.isCreating) {
        return;
      }
      const doc = state.docs.find((item) => item.path === state.activePath);
      if (!doc) {
        return;
      }
      if (state.isEditing && state.activeEditPath === doc.path) {
        exitEditMode();
      } else if (isEditableSourcePath(getSourcePath(doc))) {
        enterEditMode();
      }
    });
  }

  if (editCreateBtnEl) {
    editCreateBtnEl.addEventListener('click', () => {
      enterCreateMode();
    });
  }

  if (createPathInputEl) {
    createPathInputEl.addEventListener('input', () => {
      if (!state.isCreating) {
        return;
      }
      updateCreatePathValidation(true);
    });
    createPathInputEl.addEventListener('blur', () => {
      if (!state.isCreating) {
        return;
      }
      updateCreatePathValidation(true);
    });
  }

  if (editSaveBtnEl) {
    editSaveBtnEl.addEventListener('click', () => {
      void saveCurrentDoc();
    });
  }

  if (editCancelBtnEl) {
    editCancelBtnEl.addEventListener('click', () => {
      exitEditMode();
    });
  }

  if (editRebuildBtnEl) {
    editRebuildBtnEl.addEventListener('click', () => {
      const doc = state.docs.find((item) => item.path === state.activePath);
      if (!doc || state.isEditing) {
        return;
      }
      void rebuildIndexForDoc(doc);
    });
  }

  if (editEditorEl) {
    editEditorEl.addEventListener('keydown', (event) => {
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveCurrentDoc();
      }
    });
  }

  resetDocEditorState();
  setEditorPanelVisibility(false);
  loadData();
}

export { initApp };
