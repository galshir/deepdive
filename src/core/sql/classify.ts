import { lex } from './lexer';

export interface Classification {
  readOnly: boolean;
  keyword: string;
  reason?: string;
}

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES', 'HELP', 'USE']);

/** Keywords that modify data, schema, privileges or session/server state wherever they appear. */
const WRITE_TOKENS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'LOCK', 'UNLOCK', 'CALL', 'LOAD', 'HANDLER', 'INTO', 'OUTFILE', 'DUMPFILE', 'KILL',
  'SHUTDOWN', 'RESTART', 'INSTALL', 'UNINSTALL', 'IMPORT', 'PURGE', 'RESET', 'FLUSH', 'OPTIMIZE', 'REPAIR',
  'ANALYZE', 'CHECKSUM', 'CACHE', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'XA', 'SAVEPOINT', 'ROLLBACK', 'COMMIT',
]);

/**
 * Conservatively classifies a single statement. Anything not positively identified as read-only is
 * treated as a write and requires explicit confirmation. This is a safety net, not a security
 * boundary: use a read-only MySQL account for hard guarantees.
 */
export function classifyStatement(statement: string): Classification {
  const tokens: string[] = [];
  for (const seg of lex(statement)) {
    if (seg.type !== 'code') continue;
    const words = seg.text.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g);
    if (words) tokens.push(...words);
  }
  const keyword = tokens[0] ?? '';
  if (!READ_KEYWORDS.has(keyword)) {
    return { readOnly: false, keyword, reason: keyword ? `${keyword} statements can modify data or server state` : 'Unrecognized statement' };
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (WRITE_TOKENS.has(t)) {
      if (t === 'ANALYZE' && tokens[i - 1] === 'EXPLAIN') continue;
      return { readOnly: false, keyword, reason: `Statement contains ${t}` };
    }
    if (t === 'FOR' && (tokens[i + 1] === 'UPDATE' || tokens[i + 1] === 'SHARE')) {
      return { readOnly: false, keyword, reason: 'Locking read (FOR UPDATE/SHARE)' };
    }
    if (t === 'SET' && keyword !== 'SHOW') return { readOnly: false, keyword, reason: 'Statement contains SET' };
  }
  return { readOnly: true, keyword };
}

export function isReadOnlyStatement(statement: string): boolean {
  return classifyStatement(statement).readOnly;
}
