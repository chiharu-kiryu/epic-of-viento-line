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
  getSourcePath,
} from './app-helpers.js';
import { renderHeroBanner, buildCommonCards, getHeroCardsByCategory } from './app-render.js';
import { renderStructuredBlocks } from './app-structured.js';

const {
  statusEl,
  listEl,
  searchInput,
  categoryTabsEl,
  titleEl,
  pathEl,
  metaEl,
  sectionEl,
  contentEl,
  galleryEl,
} = domElements;

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
  const docPath = getSourcePath(doc);
  pathEl.textContent = `${docPath || doc.path} · ${doc.type || 'txt'}`;

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
