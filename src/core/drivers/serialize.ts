import type { CellValue } from '../../shared/model';

const MAX_BINARY_PREVIEW = 64;
const MAX_TEXT = 1_000_000;

/** Converts driver values into JSON-safe cell values for the webview. */
export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}… (truncated)` : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    default:
      break;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) {
    if (value.length <= MAX_BINARY_PREVIEW) {
      return `0x${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }
    return `(binary ${value.length} bytes)`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
