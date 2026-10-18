import { useEffect, useState } from 'react';
import type { SchemaDiff, SyncScript } from '../../../shared/model';
import { ErrorBox, Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { SqlEditor } from '../../components/SqlEditor';
import { errorMessage, rpc, RpcError } from '../../lib/rpc';
import { uid } from '../../lib/util';
import { useStore } from '../../store';
import type { SideNames } from './compareUtil';
import { compareSchemas } from './compareActions';

/** The SQL editor runs at most this many statements per request. */
const CHUNK = 100;

export function SyncPanel({ diff, names, tables }: { diff: SchemaDiff; names: SideNames; tables: string[] }) {
  const connections = useStore((s) => s.connections);
  const sourceConn = connections.find((c) => c.config.id === diff.source.connectionId);
  const targetConn = connections.find((c) => c.config.id === diff.target.connectionId);
  const [includeDrops, setIncludeDrops] = useState(false);
  const [script, setScript] = useState<SyncScript>();
  const [busy, setBusy] = useState<'generate' | 'run' | null>(null);
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<{ sql: string; error: string; applied: number }>();
  const selectionKey = tables.join('\u0001');

  // A script describes one selection; changing the selection or drop policy makes it stale.
  useEffect(() => {
    setScript(undefined);
    setFailure(undefined);
  }, [selectionKey, includeDrops]);

  const demo = sourceConn?.config.kind === 'demo' || targetConn?.config.kind === 'demo';
  if (demo) {
    return <div className="notice wide">Sync scripts are generated between MySQL connections. Demo connections can be compared, but not synced.</div>;
  }

  const generate = async () => {
    setBusy('generate');
    setError(undefined);
    setFailure(undefined);
    try {
      setScript(await rpc({ type: 'generateSyncScript', source: diff.source, target: diff.target, options: diff.options, tables, includeDrops }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!script) return;
    setBusy('run');
    setError(undefined);
    setFailure(undefined);
    let applied = 0;
    try {
      for (let i = 0; i < script.statements.length; i += CHUNK) {
        const chunk = script.statements.slice(i, i + CHUNK);
        const res = await rpc({ type: 'runSql', connectionId: diff.target.connectionId, queryId: uid('sync'), sql: chunk.join(';\n'), database: diff.target.database });
        const failed = res.statements.find((st) => st.error);
        applied += res.statements.filter((st) => !st.error).length;
        if (failed || res.cancelled) {
          setFailure({ sql: failed?.sql ?? '', error: failed?.error ?? 'Cancelled', applied });
          break;
        }
      }
      if (applied === script.statements.length) useStore.getState().toast('success', `Applied ${applied} statement(s) to ${names.target}`);
      await compareSchemas(diff.source, diff.target);
    } catch (err) {
      if (err instanceof RpcError && err.code === 'DECLINED') useStore.getState().toast('info', err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const readOnly = Boolean(targetConn?.config.readOnly);
  return (
    <div className="cmp-sync">
      <div className="cmp-sync-head">
        <span>
          Make <strong>{names.target}</strong> match <strong>{names.source}</strong> for {tables.length} table(s).
        </span>
        <label className="check small" title="Also remove tables, columns, indexes and foreign keys that exist only in the target. Dropping loses data.">
          <input type="checkbox" checked={includeDrops} onChange={(e) => setIncludeDrops(e.target.checked)} />
          include drops
        </label>
        <span className="spacer" />
        <button type="button" className="btn small" disabled={busy !== null || tables.length === 0} onClick={() => void generate()}>
          {busy === 'generate' ? <Spinner /> : <Icon name="code" />} {script ? 'Regenerate' : 'Generate script'}
        </button>
      </div>
      {includeDrops ? <div className="notice wide warn-notice">“Include drops” removes objects that exist only in {names.target}. Dropped tables and columns lose their data.</div> : null}
      {error ? <ErrorBox message={error} /> : null}
      {script ? (
        <>
          {script.warnings.length ? (
            <div className="notice wide warn-notice cmp-warnings">
              <Icon name="warn" />
              <ul>
                {script.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="cmp-script">
            <SqlEditor value={script.script} onChange={() => undefined} readOnly ariaLabel="Sync script" />
          </div>
          <div className="cmp-sync-actions">
            <span className="muted small">{script.statements.length} statement(s)</span>
            <span className="spacer" />
            <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'copyText', text: script.script })}>
              <Icon name="copy" /> Copy
            </button>
            <button type="button" className="btn small ghost" onClick={() => useStore.getState().openSqlWith(script.script, diff.target.connectionId, diff.target.database)} title="Edit the script in the SQL editor before running it">
              <Icon name="external" /> Open in SQL editor
            </button>
            <button
              type="button"
              className="btn small primary"
              disabled={busy !== null || script.statements.length === 0 || readOnly}
              onClick={() => void run()}
              title={readOnly ? `${names.target} is read-only` : `Runs on ${targetConn?.config.name} / ${diff.target.database} after a confirmation`}
            >
              {busy === 'run' ? <Spinner /> : <Icon name="play" />} Run on {names.target}
            </button>
          </div>
          {failure ? (
            <ErrorBox message={`Stopped after ${failure.applied} statement(s). ${failure.error}${failure.sql ? `\n\n${failure.sql}` : ''}\n\nStatements before it were committed; the comparison was refreshed to show the current state.`} />
          ) : null}
        </>
      ) : busy !== 'generate' ? (
        <div className="muted small pad">
          Generates CREATE / ALTER statements for the tables ticked in the list. Nothing runs until you press Run and confirm; you can also open the script in the SQL editor and change it first.
        </div>
      ) : null}
    </div>
  );
}
