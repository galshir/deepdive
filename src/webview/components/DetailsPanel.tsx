import type { ForeignKeyInfo, TableDetails } from '../../shared/model';
import { rpc } from '../lib/rpc';
import { formatBytes, formatCount, key } from '../lib/util';
import { addTableToBuilder } from '../views/builderActions';
import { useStore } from '../store';
import { ConnDot, EmptyState, ErrorBox, Spinner } from './common';
import { Icon } from './Icon';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="detail-actions">{children}</div>;
}

export function DetailsPanel() {
  const selection = useStore((s) => s.selection);
  return (
    <aside className="details" aria-label="Details">
      <div className="panel-header">
        <Icon name="info" /> <span>Details</span>
      </div>
      <div className="details-body">
        {!selection ? (
          <EmptyState icon="focus" title="Nothing selected">
            Click a connection, database bubble, table, column or relationship to inspect it.
          </EmptyState>
        ) : selection.kind === 'connection' ? (
          <ConnectionDetails id={selection.connectionId} />
        ) : selection.kind === 'database' ? (
          <DatabaseDetails connectionId={selection.connectionId} database={selection.database} />
        ) : selection.kind === 'table' ? (
          <TableDetailsView connectionId={selection.connectionId} database={selection.database} table={selection.table} />
        ) : selection.kind === 'column' ? (
          <ColumnDetails connectionId={selection.connectionId} database={selection.database} table={selection.table} column={selection.column} />
        ) : (
          <RelationshipDetails connectionId={selection.connectionId} fk={selection.fk} />
        )}
      </div>
    </aside>
  );
}

function ConnectionDetails({ id }: { id: string }) {
  const c = useStore((s) => s.connections.find((x) => x.config.id === id));
  const dbs = useStore((s) => s.databases[id]);
  if (!c) return <EmptyState title="Connection removed" />;
  const st = useStore.getState();
  const cfg = c.config;
  return (
    <div>
      <h2 className="detail-title">
        <ConnDot color={cfg.color} status={c.status} /> {cfg.name}
      </h2>
      <dl className="kv">
        <Field label="Status">
          <span className={`status-pill ${c.status}`}>{c.status}</span>
        </Field>
        <Field label="Type">{cfg.kind === 'demo' ? `Demo (${cfg.demoDataset})` : 'MySQL'}</Field>
        {cfg.kind === 'mysql' ? (
          <>
            <Field label="Server">
              {cfg.host}:{cfg.port}
            </Field>
            <Field label="User">{cfg.user}</Field>
            <Field label="Password">{c.hasPassword ? 'stored in SecretStorage' : 'none'}</Field>
            <Field label="TLS">{cfg.tls.mode}</Field>
          </>
        ) : null}
        <Field label="Environment">{cfg.environment}</Field>
        <Field label="Access">{cfg.readOnly ? 'Read-only' : 'Read & write (with confirmation)'}</Field>
        {c.serverVersion ? <Field label="Version">{c.serverVersion}</Field> : null}
        {dbs?.data ? <Field label="Databases">{dbs.data.filter((d) => !d.isSystem).length}</Field> : null}
      </dl>
      {c.error ? <ErrorBox message={c.error} onRetry={() => void st.connect(id)} /> : null}
      <Actions>
        {c.status === 'connected' ? (
          <button type="button" className="btn" onClick={() => void st.disconnect(id)}>
            <Icon name="unplug" /> Disconnect
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={c.status === 'connecting'} onClick={() => void st.connect(id)}>
            <Icon name="plug" /> Connect
          </button>
        )}
        <button type="button" className="btn" onClick={() => st.set({ connectionForm: { open: true, editing: cfg } })}>
          <Icon name="edit" /> Edit
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() =>
            void rpc({ type: 'deleteConnection', connectionId: id })
              .then((removed) => removed && st.select(null))
              .catch((e: Error) => st.toast('error', e.message))
          }
        >
          <Icon name="trash" /> Remove
        </button>
      </Actions>
    </div>
  );
}

function DatabaseDetails({ connectionId, database }: { connectionId: string; database: string }) {
  const info = useStore((s) => s.databases[connectionId]?.data?.find((d) => d.name === database));
  const tables = useStore((s) => s.tables[key(connectionId, database)]);
  const st = useStore.getState();
  const views = tables?.data?.filter((t) => t.type === 'view').length ?? 0;
  return (
    <div>
      <h2 className="detail-title">
        <Icon name="database" size={16} /> {database}
      </h2>
      <dl className="kv">
        <Field label="Tables">{formatCount(info?.tableCount)}</Field>
        {tables?.data ? <Field label="Views">{views}</Field> : null}
        <Field label="Size">{formatBytes(info?.sizeBytes)}</Field>
        {info?.isSystem ? <Field label="Kind">System database</Field> : null}
      </dl>
      <Actions>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            st.toggleExpanded(`db:${key(connectionId, database)}`, true);
            void st.loadTables(connectionId, database);
            st.openTab('graph');
          }}
        >
          <Icon name="graph" /> Show tables in graph
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            st.set((s) => ({ schemaFocus: { ...s.schemaFocus, connectionId, database, table: undefined } }));
            st.openTab('schema');
          }}
        >
          <Icon name="schema" /> Schema diagram
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            st.updateBuilder({ connectionId, database });
            st.openTab('builder');
          }}
        >
          <Icon name="builder" /> New visual query
        </button>
        <button type="button" className="btn" onClick={() => st.openSqlWith(`SELECT *\nFROM \`${database.replace(/`/g, '``')}\`.\n`, connectionId, database)}>
          <Icon name="code" /> SQL editor
        </button>
      </Actions>
    </div>
  );
}

