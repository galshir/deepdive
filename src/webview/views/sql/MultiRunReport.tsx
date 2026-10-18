import { useMemo, useState } from 'react';
import type { MultiRunStatus, MultiRunTarget } from '../../../shared/model';
import { Spinner } from '../../components/common';
import { DataGrid } from '../../components/DataGrid';
import { Icon } from '../../components/Icon';
import { rpc } from '../../lib/rpc';
import type { MultiRunView } from '../../store';
import { affectedRows, combinedResult, formatDuration, liveCounts, reportMarkdown, sortedTargets, STATUS_META, statementLabel } from './multiRunUtil';

type Filter = 'all' | Exclude<MultiRunStatus, 'pending' | 'running'>;
const MAX_GROUP_CHIPS = 12;

const normalizeScript = (sql: string) => sql.replace(/\s+/g, ' ').replace(/\s*;\s*/g, ';').replace(/;+$/, '').trim();

export interface ReportActions {
  retry: (mode: 'failed' | 'partial' | 'database', database?: string) => void;
  /** Starts a new run of the editor's current script on these databases. */
  runEdited: (databases: string[]) => void;
  openInEditor: (database: string) => void;
}

function StatusBadge({ status }: { status: MultiRunStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`mr-status st-${status}`}>
      {status === 'running' ? <Spinner /> : <Icon name={m.icon} size={12} />} {m.label}
    </span>
  );
}

