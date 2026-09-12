import fs from 'node:fs/promises';
import vm from 'node:vm';
import { API_PATHS, API_ERRORS, API_RESPONSE } from '../lib/doc-api-contract.mjs';
import { getDocTemplate, DOC_TYPE_TEMPLATE_DEFS } from '../../web/modules/app-type-templates.js';
import { createBlockDraft, serializeBlockDraft, serializeSourceDraft } from '../../web/modules/app-editor-draft.js';
import { t, localize, getLanguage, onLanguageChange, translatePage, translateMessage } from '../../web/i18n/index.js';

// A small DOM surface for testing the production editor controller without a browser dependency.
export class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  set innerHTML(value) { this.children = []; this.markup = value; }
  get innerHTML() { return this.markup || ''; }
  get childElementCount() { return this.children.length; }
  set value(value) { this.inputValue = this.tagName === 'TEXTAREA' ? String(value).replace(/\r\n|\r/g, '\n') : value; }
  get value() { return this.inputValue; }
  set textContent(value) { this.children = []; this.text = String(value ?? ''); }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  replaceChildren(...children) { this.children = [...children]; this.text = ''; }
  appendChild(child) { this.children.push(...(child.tagName === 'FRAGMENT' ? child.children : [child])); }
  focus() {}
  addEventListener() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => {
      const matches = selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase();
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function editorHarness(overrides = {}) {
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element(id === 'docSourceEditor' ? 'textarea' : 'div'));
      return elements.get(id);
    },
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
  };
  const context = vm.createContext({
    URL, Set, Map, console, setTimeout, clearTimeout, setInterval, clearInterval, document,
    location: { href: 'http://127.0.0.1/web/?mode=edit', search: '?mode=edit' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    window: { confirm: () => false },
    API_PATHS, API_ERRORS, API_RESPONSE, getDocTemplate, DOC_TYPE_TEMPLATE_DEFS, createBlockDraft, serializeBlockDraft, serializeSourceDraft,
    t, localize, getLanguage, onLanguageChange, translatePage, translateMessage,
    toDisplayValue: (value) => String(value ?? ''),
    getDisplayCategory: (doc) => doc?.category || 'other',
    getDocListButtonCacheVersion: () => 0,
    getRenderedDocListButtons: () => [],
    readDocSource: async () => ({ content: '', version: '1' }),
    loadTemplateContent: async () => '',
    writeDoc: async () => ({ version: '2' }),
    ...overrides,
  });
  const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');
  const stateSource = stripImports(await fs.readFile(new URL('../../web/modules/app-state.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const runtimeSource = stripImports(await fs.readFile(new URL('../../web/modules/app-runtime.js', import.meta.url), 'utf8')).replace('export { initApp };', '');
  vm.runInContext(`${stateSource}\nconst state = appState;\n${runtimeSource}\n` +
    'globalThis.state = state; globalThis.renderActualContent = renderContent; renderContent = () => {}; renderMeta = () => {}; syncDocListEditPermissions = () => {};', context);
  context.state.mode = 'edit';
  context.state.editBackendAvailable = true;
  const doc = {
    path: 'rule/编辑检查', sourcePath: 'design-data/design-rules/编辑检查.md',
    category: 'rule', meta: {}, blocks: [{ type: 'heading', title: '旧索引的错误标题' }],
    _sourceCachedText: '原文\n', _sourceVersion: '1',
  };
  context.state.docs = [doc];
  context.state.activePath = doc.path;
  context.rebuildDocPathCaches([doc]);
  const source = document.getElementById('docSourceEditor');
  const begin = (content = '原文\n', version = '1') => {
    source.value = content;
    context.applyEditMode(doc, true);
    context.setEditSessionClean(content, version);
  };
  return { runtime: context, state: context.state, doc, source, element: document.getElementById, begin };
}
