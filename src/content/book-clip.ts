import { compactMarkdown, markdownText } from '../modules/book-clip/markdown';
import { chapterKey, webUrl, type BookChapter, type BookPage, type BookScan } from '../modules/book-clip/types';

const tidy = (text?: string | null) => (text ?? '').replace(/\s+/gu, ' ').trim();
const destination = (url: string) => url.replace(/\(/gu, '%28').replace(/\)/gu, '%29');
const block = (text: string) => text ? `\n\n${text}\n\n` : '';
const blockBody = (text: string) => text.trim();
const courseRoute = (url: URL) => /^(?:www\.)?codefather\.cn$/u.test(url.hostname)
  ? url.pathname.match(/^\/course\/(\d+)(?:\/section\/(\d+))?\/?$/u) : null;
const coursePage = (url: URL) => Boolean(courseRoute(url)?.[2]);
const formatMarks = /[\u061c\u200b\u200e\u200f\u2060]/gu;
const omitted = 'script,style,template,noscript,svg,canvas,iframe,nav,aside,form,footer,button,input,select,textarea,[hidden],[aria-hidden="true"]';
const navigation = 'aside,nav,[role="navigation"],[class*="sidebar"],[class*="side-bar"],[class*="catalog"],[class*="chapter-list"],[class*="course-menu"],[class*="course-nav"],[class*="lesson-list"],[class*="menu-list"]';
const controls = 'a[href],button,[role="button"],[role="menuitem"],[role="treeitem"]';

function visible(element: HTMLElement): boolean {
  if (element.closest('[hidden],[aria-hidden="true"]') || !element.getClientRects().length) return false;
  const style = getComputedStyle(element);
  return style.visibility === 'visible' && Number(style.opacity) !== 0;
}

const courseBody = (doc: Document) => [...doc.querySelectorAll<HTMLElement>('.course-container .markdown-body, .article-container .markdown-body')].find(visible);

function articleRoot(doc: Document): HTMLElement {
  const candidates = doc.querySelectorAll<HTMLElement>('article,main,[role="main"],.markdown-body,.article-content,.post-content,.rich-text,.prose,[class*="reader-content"]');
  let best = doc.body;
  let high = -Infinity;
  for (const el of candidates) {
    if (!visible(el) || el.closest('nav,aside,footer,form')) continue;
    const textLength = tidy(el.innerText).length;
    if (textLength < 25) continue;
    const links = el.querySelectorAll<HTMLAnchorElement>('a');
    const linkLength = [...links].reduce((sum, link) => sum + tidy(link.innerText).length, 0);
    const score = Math.min(textLength, 18000) / 31 + Math.min(el.querySelectorAll('p,pre').length, 100) * 20
      - linkLength / textLength * 700 - links.length;
    if (score >= high) { high = score; best = el; }
  }
  return best;
}

function heading(doc: Document, root: HTMLElement, url: URL): string {
  const courseHeading = coursePage(url) ? root.closest('.article-container')?.querySelector<HTMLElement>('h1') : null;
  return tidy(courseHeading?.innerText || root.querySelector<HTMLElement>('h1')?.innerText)
    || tidy(doc.title).replace(/\s+[-|_]\s+.*$/u, '') || '未命名文章';
}

function selectorOf(el: HTMLElement): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node?.parentElement; node = node.parentElement) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const index = [...node.parentElement.children].indexOf(node) + 1;
    parts.unshift(`${node.localName}:nth-child(${index})`);
  }
  return parts.join(' > ');
}

function findGenericChapters(doc: Document, url: URL, root: HTMLElement): BookChapter[] {
  const numbered = /^(?:第\s*[一二三四五六七八九十百千\d]+\s*[章节篇]|\d{1,3}(?:[.．、]|\s*[-：:]))\s*\S/u;
  const collect = (container: HTMLElement, allowGeneric: boolean) => {
    const found = new Map<string, BookChapter>();
    for (const el of [...container.querySelectorAll<HTMLElement>(allowGeneric ? `${controls},li,div,span` : 'a[href]')].slice(0, 4500)) {
      if ((root !== doc.body && root.contains(el)) || el.closest('form,[contenteditable="true"]') || !visible(el)) continue;
      const title = tidy(el.innerText).replace(/\s*[✓✔●]$/u, '').trim();
      if (!numbered.test(title) || title.length > 112 || title.split(' ').some((part, index) => index > 1 && numbered.test(part))
        || [...el.children].some(child => child instanceof HTMLElement && visible(child) && tidy(child.innerText) === title)) continue;
      const anchor = el.closest('a[href]') ?? el.querySelector('a[href]');
      const href = anchor && webUrl(anchor.getAttribute('href') ?? '', url.href);
      if (anchor && (!href || href.origin !== url.origin || (href.pathname === url.pathname && href.search === url.search && href.hash))) continue;
      if (!href && !allowGeneric) continue;
      const id = chapterKey(title);
      if (id && !found.has(id)) found.set(id, { title, url: href?.href ?? '', selector: selectorOf(el) });
    }
    return [...found.values()];
  };
  const lists = [...doc.querySelectorAll<HTMLElement>(navigation)].filter(visible).map(el => collect(el, true));
  const best = lists.reduce<BookChapter[]>((left, right) => right.length > left.length ? right : left, []);
  return (best.length >= 2 ? best : collect(doc.body, false)).slice(0, 450);
}

