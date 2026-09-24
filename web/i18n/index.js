import { formatMessage } from './messages.js';
import { supportedLanguages, isSupportedLanguage } from './languages.js';

export const LANGUAGES = supportedLanguages;
export const LANGUAGE_STORAGE_KEY = 'viento-ui-language';
export const isLanguage = isSupportedLanguage;
const listeners = new Set();
const formattedMessages = new Map();
const messageTag = Symbol('interface message');
let language = 'zh-CN';
export const getLanguage = () => language;

// Explicitly nested interface text can be translated again after a language
// change. Ordinary string arguments remain literal, including authored names.
export function uiMessage(key, ...values) {
  return { [messageTag]: true, key, values };
}

export function asUiMessage(text) {
  const message = formattedMessages.get(String(text));
  return message ? uiMessage(message.key, ...message.values) : text;
}

// Only explicit interface messages enter the catalogue. Never translate
// arbitrary document text, metadata, paths, template labels or DOM contents.
export function t(message, ...values) {
  if (message?.[messageTag]) return t(message.key, ...message.values);
  const key = Array.isArray(message)
    ? message.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '')
    : message;
  const result = formatMessage(language, key, ...values.map(value => value?.[messageTag] ? t(value) : value));
  if (formattedMessages.size > 2048) formattedMessages.delete(formattedMessages.keys().next().value);
  formattedMessages.set(result, { key, values });
  return result;
}

// Use only for interface status fields that were previously produced by t().
export function translateMessage(text) {
  const message = formattedMessages.get(String(text));
  return message ? t(message.key, ...message.values) : text;
}

export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyLanguage(value) {
  const next = isLanguage(value) ? value : 'zh-CN';
  const changed = next !== language;
  language = next;
  if (globalThis.document?.documentElement) document.documentElement.lang = next;
  if (changed) for (const listener of listeners) listener(next);
}

// Live getters keep existing controller references valid after a switch.
export function localize(messages) {
  const cache = new WeakMap();
  const wrap = (value) => {
    if (typeof value === 'string') return t(value);
    if (!value || typeof value !== 'object') return value;
    if (!cache.has(value)) {
      const projectKeys = new Set();
      cache.set(value, new Proxy(value, {
        get: (object, key) => projectKeys.has(key) ? Reflect.get(object, key) : wrap(Reflect.get(object, key)),
        // The project can supply its own category labels, even when they happen
        // to match a built-in message. Those labels are authored data.
        defineProperty: (object, key, descriptor) => {
          projectKeys.add(key);
          return Reflect.defineProperty(object, key, descriptor);
        },
      }));
    }
    return cache.get(value);
  };
  return wrap(messages);
}

export function translatePage(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const attribute of ['title', 'placeholder', 'aria-label']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
  }
}
