import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPARE_OPTIONS, diffSchemas, normalizeColumnType, normalizeDefault, summarizeDiff } from '../../src/core/services/schemaDiff';
import { buildSyncScript, columnDefinition } from '../../src/core/sql/schemaSync';
import type { DatabaseSchema, ForeignKeyInfo, IndexInfo, SchemaCompareOptions, SchemaDiff, TableDetails } from '../../src/shared/model';
import { col, table } from '../helpers/fixtures';

function schema(database: string, tables: TableDetails[], extra: { indexes?: IndexInfo[]; foreignKeys?: Omit<ForeignKeyInfo, 'database'>[] } = {}): DatabaseSchema {
  return {
    database,
    tables: tables.map((t) => ({ ...t.table, database, engine: 'InnoDB' })),
    columns: tables.flatMap((t) => t.columns),
    indexes: [...tables.flatMap((t) => t.indexes), ...(extra.indexes ?? [])],
    foreignKeys: (extra.foreignKeys ?? []).map((f) => ({ ...f, database })),
  };
}

const fk = (name: string, tableName: string, column: string, ref: string, extra: Partial<ForeignKeyInfo> = {}): Omit<ForeignKeyInfo, 'database'> => ({
  name,
  table: tableName,
  columns: [column],
  referencedDatabase: '',
  referencedTable: ref,
  referencedColumns: ['id'],
  onUpdate: 'RESTRICT',
  onDelete: 'CASCADE',
  cardinality: 'many-to-one',
  ...extra,
});

const users = (db: string, cols = [col('users', 'id', 'int', { columnType: 'int', nullable: false }), col('users', 'email', 'varchar', { columnType: 'varchar(100)', nullable: false })]) =>
  table(db, 'users', cols);

const diffOf = (a: DatabaseSchema, b: DatabaseSchema, opts: Partial<SchemaCompareOptions> = {}): SchemaDiff => {
  const options = { ...DEFAULT_COMPARE_OPTIONS, ...opts };
  const tables = diffSchemas(a, b, options);
  return { source: { connectionId: 'qa', database: a.database }, target: { connectionId: 'stg', database: b.database }, options, tables, summary: summarizeDiff(tables), comparedAt: 0 };
};

