import { DOWNLOAD_PREVIEW_FILE } from '../shared/constants';
import styles from './file-preview.css?inline';

const IMAGE_EXTENSIONS = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const VIDEO_EXTENSIONS = /\.(?:m4v|mov|mp4|ogv|webm)$/i;
const TEXT_EXTENSIONS = /\.(?:txt|md|rst|log|csv|tsv|sql|json|jsonc|xml|ya?ml|toml|ini|conf|properties|diff|patch|java|kt|kts|js|mjs|cjs|jsx|ts|tsx|css|scss|less|vue|svelte|py|rb|go|rs|c|h|cpp|hpp|cs|swift|sh|bash|zsh|ps1|gradle|proto)$/i;
const WEB_SOURCE_EXTENSIONS = /\.(?:html?|php|aspx?|jsp)$/i;
const BINARY_EXTENSIONS = /\.(?:exe|msi|msix|msixbundle|appx|appxbundle|apk|aab|ipa|dmg|pkg|deb|rpm|appimage|run|iso|img|vhdx?|vmdk|qcow2?|bin|zip|rar|7z|tar|gz|xz|bz2|zst|cab|jar|crx|scr|com)$/i;
const MAX_PREVIEW_BYTES = 512 * 1024;

type PreviewKind = 'image' | 'video' | 'text';

const previewKind = (name: string, explicitName: boolean): PreviewKind | undefined => {
  if (IMAGE_EXTENSIONS.test(name)) return 'image';
  if (VIDEO_EXTENSIONS.test(name)) return 'video';
  if (TEXT_EXTENSIONS.test(name) || (explicitName && WEB_SOURCE_EXTENSIONS.test(name))) return 'text';
};

const fileNameFromPath = (url: URL): string => {
  const name = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

const readPreviewText = async (url: URL, referrerPolicy: ReferrerPolicy | undefined, signal: AbortSignal) => {
  const response = await fetch(url, { referrerPolicy, signal });
  if (!response.ok || !response.body) throw new Error('无法读取文件');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let remaining = MAX_PREVIEW_BYTES;
  // ponytail: 只读取文件开头，长文件继续查看需下载；需要全文浏览时再做分页。
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      if (value.length > remaining) return { text, truncated: true };
      remaining -= value.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
};

const showFilePreview = (link: HTMLAnchorElement, url: URL, fileName: string, kind: PreviewKind): void => {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(styles);
  shadow.adoptedStyleSheets = [sheet];

  const dialog = document.createElement('dialog');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'devpilot-file-name';
  title.textContent = fileName;
  dialog.setAttribute('aria-labelledby', title.id);
  header.append(title);

  const body = document.createElement('section');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = '正在加载预览…';
  body.append(status);

  const footer = document.createElement('footer');
  const close = document.createElement('button');
  close.textContent = '关闭';
  close.autofocus = true;
  close.addEventListener('click', () => dialog.close());
  const download = document.createElement('button');
  download.className = 'primary';
  download.textContent = '下载文件';
  const downloadStatus = document.createElement('p');
  downloadStatus.setAttribute('role', 'status');
  downloadStatus.hidden = true;
  const downloadName = link.download;
  const referrerPolicy = (link.relList.contains('noreferrer') ? 'no-referrer' : link.referrerPolicy) as ReferrerPolicy;
  download.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (url.origin === window.origin) {
      const save = document.createElement('a');
      save.href = url.href;
      save.download = downloadName;
      save.referrerPolicy = referrerPolicy;
      save.click();
      return;
    }
    download.disabled = true;
    downloadStatus.hidden = true;
    void chrome.runtime.sendMessage({ type: DOWNLOAD_PREVIEW_FILE, url: url.href })
      .then((response: { ok?: boolean } | undefined) => {
        if (!response?.ok) throw new Error('下载未启动');
      }).catch(() => {
        downloadStatus.hidden = false;
        downloadStatus.textContent = '无法启动下载，请重试。';
      }).finally(() => { download.disabled = false; });
  });
  footer.append(downloadStatus, close, download);
  dialog.append(header, body, footer);
  shadow.append(dialog);

  const controller = new AbortController();
  dialog.addEventListener('close', () => {
    controller.abort();
    host.remove();
  }, { once: true });
  document.documentElement.append(host);
  dialog.showModal();

  if (kind !== 'text') {
    const media = document.createElement(kind === 'image' ? 'img' : 'video');
    if (media instanceof HTMLImageElement) {
      media.alt = fileName;
      media.referrerPolicy = referrerPolicy;
    } else {
      media.controls = true;
      media.preload = 'metadata';
    }
    media.addEventListener(kind === 'image' ? 'load' : 'loadedmetadata', () => { status.hidden = true; }, { once: true });
    media.addEventListener('error', () => {
      media.remove();
      status.hidden = false;
      status.textContent = '无法加载预览，你仍可下载文件。';
    }, { once: true });
    // 交给浏览器按需加载媒体，关闭时停止视频播放和网络请求。
    controller.signal.addEventListener('abort', () => {
      media.removeAttribute('src');
      if (media instanceof HTMLVideoElement) media.load();
    }, { once: true });
    media.src = url.href;
    body.prepend(media);
    return;
  }

  void readPreviewText(url, referrerPolicy || undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])).then(({ text, truncated }) => {
    if (controller.signal.aborted) return;
    if (!text) {
      status.textContent = '文件为空。';
      return;
    }
    const code = document.createElement('pre');
    code.tabIndex = 0;
    // 源码、SQL 和标记文件都只作为文本显示。
    code.textContent = text;
    body.prepend(code);
    status.hidden = !truncated;
    status.textContent = truncated ? '已显示文件开头的 512 KB，下载可查看完整内容。' : '';
  }).catch(() => {
    if (!controller.signal.aborted) status.textContent = '无法加载预览，你仍可下载文件。';
  });
};

export const registerFilePreview = (): void => {
  window.addEventListener('click', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const link = event.composedPath().find((element) => element instanceof HTMLAnchorElement);
    const href = link?.getAttribute('href')?.trim();
    if (!link || !href || href.startsWith('#')) return;
    const url = URL.parse(link.href);
    if (!url || url.username || url.password) return;
    const isPageBlob = url.protocol === 'blob:' && url.origin !== 'null' && url.origin === window.origin;
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && !isPageBlob) return;

    const pathName = isPageBlob ? '' : fileNameFromPath(url).trim();
    const queryName = (url.searchParams.get('filename') ?? url.searchParams.get('fileName') ?? '').trim();
    const downloadName = link.download.trim();
    if ([pathName, queryName, downloadName].some((name) => BINARY_EXTENSIONS.test(name))) return;
    const fileName = downloadName || queryName || pathName;
    const kind = previewKind(fileName, Boolean(downloadName || queryName || link.hasAttribute('download')));
    if (!kind) return;

    // 已识别的文件链接由预览接管，同时阻止页面点击处理器再次触发下载。
    showFilePreview(link, url, fileName, kind);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
};
