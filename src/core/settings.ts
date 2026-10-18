import type { UiSettings } from '../shared/model';

export interface Settings extends UiSettings {
  maxActiveConnections: number;
  historyMaxEntries: number;
}

export const DEFAULT_SETTINGS: Settings = {
  pageSize: 100,
  maxResultRows: 1000,
  queryTimeoutMs: 30_000,
  maxTablesPerDatabase: 150,
  maxTablesPerDataSearch: 50,
  poolSize: 4,
  maxActiveConnections: 8,
  historyEnabled: true,
  historyMaxEntries: 500,
  multiRunMaxDatabases: 500,
  multiRunConcurrency: 1,
};

export function toUiSettings(s: Settings): UiSettings {
  return {
    pageSize: s.pageSize,
    maxResultRows: s.maxResultRows,
    queryTimeoutMs: s.queryTimeoutMs,
    maxTablesPerDatabase: s.maxTablesPerDatabase,
    maxTablesPerDataSearch: s.maxTablesPerDataSearch,
    poolSize: s.poolSize,
    historyEnabled: s.historyEnabled,
    multiRunMaxDatabases: s.multiRunMaxDatabases,
    multiRunConcurrency: s.multiRunConcurrency,
  };
}