describe('schema diff', () => {
  it('reports identical schemas in different databases as the same', () => {
    const d = diffOf(schema('qa', [users('qa')]), schema('stg', [users('stg')]));
    expect(d.summary.tables).toEqual({ same: 1, only_source: 0, only_target: 0, changed: 0 });
  });

  it('finds tables, columns and changed column definitions on each side', () => {
    const qa = schema('qa', [
      users('qa', [col('users', 'id', 'int', { columnType: 'int', nullable: false }), col('users', 'email', 'varchar', { columnType: 'varchar(255)', nullable: false }), col('users', 'is_active', 'tinyint', { columnType: 'tinyint(1)', defaultValue: '1' })]),
      table('qa', 'audit', [col('audit', 'id', 'int')]),
    ]);
    const stg = schema('stg', [users('stg', [col('users', 'id', 'int', { columnType: 'int', nullable: false }), col('users', 'email', 'varchar', { columnType: 'varchar(100)', nullable: true }), col('users', 'legacy', 'int')]), table('stg', 'old_stuff', [col('old_stuff', 'id', 'int')])]);
    const d = diffOf(qa, stg);
    expect(d.tables.map((t) => [t.name, t.status])).toEqual([
      ['audit', 'only_source'],
      ['old_stuff', 'only_target'],
      ['users', 'changed'],
    ]);
    const u = d.tables.find((t) => t.name === 'users')!;
    expect(u.columns.map((c) => [c.name, c.status])).toEqual([
      ['id', 'same'],
      ['email', 'changed'],
      ['is_active', 'only_source'],
      ['legacy', 'only_target'],
    ]);
    expect(u.columns[1]!.changes).toEqual([
      { field: 'type', source: 'varchar(255)', target: 'varchar(100)' },
      { field: 'nullable', source: 'NOT NULL', target: 'NULL' },
    ]);
    expect(d.summary.objects).toEqual({ only_source: 1, only_target: 1, changed: 1 });
  });

  it('ignores column order and comments by default, and can report them', () => {
    const a = schema('qa', [users('qa', [col('users', 'id', 'int', { comment: 'pk' }), col('users', 'email', 'varchar')])]);
    const b = schema('stg', [users('stg', [col('users', 'email', 'varchar'), col('users', 'id', 'int')])]);
    expect(diffOf(a, b).summary.tables.same).toBe(1);
    const strict = diffOf(a, b, { ignoreColumnOrder: false, ignoreComments: false }).tables[0]!;
    expect(strict.columns.find((c) => c.name === 'id')!.changes).toEqual([
      { field: 'comment', source: 'pk', target: null },
      { field: 'position', source: 'FIRST', target: 'AFTER email' },
    ]);
  });

  it('normalizes MySQL version differences only when asked', () => {
    expect(normalizeColumnType('INT(11) unsigned', true)).toBe('int unsigned');
    expect(normalizeColumnType('tinyint(1)', true)).toBe('tinyint(1)');
    expect(normalizeColumnType('int(11)', false)).toBe('int(11)');
    expect(normalizeDefault("'abc'", true)).toBe('abc');
    expect(normalizeDefault('current_timestamp()', true)).toBe('CURRENT_TIMESTAMP');
    const a = schema('qa', [users('qa', [col('users', 'id', 'int', { columnType: 'int(11)' })])]);
    const b = schema('stg', [users('stg', [col('users', 'id', 'int', { columnType: 'int' })])]);
    expect(diffOf(a, b).summary.tables.changed).toBe(1);
    expect(diffOf(a, b, { normalizeTypes: true }).summary.tables.same).toBe(1);
  });

  it('matches names case-sensitively unless told otherwise', () => {
    const a = schema('qa', [users('qa')]);
    const b = schema('stg', [table('stg', 'Users', users('stg').columns.map((c) => ({ ...c, table: 'Users' })))]);
    expect(diffOf(a, b).summary.tables).toMatchObject({ only_source: 1, only_target: 1 });
    const ci = diffOf(a, b, { ignoreCase: true });
    expect(ci.summary.tables.same).toBe(1);
    expect(ci.tables[0]!.targetName).toBe('Users');
  });

  it('pairs indexes and foreign keys that differ only by name', () => {
    const idx = (name: string, columns: string[], unique = false): IndexInfo => ({ table: 'orders', name, unique, primary: false, columns, type: 'BTREE' });
    const orders = (db: string) => table(db, 'orders', [col('orders', 'id', 'int'), col('orders', 'user_id', 'int'), col('orders', 'code', 'varchar')]);
    const a = schema('qa', [users('qa'), orders('qa')], { indexes: [idx('ix_user', ['user_id']), idx('ux_code', ['code'], true)], foreignKeys: [fk('fk_orders_user', 'orders', 'user_id', 'users')] });
    const b = schema('stg', [users('stg'), orders('stg')], { indexes: [idx('orders_user_id_idx', ['user_id']), idx('ux_code', ['code'])], foreignKeys: [fk('orders_ibfk_1', 'orders', 'user_id', 'users')] });
    const o = diffOf(a, b).tables.find((t) => t.name === 'orders')!;
    expect(o.indexes.find((i) => i.name === 'ix_user')).toMatchObject({ status: 'changed', targetName: 'orders_user_id_idx', changes: [{ field: 'name', source: 'ix_user', target: 'orders_user_id_idx' }] });
    expect(o.indexes.find((i) => i.name === 'ux_code')!.changes).toEqual([{ field: 'kind', source: 'UNIQUE', target: 'INDEX' }]);
    expect(o.foreignKeys[0]).toMatchObject({ status: 'changed', targetName: 'orders_ibfk_1' });
  });
});

