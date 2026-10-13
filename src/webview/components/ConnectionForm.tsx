import { useEffect, useRef, useState } from 'react';
import type { ConnectionConfig, Environment, TlsMode } from '../../shared/model';
import type { ConnectionInput } from '../../shared/protocol';
import { errorMessage, rpc } from '../lib/rpc';
import { useStore } from '../store';
import { Icon } from './Icon';

const COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ef4444', '#14b8a6', '#eab308', '#ec4899'];

function initial(editing?: ConnectionConfig): ConnectionInput {
  if (editing) return { ...editing, database: editing.database ?? '' };
  return {
    name: '',
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    kind: 'mysql',
    environment: 'development',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    database: '',
    readOnly: true,
    tls: { mode: 'disabled' },
    connectTimeoutMs: 10000,
  };
}

export function ConnectionForm() {
  const form = useStore((s) => s.connectionForm);
  const editing = form.editing;
  const [value, setValue] = useState<ConnectionInput>(() => initial(editing));
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const close = () => useStore.getState().set({ connectionForm: { open: false } });
  const patch = (p: Partial<ConnectionInput>) => setValue((v) => ({ ...v, ...p }));
  const pw = clearPassword ? null : password ? password : editing ? undefined : null;

  const test = async () => {
    setBusy('test');
    setStatus(null);
    try {
      const r = await rpc({ type: 'testConnection', config: value, password: pw });
      setStatus({ ok: true, message: `Connected: ${r.serverVersion}` });
    } catch (err) {
      setStatus({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (connectAfter: boolean) => {
    setBusy('save');
    setStatus(null);
    try {
      const s = await rpc({ type: 'saveConnection', config: value, password: pw });
      useStore.getState().toast('success', `Saved "${s.config.name}"`);
      useStore.getState().setActiveConnection(s.config.id);
      useStore.getState().select({ kind: 'connection', connectionId: s.config.id });
      close();
      if (connectAfter) void useStore.getState().connect(s.config.id);
    } catch (err) {
      setStatus({ ok: false, message: errorMessage(err) });
      setBusy(null);
    }
  };

  const isDemo = value.kind === 'demo';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="conn-form-title" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2 id="conn-form-title">{editing ? `Edit "${editing.name}"` : 'New MySQL connection'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <div className="form-grid">
            <label>
              Name
              <input ref={firstField} required value={value.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Production replica" />
            </label>
            <div className="field">
              <span>Color</span>
              <div className="swatches" role="radiogroup" aria-label="Color">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={value.color === c}
                    aria-label={c}
                    className={`swatch ${value.color === c ? 'on' : ''}`}
                    style={{ background: c }}
                    onClick={() => patch({ color: c })}
                  />
                ))}
              </div>
            </div>
            <label>
              Environment
              <select value={value.environment} onChange={(e) => patch({ environment: e.target.value as Environment })}>
                <option value="development">development</option>
                <option value="staging">staging</option>
                <option value="production">production</option>
                <option value="other">other</option>
              </select>
            </label>
            {!isDemo ? (
              <>
                <label className="span2">
                  Host
                  <input required value={value.host} onChange={(e) => patch({ host: e.target.value })} placeholder="127.0.0.1" />
                </label>
                <label>
                  Port
                  <input type="number" min={1} max={65535} value={value.port} onChange={(e) => patch({ port: Number(e.target.value) || 3306 })} />
                </label>
                <label>
                  User
                  <input required value={value.user} autoComplete="off" onChange={(e) => patch({ user: e.target.value })} />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    disabled={clearPassword}
                    placeholder={editing ? '(unchanged)' : ''}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                {editing ? (
                  <label className="check">
                    <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> Remove stored password
                  </label>
                ) : (
                  <div className="hint">Stored in VS Code SecretStorage, never in settings.</div>
                )}
                <label>
                  Default database <span className="muted">(optional)</span>
                  <input value={value.database ?? ''} onChange={(e) => patch({ database: e.target.value })} />
                </label>
                <label>
                  Connect timeout (ms)
                  <input type="number" min={1000} max={120000} step={1000} value={value.connectTimeoutMs} onChange={(e) => patch({ connectTimeoutMs: Number(e.target.value) || 10000 })} />
                </label>
                <label>
                  TLS
                  <select value={value.tls.mode} onChange={(e) => patch({ tls: { ...value.tls, mode: e.target.value as TlsMode } })}>
                    <option value="disabled">Disabled</option>
                    <option value="required">Required (encrypt, don&apos;t verify certificate)</option>
                    <option value="verify">Verify server certificate</option>
                  </select>
                </label>
                {value.tls.mode !== 'disabled' ? (
                  <>
                    <label className="span2">
                      CA certificate path <span className="muted">(optional)</span>
                      <input value={value.tls.caPath ?? ''} onChange={(e) => patch({ tls: { ...value.tls, caPath: e.target.value } })} placeholder="/path/to/ca.pem" />
                    </label>
                    <label>
                      Client cert path
                      <input value={value.tls.certPath ?? ''} onChange={(e) => patch({ tls: { ...value.tls, certPath: e.target.value } })} />
                    </label>
                    <label>
                      Client key path
                      <input value={value.tls.keyPath ?? ''} onChange={(e) => patch({ tls: { ...value.tls, keyPath: e.target.value } })} />
                    </label>
                  </>
                ) : null}
              </>
            ) : (
              <div className="hint span2">Demo connection backed by an in-memory database. No credentials are used.</div>
            )}
            <label className="check span2">
              <input type="checkbox" checked={value.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} />
              Read-only (recommended) — refuse INSERT/UPDATE/DELETE/DDL and grid edits
            </label>
          </div>
          {status ? (
            <div className={`form-status ${status.ok ? 'ok' : 'err'}`} role="status">
              <Icon name={status.ok ? 'check' : 'warn'} /> {status.message}
            </div>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => void test()} disabled={busy !== null}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void save(false)} disabled={busy !== null}>
              Save
            </button>
            <button type="submit" className="btn primary" disabled={busy !== null}>
              Save &amp; connect
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
