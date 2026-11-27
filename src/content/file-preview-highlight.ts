import { common, createLowlight } from 'lowlight';

const highlighter = createLowlight({
  ...common,
  sql: (hljs) => {
    const grammar = common.sql(hljs);
    return {
      ...grammar,
      // 通用 SQL 语法未覆盖部分 MySQL 建表写法，补齐反引号标识符和常用类型、属性。
      contains: [
        { scope: 'symbol', begin: /`/, end: /`/, contains: [{ match: /``/ }] },
        { scope: 'type', match: /\b(?:TINYINT|MEDIUMINT|DATETIME|TINYTEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|MEDIUMBLOB|LONGBLOB|JSON)\b|\b(?:ENUM|SET)(?=\s*\()/i },
        { scope: 'keyword', match: /\b(?:AUTO_INCREMENT|COMMENT|UNSIGNED|ZEROFILL|ENGINE)\b/i },
        ...grammar.contains,
      ],
    };
  },
});

const MAX_HIGHLIGHT_LENGTH = 100_000;
const languageAliases = new Map([
  ['tsx', 'typescript'], ['properties', 'ini'],
  ['vue', 'xml'], ['svelte', 'xml'], ['aspx', 'xml'], ['asp', 'xml'],
]);

type SyntaxNodes = ReturnType<typeof highlighter.highlight>['children'];

function appendTokens(parent: DocumentFragment | HTMLElement, nodes: SyntaxNodes): void {
  for (const node of nodes) {
    if (node.type === 'text') parent.append(node.value);
    else if (node.type === 'element' && node.tagName === 'span') {
      const span = document.createElement('span');
      const classes = node.properties.className;
      if (Array.isArray(classes)) span.className = classes.join(' ');
      appendTokens(span, node.children);
      parent.append(span);
    }
  }
}

export function highlightPreview(code: HTMLPreElement, fileName: string, text: string): void {
  const extension = fileName.match(/\.(\w+)$/)?.[1].toLowerCase();
  if (!extension) return;
  const language = languageAliases.get(extension) ?? extension;
  if (!highlighter.registered(language)) return;

  // ponytail: 只解析前段完整行，避免大文件阻塞网页；需要全文高亮时再移至 Worker。
  const end = text.length <= MAX_HIGHLIGHT_LENGTH ? text.length : text.lastIndexOf('\n', MAX_HIGHLIGHT_LENGTH - 1) + 1;
  if (end === 0) return;
  const source = text.slice(0, end);
  // 文件只进入文本节点，不把高亮结果作为 HTML 注入网页。
  const fragment = document.createDocumentFragment();
  appendTokens(fragment, highlighter.highlight(language, source).children);
  if (fragment.childElementCount === 0 || fragment.textContent !== source) return;
  if (end < text.length) fragment.append(text.slice(end));
  code.replaceChildren(fragment);
  code.classList.add('syntax-preview');
}
