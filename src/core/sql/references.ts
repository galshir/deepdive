import { lex } from './lexer';

type Token = { kind: 'name' | 'dot' | 'other'; value: string };

function tokens(sql: string): Token[] {
  const out: Token[] = [];
  for (const seg of lex(sql)) {
    if (seg.type === 'comment') continue;
    if (seg.type === 'ident') {
      out.push({ kind: 'name', value: seg.text.slice(1, -1).replace(/``/g, '`') });
    } else if (seg.type === 'string') {
      out.push({ kind: 'other', value: seg.text });
    } else {
      for (const m of seg.text.matchAll(/[A-Za-z0-9_$]+|\S/g)) {
        const v = m[0];
        out.push({ kind: v === '.' ? 'dot' : /^[A-Za-z0-9_$]+$/.test(v) ? 'name' : 'other', value: v });
      }
    }
  }
  return out;
}

/**
 * Returns the known database names the SQL refers to explicitly (`db.table`, `db`.`table`).
 * Such references ignore the default database, so a script run on many databases would hit the
 * same objects every time. Matching is case-insensitive; table aliases that happen to equal a
 * database name are reported too, which is acceptable for a warning.
 */
export function qualifiedDatabaseRefs(sql: string, databases: readonly string[]): string[] {
  const names = new Map(databases.map((d) => [d.toLowerCase(), d]));
  const found = new Set<string>();
  const t = tokens(sql);
  for (let i = 0; i + 2 < t.length; i++) {
    if (t[i]!.kind !== 'name' || t[i + 1]!.kind !== 'dot' || t[i + 2]!.kind !== 'name') continue;
    if (t[i - 1]?.kind === 'dot') continue;
    const db = names.get(t[i]!.value.toLowerCase());
    if (db) found.add(db);
  }
  return [...found];
}
