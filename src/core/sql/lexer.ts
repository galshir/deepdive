// A tiny MySQL-aware lexer: splits SQL into code / string / identifier / comment segments.
// Used to split scripts into statements, classify statements and inline parameters for display.

export type SegmentType = 'code' | 'string' | 'ident' | 'comment';

export interface Segment {
  type: SegmentType;
  text: string;
}

export function lex(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = '';
  const flush = () => {
    if (code) out.push({ type: 'code', text: code });
    code = '';
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      flush();
      let j = i + 1;
      while (j < n) {
        const d = sql[j]!;
        if (d === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (d === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push({ type: c === '`' ? 'ident' : 'string', text: sql.slice(i, Math.min(j + 1, n)) });
      i = j + 1;
      continue;
    }
    if ((c === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) || c === '#') {
      flush();
      let j = sql.indexOf('\n', i);
      if (j === -1) j = n;
      out.push({ type: 'comment', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      // MySQL executes the contents of /*! … */ comments, so treat them as code.
      if (sql[i + 2] === '!') {
        code += sql.slice(i, j);
      } else {
        flush();
        out.push({ type: 'comment', text: sql.slice(i, j) });
      }
      i = j;
      continue;
    }
    code += c;
    i++;
  }
  flush();
  return out;
}

/** Splits a script into statements on top-level semicolons. Empty statements are dropped. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (const seg of lex(sql)) {
    if (seg.type !== 'code') {
      current += seg.text;
      continue;
    }
    const parts = seg.text.split(';');
    parts.forEach((part, idx) => {
      current += part;
      if (idx < parts.length - 1) {
        statements.push(current);
        current = '';
      }
    });
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => lex(s).some((seg) => seg.type !== 'comment' && seg.text.trim() !== ''));
}
