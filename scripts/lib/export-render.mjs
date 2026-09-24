import { MEDIA_KINDS, isMediaValue, splitMediaText } from './media-format.mjs';
import { splitValueFields } from './document-values.mjs';
import { formatMessage } from '../../web/i18n/messages.js';
import { isSupportedLanguage } from '../../web/i18n/languages.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const escapeMarkdown = (value) => String(value ?? '').replace(/[\\`*_[\]<>#|]/g, '\\$&');

// Both formats consume the same parser layout as the editor. No document type
// or field name is special, and source HTML is always treated as plain text.
export function renderExport(documents, format, resolveMedia, language = 'zh-CN') {
  if (!isSupportedLanguage(language)) throw new Error('不支持的界面语言');
  const t = (key, ...values) => formatMessage(language, key, ...values);
  const html = format === 'html';
  const escape = html ? escapeHtml : escapeMarkdown;
  let embedded = new Set();
  function media(value, asset = resolveMedia(value.src)) {
    embedded.add(asset.path);
    const url = asset.path.split('/').map(encodeURIComponent).join('/');
    const caption = value.caption || value.alt || asset.name;
    if (!html) return value.type === 'image'
      ? `![${escape(caption)}](<${url}>)`
      : `[${escape(t(value.type === 'audio' ? '音频：{0}' : '视频：{0}', caption))}](<${url}>)`;
    if (value.type === 'audio') return `<figure><audio controls preload="auto" src="${escapeHtml(url)}" aria-label="${escapeHtml(caption)}"></audio><a href="${escapeHtml(url)}" download>${escapeHtml(t('下载原音频'))}</a><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
    const content = value.type === 'video'
      ? `<video controls preload="metadata" playsinline src="${escapeHtml(url)}" aria-label="${escapeHtml(caption)}"></video><a href="${escapeHtml(url)}" download>${escapeHtml(t('下载原视频'))}</a>`
      : `<img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}" loading="lazy">`;
    return `<figure>${content}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  }
  function text(value) {
    return splitMediaText(String(value ?? '')).map((part) => isMediaValue(part) ? media(part) : escape(part.text)).join(html ? '' : '\n\n');
  }
  function value(entry, depth = 0) {
    if (depth > 64) throw new Error('文档字段嵌套过深，无法导出');
    if (isMediaValue(entry)) return media(entry);
    const pairs = splitValueFields(entry);
    if (pairs) {
      const fields = pairs.map(([key, item]) => field(key, item, depth + 1));
      return html ? `<dl>${fields.join('')}</dl>` : fields.join('\n\n');
    }
    if (Array.isArray(entry)) {
      if (!entry.length) return text('[]');
      const items = entry.map((item) => value(item, depth + 1));
      return html ? `<ol>${items.map((item) => `<li>${item}</li>`).join('')}</ol>`
        : items.map((item, index) => `${index + 1}. ${item.replace(/\n/g, '\n   ')}`).join('\n');
    }
    if (entry && typeof entry === 'object') {
      if (!Object.keys(entry).length) return text('{}');
      const fields = Object.entries(entry).map(([key, item]) => field(key, item, depth + 1));
      return html ? `<dl>${fields.join('')}</dl>` : fields.join('\n\n');
    }
    return text(entry === null ? 'null' : entry);
  }
  function field(key, entry, depth = 0) {
    const content = value(entry, depth);
    return html ? `<div class="field"><dt>${escape(key)}</dt><dd>${content}</dd></div>` : `**${escape(key)}：** ${content}`;
  }
  function block(item) {
    if (isMediaValue(item)) return media(item);
    if (item.type === 'kv') return html ? `<dl>${field(item.key, item.value)}</dl>` : field(item.key, item.value);
    if (item.type === 'json') return value(item.value);
    if (item.type === 'code') {
      const code = item.value ?? item.code ?? item.text ?? item.content ?? '';
      let fenceSize = 3;
      for (const match of String(code).matchAll(/`+/g)) fenceSize = Math.max(fenceSize, match[0].length + 1);
      const fence = '`'.repeat(fenceSize);
      return html ? `<pre><code>${escapeHtml(code)}</code></pre>` : `${fence}${String(item.language || '').replace(/[\r\n`]/g, '')}\n${code}\n${fence}`;
    }
    if (item.type === 'table') {
      const rows = [item.header || item.headers || [], ...(item.rows || [])];
      if (html) return `<div class="table-wrap"><table>${rows.map((row, i) => `<tr>${row.map((cell) => `<${i ? 'td' : 'th'}>${text(cell)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`;
      const line = (row) => `| ${row.map((cell) => text(cell).replace(/\r?\n/g, '<br>')).join(' | ')} |`;
      return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
    }
    if (item.type === 'list') {
      const items = (item.items || []).map((entry) => text(typeof entry === 'object' ? entry.text ?? JSON.stringify(entry) : entry));
      const tag = item.ordered ? 'ol' : 'ul';
      return html ? `<${tag}>${items.map((entry) => `<li>${entry}</li>`).join('')}</${tag}>`
        : items.map((entry, index) => `${item.ordered ? `${index + 1}.` : '-'} ${entry.replace(/\n/g, '\n  ')}`).join('\n');
    }
    if (item.type === 'heading') return heading(item.title, item.level || 2);
    const content = text(item.text ?? item.raw ?? '');
    return html ? `<div class="paragraph">${content}</div>` : content;
  }
  function heading(title, level) {
    const size = Math.max(1, Math.min(6, level));
    return html ? `<h${size}>${escape(title)}</h${size}>` : `${'#'.repeat(size)} ${escape(title)}`;
  }
  const contents = documents.map((doc, index) => {
    embedded = new Set();
    const level = Math.min(5, (doc.depth || 0) + 1);
    const title = heading(doc.title, level);
    const sections = doc.layout.sections.map((section) => [
      heading(section.titleKey === '内容' ? t('内容') : section.title, level + Math.max(1, (section.level || 2) - 1)),
      ...(section.blocks || []).map(block),
    ].join('\n\n')).join('\n\n');
    const linked = (doc.linkedAssets || []).filter((asset) => !embedded.has(asset.path)).map((asset) => MEDIA_KINDS.includes(asset.kind)
      ? media({ type: asset.kind, caption: asset.name }, asset)
      : html ? `<p><a href="${escapeHtml(asset.path.split('/').map(encodeURIComponent).join('/'))}" download>${escape(asset.name)}</a></p>`
        : `[${escape(asset.name)}](<${asset.path.split('/').map(encodeURIComponent).join('/')}>)`).join('\n\n');
    const body = [title, sections, linked ? heading(t('关联素材'), level + 1) : '', linked].filter(Boolean).join('\n\n');
    return html ? `<article id="document-${index + 1}">${body}</article>` : body;
  }).join('\n\n');
  if (!html) return `${contents}\n`;
  const toc = documents.length > 1 ? `<nav aria-label="${escapeHtml(t('文档导航'))}"><ol>${documents.map((doc, index) => `<li><a href="#document-${index + 1}">${escapeHtml(doc.title)}</a></li>`).join('')}</ol></nav>` : '';
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(documents[0]?.title || t('作品文档'))}</title><style>
:root{color-scheme:light;font:17px/1.8 system-ui,sans-serif;color:#26352f;background:#f5f7f4}body{margin:0}main{max-width:920px;margin:auto;padding:42px 32px 80px;background:#fff;min-height:100vh;box-sizing:border-box}h1,h2,h3,h4,h5,h6{line-height:1.4;overflow-wrap:anywhere}h1{font-size:2rem}h2{margin-top:2em;border-bottom:1px solid #d8e4db;padding-bottom:.4em}article+article{border-top:2px solid #d8e4db;margin-top:3em;padding-top:1.5em}a{color:#246750}nav{padding:12px 24px;background:#edf4ee;border-radius:12px}.paragraph,dd,li{white-space:pre-wrap;overflow-wrap:anywhere}.field{display:grid;grid-template-columns:minmax(100px,22%) minmax(0,1fr);gap:18px;padding:8px 0}dt{font-weight:600}dd{margin:0}dl dl{margin:0}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8e4db;padding:8px 12px;text-align:left}pre{white-space:pre-wrap;background:#f3f5f3;padding:16px;border-radius:8px;overflow-wrap:anywhere}figure{margin:24px 0}img,video{display:block;max-width:100%;max-height:75vh;border-radius:8px}audio{display:block;width:100%;max-width:100%;height:54px}figcaption{font-size:.85rem;color:#607168}footer{border-top:1px solid #d8e4db;margin-top:3em;padding-top:1em;color:#607168;font-size:.8rem}@media(max-width:600px){main{padding:22px 18px}.field{grid-template-columns:1fr;gap:3px}}@media print{main{padding:0;max-width:none}nav,video,audio{display:none}img{max-height:20cm}h1,h2,h3{break-after:avoid}figure,.field{break-inside:avoid}a{color:inherit}}
</style></head><body><main>${toc}${contents}<footer>${escapeHtml(t('由 Viento Studio 导出 · 解压后可离线阅读'))}</footer></main></body></html>\n`;
}
