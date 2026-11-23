export interface BookChapter {
  title: string;
  url: string;
  selector?: string;
}

export interface BookPage {
  title: string;
  url: string;
  markdown: string;
  textLength: number;
  images: { url: string; offset: number; length: number }[];
}

export interface BookScan {
  title: string;
  url: string;
  chapters: BookChapter[];
}

export type BookClipAction =
  | { action: 'scan' }
  | { action: 'extract'; origin: string }
  | { action: 'jump'; origin: string; chapter: BookChapter }
  | { action: 'image'; origin: string; url: string; pageUrl: string };

export type BookClipResult =
  | { scan: BookScan }
  | { page: BookPage }
  | { jumped: boolean }
  | { image: { extension: string; base64: string } };

export const chapterKey = (title: string): string => title.toLowerCase()
  .replace(/^\s*(\d{1,3}[.．、:：-]\s*|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇]\s*)/u, '')
  .replace(/[\s\p{P}\p{S}]/gu, '');

export function webUrl(value: string, base?: string): URL | undefined {
  if (!value.trim()) return;
  try {
    const url = new URL(value, base);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return url;
  } catch { /* Not a supported web URL. */ }
}
