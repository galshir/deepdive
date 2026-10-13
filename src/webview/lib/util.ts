import type { CellValue, ColumnInfo } from '../../shared/model';

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/** Joins key parts with a separator that cannot appear in MySQL identifiers typed by users. */
export const key = (...parts: (string | undefined)[]) => parts.filter((p) => p !== undefined).join('\u0001');

export function formatCount(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function cellText(v: CellValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** TSV with escaping of tabs/newlines, suitable for pasting into spreadsheets. */
export function toTsv(header: string[] | null, rows: CellValue[][]): string {
  const esc = (v: CellValue) => {
    const s = v === null ? '' : String(v);
    return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => r.map(esc).join('\t'));
  return (header ? [header.map((h) => esc(h)).join('\t'), ...lines] : lines).join('\n');
}

export function toJson(columns: string[], rows: CellValue[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))),
    null,
    2,
  );
}

const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const DATE = new Set(['date', 'datetime', 'timestamp', 'time']);
const TEXT = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json']);

export type ColumnCategory = 'number' | 'date' | 'text' | 'boolean' | 'other';

export function columnCategory(c: Pick<ColumnInfo, 'dataType' | 'columnType'> | undefined): ColumnCategory {
  if (!c) return 'other';
  if (c.columnType === 'tinyint(1)' || c.dataType === 'bool' || c.dataType === 'boolean' || c.dataType === 'bit') return 'boolean';
  if (NUMERIC.has(c.dataType)) return 'number';
  if (DATE.has(c.dataType)) return 'date';
  if (TEXT.has(c.dataType)) return 'text';
  return 'other';
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function shortSql(sql: string, max = 120): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
