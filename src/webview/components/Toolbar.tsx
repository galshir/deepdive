import { useState } from 'react';
import { rpc } from '../lib/rpc';
import { useStore } from '../store';
import { ConnDot } from './common';
import { Icon, IconButton } from './Icon';

export function Toolbar() {
  const connections = useStore((s) => s.connections);
  const activeId = useStore((s) => s.activeConnectionId);
  const set = useStore((s) => s.set);
  const [term, setTerm] = useState('');
  const active = connections.find((c) => c.config.id === activeId);

  const runSearch = () => {
    const t = term.trim();
    if (!t) return;
    useStore.getState().searchMetadata(t);
  };

  return (
    <header className="toolbar" role="toolbar" aria-label="DeepDive toolbar">
      <div className="brand" title="DeepDive — visual MySQL explorer">
        <Icon name="sparkle" size={16} />
        <span>DeepDive</span>
      </div>
      <div className="toolbar-group">
        {active ? <ConnDot color={active.config.color} status={active.status} /> : null}
        <select
          className="conn-select"
          aria-label="Active connection"
          value={activeId ?? ''}
          onChange={(e) => {
            const id = e.target.value || undefined;
            useStore.getState().setActiveConnection(id);
            if (id) useStore.getState().select({ kind: 'connection', connectionId: id });
          }}
        >
          {connections.length === 0 ? <option value="">No connections</option> : null}
          {connections.map((c) => (
            <option key={c.config.id} value={c.config.id}>
              {c.config.name} {c.status === 'connected' ? '●' : c.status === 'error' ? '⚠' : '○'}
            </option>
          ))}
        </select>
        {active && active.status !== 'connected' ? (
          <button type="button" className="btn small primary" onClick={() => void useStore.getState().connect(active.config.id)} disabled={active.status === 'connecting'}>
            <Icon name="plug" /> {active.status === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        ) : null}
        {active?.config.readOnly ? (
          <span className="badge" title="Writes are refused on this connection">
            <Icon name="lock" size={11} /> read-only
          </span>
        ) : null}
        {active?.config.environment === 'production' ? <span className="badge danger">production</span> : null}
      </div>
      <form
        className="global-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search databases, tables, columns…"
          aria-label="Global metadata search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </form>
      <div className="toolbar-group right">
        <IconButton icon="refresh" label="Refresh metadata of the active connection" disabled={active?.status !== 'connected'} onClick={() => activeId && void useStore.getState().refreshConnection(activeId)} />
        <button type="button" className="btn small" onClick={() => set({ connectionForm: { open: true } })}>
          <Icon name="plus" /> New connection
        </button>
        {!connections.some((c) => c.config.kind === 'demo') ? (
          <button
            type="button"
            className="btn small ghost"
            title="Adds two offline demo servers so you can explore without credentials"
            onClick={() => void rpc({ type: 'addDemoConnections' }).catch((e: Error) => useStore.getState().toast('error', e.message))}
          >
            Try demo
          </button>
        ) : null}
      </div>
    </header>
  );
}
