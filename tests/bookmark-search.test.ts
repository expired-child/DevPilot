import { describe, expect, it } from 'vitest';

import {
  flattenBookmarkTree,
  searchBookmarks,
  type BookmarkEntry,
} from '../src/modules/bookmark-search/bookmark-service';

const folder = (id: string, title: string, children: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode =>
  ({ id, title, syncing: false, children });

const bookmark = (id: string, title: string, url: string): chrome.bookmarks.BookmarkTreeNode =>
  ({ id, title, url, syncing: false });

const tree: chrome.bookmarks.BookmarkTreeNode[] = [
  folder('root', '', [
    folder('bar', '书签栏', [
      folder('dev', '开发', [bookmark('1', 'GitHub', 'https://github.com')]),
      bookmark('2', 'MDN', 'https://developer.mozilla.org'),
    ]),
    folder('other', '其他书签', [bookmark('3', '', 'https://example.com')]),
  ]),
];

const entries: BookmarkEntry[] = [
  { id: 'a', title: 'React 官方文档', url: 'https://react.dev/learn', folderPath: '前端' },
  { id: 'b', title: 'React GitHub', url: 'https://github.com/facebook/react', folderPath: '代码' },
  { id: 'c', title: '使用 React 搭建', url: 'https://b.dev/x', folderPath: '笔记' },
  { id: 'd', title: '某页', url: 'https://example.com/records', folderPath: '收藏' },
];

describe('flattenBookmarkTree', () => {
  it('keeps only bookmarks and joins ancestor folder titles as the path', () => {
    expect(flattenBookmarkTree(tree)).toEqual([
      { id: '1', title: 'GitHub', url: 'https://github.com', folderPath: '书签栏 / 开发' },
      { id: '2', title: 'MDN', url: 'https://developer.mozilla.org', folderPath: '书签栏' },
      { id: '3', title: 'https://example.com', url: 'https://example.com', folderPath: '其他书签' },
    ]);
  });

  it('falls back to the url as title when the bookmark is unnamed', () => {
    expect(flattenBookmarkTree(tree)[2].title).toBe('https://example.com');
  });
});

describe('searchBookmarks', () => {
  it('returns nothing for a blank query', () => {
    expect(searchBookmarks(entries, '   ')).toEqual([]);
  });

  it('matches titles case-insensitively', () => {
    expect(searchBookmarks(entries, 'REACT').map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('requires every whitespace-separated token to match', () => {
    expect(searchBookmarks(entries, 'react learn').map(({ id }) => id)).toEqual(['a']);
    expect(searchBookmarks(entries, 'react 笔记').map(({ id }) => id)).toEqual(['c']);
  });

  it('matches urls and folder paths', () => {
    expect(searchBookmarks(entries, 'records').map(({ id }) => id)).toEqual(['d']);
    expect(searchBookmarks(entries, '收藏').map(({ id }) => id)).toEqual(['d']);
  });

  it('ranks title prefix above title containment above url-only hits', () => {
    const ranked = searchBookmarks([
      { id: 'url-only', title: '某页', url: 'https://example.com/react', folderPath: '' },
      { id: 'contains', title: '使用 React', url: 'https://a.dev/x', folderPath: '' },
      { id: 'prefix', title: 'React 教程', url: 'https://b.dev/x', folderPath: '' },
    ], 'react');
    expect(ranked.map(({ id }) => id)).toEqual(['prefix', 'contains', 'url-only']);
  });

  it('breaks score ties by shorter title first', () => {
    expect(searchBookmarks([
      { id: 'longer', title: '使用 Git 工作流', url: 'https://b.dev/x', folderPath: '' },
      { id: 'short', title: '使用 Git', url: 'https://a.dev/x', folderPath: '' },
    ], 'git').map(({ id }) => id)).toEqual(['short', 'longer']);
  });

  it('caps the result list at the given limit', () => {
    expect(searchBookmarks(entries, 'react', 2)).toHaveLength(2);
  });

  it('returns nothing when no bookmark matches', () => {
    expect(searchBookmarks(entries, 'zzz')).toEqual([]);
  });
});
