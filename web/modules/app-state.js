export const PAGE_BASE = new URL('./', location.href);
export const DATA_INDEX_URL = new URL('data/index.json', PAGE_BASE).href;
export const ASSET_BASE_URL = new URL('../', PAGE_BASE).href;
export const DOC_CAPABILITIES_URL = new URL('/api/capabilities', PAGE_BASE).href;
export const DOC_API_URL = new URL('/api/doc', PAGE_BASE).href;
export const DOC_REBUILD_URL = new URL('/api/rebuild', PAGE_BASE).href;

export const appState = {
  docs: [],
  activePath: '',
  activeTab: 'all',
  generatedStatus: '',
  editInputMode: 'source',
  editBlockDrafts: [],
  mode: 'browse',
  editBackendAvailable: false,
  isEditing: false,
  isRebuilding: false,
  isCreating: false,
  isCreatePathValid: true,
  activeEditPath: '',
  activeEditSource: '',
  activeCreatePath: '',
};

export const domElements = {
  statusEl: document.getElementById('status'),
  listEl: document.getElementById('docList'),
  searchInput: document.getElementById('searchInput'),
  searchClearEl: document.getElementById('searchClear'),
  categoryTabsEl: document.getElementById('categoryTabs'),
  titleEl: document.getElementById('docTitle'),
  subtitleEl: document.getElementById('docSubtitle'),
  typeChipEl: document.getElementById('docTypeChip'),
  groupChipEl: document.getElementById('docGroupChip'),
  pathChipEl: document.getElementById('docPathChip'),
  bannerEl: document.getElementById('heroBanner'),
  metaEl: document.getElementById('metaCards'),
  sectionEl: document.getElementById('sectionCards'),
  contentEl: document.getElementById('docContent'),
  galleryEl: document.getElementById('heroGallery'),
  editActionsEl: document.getElementById('docEditActions'),
  editCreateBtnEl: document.getElementById('docCreateBtn'),
  editBtnEl: document.getElementById('docEditBtn'),
  editSaveBtnEl: document.getElementById('docSaveBtn'),
  editCancelBtnEl: document.getElementById('docCancelBtn'),
  editRebuildBtnEl: document.getElementById('docRebuildBtn'),
  editPathEl: document.getElementById('docEditPath'),
  editModeBarEl: document.getElementById('docEditModeBar'),
  editSourceModeBtnEl: document.getElementById('docEditSourceModeBtn'),
  editBlockModeBtnEl: document.getElementById('docEditBlockModeBtn'),
  editBlockEditorEl: document.getElementById('docBlockEditor'),
  createPathWrapEl: document.getElementById('docCreatePathWrap'),
  createPathInputEl: document.getElementById('docCreatePathInput'),
  editStatusEl: document.getElementById('docEditStatus'),
  editEditorEl: document.getElementById('docSourceEditor'),
  modeSwitchEl: document.getElementById('modeSwitch'),
  modeBrowseBtnEl: document.getElementById('modeBrowseBtn'),
  modeEditBtnEl: document.getElementById('modeEditBtn'),
  modeStateEl: document.getElementById('modeStateChip'),
  editPanelEl: document.getElementById('docEditPanel'),
  docEditorWrapEl: document.getElementById('docEditorWrap'),
  leftTotalStatEl: document.getElementById('leftTotalStat'),
  leftVisibleStatEl: document.getElementById('leftVisibleStat'),
  leftLegendBodyEl: document.getElementById('leftLegendBody'),
};

export const EDITABLE_SOURCE_PREFIXES = ['design-data/', 'docs-standard/design-data/'];

export const APP_ERROR_MESSAGES = {
  noEditablePath: '该文档当前未绑定到可编辑源文件',
  loadingSource: '正在读取源文档...',
  savingSource: '正在保存源码...',
  saveSuccess: '保存成功，正在重建索引...',
  createSuccess: '新建成功，正在重建索引...',
  createPathRequired: '请先填写新建路径',
  createPathInvalid: '新建路径无效',
  createPathPlaceholder: '请输入可编辑路径（如 design-data/xxx.md）',
  rebuildStarting: '重建索引中...',
  rebuildSuccess: '重建完成，文档已刷新',
  rebuildFailed: '重建失败，请稍后重试',
  editModeUnavailable: '当前后端未开启编辑接口，已切到浏览模式。请用 `start-doc-site.sh --mode edit` 启动。',
  granularEditUnavailable: '当前文档不支持区块编辑，已切到源码模式。',
};

export const TAB_DEFINITIONS = [
  { id: 'all', label: '全部' },
  { id: 'hero', label: '英雄' },
  { id: 'item', label: '物品' },
  { id: 'other', label: '其他' },
];

export const CATEGORY_LABELS = {
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

export const CATEGORY_TAG = {
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

export const CATEGORY_ORDER = [
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

export const BACKSTORY_CHUNK_SIZE = 640;
