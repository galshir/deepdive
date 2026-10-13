import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { formatCount, key } from '../../lib/util';
import { useStore } from '../../store';
import type { ConnNodeData, DbNodeData, MoreNodeData, TableNodeData } from './layout';
import { TABLE_W } from './layout';

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} className="hidden-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="hidden-handle" isConnectable={false} />
    </>
  );
}

const activateKeys = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

export const ConnectionNode = memo(function ConnectionNode({ data }: NodeProps) {
  const d = data as ConnNodeData;
  const c = d.summary;
  return (
    <div
      className={`gnode conn-node status-${c.status} ${d.selected ? 'is-selected' : ''} ${d.dim ? 'is-dim' : ''}`}
      style={{ ['--node-color' as string]: c.config.color }}
      title={`${c.config.name}${c.serverVersion ? `\n${c.serverVersion}` : ''}${c.error ? `\n${c.error}` : ''}`}
      aria-label={`Connection ${c.config.name}, ${c.status}`}
    >
      <Handles />
      <div className="conn-core">
        {d.loading ? <Spinner /> : <Icon name="server" size={22} />}
        <div className="conn-name">{c.config.name}</div>
        <div className="conn-sub">
          {c.status === 'connected' ? `${d.dbCount ?? '…'} databases` : c.status === 'error' ? 'error — click to retry' : c.status === 'connecting' ? 'connecting…' : 'double-click to connect'}
        </div>
      </div>
      {c.config.environment === 'production' ? <div className="env-flag">PROD</div> : null}
    </div>
  );
});

export const DatabaseNode = memo(function DatabaseNode({ data }: NodeProps) {
  const d = data as DbNodeData;
  return (
    <div
      className={`gnode db-node ${d.expanded ? 'is-expanded' : ''} ${d.selected ? 'is-selected' : ''} ${d.dim ? 'is-dim' : ''} ${d.info.isSystem ? 'is-system' : ''}`}
      style={{ width: d.size, height: d.size, ['--node-color' as string]: d.color }}
      title={`${d.info.name} — ${d.info.tableCount ?? '?'} tables\nClick to ${d.expanded ? 'collapse' : 'expand'}`}
      aria-label={`Database ${d.info.name}`}
    >
      <Handles />
      <Icon name="database" size={Math.max(14, d.size / 6)} />
      <div className="db-name">{d.info.name}</div>
      <div className="db-sub">{d.loading ? <Spinner /> : `${formatCount(d.info.tableCount)} tables`}</div>
      {d.error ? (
        <div className="db-error" title={d.error}>
          <Icon name="warn" size={12} />
        </div>
      ) : null}
      {d.expanded && !d.loading && d.shownTables === 0 && !d.error ? <div className="db-empty">empty</div> : null}
    </div>
  );
});

export const TableNode = memo(function TableNode({ data }: NodeProps) {
  const d = data as TableNodeData;
  const t = d.info;
  const tKey = key(d.connectionId, t.database, t.name);
  const details = d.details?.data;
  const fkCols = new Set(details?.foreignKeys.flatMap((f) => f.columns) ?? []);
  const toggleColumns = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    const st = useStore.getState();
    st.toggleExpanded(`gcol:${tKey}`);
    void st.loadDetails(d.connectionId, t.database, t.name);
  };
  return (
    <div
      className={`gnode table-node ${d.selected ? 'is-selected' : ''} ${d.dim ? 'is-dim' : ''} ${d.match ? 'is-match' : ''}`}
      style={{ width: TABLE_W, ['--node-color' as string]: d.color }}
      aria-label={`Table ${t.name}`}
    >
      <Handles />
      <div className="table-head" title={`${t.database}.${t.name}${t.rowEstimate !== undefined ? ` — ≈${t.rowEstimate} rows` : ''}\nClick: details · Double-click: browse data`}>
        <Icon name={t.type === 'view' ? 'view' : 'table'} size={12} />
        <span className="table-name">{t.name}</span>
        {t.rowEstimate !== undefined ? <span className="table-rows">{formatCount(t.rowEstimate)}</span> : null}
        <button type="button" className="col-toggle nodrag" aria-label={d.expanded ? 'Hide columns' : 'Show columns'} aria-expanded={d.expanded} onClick={toggleColumns} onKeyDown={activateKeys(() => undefined)}>
          <Icon name={d.expanded ? 'chevronDown' : 'chevronRight'} size={11} />
        </button>
      </div>
      {d.expanded ? (
        <div className="table-cols nowheel">
          {!d.details || d.details.status === 'loading' ? <Spinner label="columns…" /> : null}
          {d.details?.status === 'error' ? <div className="muted small">{d.details.error}</div> : null}
          {details?.columns.map((c) => (
            <button
              type="button"
              key={c.name}
              className={`col-row nodrag ${d.selectedColumn === c.name ? 'on' : ''}`}
              title={`${c.name} ${c.columnType}${c.nullable ? ' NULL' : ' NOT NULL'}`}
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().select({ kind: 'column', connectionId: d.connectionId, database: t.database, table: t.name, column: c.name });
              }}
            >
              {c.isPrimaryKey ? <Icon name="key" size={10} className="pk" /> : fkCols.has(c.name) ? <Icon name="link" size={10} className="fk" /> : <span className="col-dot" />}
              <span className="col-name">{c.name}</span>
              <span className="col-type">{c.columnType}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export const MoreNode = memo(function MoreNode({ data }: NodeProps) {
  const d = data as MoreNodeData;
  return (
    <div className="gnode more-node" style={{ width: TABLE_W }} title="Show more tables">
      <Handles />+{d.hidden} more tables…
    </div>
  );
});

export const nodeTypes = { connection: ConnectionNode, database: DatabaseNode, table: TableNode, more: MoreNode };
