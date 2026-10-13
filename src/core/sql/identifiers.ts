import { validationError } from '../errors';

export type Dialect = 'mysql' | 'sqlite';

const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Validates a MySQL identifier (database, table, column or alias name).
 * MySQL allows almost any character in quoted identifiers, so instead of a whitelist we reject the
 * characters MySQL itself rejects and enforce the length limit. Existence is checked separately
 * against live metadata — callers must never rely on quoting alone.
 */
export function assertIdentifier(name: unknown, what = 'identifier'): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) throw validationError(`Invalid ${what}: must be a non-empty string`);
  if (name.length > MAX_IDENTIFIER_LENGTH) throw validationError(`Invalid ${what}: longer than ${MAX_IDENTIFIER_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000]/.test(name)) throw validationError(`Invalid ${what}: contains a NUL character`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)) {
    throw validationError(`Invalid ${what}: contains invalid unicode`);
  }
  if (/\s$/.test(name)) throw validationError(`Invalid ${what}: may not end with whitespace`);
}

/** Quotes an identifier with backticks, doubling embedded backticks. Works for MySQL and SQLite. */
export function quoteIdent(name: string, what?: string): string {
  assertIdentifier(name, what);
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Quotes `db`.`table`. */
export function qualifiedTable(database: string, table: string): string {
  return `${quoteIdent(database, 'database name')}.${quoteIdent(table, 'table name')}`;
}

/** Simple alias rule used for generated/user aliases in the query builder. */
export const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function assertAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) throw validationError(`Invalid alias "${alias}"`);
}

/** Escape character used with LIKE … ESCAPE '!' — portable between MySQL and SQLite. */
export const LIKE_ESCAPE_CHAR = '!';

/** Escapes LIKE wildcards so user text is matched literally. Use together with `ESCAPE '!'`. */
export function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (c) => `!${c}`);
}
