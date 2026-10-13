import type { CellValue, ColumnInfo, TableDetails } from '../../shared/model';
import { validationError } from '../errors';
import { escapeLike, LIKE_ESCAPE_CHAR, qualifiedTable, quoteIdent } from './identifiers';

const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real']);

export const isTextColumn = (c: ColumnInfo) => TEXT_TYPES.has(c.dataType);
export const isNumericColumn = (c: ColumnInfo) => NUMERIC_TYPES.has(c.dataType);

export interface DataSearchQuery {
  sql: string;
  params: CellValue[];
  searchedColumns: string[];
}

/**
 * Builds a bounded search query for one table. By default only text columns are matched (LIKE with
 * escaped wildcards); numeric columns are matched by equality when the term is numeric.
 * Returns null when the table has no searchable columns.
 */
export function buildDataSearchQuery(
  details: TableDetails,
  term: string,
  match: 'contains' | 'equals',
  limit: number,
  explicitColumns?: readonly string[],
): DataSearchQuery | null {
  if (!term) throw validationError('Search term is empty');
  const cols = new Map(details.columns.map((c) => [c.name, c]));
  let candidates: ColumnInfo[];
  if (explicitColumns && explicitColumns.length > 0) {
    candidates = explicitColumns.map((name) => {
      const c = cols.get(name);
      if (!c) throw validationError(`Unknown column "${name}" in ${details.table.name}`);
      return c;
    });
  } else {
    candidates = details.columns.filter((c) => isTextColumn(c) || isNumericColumn(c));
  }
  const numericTerm = /^-?\d+(\.\d+)?$/.test(term.trim());
  const parts: string[] = [];
  const params: CellValue[] = [];
  const searched: string[] = [];
  for (const c of candidates) {
    const col = quoteIdent(c.name);
    if (isNumericColumn(c)) {
      if (!numericTerm) continue;
      parts.push(`${col} = ?`);
      params.push(Number(term.trim()));
    } else if (match === 'equals') {
      parts.push(`${col} = ?`);
      params.push(term);
    } else if (isTextColumn(c)) {
      parts.push(`${col} LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`);
      params.push(`%${escapeLike(term)}%`);
    } else {
      // Explicitly chosen non-text column (dates, json…): compare its text form.
      parts.push(`CAST(${col} AS CHAR) LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`);
      params.push(`%${escapeLike(term)}%`);
    }
    searched.push(c.name);
  }
  if (parts.length === 0) return null;
  const selectCols = details.columns.slice(0, 50).map((c) => quoteIdent(c.name));
  return {
    sql: `SELECT ${selectCols.join(', ')} FROM ${qualifiedTable(details.table.database, details.table.name)} WHERE ${parts.map((p) => `(${p})`).join(' OR ')} LIMIT ?`,
    params: [...params, limit],
    searchedColumns: searched,
  };
}
