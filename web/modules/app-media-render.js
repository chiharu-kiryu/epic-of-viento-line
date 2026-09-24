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
  const timed = media.type === 'video' || media.type === 'audio';
  const element = document.createElement(timed ? media.type : 'img');
  const caption = String(media.caption || media.alt || '');
  element.className = 'doc-media-content';
  if (timed) {
    element.controls = true;
    // WebKit/GStreamer can truncate Ogg duration and seek back to zero when
    // buffering stops after metadata. Audio needs normal buffering for seeking.
    element.preload = media.type === 'audio' ? 'auto' : 'metadata';
    if (media.type === 'video') element.setAttribute('playsinline', '');
    const label = media.type === 'audio' ? '音频素材' : '视频素材';
    element.setAttribute('aria-label', caption || t(label));
    if (!caption) element.setAttribute('data-i18n-aria-label', label);
  } else {
    element.alt = caption;
    element.loading = 'lazy';
  }
  const status = document.createElement('p');
  status.className = 'doc-media-status';
  status.hidden = true;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'doc-btn doc-btn-ghost doc-media-retry';
  retry.dataset.i18n = '重试加载';
  retry.textContent = t('重试加载');
  retry.hidden = true;
  retry.addEventListener('click', () => {
    // Reload only this resource; keep the draft and other players intact.
    if (timed) element.load();
    else element.src = url;
  });
  element.addEventListener('error', () => {
    status.hidden = false;
    retry.hidden = false;
    status.dataset.i18n = media.type === 'audio' ? '音频暂时无法播放，请检查素材是否在线及音频编码。'
      : media.type === 'video' ? '视频暂时无法播放，请检查素材是否在线及视频编码。' : '图片暂时无法读取，请检查素材是否在线。';
    status.textContent = t(status.dataset.i18n);
  });
  element.addEventListener(timed ? 'loadeddata' : 'load', () => {
    status.hidden = true;
    retry.hidden = true;
  });
  element.src = url;
  figure.appendChild(element);
  if (caption) {
    const label = document.createElement('figcaption');
    label.textContent = caption;
    figure.appendChild(label);
  }
  if (timed) {
    const link = document.createElement('a');
    link.href = url;
    link.download = caption || media.type;
    link.dataset.i18n = media.type === 'audio' ? '下载原音频' : '下载原视频';
    link.textContent = t(link.dataset.i18n);
    figure.appendChild(link);
  }
  figure.appendChild(status);
  figure.appendChild(retry);
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