describe('sync script', () => {
  it('renders column definitions for MySQL', () => {
    expect(columnDefinition(col('t', 'status', 'varchar', { columnType: 'varchar(16)', nullable: false, defaultValue: "it's" }))).toBe("`status` varchar(16) NOT NULL DEFAULT 'it''s'");
    expect(columnDefinition(col('t', 'n', 'int', { columnType: 'int unsigned', defaultValue: '0', comment: 'count' }))).toBe("`n` int unsigned NULL DEFAULT 0 COMMENT 'count'");
    expect(columnDefinition(col('t', 'ts', 'timestamp', { columnType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' }))).toBe(
      '`ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    );
    expect(columnDefinition(col('t', 'u', 'varchar', { columnType: 'varchar(36)', defaultValue: 'uuid()', extra: 'DEFAULT_GENERATED' }))).toBe('`u` varchar(36) NULL DEFAULT (uuid())');
    expect(columnDefinition(col('t', 'id', 'int', { columnType: 'int', nullable: false, isAutoIncrement: true, extra: 'auto_increment' }))).toBe('`id` int NOT NULL AUTO_INCREMENT');
    expect(columnDefinition(col('t', 'g', 'int', { extra: 'VIRTUAL GENERATED' }))).toBeUndefined();
  });

  it('creates missing tables first, alters changed ones and adds foreign keys last', () => {
    const qa = schema(
      'qa',
      [
        users('qa', [col('users', 'id', 'int', { columnType: 'int', nullable: false }), col('users', 'email', 'varchar', { columnType: 'varchar(255)', nullable: false }), col('users', 'is_active', 'tinyint', { columnType: 'tinyint(1)', nullable: false, defaultValue: '1' })]),
        table('qa', 'teams', [col('teams', 'id', 'int')]),
        table('qa', 'members', [col('members', 'id', 'int'), col('members', 'team_id', 'int')]),
      ],
      { indexes: [{ table: 'users', name: 'ux_email', unique: true, primary: false, columns: ['email'], type: 'BTREE' }], foreignKeys: [fk('fk_members_team', 'members', 'team_id', 'teams'), fk('fk_users_team', 'users', 'id', 'teams')] },
    );
    const stg = schema('stg', [users('stg', [col('users', 'id', 'int', { columnType: 'int', nullable: false }), col('users', 'email', 'varchar', { columnType: 'varchar(100)', nullable: false }), col('users', 'legacy', 'int')]), table('stg', 'junk', [col('junk', 'id', 'int')])]);
    const diff = diffOf(qa, stg);
    const create = new Map([
      ['teams', 'CREATE TABLE `teams` (\n  `id` int\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4'],
      ['members', 'CREATE TABLE `members` (\n  `id` int,\n  `team_id` int,\n  CONSTRAINT `fk_members_team` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`)\n) ENGINE=InnoDB'],
    ]);
    const out = buildSyncScript({ diff, source: qa, target: stg, createStatements: create, includeDrops: false });
    expect(out.statements).toEqual([
      'CREATE TABLE `teams` (\n  `id` int\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
      'CREATE TABLE `members` (\n  `id` int,\n  `team_id` int,\n  CONSTRAINT `fk_members_team` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`)\n) ENGINE=InnoDB',
      'ALTER TABLE `users`\n  MODIFY COLUMN `email` varchar(255) NOT NULL,\n  ADD COLUMN `is_active` tinyint(1) NOT NULL DEFAULT 1 AFTER `email`,\n  ADD UNIQUE INDEX `ux_email` (`email`)',
      'ALTER TABLE `users` ADD CONSTRAINT `fk_users_team` FOREIGN KEY (`id`) REFERENCES `teams` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
    ]);
    expect(out.script).toContain('-- Skipped: table junk exists only in the target');
    expect(out.script).toContain('-- Skipped: users: column legacy exists only in the target');

    const withDrops = buildSyncScript({ diff, source: qa, target: stg, createStatements: create, includeDrops: true, tables: ['users', 'junk'] });
    expect(withDrops.statements).toEqual([
      'DROP TABLE `junk`',
      'ALTER TABLE `users`\n  DROP COLUMN `legacy`,\n  MODIFY COLUMN `email` varchar(255) NOT NULL,\n  ADD COLUMN `is_active` tinyint(1) NOT NULL DEFAULT 1 AFTER `email`,\n  ADD UNIQUE INDEX `ux_email` (`email`)',
      'ALTER TABLE `users` ADD CONSTRAINT `fk_users_team` FOREIGN KEY (`id`) REFERENCES `teams` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
    ]);
  });

  it('redefines changed indexes and foreign keys, renames indexes, and warns about what it cannot do', () => {
    const idx = (name: string, columns: string[], unique = false): IndexInfo => ({ table: 'users', name, unique, primary: false, columns, type: 'BTREE' });
    const qa = schema('qa', [users('qa'), table('qa', 'v_active', [col('v_active', 'id', 'int')], [], 'view')], {
      indexes: [idx('ix_email', ['email'], true), idx('ix_new_name', ['id', 'email'])],
      foreignKeys: [fk('fk_self', 'users', 'id', 'users', { onDelete: 'SET NULL' })],
    });
    const stg = schema('stg', [users('stg')], { indexes: [idx('ix_email', ['email']), idx('ix_old_name', ['id', 'email'])], foreignKeys: [fk('fk_self', 'users', 'id', 'users')] });
    const out = buildSyncScript({ diff: diffOf(qa, stg), source: qa, target: stg, createStatements: new Map(), includeDrops: false });
    expect(out.statements).toEqual([
      'ALTER TABLE `users` DROP FOREIGN KEY `fk_self`',
      'ALTER TABLE `users`\n  DROP INDEX `ix_email`,\n  ADD UNIQUE INDEX `ix_email` (`email`),\n  RENAME INDEX `ix_old_name` TO `ix_new_name`',
      'ALTER TABLE `users` ADD CONSTRAINT `fk_self` FOREIGN KEY (`id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT',
    ]);
    expect(out.warnings).toEqual(['View v_active exists only in the source. View definitions are not compared; create it manually.']);
  });

  it('says when there is nothing to run', () => {
    const a = schema('qa', [users('qa')]);
    const out = buildSyncScript({ diff: diffOf(a, schema('stg', [users('stg')])), source: a, target: a, createStatements: new Map(), includeDrops: false });
    expect(out.statements).toEqual([]);
    expect(out.script).toContain('Nothing to run');
  });
});