function findCourseChapters(doc: Document, url: URL, courseId: string): BookChapter[] {
  const found = new Map<string, BookChapter>();
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('.rct-tree-root a.article-title[href]')) {
    const href = webUrl(anchor.getAttribute('href') ?? '', url.href);
    if (!href || href.origin !== url.origin || !visible(anchor) || anchor.closest('form,[contenteditable="true"]')) continue;
    const route = courseRoute(href);
    if (route?.[1] !== courseId || !route[2] || found.has(route[2])) continue;
    const title = tidy(anchor.innerText).replace(/\s+(?:可试学|已学完)$/u, '');
    if (title) found.set(route[2], { title, url: href.href, selector: selectorOf(anchor) });
    if (found.size >= 450) break;
  }
  return [...found.values()];
}

export async function scanBook(doc = document, href = location.href): Promise<BookScan> {
  const url = new URL(href);
  const route = courseRoute(url);
  if (route) {
    let chapters = findCourseChapters(doc, url, route[1]);
    if (!chapters.length) {
      // The course summary can render before its separate chapter tree.
      await new Promise<void>(resolve => {
        const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
        const observer = new MutationObserver(() => {
          chapters = findCourseChapters(doc, url, route[1]);
          if (chapters.length) finish();
        });
        const timer = setTimeout(finish, 6000);
        observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'href'] });
      });
    }
    const root = (route[2] ? courseBody(doc) : undefined) ?? articleRoot(doc);
    return { title: heading(doc, root, url), url: url.href, chapters };
  }
  const root = articleRoot(doc);
  if (tidy(root.innerText).length < 25) throw new Error('当前网页未发现可读取的文章正文。');
  const title = heading(doc, root, url);
  const chapters = findGenericChapters(doc, url, root);
  return { title, url: url.href, chapters: chapters.length >= 2 ? chapters : [{ title, url: url.href }] };
}

export function jumpBookChapter(chapter: BookChapter): boolean {
  const url = new URL(location.href);
  const route = courseRoute(url);
  const chapters = route ? findCourseChapters(document, url, route[1]) : findGenericChapters(document, url, articleRoot(document));
  const current = chapters.find(item => item.url === chapter.url && (route || item.title === chapter.title));
  if (!current?.selector) return false;
  const el = document.querySelector<HTMLElement>(current.selector);
  if (!el || el.closest('form,[contenteditable="true"]')) return false;
  const target = el.closest<HTMLElement>(controls) ?? el;
  if (target instanceof HTMLButtonElement && target.form) return false;
  if (target instanceof HTMLAnchorElement && (target.hasAttribute('download') || (target.target && target.target !== '_self'))) return false;
  target.click();
  return true;
}

