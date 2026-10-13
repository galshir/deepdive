import type { CellValue, ColumnInfo, QueryModel, TableDetails } from '../../shared/model';
import { validationError } from '../errors';
import { buildFilter, type ColumnResolver } from './filters';
import { ALIAS_PATTERN, assertAlias, qualifiedTable, quoteIdent } from './identifiers';

export interface CompiledQuery {
  sql: string;
  params: CellValue[];
  notes: string[];
}

export type DetailsLookup = (database: string, table: string) => TableDetails;

const AGGREGATES: Record<string, (expr: string) => string> = {
  count: (e) => `COUNT(${e})`,
  count_distinct: (e) => `COUNT(DISTINCT ${e})`,
  sum: (e) => `SUM(${e})`,
  avg: (e) => `AVG(${e})`,
  min: (e) => `MIN(${e})`,
  max: (e) => `MAX(${e})`,
};

/**
 * Compiles a visual query model into a SELECT. Only joins explicitly present in the model are used —
 * the compiler never infers relationships. All identifiers are validated against metadata.
 */
export function compileQueryModel(model: QueryModel, lookup: DetailsLookup): CompiledQuery {
  const notes: string[] = [];
  if (model.tables.length === 0) throw validationError('Add at least one table to the query');

  const sources = new Map<string, { details: TableDetails; cols: Map<string, ColumnInfo> }>();
  for (const t of model.tables) {
    assertAlias(t.alias);
    if (sources.has(t.alias)) throw validationError(`Alias "${t.alias}" is used twice`);
    const details = lookup(t.database, t.table);
    sources.set(t.alias, { details, cols: new Map(details.columns.map((c) => [c.name, c])) });
  }

  const ref = (source: string | undefined, column: string): { sql: string; column: ColumnInfo } => {
    const alias = source ?? (model.tables.length === 1 ? model.tables[0]!.alias : undefined);
    if (alias === undefined) throw validationError(`Column "${column}" must specify its table`);
    const src = sources.get(alias);
    if (!src) throw validationError(`Unknown table alias "${alias}"`);
    const info = src.cols.get(column);
    if (!info) throw validationError(`Unknown column "${column}" in "${src.details.table.name}"`);
    return { sql: `${quoteIdent(alias)}.${quoteIdent(column)}`, column: info };
  };
  const resolver: ColumnResolver = ref;

  // ----- SELECT list -----
  const selectParts: string[] = [];
  const plainColumns: { source: string; column: string }[] = [];
  let hasAggregate = false;
  const outputNames = new Set<string>();
  for (const c of model.columns) {
    if (!sources.has(c.source)) throw validationError(`Unknown table alias "${c.source}"`);
    let expr: string;
    if (c.column === '*') {
      if (c.aggregate && c.aggregate !== 'count') throw validationError('Only COUNT can be applied to *');
      expr = c.aggregate ? 'COUNT(*)' : `${quoteIdent(c.source)}.*`;
    } else {
      const base = ref(c.source, c.column).sql;
      if (c.aggregate) {
        const fn = AGGREGATES[c.aggregate];
        if (!fn) throw validationError(`Unknown aggregate "${c.aggregate}"`);
        expr = fn(base);
      } else {
        expr = base;
        plainColumns.push({ source: c.source, column: c.column });
      }
    }
    if (c.aggregate) hasAggregate = true;
    let alias = c.as;
    if (!alias && c.aggregate) {
      const candidate = `${c.aggregate}_${c.column === '*' ? 'all' : c.column}`;
      if (ALIAS_PATTERN.test(candidate)) alias = candidate;
    }
    if (alias) {
      assertAlias(alias);
      if (outputNames.has(alias)) throw validationError(`Output name "${alias}" is used twice`);
      outputNames.add(alias);
      expr += ` AS ${quoteIdent(alias)}`;
    }
    selectParts.push(expr);
  }
  if (selectParts.length === 0) {
    selectParts.push('*');
    notes.push('No columns selected — selecting all columns.');
  }

  // ----- FROM / JOIN -----
  for (const j of model.joins) {
    if (!sources.has(j.leftAlias) || !sources.has(j.rightAlias)) throw validationError('Join references a table that is not in the query');
    if (j.leftAlias === j.rightAlias) throw validationError('A join must connect two different tables');
    ref(j.leftAlias, j.leftColumn);
    ref(j.rightAlias, j.rightColumn);
  }
  const [first, ...rest] = model.tables;
  const placed = new Set<string>([first!.alias]);
  const fromParts = [`${qualifiedTable(first!.database, first!.table)} AS ${quoteIdent(first!.alias)}`];
  const remaining = [...rest];
  const usedJoins = new Set<string>();
  while (remaining.length > 0) {
    const idx = remaining.findIndex((t) =>
      model.joins.some((j) => (j.leftAlias === t.alias && placed.has(j.rightAlias)) || (j.rightAlias === t.alias && placed.has(j.leftAlias))),
    );
    if (idx === -1) {
      throw validationError(
        `Table "${remaining[0]!.table}" (${remaining[0]!.alias}) is not joined to the rest of the query. Connect two columns to create a join, or remove the table.`,
      );
    }
    const t = remaining.splice(idx, 1)[0]!;
    const joins = model.joins.filter(
      (j) => (j.leftAlias === t.alias && placed.has(j.rightAlias)) || (j.rightAlias === t.alias && placed.has(j.leftAlias)),
    );
    const firstJoin = joins[0]!;
    // Joins are stored as "left <type> right". If the new table is the left side, flip outer joins.
    let type = firstJoin.type;
    if (firstJoin.leftAlias === t.alias && type !== 'inner') type = type === 'left' ? 'right' : 'left';
    if (joins.some((j) => j.type !== firstJoin.type)) notes.push(`Joins to "${t.alias}" use different types; using ${type.toUpperCase()} JOIN.`);
    const on = joins
      .map((j) => {
        usedJoins.add(j.id);
        return `${ref(j.leftAlias, j.leftColumn).sql} = ${ref(j.rightAlias, j.rightColumn).sql}`;
      })
      .join(' AND ');
    fromParts.push(`${type.toUpperCase()} JOIN ${qualifiedTable(t.database, t.table)} AS ${quoteIdent(t.alias)} ON ${on}`);
    placed.add(t.alias);
  }
  const unused = model.joins.filter((j) => !usedJoins.has(j.id));
  if (unused.length > 0) throw validationError('Some joins could not be placed in the query');

  // ----- WHERE -----
  const where = buildFilter(model.filter, resolver);

  // ----- GROUP BY -----
  let groupBy = model.groupBy.map((g) => ref(g.source, g.column).sql);
  if (hasAggregate && groupBy.length === 0 && plainColumns.length > 0) {
    groupBy = plainColumns.map((p) => ref(p.source, p.column).sql);
    notes.push('Added GROUP BY for the non-aggregated columns.');
  }

  // ----- ORDER BY -----
  const orderBy = model.orderBy.map((o) => {
    if (o.direction !== 'asc' && o.direction !== 'desc') throw validationError('Invalid sort direction');
    return `${ref(o.source, o.column).sql} ${o.direction.toUpperCase()}`;
  });

  const params: CellValue[] = [];
  const lines = [`SELECT ${model.distinct ? 'DISTINCT ' : ''}${selectParts.join(',\n       ')}`, `FROM ${fromParts.join('\n  ')}`];
  if (where) {
    lines.push(`WHERE ${where.sql}`);
    params.push(...where.params);
  }
  if (groupBy.length) lines.push(`GROUP BY ${groupBy.join(', ')}`);
  if (orderBy.length) lines.push(`ORDER BY ${orderBy.join(', ')}`);
  if (model.limit !== null) {
    if (!Number.isInteger(model.limit) || model.limit < 1) throw validationError('Invalid limit');
    lines.push('LIMIT ?');
    params.push(model.limit);
  }
  return { sql: lines.join('\n'), params, notes };
}
