import type { CellValue } from '../../shared/model';
import type { Dialect } from './identifiers';
import { lex } from './lexer';

/** Formats a value as a SQL literal. Only used for display/"open in editor" — execution always uses parameters. */
export function formatLiteral(value: CellValue, dialect: Dialect): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers cannot be used as SQL literals');
    return String(value);
  }
  if (dialect === 'sqlite') return `'${value.replace(/'/g, "''")}'`;
  // eslint-disable-next-line no-control-regex
  const escaped = value.replace(/[\0\n\r\b\t\\'\x1a]/g, (c) => {
    switch (c) {
      case '\0': return '\\0';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\x1a': return '\\Z';
      case "'": return "''";
      default: return '\\\\';
    }
  });
  return `'${escaped}'`;
}

/** Replaces `?` placeholders that appear in code (not inside strings/identifiers/comments). */
export function inlineParams(sql: string, params: readonly CellValue[], dialect: Dialect): string {
  let index = 0;
  const out = lex(sql).map((seg) => {
    if (seg.type !== 'code') return seg.text;
    return seg.text.replace(/\?/g, () => {
      if (index >= params.length) throw new Error('Not enough parameters for SQL placeholders');
      return formatLiteral(params[index++]!, dialect);
    });
  });
  if (index !== params.length) throw new Error('Too many parameters for SQL placeholders');
  return out.join('');
}
