import { useEffect, useRef } from 'react';
import { shortSql } from '../lib/util';
import { useStore } from '../store';
import { Icon, IconButton } from './Icon';

export function LogPanel() {
  const logs = useStore((s) => s.logs);
  const connections = useStore((s) => s.connections);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs.length]);
  const name = (id?: string) => connections.find((c) => c.config.id === id)?.config;
  return (
    <section className="log-panel" aria-label="Execution log">
      <div className="panel-header">
        <Icon name="logs" /> <span>Execution log</span>
        <span className="muted">{logs.length} entries</span>
        <span className="spacer" />
        <IconButton icon="trash" label="Clear log" onClick={() => useStore.getState().set({ logs: [] })} />
      </div>
      <div className="log-list" ref={ref}>
        {logs.length === 0 ? <div className="muted pad">Queries, connections and errors will appear here.</div> : null}
        {logs.map((l) => {
          const c = name(l.connectionId);
          return (
            <div key={l.id} className={`log-row ${l.level}`}>
              <span className="log-time">{new Date(l.time).toLocaleTimeString()}</span>
              {c ? (
                <span className="log-conn" style={{ borderColor: c.color }}>
                  {c.name}
                </span>
              ) : null}
              <span className="log-msg">{l.message}</span>
              {l.durationMs !== undefined ? <span className="muted">{l.durationMs} ms</span> : null}
              {l.sql ? (
                <button type="button" className="log-sql" title="Open in SQL editor" onClick={() => useStore.getState().openSqlWith(l.sql!, l.connectionId)}>
                  {shortSql(l.sql, 160)}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