function fkLabel(fk: ForeignKeyInfo, direction: 'out' | 'in') {
  return direction === 'out'
    ? `${fk.columns.join(', ')} → ${fk.referencedTable}.${fk.referencedColumns.join(', ')}`
    : `${fk.table}.${fk.columns.join(', ')} → ${fk.referencedColumns.join(', ')}`;
}

function useDetails(connectionId: string, database: string, table: string) {
  return useStore((s) => s.details[key(connectionId, database, table)]);
}

function TableDetailsView({ connectionId, database, table }: { connectionId: string; database: string; table: string }) {
  const d = useDetails(connectionId, database, table);
  const st = useStore.getState();
  if (!d || d.status === 'loading') return <Spinner label="Loading table…" />;
  if (d.status === 'error') return <ErrorBox message={d.error ?? 'Failed'} onRetry={() => void st.loadDetails(connectionId, database, table, true)} />;
  const t = d.data!;
  return (
    <div>
      <h2 className="detail-title">
        <Icon name={t.table.type === 'view' ? 'view' : 'table'} size={16} /> {table}
      </h2>
      <div className="muted small">
        {database} · {t.table.type}
        {t.table.engine ? ` · ${t.table.engine}` : ''} · ≈{formatCount(t.table.rowEstimate)} rows (estimate)
      </div>
      {t.table.comment ? <p className="comment">{t.table.comment}</p> : null}
      <Actions>
        <button type="button" className="btn primary" onClick={() => st.openTable(connectionId, database, table)}>
          <Icon name="table" /> Browse data
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            st.set((s) => ({ schemaFocus: { ...s.schemaFocus, connectionId, database, table } }));
            st.openTab('schema');
          }}
        >
          <Icon name="schema" /> Relationships
        </button>
        <button type="button" className="btn" onClick={() => void addTableToBuilder(connectionId, database, table)}>
          <Icon name="builder" /> Add to query
        </button>
      </Actions>
      <ColumnsTable details={t} connectionId={connectionId} />
      <h3>Indexes</h3>
      {t.indexes.length === 0 ? <div className="muted small">No indexes</div> : null}
      <ul className="plain-list">
        {t.indexes.map((i) => (
          <li key={i.name}>
            <Icon name={i.primary ? 'key' : 'layers'} size={12} /> <b>{i.name}</b> ({i.columns.join(', ')}){' '}
            <span className="muted">{i.primary ? 'primary' : i.unique ? 'unique' : i.type.toLowerCase()}</span>
          </li>
        ))}
      </ul>
      <h3>References (outgoing)</h3>
      {t.foreignKeys.length === 0 ? <div className="muted small">No foreign keys declared on this table.</div> : null}
      <ul className="plain-list">
        {t.foreignKeys.map((fk) => (
          <li key={fk.name}>
            <button type="button" className="link" onClick={() => st.select({ kind: 'relationship', connectionId, fk })}>
              <Icon name="link" size={12} /> {fkLabel(fk, 'out')}
            </button>{' '}
            <button type="button" className="link muted" title="Follow relationship" onClick={() => st.select({ kind: 'table', connectionId, database: fk.referencedDatabase, table: fk.referencedTable })}>
              open ›
            </button>
          </li>
        ))}
      </ul>
      <h3>Referenced by (incoming)</h3>
      {t.referencedBy.length === 0 ? <div className="muted small">No foreign keys reference this table.</div> : null}
      <ul className="plain-list">
        {t.referencedBy.map((fk) => (
          <li key={`${fk.table}.${fk.name}`}>
            <button type="button" className="link" onClick={() => st.select({ kind: 'relationship', connectionId, fk })}>
              <Icon name="link" size={12} /> {fkLabel(fk, 'in')}
            </button>{' '}
            <button type="button" className="link muted" title="Follow relationship" onClick={() => st.select({ kind: 'table', connectionId, database: fk.database, table: fk.table })}>
              open ›
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ColumnsTable({ details, connectionId }: { details: TableDetails; connectionId: string }) {
  const fkCols = new Set(details.foreignKeys.flatMap((f) => f.columns));
  const st = useStore.getState();
  return (
    <>
      <h3>Columns ({details.columns.length})</h3>
      <table className="mini-table">
        <thead>
          <tr>
            <th aria-label="Key" />
            <th>Name</th>
            <th>Type</th>
            <th>Null</th>
          </tr>
        </thead>
        <tbody>
          {details.columns.map((c) => (
            <tr
              key={c.name}
              className="clickable"
              tabIndex={0}
              onClick={() => st.select({ kind: 'column', connectionId, database: details.table.database, table: details.table.name, column: c.name })}
              onKeyDown={(e) => e.key === 'Enter' && st.select({ kind: 'column', connectionId, database: details.table.database, table: details.table.name, column: c.name })}
            >
              <td>{c.isPrimaryKey ? <Icon name="key" size={12} className="pk" title="Primary key" /> : fkCols.has(c.name) ? <Icon name="link" size={12} className="fk" title="Foreign key" /> : null}</td>
              <td>{c.name}</td>
              <td className="muted">{c.columnType}</td>
              <td className="muted">{c.nullable ? 'yes' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ColumnDetails({ connectionId, database, table, column }: { connectionId: string; database: string; table: string; column: string }) {
  const d = useDetails(connectionId, database, table);
  const st = useStore.getState();
  if (!d || d.status === 'loading') return <Spinner label="Loading column…" />;
  if (d.status === 'error') return <ErrorBox message={d.error ?? 'Failed'} />;
  const t = d.data!;
  const c = t.columns.find((x) => x.name === column);
  if (!c) return <EmptyState title="Column not found" />;
  const indexes = t.indexes.filter((i) => i.columns.includes(column));
  const fk = t.foreignKeys.find((f) => f.columns.includes(column));
  const incoming = t.referencedBy.filter((f) => f.referencedColumns.includes(column));
  return (
    <div>
      <h2 className="detail-title">
        <Icon name={c.isPrimaryKey ? 'key' : fk ? 'link' : 'column'} size={16} /> {column}
      </h2>
      <div className="muted small">
        <button type="button" className="link" onClick={() => st.select({ kind: 'table', connectionId, database, table })}>
          {database}.{table}
        </button>
      </div>
      <dl className="kv">
        <Field label="Type">
          <code>{c.columnType}</code>
        </Field>
        <Field label="Nullable">{c.nullable ? 'YES' : 'NO'}</Field>
        <Field label="Default">{c.defaultValue === null ? <span className="null">NULL / none</span> : <code>{c.defaultValue}</code>}</Field>
        <Field label="Key">{c.key === 'PRI' ? 'Primary key' : c.key === 'UNI' ? 'Unique' : c.key === 'MUL' ? 'Indexed (non-unique)' : '—'}</Field>
        <Field label="Indexes">{indexes.length ? indexes.map((i) => i.name).join(', ') : 'not indexed'}</Field>
        {c.isAutoIncrement ? <Field label="Extra">auto_increment</Field> : c.extra ? <Field label="Extra">{c.extra}</Field> : null}
        {fk ? <Field label="References">{`${fk.referencedTable}.${fk.referencedColumns[fk.columns.indexOf(column)]}`}</Field> : null}
        {incoming.length ? <Field label="Referenced by">{incoming.map((f) => `${f.table}.${f.columns.join(',')}`).join('; ')}</Field> : null}
        {c.comment ? <Field label="Comment">{c.comment}</Field> : null}
      </dl>
      <Actions>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            st.openTable(connectionId, database, table, { showFilters: true });
            window.dispatchEvent(new CustomEvent('deepdive:addFilter', { detail: { tab: `data:${key(connectionId, database, table)}`, column } }));
          }}
        >
          <Icon name="filter" /> Filter by this column
        </button>
      </Actions>
    </div>
  );
}

function RelationshipDetails({ connectionId, fk }: { connectionId: string; fk: ForeignKeyInfo }) {
  const st = useStore.getState();
  return (
    <div>
      <h2 className="detail-title">
        <Icon name="link" size={16} /> {fk.name}
      </h2>
      <div className="muted small">Foreign key constraint</div>
      <dl className="kv">
        <Field label="From">
          <button type="button" className="link" onClick={() => st.select({ kind: 'table', connectionId, database: fk.database, table: fk.table })}>
            {fk.database}.{fk.table}
          </button>{' '}
          ({fk.columns.join(', ')})
        </Field>
        <Field label="To">
          <button type="button" className="link" onClick={() => st.select({ kind: 'table', connectionId, database: fk.referencedDatabase, table: fk.referencedTable })}>
            {fk.referencedDatabase}.{fk.referencedTable}
          </button>{' '}
          ({fk.referencedColumns.join(', ')})
        </Field>
        <Field label="Cardinality">{fk.cardinality === 'one-to-one' ? 'one-to-one (unique on referencing side)' : 'many-to-one'}</Field>
        <Field label="ON UPDATE">{fk.onUpdate}</Field>
        <Field label="ON DELETE">{fk.onDelete}</Field>
      </dl>
      <pre className="sql-block">
        {`CONSTRAINT \`${fk.name}\`\n  FOREIGN KEY (${fk.columns.map((c) => `\`${c}\``).join(', ')})\n  REFERENCES \`${fk.referencedTable}\` (${fk.referencedColumns.map((c) => `\`${c}\``).join(', ')})\n  ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`}
      </pre>
    </div>
  );
}
