import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ConnectionForm } from './components/ConnectionForm';
import { DetailsPanel } from './components/DetailsPanel';
import { Explorer } from './components/Explorer';
import { Icon, type IconName } from './components/Icon';
import { LogPanel } from './components/LogPanel';
import { Toasts } from './components/Toasts';
import { Toolbar } from './components/Toolbar';
import { Spinner } from './components/common';
import { errorMessage, onHostEvent, rpc } from './lib/rpc';
import { type FixedTab, type Tab, useStore } from './store';
import { GraphView } from './views/GraphView';
import { QueryBuilderView } from './views/QueryBuilderView';
import { SchemaView } from './views/SchemaView';
import { SearchView } from './views/SearchView';
import { SqlEditorView } from './views/SqlEditorView';
import { TableDataView } from './views/TableDataView';

const FIXED: Record<FixedTab, { label: string; icon: IconName }> = {
  graph: { label: 'Graph', icon: 'graph' },
  schema: { label: 'Schema', icon: 'schema' },
  builder: { label: 'Query builder', icon: 'builder' },
  sql: { label: 'SQL editor', icon: 'code' },
  search: { label: 'Search', icon: 'search' },
};

function useHostEvents() {
  useEffect(() => {
    const st = useStore.getState;
    const off = onHostEvent((e) => {
      switch (e.type) {
        case 'connectionsChanged':
          st().setConnections(e.connections);
          break;
        case 'log':
          st().addLog(e.entry);
          break;
        case 'settingsChanged':
          st().set({ settings: e.settings });
          break;
        case 'openSql':
          st().openSqlWith(e.sql, e.connectionId);
          break;
        case 'openConnectionForm':
          st().set({ connectionForm: { open: true } });
          break;
        case 'focusConnection':
          st().setActiveConnection(e.connectionId);
          st().select({ kind: 'connection', connectionId: e.connectionId });
          st().openTab('graph');
          break;
        case 'searchProgress': {
          const p = e.progress;
          st().updateSearch((s) => {
            if (s.data.searchId !== p.searchId) return {};
            return {
              data: {
                ...s.data,
                done: p.done,
                total: p.total,
                current: p.current,
                running: !p.finished,
                cancelled: p.cancelled,
                results: p.result ? [...s.data.results, p.result] : s.data.results,
              },
            };
          });
          break;
        }
        case 'savedQueriesChanged':
          st().set({ savedQueries: e.savedQueries });
          break;
        case 'historyChanged':
          st().set((s) => ({ historyVersion: s.historyVersion + 1 }));
          break;
        case 'multiRunProgress': {
          const p = e.progress;
          st().updateSql((s) => {
            const run = s.multiRun;
            if (!run || run.summary.runId !== p.runId || p.attempt < run.summary.attempt) return {};
            const db = p.target.database;
            return {
              multiRun: {
                ...run,
                summary: run.summary.attempt < p.attempt ? { ...run.summary, attempt: p.attempt, running: true } : run.summary,
                targets: { ...run.targets, [db]: p.target },
                results: p.results ? { ...run.results, [db]: { ...run.results[db], ...p.results } } : run.results,
              },
            };
          });
          break;
        }
        case 'multiRunFinished':
          st().updateSql((s) => (s.multiRun?.summary.runId === e.summary.runId && e.summary.attempt >= s.multiRun.summary.attempt ? { multiRun: { ...s.multiRun, summary: e.summary } } : {}));
          break;
        default:
          break;
      }
    });
    rpc({ type: 'init' })
      .then((r) => {
        st().set((s) => ({ settings: r.settings, ready: true, savedQueries: r.savedQueries, sql: { ...s.sql, concurrency: r.settings.multiRunConcurrency } }));
        st().setConnections(r.connections);
        const active = r.connections.find((c) => c.status === 'connected') ?? r.connections[0];
        if (active) st().setActiveConnection(active.config.id);
      })
      .catch((err: unknown) => {
        st().set({ ready: true });
        st().toast('error', `Failed to initialise: ${errorMessage(err)}`);
      });
    return off;
  }, []);
}

function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const connections = useStore((s) => s.connections);
  const st = useStore.getState();
  const label = (t: Tab) => (t.kind === 'data' ? t.table : FIXED[t.kind].label);
  return (
    <div className="tabs main-tabs" role="tablist" aria-label="Views">
      {tabs.map((t) => {
        const color = t.kind === 'data' ? connections.find((c) => c.config.id === t.connectionId)?.config.color : undefined;
        return (
          <div key={t.id} className={`tab ${active === t.id ? 'active' : ''} ${t.kind === 'data' ? 'closable' : ''}`} style={color ? { ['--tab-color' as string]: color } : undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={active === t.id}
              className="tab-btn"
              title={t.kind === 'data' ? `${t.database}.${t.table}` : undefined}
              onClick={() => st.openTab(t.id as FixedTab)}
              onAuxClick={(e) => e.button === 1 && st.closeTab(t.id)}
            >
              <Icon name={t.kind === 'data' ? 'table' : FIXED[t.kind].icon} size={13} />
              <span>{label(t)}</span>
            </button>
            {t.kind === 'data' ? (
              <button type="button" className="tab-close" aria-label={`Close ${t.table}`} onClick={() => st.closeTab(t.id)}>
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ActiveView() {
  const active = useStore((s) => s.activeTab);
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTab));
  if (!tab) return null;
  switch (tab.kind) {
    case 'graph':
      return <GraphView />;
    case 'schema':
      return <SchemaView />;
    case 'builder':
      return <QueryBuilderView />;
    case 'sql':
      return <SqlEditorView />;
    case 'search':
      return <SearchView />;
    case 'data':
      return <TableDataView key={active} tab={tab} />;
    default:
      return null;
  }
}

export function App() {
  useHostEvents();
  const ready = useStore((s) => s.ready);
  const formOpen = useStore((s) => s.connectionForm.open);
  const formKey = useStore((s) => s.connectionForm.editing?.id ?? 'new');
  if (!ready) {
    return (
      <div className="boot">
        <Spinner label="Starting DeepDive…" />
      </div>
    );
  }
  return (
    <div className="app">
      <Toolbar />
      <PanelGroup direction="horizontal" className="main" autoSaveId="deepdive-main">
        <Panel defaultSize={17} minSize={10} collapsible>
          <Explorer />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={62} minSize={30}>
          <PanelGroup direction="vertical" autoSaveId="deepdive-center">
            <Panel defaultSize={80} minSize={30}>
              <div className="center">
                <TabBar />
                <div className="view-host" role="tabpanel">
                  <ActiveView />
                </div>
              </div>
            </Panel>
            <PanelResizeHandle className="resize-handle horizontal" />
            <Panel defaultSize={20} minSize={5} collapsible>
              <LogPanel />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={21} minSize={12} collapsible>
          <DetailsPanel />
        </Panel>
      </PanelGroup>
      {formOpen ? <ConnectionForm key={formKey} /> : null}
      <Toasts />
    </div>
  );
}
