import type { CellValue, FilterScalar, RowEdit, TableDetails } from '../../shared/model';
import { validationError } from '../errors';
import { toParam } from './filters';
import type { Dialect } from './identifiers';
import { qualifiedTable, quoteIdent } from './identifiers';

export interface Statement {
  sql: string;
  params: CellValue[];
}

function keyWhere(details: TableDetails, key: Record<string, FilterScalar>): Statement {
  const pk = details.primaryKey;
  if (pk.length === 0) throw validationError(`Table "${details.table.name}" has no primary key; rows cannot be edited safely`);
  const keys = Object.keys(key);
  if (keys.length !== pk.length || !pk.every((c) => keys.includes(c))) {
    throw validationError('Row identity must contain exactly the primary key columns');
  }
  const params: CellValue[] = [];
  const parts = pk.map((c) => {
    const v = key[c];
    if (v === null || v === undefined) throw validationError(`Primary key column "${c}" cannot be NULL`);
    params.push(toParam(v));
    return `${quoteIdent(c)} = ?`;
  });
  return { sql: parts.join(' AND '), params };
}

/** Builds one UPDATE/DELETE per row, each addressed by its primary key and limited to a single row. */
export function buildEditStatements(
  details: TableDetails,
  updates: readonly RowEdit[],
  deletes: readonly Record<string, FilterScalar>[],
  dialect: Dialect,
): Statement[] {
  if (details.table.type === 'view') throw validationError('Views cannot be edited from the data browser');
  const cols = new Set(details.columns.map((c) => c.name));
  const table = qualifiedTable(details.table.database, details.table.name);
  const limit = dialect === 'mysql' ? ' LIMIT 1' : '';
  const out: Statement[] = [];
  for (const u of updates) {
    const changed = Object.keys(u.changes);
    if (changed.length === 0) continue;
    for (const c of changed) if (!cols.has(c)) throw validationError(`Unknown column "${c}"`);
    const where = keyWhere(details, u.key);
    out.push({
      sql: `UPDATE ${table} SET ${changed.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${where.sql}${limit}`,
      params: [...changed.map((c) => toParam(u.changes[c]!)), ...where.params],
    });
  }
  for (const d of deletes) {
    const where = keyWhere(details, d);
    out.push({ sql: `DELETE FROM ${table} WHERE ${where.sql}${limit}`, params: where.params });
  }
  return out;
}
