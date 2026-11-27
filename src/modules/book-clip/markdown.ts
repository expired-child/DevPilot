const literal = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|\$\$)[^\n]*\n[\s\S]*?^[ \t>]*\1[ \t]*(?=\n|$)/gmu;

function mapProse(markdown: string, transform: (text: string) => string): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const match of markdown.matchAll(literal)) {
    parts.push(transform(markdown.slice(cursor, match.index)), match[0]);
    cursor = match.index + match[0].length;
  }
  parts.push(transform(markdown.slice(cursor)));
  return parts.join('');
}

export const compactMarkdown = (markdown: string): string => mapProse(markdown, text => text.replace(/\n(?:[ \t]*\n)+/gu, '\n\n')).trim();
export const lowerHeadings = (markdown: string): string => mapProse(markdown, text => text.replace(/^#{1,5} /gmu, '#$&'));
export const markdownText = (text: string): string => text.replace(/([\\*_`[\]])/gu, '\\$1').replace(/</gu, '&lt;');
