import type { ReactNode } from 'react';
import type { ConnectionSummary } from '../../shared/model';
import { useStore } from '../store';
import { Icon } from './Icon';

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function EmptyState({ icon = 'info', title, children }: { icon?: Parameters<typeof Icon>[0]['name']; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={28} />
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <Icon name="warn" />
      <span className="error-text">{message}</span>
      {onRetry ? (
        <button type="button" className="btn small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function ConnDot({ color, status }: { color: string; status?: ConnectionSummary['status'] }) {
  return <span className={`conn-dot status-${status ?? 'connected'}`} style={{ background: color }} aria-hidden />;
}

/** Connection + database pickers shared by the builder, SQL editor and schema view. */
export function ConnectionDatabasePicker({
  connectionId,
  database,
  onChange,
  allowNoDatabase,
}: {
  connectionId?: string;
  database?: string;
  onChange: (connectionId: string | undefined, database: string | undefined) => void;
  allowNoDatabase?: boolean;
}) {
  const connections = useStore((s) => s.connections);
  const dbs = useStore((s) => (connectionId ? s.databases[connectionId] : undefined));
  const showSystem = useStore((s) => s.showSystemDatabases);
  const connected = connections.filter((c) => c.status === 'connected');
  const conn = connections.find((c) => c.config.id === connectionId);
  return (
    <div className="picker">
      {conn ? <ConnDot color={conn.config.color} status={conn.status} /> : null}
      <select
        aria-label="Connection"
        value={connectionId ?? ''}
        onChange={(e) => {
          const id = e.target.value || undefined;
          onChange(id, undefined);
          if (id) void useStore.getState().loadDatabases(id);
        }}
      >
        <option value="">{connected.length ? 'Select connection…' : 'No connected servers'}</option>
        {connected.map((c) => (
          <option key={c.config.id} value={c.config.id}>
            {c.config.name}
          </option>
        ))}
      </select>
      <select aria-label="Database" value={database ?? ''} disabled={!connectionId} onChange={(e) => onChange(connectionId, e.target.value || undefined)}>
        <option value="">{allowNoDatabase ? '(no default database)' : 'Select database…'}</option>
        {(dbs?.data ?? [])
          .filter((d) => showSystem || !d.isSystem || d.name === database)
          .map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
      </select>
      {dbs?.status === 'loading' ? <Spinner /> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
