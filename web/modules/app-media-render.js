import { t } from '../i18n/index.js';
import { isMediaValue, mediaUrl, splitMediaText } from '../../scripts/lib/media-format.mjs';

export function renderMedia(media) {
  const figure = document.createElement('figure');
  figure.className = 'doc-media';
  const url = mediaUrl(media.src);
  if (!url) {
    figure.dataset.i18n = '素材引用无效';
    figure.textContent = t('素材引用无效');
    return figure;
  }
  const element = document.createElement(media.type === 'video' ? 'video' : 'img');
  const caption = String(media.caption || media.alt || '');
  element.className = 'doc-media-content';
  if (media.type === 'video') {
    element.controls = true;
    element.preload = 'metadata';
    element.setAttribute('playsinline', '');
    element.setAttribute('aria-label', caption || t('视频素材'));
    if (!caption) element.setAttribute('data-i18n-aria-label', '视频素材');
  } else {
    element.alt = caption;
    element.loading = 'lazy';
  }
  const status = document.createElement('p');
  status.className = 'doc-media-status';
  status.hidden = true;
  element.addEventListener('error', () => {
    status.hidden = false;
    status.dataset.i18n = media.type === 'video' ? '视频暂时无法播放，请检查素材是否在线及视频编码。' : '图片暂时无法读取，请检查素材是否在线。';
    status.textContent = media.type === 'video' ? t('视频暂时无法播放，请检查素材是否在线及视频编码。') : t('图片暂时无法读取，请检查素材是否在线。');
  });
  element.src = url;
  figure.appendChild(element);
  if (caption) {
    const label = document.createElement('figcaption');
    label.textContent = caption;
    figure.appendChild(label);
  }
  if (media.type === 'video') {
    const link = document.createElement('a');
    link.href = url;
    link.download = caption || 'video';
    link.textContent = t('下载原视频');
    link.dataset.i18n = '下载原视频';
    figure.appendChild(link);
  }
  figure.appendChild(status);
  return figure;
}

export function renderMediaText(text) {
  const parts = splitMediaText(text);
  if (!parts.some(isMediaValue)) return null;
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (isMediaValue(part)) fragment.appendChild(renderMedia(part));
    else if (part.text.trim()) {
      const p = document.createElement('p');
      p.className = 'doc-paragraph';
      p.textContent = part.text;
      fragment.appendChild(p);
    }
  }
  return fragment;
}
