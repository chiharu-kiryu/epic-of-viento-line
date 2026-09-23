import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Element } from './editor-harness.mjs';
import { t, translateMessage } from '../../web/i18n/index.js';

// Event-capable DOM fixture for the real dialog controllers. It reads their
// actual markup; layout and rendering remain covered by the native smoke test.
class DialogElement extends Element {
  constructor(tag, document) {
    super(tag);
    this.ownerDocument = document;
    this.listeners = new Map();
    this.open = false;
  }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const token of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?([\w-]+)\b([^>]*)>|([^<]+)/g)) {
      if (!token[1]) { if (token[3]) stack.at(-1).text = (stack.at(-1).text || '') + token[3]; continue; }
      const tag = token[1].toLowerCase();
      if (token[0].startsWith('</')) { if (stack.at(-1).tagName === tag.toUpperCase()) stack.pop(); continue; }
      const node = new DialogElement(tag, this.ownerDocument);
      for (const attr of token[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) {
        node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      stack.at(-1).appendChild(node);
      if (!voidTags.has(tag) && !token[0].endsWith('/>')) stack.push(node);
    }
  }
  get innerHTML() { return ''; }
  setAttribute(name, value) {
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    else this[name] = ['disabled', 'checked', 'hidden', 'required', 'multiple'].includes(name) ? true : value;
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
    return super.getAttribute(name);
  }
  appendChild(child) {
    if (child.tagName === 'FRAGMENT') { child.children.forEach((node) => this.appendChild(node)); return child; }
    child.parentElement = this; this.children.push(child);
    if (this.tagName === 'SELECT' && this.children.length === 1) this.value = child.value;
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
  remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    const tag = selector.match(/^[\w-]+/)?.[0];
    const id = selector.match(/#([\w-]+)/)?.[1];
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id)
      && classes.every((name) => this.classList.contains(name))
      && (!selector.includes(':checked') || this.checked)
      && [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value);
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.split(',').some((part) => child.matches(part.trim())) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
  dispatch(type, properties = {}) {
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...properties };
    let node = this;
    do {
      for (const listener of node.listeners.get(type) || []) listener(event);
      node = event.bubbles && !event.stopped ? node.parentElement : null;
    } while (node);
    return event;
  }
  click() {
    for (let node = this; node; node = node.parentElement) if (node.disabled) return;
    this.dispatch('click', { bubbles: true });
  }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.focus(); this.selectionStart = 0; this.selectionEnd = this.value.length; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; setImmediate(() => this.dispatch('close')); }
  requestSubmit() { this.dispatch('submit', { bubbles: true }); }
  scrollIntoView() {}
  pause() {}
}

export const flushDialogs = () => new Promise(setImmediate);

export async function dialogHarness(module, overrides = {}) {
  const document = {};
  document.documentElement = new DialogElement('html', document);
  document.body = new DialogElement('body', document);
  document.createElement = (tag) => new DialogElement(tag, document);
  document.createDocumentFragment = () => document.createElement('fragment');
  document.getElementById = (id) => document.body.querySelector(`#${id}`);
  document.querySelector = (selector) => document.body.querySelector(selector);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  const html = await fs.readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  document.body.innerHTML = html.match(/<body\b[^>]*>([\s\S]*?)<script/)[1];
  const window = new DialogElement('window', document);
  window.confirm = () => true; window.alert = () => {};
  const timers = new Map();
  let timerId = 0;
  const runtime = vm.createContext({
    document, window, URL, AbortController, DOMException, console,
    location: { href: 'http://127.0.0.1/web/' },
    t, translateMessage, translatePage() {}, onLanguageChange() {},
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    ...overrides,
  });
  const source = (await fs.readFile(new URL(`../../web/modules/${module}.js`, import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '').replaceAll('export ', '');
  vm.runInContext(source, runtime);
  return { runtime, document, element: document.getElementById, timers };
}
