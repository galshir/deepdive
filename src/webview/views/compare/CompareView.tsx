import { useState } from 'react';
import type { SchemaCompareOptions } from '../../../shared/model';
import { ConnectionDatabasePicker, EmptyState, ErrorBox, Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { rpc } from '../../lib/rpc';
import { useStore } from '../../store';
import { compareSchemas, compareServers } from './compareActions';
import { SchemaDiffPanel } from './SchemaDiffPanel';
import { ServerDiffPanel } from './ServerDiffPanel';

const OPTION_LABELS: Record<keyof SchemaCompareOptions, { label: string; hint: string }> = {
  ignoreColumnOrder: { label: 'Ignore column order', hint: 'A column in a different position is not a difference.' },
  ignoreComments: { label: 'Ignore comments', hint: 'Table and column comments are not compared.' },
  normalizeTypes: { label: 'Ignore MySQL version differences', hint: 'int(11) equals int, and default values spelled differently by MySQL 5.7, 8 and MariaDB are equal.' },
  ignoreCase: { label: 'Ignore letter case in names', hint: 'Users and users are the same table (servers with different lower_case_table_names).' },
};

export function CompareView() {
  const compare = useStore((s) => s.compare);
  const update = useStore((s) => s.updateCompare);
  const [showOptions, setShowOptions] = useState(false);
  const { level, source, target, options } = compare;
  const schemaReady = Boolean(source.connectionId && source.database && target.connectionId && target.database) && !(source.connectionId === target.connectionId && source.database === target.database);
  const serverReady = Boolean(source.connectionId && target.connectionId) && source.connectionId !== target.connectionId;
  const busy = level === 'schema' ? Boolean(compare.schema?.loading) : Boolean(compare.server?.running);
  const ready = level === 'schema' ? schemaReady : serverReady;
  const run = () => void (level === 'schema' ? compareSchemas() : compareServers());

  return (
    <div className="view compare-view">
      <div className="view-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Compare level">
          <button type="button" role="radio" aria-checked={level === 'schema'} className={level === 'schema' ? 'on' : ''} onClick={() => update({ level: 'schema' })}>
            Schemas
          </button>
          <button type="button" role="radio" aria-checked={level === 'server'} className={level === 'server' ? 'on' : ''} onClick={() => update({ level: 'server' })}>
            Servers
          </button>
        </div>
        <div className="cmp-side">
          <span className="cmp-side-label">Source</span>
          <ConnectionDatabasePicker label="Source" hideDatabase={level === 'server'} connectionId={source.connectionId} database={source.database} onChange={(c, d) => update({ source: { connectionId: c, database: d } })} />
        </div>
        <button type="button" className="icon-btn" aria-label="Swap source and target" title="Swap source and target" onClick={() => update({ source: target, target: source })}>
          <Icon name="swap" />
        </button>
        <div className="cmp-side">
          <span className="cmp-side-label">Target</span>
          <ConnectionDatabasePicker label="Target" hideDatabase={level === 'server'} connectionId={target.connectionId} database={target.database} onChange={(c, d) => update({ target: { connectionId: c, database: d } })} />
        </div>
        <span className="spacer" />
        <button type="button" className="btn small ghost" aria-expanded={showOptions} onClick={() => setShowOptions((v) => !v)}>
          <Icon name="filter" /> Options
        </button>
        {level === 'server' && compare.server?.running ? (
          <button type="button" className="btn small" onClick={() => void rpc({ type: 'cancelCompare', compareId: compare.server!.compareId })}>
            <Icon name="stop" /> Cancel
          </button>
        ) : (
          <button type="button" className="btn small primary" disabled={!ready || busy} onClick={run} title={ready ? undefined : level === 'schema' ? 'Choose two different databases' : 'Choose two different connections'}>
            {busy ? <Spinner /> : <Icon name="diff" />} Compare
          </button>
        )}
        {showOptions ? (
          <div className="popover compare-options" role="dialog" aria-label="Comparison options" onKeyDown={(e) => e.key === 'Escape' && setShowOptions(false)}>
            <div className="popover-list">
              {(Object.keys(OPTION_LABELS) as (keyof SchemaCompareOptions)[]).map((k) => (
                <label key={k} className="check cmp-option" title={OPTION_LABELS[k].hint}>
                  <input type="checkbox" checked={options[k]} onChange={(e) => update({ options: { ...options, [k]: e.target.checked } })} />
                  <span>
                    {OPTION_LABELS[k].label}
                    <span className="muted small"> — {OPTION_LABELS[k].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="compare-body">
        {level === 'schema' ? (
          compare.schema?.error ? (
            <ErrorBox message={compare.schema.error} onRetry={run} />
          ) : compare.schema?.diff ? (
            <SchemaDiffPanel key={compare.schema.diff.comparedAt} diff={compare.schema.diff} loading={compare.schema.loading} />
          ) : compare.schema?.loading ? (
            <div className="center-fill">
              <Spinner label="Loading both schemas…" />
            </div>
          ) : (
            <EmptyState icon="diff" title="Compare two schemas">
              <p>Choose a source and a target database, on the same server or on different ones (for example QA and Staging), then press Compare.</p>
              <p>You get every table, column, index and foreign key that is missing on either side or defined differently, and a script that brings the target in line with the source.</p>
            </EmptyState>
          )
        ) : compare.server ? (
          <ServerDiffPanel server={compare.server} />
        ) : (
          <EmptyState icon="diff" title="Compare two servers">
            <p>Choose two connections, for example QA and Staging. Databases are matched by name; each pair is compared table by table, and databases that exist on one side only are listed.</p>
          </EmptyState>
        )}
      </div>
    </div>
  );
}