function TargetDetail({ view, target, actions, busy }: { view: MultiRunView; target: MultiRunTarget; actions: ReportActions; busy: boolean }) {
  const statements = view.summary.statements;
  const results = view.results[target.database] ?? {};
  const firstWithRows = Object.keys(results).map(Number).sort((a, b) => a - b)[0];
  const [shown, setShown] = useState<number | undefined>(firstWithRows);
  const result = shown !== undefined ? results[shown] : undefined;
  const from = target.statements.findIndex((s) => s.status !== 'ok');
  const canRetry = !busy && !view.summary.running && target.status !== 'succeeded' && target.status !== 'running' && target.status !== 'pending';
  return (
    <div className="mr-detail">
      <div className="mr-detail-head">
        <Icon name="database" />
        <strong>{target.database}</strong>
        <StatusBadge status={target.status} />
        {target.attempts.length > 1 ? (
          <span className="muted small">
            {target.attempts.map((a) => `attempt ${a.attempt}: ${STATUS_META[a.status].label.toLowerCase()}${a.failedStatementIndex !== undefined && a.status !== 'succeeded' ? ` at #${a.failedStatementIndex + 1}` : ''}`).join(' · ')}
          </span>
        ) : null}
        <span className="spacer" />
        {canRetry ? (
          <button type="button" className="btn small" onClick={() => actions.retry('database', target.database)} title={from > 0 ? `Statements #1–#${from} are already applied and are not run again` : undefined}>
            <Icon name="refresh" /> {from > 0 ? `Retry from #${from + 1}` : 'Retry'}
          </button>
        ) : null}
        <button type="button" className="btn small ghost" onClick={() => actions.openInEditor(target.database)} title="Switch the editor to this database to fix it by hand">
          <Icon name="code" /> Open in editor
        </button>
      </div>
      {target.status === 'partial' ? (
        <div className="notice warn-notice">
          <Icon name="warn" /> Statements before #{(target.failedStatementIndex ?? 0) + 1} were committed on this database. Make sure the failure did not leave partial changes before retrying.
        </div>
      ) : null}
      <ol className="mr-statements">
        {target.statements.map((st, i) => (
          <li key={i} className={`mr-statement st-${st.status === 'ok' ? 'succeeded' : st.status === 'error' ? 'failed' : 'not_run'}`}>
            <Icon name={st.status === 'ok' ? 'check' : st.status === 'error' ? 'x' : 'stop'} size={12} />
            <button type="button" className={`link mono ${results[i] ? '' : 'muted'}`} disabled={!results[i]} onClick={() => setShown(i)} title={statements[i]}>
              {statementLabel(statements, i, 90)}
            </button>
            <span className="muted small">
              {st.status === 'ok'
                ? `${st.rowCount !== undefined ? `${st.rowCount} row(s)` : `${st.affectedRows ?? 0} affected`} · ${st.durationMs ?? 0} ms${st.attempt && view.summary.attempt > 1 ? ` · attempt ${st.attempt}` : ''}`
                : st.status === 'not_run'
                  ? st.error ?? 'not run'
                  : ''}
            </span>
            {st.status === 'error' ? (
              <div className="mr-error">
                {st.errorCode ? <span className="badge danger">{st.errorCode}</span> : null} {st.error}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {result ? (
        <div className="mr-grid">
          <DataGrid columns={result.columns.map((c) => ({ name: c.name, type: c.type }))} rows={result.rows} ariaLabel={`Results of statement ${(shown ?? 0) + 1} on ${target.database}`} emptyMessage="No rows." />
        </div>
      ) : null}
    </div>
  );
}

export function MultiRunReport({ view, connectionName, production, editorText, actions, busy }: { view: MultiRunView; connectionName: string; production: boolean; editorText: string; actions: ReportActions; busy: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<'summary' | 'combined'>('summary');
  const s = view.summary;
  const counts = liveCounts(view);
  const total = view.order.length;
  const finished = !s.running;
  const targets = useMemo(() => sortedTargets(view), [view]);
  const rows = filter === 'all' ? targets : targets.filter((t) => t.status === filter);
  const combined = useMemo(() => (finished ? combinedResult(view) : undefined), [finished, view]);
  const selectedTarget = selected ? view.targets[selected] : undefined;
  const unchanged = targets.filter((t) => t.status === 'failed' || t.status === 'not_run').map((t) => t.database);
  const partial = targets.filter((t) => t.status === 'partial').map((t) => t.database);
  const scriptChanged = editorText.trim() !== '' && normalizeScript(editorText) !== normalizeScript(s.statements.join(';'));
  const elapsed = (s.finishedAt ?? Date.now()) - s.startedAt;

  const chip = (f: Filter, label: string, n: number) => (
    <button type="button" className={`chip ${filter === f ? 'on' : ''} ${f !== 'all' ? `st-${f}` : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)} disabled={f !== 'all' && n === 0}>
      {f !== 'all' ? <Icon name={STATUS_META[f].icon} size={11} /> : null} {label} <span className="pill">{n}</span>
    </button>
  );

  return (
    <div className="mr-report">
      <div className="mr-head">
        {finished ? <Icon name={counts.failed || counts.partial ? 'warn' : s.cancelled ? 'stop' : 'check'} className={counts.failed || counts.partial ? 'st-failed' : 'st-succeeded'} /> : <Spinner />}
        <strong>
          {finished ? `${s.cancelled ? 'Cancelled' : 'Finished'} on "${connectionName}"` : `Running on "${connectionName}" — ${counts.done} of ${total}`}
        </strong>
        {production ? <span className="badge danger">PRODUCTION</span> : null}
        <span className="muted small">
          {total} database(s) · {s.statements.length} statement(s) · {formatDuration(elapsed)}
          {s.attempt > 1 ? ` · attempt ${s.attempt}` : ''}
        </span>
        {!finished ? <progress value={counts.done} max={total} /> : null}
        <span className="spacer" />
        {finished && unchanged.length ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => actions.retry('failed')} title="Run the whole script again on databases that failed without changes or were not run">
            <Icon name="refresh" /> Retry failed ({unchanged.length})
          </button>
        ) : null}
        {finished && partial.length ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => actions.retry('partial')} title="Continue each partially applied database from its failed statement">
            <Icon name="refresh" /> Retry partial ({partial.length})
          </button>
        ) : null}
        {finished && scriptChanged && (unchanged.length || partial.length) ? (
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => actions.runEdited([...partial, ...unchanged])}
            title="Start a new run of the script now in the editor on the failed and partial databases. On partial databases, statements that were already applied run again."
          >
            <Icon name="play" /> Run edited script on {unchanged.length + partial.length}
          </button>
        ) : null}
        <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'copyText', text: reportMarkdown(view, connectionName) })} title="Copy the report as Markdown">
          <Icon name="copy" /> Copy report
        </button>
      </div>

      <div className="mr-chips">
        {chip('all', 'All', total)}
        {chip('succeeded', 'Succeeded', counts.succeeded)}
        {chip('failed', 'Failed', counts.failed)}
        {chip('partial', 'Partial', counts.partial)}
        {chip('not_run', 'Not run', counts.not_run)}
        {combined ? (
          <div className="segmented mr-tabs" role="tablist" aria-label="Report view">
            <button type="button" role="tab" aria-selected={tab === 'summary'} className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>
              Per database
            </button>
            <button type="button" role="tab" aria-selected={tab === 'combined'} className={tab === 'combined' ? 'on' : ''} onClick={() => setTab('combined')}>
              Combined results (#{combined.statementIndex + 1})
            </button>
          </div>
        ) : null}
      </div>

      {tab === 'combined' && combined ? (
        <div className="mr-combined">
          <div className="result-meta muted small">
            {combined.rows.length.toLocaleString()} row(s) from {total} databases{combined.truncated ? ' — some results were truncated (setting deepdive.maxResultRows)' : ''}
          </div>
          <DataGrid columns={combined.columns.map((c) => ({ name: c.name, type: c.type }))} rows={combined.rows} ariaLabel="Combined results" emptyMessage="No rows." />
        </div>
      ) : (
        <div className="mr-body">
          {finished && partial.length ? (
            <div className="notice warn-notice">
              <Icon name="warn" /> {partial.length} database(s) are partially applied: statements before the failure were committed. “Retry partial” continues each one from its failed statement.
            </div>
          ) : null}
          {finished && s.errorGroups.length ? (
            <section className="mr-groups" aria-label="Errors">
              {s.errorGroups.map((g) => (
                <div key={`${g.code}:${g.message}`} className="mr-group">
                  <div className="mr-group-head">
                    <span className="badge danger">{g.code}</span>
                    <span className="mr-group-msg">{g.message}</span>
                    <span className="muted small">
                      {g.databases.length} database{g.databases.length === 1 ? '' : 's'}
                    </span>
                    <button type="button" className="link small" onClick={() => void rpc({ type: 'copyText', text: g.databases.join('\n') })}>
                      copy list
                    </button>
                  </div>
                  <div className="mr-group-dbs">
                    {g.databases.slice(0, MAX_GROUP_CHIPS).map((d) => (
                      <button key={d} type="button" className={`chip ${selected === d ? 'on' : ''}`} onClick={() => setSelected(d)}>
                        {d}
                      </button>
                    ))}
                    {g.databases.length > MAX_GROUP_CHIPS ? <span className="muted small">+{g.databases.length - MAX_GROUP_CHIPS} more</span> : null}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          <div className="mr-table-wrap">
            <table className="mr-table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Status</th>
                  <th>Failed statement</th>
                  <th>Error</th>
                  <th className="num">Affected</th>
                  <th className="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const failed = t.failedStatementIndex;
                  const st = failed !== undefined ? t.statements[failed] : undefined;
                  return (
                    <tr key={t.database} className={selected === t.database ? 'selected' : ''} onClick={() => setSelected(selected === t.database ? undefined : t.database)}>
                      <td>
                        <button type="button" className="link" aria-expanded={selected === t.database}>
                          {t.database}
                        </button>
                      </td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="mono small" title={failed !== undefined ? s.statements[failed] : undefined}>
                        {failed !== undefined && t.status !== 'succeeded' ? statementLabel(s.statements, failed, 40) : ''}
                      </td>
                      <td className="mr-error-cell" title={st?.error}>
                        {st?.error ?? ''}
                      </td>
                      <td className="num">{affectedRows(t) ?? ''}</td>
                      <td className="num muted">{t.status === 'pending' || t.status === 'running' ? '' : formatDuration(t.durationMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {selectedTarget ? <TargetDetail key={`${selectedTarget.database}:${s.attempt}`} view={view} target={selectedTarget} actions={actions} busy={busy} /> : null}
        </div>
      )}
    </div>
  );
}
