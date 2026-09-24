import { renderStructuredBlocks } from './app-structured.js';
import { isMediaValue } from '../../scripts/lib/media-format.mjs';
import { renderMedia, renderMediaText } from './app-media-render.js';
import { splitValueFields } from '../../scripts/lib/document-values.mjs';
import { t } from '../i18n/index.js';

export function hasDocumentLayout(doc) {
  return doc?.layout?.schemaVersion === 'viento-layout-v1' && Array.isArray(doc.layout.sections);
}

function fieldRow(key, value) {
  const row = document.createElement('div');
  row.className = 'document-field';
  const label = document.createElement('dt');
  label.className = 'document-field-label';
  label.textContent = key;
  const content = document.createElement('dd');
  content.className = 'document-field-value';
  content.appendChild(renderValue(value));
  row.appendChild(label);
  row.appendChild(content);
  return row;
}

function renderValue(value) {
  if (isMediaValue(value)) return renderMedia(value);
  if (Array.isArray(value)) {
    if (!value.length) return renderValue('[]');
    const list = document.createElement('ol');
    list.className = 'document-value-list';
    for (const item of value) {
      const entry = document.createElement('li');
      entry.appendChild(renderValue(item));
      list.appendChild(entry);
    }
    return list;
  }
  if (value && typeof value === 'object') {
    if (!Object.keys(value).length) return renderValue('{}');
    const fields = document.createElement('dl');
    fields.className = 'document-fields';
    for (const [key, entry] of Object.entries(value)) fields.appendChild(fieldRow(key, entry));
    return fields;
  }
  const text = value === null ? 'null' : String(value ?? '');
  const media = renderMediaText(text);
  if (media) return media;
  const pairs = splitValueFields(text);
  if (pairs) {
    const fields = document.createElement('dl');
    fields.className = 'document-fields document-value-rows';
    for (const [key, entry] of pairs) fields.appendChild(fieldRow(key, entry));
    return fields;
  }
  const span = document.createElement('span');
  span.className = 'document-value-text';
  span.textContent = text;
  return span;
}

export function renderDocumentLayout(doc) {
  if (!hasDocumentLayout(doc)) return [];
  const cards = doc.layout.sections.map((section) => {
    const card = document.createElement('section');
    card.className = 'meta-card document-section';
    card.dataset.sectionId = section.id;
    if (section.anchor) card.id = section.anchor.replace(/^#/, '');
    const title = document.createElement('h3');
    if (section.titleKey === '内容') { title.dataset.i18n = '内容'; title.textContent = t('内容'); }
    else title.textContent = section.title;
    card.appendChild(title);
    let fields = null;
    for (const block of section.blocks || []) {
      if (block.type === 'kv') {
        if (!fields) {
          fields = document.createElement('dl');
          fields.className = 'document-fields';
          card.appendChild(fields);
        }
        fields.appendChild(fieldRow(block.key, block.value));
      } else if (block.type === 'json') {
        // Root lists and scalars use the same typed rendering as nested fields.
        fields = null;
        card.appendChild(renderValue(block.value));
      } else {
        fields = null;
        const rendered = renderStructuredBlocks([block]);
        if (rendered) card.appendChild(rendered);
      }
    }
    return card;
  });
  doc._contentRenderMode = 'card-only';
  return cards;
}
