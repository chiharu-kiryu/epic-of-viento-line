const statusEl = document.getElementById('status');
const listEl = document.getElementById('docList');
const searchInput = document.getElementById('searchInput');
const titleEl = document.getElementById('docTitle');
const pathEl = document.getElementById('docPath');
const contentEl = document.getElementById('docContent');
const galleryEl = document.getElementById('heroGallery');
const PAGE_BASE = new URL('./', location.href);
const DATA_INDEX_URL = new URL('data/index.json', PAGE_BASE).href;
const ASSET_BASE_URL = new URL('../', PAGE_BASE).href;

let docs = [];
let activePath = '';

function createDetailsGroup(title, records) {
  const details = document.createElement('details');
  details.className = 'doc-group';
  details.open = true;

  const summary = document.createElement('summary');
  summary.textContent = `${title}（${records.length}）`;
  details.appendChild(summary);

  for (const doc of records) {
    const button = document.createElement('button');
    button.className = 'doc-item';
    button.type = 'button';
    button.textContent = doc.name;
    button.title = doc.path;
    button.dataset.path = doc.path;
    button.addEventListener('click', () => selectDoc(doc.path));
    details.appendChild(button);
  }
  return details;
}

function groupDocs(filtered) {
  const groups = new Map();
  for (const doc of filtered) {
    const key = `${doc.group}::${doc.category}`;
    const item = groups.get(key) || [];
    item.push(doc);
    groups.set(key, item);
  }
  return groups;
}

function markActiveItem() {
  for (const button of listEl.querySelectorAll('.doc-item')) {
    button.classList.toggle('active', button.dataset.path === activePath);
  }
}

function renderGallery(images) {
  galleryEl.innerHTML = '';
  if (!images || images.length === 0) {
    return;
  }
  const header = document.createElement('div');
  header.className = 'meta-path';
  header.textContent = '相关图片';
  galleryEl.appendChild(header);

  for (const url of images) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = new URL(url, ASSET_BASE_URL).href;
    img.alt = url;
    galleryEl.appendChild(img);
  }
}

function formatTime(value) {
  if (!value) {
    return '';
  }
  return new Date(value).toLocaleString();
}

function selectDoc(pathValue) {
  const doc = docs.find((item) => item.path === pathValue);
  if (!doc) {
    return;
  }
  activePath = doc.path;
  titleEl.textContent = doc.title || doc.name;
  pathEl.textContent = `${doc.path} · ${doc.type || 'txt'} · 更新：${formatTime(doc.lastModified)}`;
  renderGallery(doc.heroImages || []);
  contentEl.textContent = doc.content || '';
  markActiveItem();
}

function renderList(filteredDocs) {
  listEl.innerHTML = '';
  if (!filteredDocs.length) {
    listEl.innerHTML = '<div class="doc-group">未匹配到文档</div>';
    return;
  }

  const groups = groupDocs(filteredDocs);
  const groupNames = [...groups.keys()].sort((a, b) => {
    const left = a.split('::')[0];
    const right = b.split('::')[0];
    return left.localeCompare(right, 'zh-CN');
  });

  for (const key of groupNames) {
    const title = key.split('::')[0];
    const block = createDetailsGroup(title, groups.get(key));
    listEl.appendChild(block);
  }
  markActiveItem();
}

async function loadData() {
  try {
    const response = await fetch(DATA_INDEX_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    docs = payload.docs || [];
    statusEl.textContent = `共 ${docs.length} 个文档（静态生成 ${formatTime(payload.generatedAt)}）`;
    renderList(docs);
    if (docs.length > 0) {
      selectDoc(docs[0].path);
    }
  } catch (error) {
    statusEl.textContent = `加载失败：${error.message}`;
    listEl.textContent = '请先执行静态生成脚本：node scripts/build-static-doc-site.mjs';
  }
}

searchInput.addEventListener('input', () => {
  const keyword = searchInput.value.trim().toLowerCase();
  if (!keyword) {
    renderList(docs);
    return;
  }
  const filtered = docs.filter((doc) => {
    const source = `${doc.name} ${doc.path} ${doc.group} ${doc.category}`.toLowerCase();
    return source.includes(keyword);
  });
  renderList(filtered);
});

loadData();
