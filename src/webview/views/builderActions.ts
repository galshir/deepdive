import type { QueryJoin, QueryModel, TableDetails } from '../../shared/model';
import { emptyGroup } from '../lib/filters';
import { key, uid } from '../lib/util';
import { emptyModel, useStore } from '../store';

export function makeAlias(table: string, taken: ReadonlySet<string>): string {
  const base = (table.match(/[A-Za-z0-9]+/g) ?? ['t']).map((p) => p[0]!.toLowerCase()).join('').replace(/^[0-9]/, 't$&').slice(0, 6) || 't';
  let alias = /^[A-Za-z_]/.test(base) ? base : `t${base}`;
  let n = 2;
  while (taken.has(alias)) alias = `${base}${n++}`;
  return alias;
}

export async function addTableToBuilder(connectionId: string, database: string, table: string): Promise<void> {
  const st = useStore.getState();
  const details = await st.loadDetails(connectionId, database, table);
  if (!details) {
    st.toast('error', `Could not load ${database}.${table}`);
    return;
  }
  let model = st.builder.model;
  if (st.builder.connectionId && st.builder.connectionId !== connectionId && model.tables.length > 0) {
    model = emptyModel();
    st.toast('info', 'Started a new visual query for the other connection.');
  }
  const taken = new Set(model.tables.map((t) => t.alias));
  const alias = makeAlias(table, taken);
  const n = model.tables.length;
  model = {
    ...model,
    tables: [...model.tables, { alias, database, table, position: { x: 40 + (n % 2) * 300, y: 30 + Math.floor(n / 2) * 320 + (n % 2) * 40 } }],
  };
  st.updateBuilder({ connectionId, database: st.builder.database ?? database, model });
  st.openTab('builder');
}

export interface JoinSuggestion {
  id: string;
  label: string;
  join: QueryJoin;
}

/** Suggests joins only from declared foreign keys between tables already on the canvas. */
export function suggestJoins(model: QueryModel, connectionId: string | undefined): JoinSuggestion[] {
  if (!connectionId) return [];
  const details = useStore.getState().details;
  const out: JoinSuggestion[] = [];
  const has = (a: string, ac: string, b: string, bc: string) =>
    model.joins.some(
      (j) => (j.leftAlias === a && j.leftColumn === ac && j.rightAlias === b && j.rightColumn === bc) || (j.leftAlias === b && j.leftColumn === bc && j.rightAlias === a && j.rightColumn === ac),
    );
  for (const child of model.tables) {
    const d: TableDetails | undefined = details[key(connectionId, child.database, child.table)]?.data;
    if (!d) continue;
    for (const fk of d.foreignKeys) {
      if (fk.columns.length !== 1) continue;
      for (const parent of model.tables) {
        if (parent.alias === child.alias && fk.referencedTable !== child.table) continue;
        if (parent.database !== fk.referencedDatabase || parent.table !== fk.referencedTable || parent.alias === child.alias) continue;
        const cc = fk.columns[0]!;
        const pc = fk.referencedColumns[0]!;
        if (has(child.alias, cc, parent.alias, pc)) continue;
        out.push({
          id: `${child.alias}.${cc}-${parent.alias}.${pc}`,
          label: `${child.alias}.${cc} → ${parent.alias}.${pc}`,
          join: { id: uid('j'), type: 'inner', leftAlias: child.alias, leftColumn: cc, rightAlias: parent.alias, rightColumn: pc },
        });
      }
    }
  }
  return out;
}

export function resetBuilder(): void {
  useStore.getState().updateBuilder({ model: { ...emptyModel(), filter: emptyGroup() }, result: undefined, sql: undefined, notes: [], previewError: undefined });
}