export function readBookPage(doc = document, href = location.href): BookPage {
  const url = new URL(href);
  const knownCourse = coursePage(url);
  const root = knownCourse ? courseBody(doc) : articleRoot(doc);
  if (!root) return { title: heading(doc, doc.body, url), url: url.href, markdown: '', textLength: 0, images: [] };
  const title = heading(doc, root, url);
  const styles = new WeakMap<HTMLElement, CSSStyleDeclaration>();
  const styleOf = (el: HTMLElement) => {
    let style = styles.get(el);
    if (!style) { style = getComputedStyle(el); styles.set(el, style); }
    return style;
  };
  const hidden = (el: HTMLElement) => {
    const s = styleOf(el);
    return s.display === 'none' || Number(s.opacity) === 0 || s.contentVisibility === 'hidden'
      || s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)'
      || (/^(?:absolute|fixed)$/u.test(s.position) && (parseFloat(s.left) <= -1000 || parseFloat(s.top) <= -1000))
      || (!(el instanceof HTMLImageElement) && ((/^(?:clip|hidden)$/u.test(s.overflowX) && s.width === '0px')
        || (/^(?:clip|hidden)$/u.test(s.overflowY) && s.height === '0px')));
  };
  const skip = (el: HTMLElement) => el.matches(omitted) || hidden(el)
    || /(?:^|[\s_-])(comment|share|social|ads?|recommendation|copyright|toolbar|sidebar|table-of-contents)(?:[\s_-]|$)/iu.test(`${el.id} ${el.className}`);
  const displayText = (node: Text) => {
    if (!node.parentElement) return '';
    const style = styleOf(node.parentElement);
    const fill = style.webkitTextFillColor || style.color;
    return style.visibility !== 'visible' || style.fontSize === '0px' || /^(?:transparent|rgba\([^)]*,\s*0\))$/u.test(fill) ? '' : node.data;
  };
  const imageUrls: string[] = [];
  const imageMarker = '\u0000bookclip-image-';
  const imageEnd = '\u0000';
  const clean = new WeakMap<Text, string>();
  if (knownCourse) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node instanceof HTMLElement && (skip(node) || node.matches('a,code,pre,kbd,samp,.katex-display'))) return NodeFilter.FILTER_REJECT;
      return node instanceof Text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    });
    const textOf = (node: Node) => (node instanceof Text ? displayText(node) : node.textContent ?? '').replace(formatMarks, '').trimEnd();
    const imageOf = (node: Node) => node instanceof Element && (node.matches('img,picture') || Boolean(node.querySelector('img')));
    function adjacent(node: Node, scope: Element, direction: 'previousSibling' | 'nextSibling'): Node | undefined {
      for (let current: Node | null = node; current && current !== scope; current = current.parentNode) {
        for (let sibling = current[direction]; sibling; sibling = sibling[direction]) {
          if (sibling instanceof HTMLElement && skip(sibling)) continue;
          if ((sibling instanceof Element || sibling instanceof Text) && (textOf(sibling).trim() || imageOf(sibling))) return sibling;
        }
      }
    }
    const candidates: { node: Text; prose: Element; value: string; before: string; after: string; position: 'prose' | 'detached' | 'symbol' }[] = [];
    for (let node = walker.nextNode(); node instanceof Text; node = walker.nextNode()) {
      const container = node.parentElement?.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figure,div');
      const prose: Element = container && root.contains(container) ? container : root;
      const text = displayText(node).replace(formatMarks, '');
      const tail = text.match(/(?<![A-Za-z0-9+/=])([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)(\s*)$/u);
      if (!tail) continue;
      const before = text.slice(0, tail.index);
      const previous = before.trim() ? undefined : adjacent(node, prose, 'previousSibling');
      const context = before.trimEnd() || (previous && prose !== root ? textOf(previous) : '');
      let position: (typeof candidates)[number]['position'];
      if (/(?:\p{Script=Han}|[。！？；，、）】」”’!?;.:：)~～…])$/u.test(context)) position = 'prose';
      else if (/[{}#*]$/u.test(context)) position = 'symbol';
      else {
        if (before.trim() || adjacent(node, prose, 'nextSibling')) continue;
        const preceding = previous ?? adjacent(node, root, 'previousSibling');
        const afterImage = preceding && imageOf(preceding) && !textOf(preceding).trim();
        const atEnd = (!previous || prose === root) && !adjacent(node, root, 'nextSibling');
        if (!afterImage && !atEnd) continue;
        position = 'detached';
      }
      candidates.push({ node, prose, value: tail[1], before, after: tail[2], position });
    }
    const occurrences = new Map<string, number>();
    const paragraphs = new Set<Element>();
    for (const { value, prose, position } of candidates) {
      if (position !== 'prose') continue;
      occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
      paragraphs.add(prose);
    }
    const repeated = [...occurrences.values()].filter(count => count > 1).length;
    // shortcut: known course pattern only; use verified DOM markers if the site changes the embedding.
    if (paragraphs.size >= 3 && repeated) {
      const dense = paragraphs.size >= 10 && repeated >= 2;
      for (const { node, value, before, after, position } of candidates) {
        const count = occurrences.get(value) ?? 0;
        if ((dense && position !== 'symbol') || count >= (position === 'detached' ? 1 : 2)) clean.set(node, before.trimEnd() + after);
      }
    }
  }

  function render(node: Node, literal = false): string {
    if (node instanceof Text) {
      const text = displayText(node);
      if (literal) return text;
      return markdownText((clean.get(node) ?? (knownCourse ? text.replace(formatMarks, '') : text)).replace(/\s+/gu, ' '));
    }
    if (!(node instanceof Element)) return '';
    if (node.matches('math,.katex-display')) {
      const math = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.getAttribute('alttext');
      if (math && getComputedStyle(node).visibility === 'visible') return block(`$$\n${math}\n$$`);
    }
    if (!(node instanceof HTMLElement) || skip(node)) return '';
    const tag = node.localName;
    const shown = styleOf(node).visibility === 'visible';
    const children = (asLiteral = literal) => [...node.childNodes].map(child => render(child, asLiteral)).join('');
    if (tag === 'br') return shown ? (literal ? '\n' : '  \n') : '';
    if (literal) return children(true);
    if (tag === 'hr') return shown ? block('---') : '';
    if (node instanceof HTMLImageElement) {
      if (!shown) return '';
      const source = node.dataset.original || node.dataset.src || node.dataset.lazySrc || node.currentSrc || node.getAttribute('src') || '';
      const alt = markdownText(tidy(node.alt) || '图片');
      if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]+$/iu.test(source)) return `![${alt}](${source})`;
      const src = webUrl(source, url.href);
      if (!src) return '';
      return `![${alt}](${imageMarker}${imageUrls.push(src.href) - 1}${imageEnd})`;
    }
    if (tag === 'pre') {
      const code = node.querySelector('code') ?? node;
      const body = render(code, true).replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
      if (!body.trim()) return '';
      const language = `${node.className} ${code.className}`.match(/(?:language|lang)-([\w+#.-]+)/u)?.[1] ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/gu)].map(match => match[0].length + 1)));
      return block(`${fence}${language}\n${body}\n${fence}`);
    }
    if (tag === 'code') {
      const text = children(true).trim();
      if (!text) return '';
      const fence = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));
      return text.includes('`') ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
    }
    if (tag === 'a') {
      const label = children().trim();
      const link = webUrl(node.getAttribute('href') ?? '', url.href);
      return label && link ? `[${label}](${destination(link.href)})` : label;
    }
    if (/^(strong|b|em|i|s|del|strike)$/u.test(tag)) {
      const text = children();
      if (!text.trim()) return text;
      const mark = /^(strong|b)$/u.test(tag) ? '**' : /^(em|i)$/u.test(tag) ? '*' : '~~';
      return text.replace(/^(\s*)([\s\S]*?\S)(\s*)$/u, `$1${mark}$2${mark}$3`);
    }
    if (tag === 'blockquote') return block(blockBody(children()).split('\n').map(line => `> ${line}`).join('\n'));
    if (node instanceof HTMLTableElement) {
      const rows = [...node.rows].filter(row => !hidden(row) && row.parentElement && !hidden(row.parentElement)).map(row =>
        [...row.cells].filter(cell => !hidden(cell)).map(cell => blockBody(render(cell)).replace(/\|/gu, '\\|').replace(/\n+/gu, '<br>')));
      const width = Math.max(0, ...rows.map(row => row.length));
      if (!width) return '';
      const row = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
      return block([row(rows[0]), row(Array<string>(width).fill('---')), ...rows.slice(1).map(row)].join('\n'));
    }
    if (tag === 'ul' || tag === 'ol') {
      const start = node instanceof HTMLOListElement ? node.start : 1;
      return block([...node.children].filter(li => li.localName === 'li').map(li => blockBody(render(li))).filter(Boolean).map((text, index) => {
        const marker = tag === 'ol' ? `${start + index}. ` : '- ';
        return marker + text.replace(/\n/gu, `\n${' '.repeat(marker.length)}`);
      }).join('\n'));
    }
    const text = children();
    if (/^h[1-6]$/u.test(tag)) return text.trim() ? block(`${'#'.repeat(Number(tag[1]))} ${text.trim()}`) : '';
    return /^(?:p|div|section|article|main|figure)$/u.test(tag) ? block(blockBody(text)) : text;
  }

  const text = compactMarkdown(render(root));
  const template = text.startsWith('# ') ? text : `# ${markdownText(title)}\n\n${text}`;
  const images: BookPage['images'] = [];
  let shift = 0;
  const markdown = template.replace(new RegExp(`${imageMarker}(\\d+)${imageEnd}`, 'gu'), (marker: string, index: string, offset: number) => {
    const source = imageUrls[Number(index)];
    if (!source) { shift -= marker.length; return ''; }
    const written = destination(source);
    images.push({ url: source, offset: offset + shift, length: written.length });
    shift += written.length - marker.length;
    return written;
  });
  return { title, url: url.href, markdown: `${markdown}\n`, textLength: text.length, images };
}
