import { describe, expect, it } from 'vitest';
import { classifyStatement, isReadOnlyStatement } from '../../src/core/sql/classify';
import { splitStatements } from '../../src/core/sql/lexer';

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT `c;d` FROM t; -- x;y\nSELECT 3")).toEqual(["SELECT 'a;b'", 'SELECT `c;d` FROM t', '-- x;y\nSELECT 3']);
  });

  it('handles escaped quotes and block comments', () => {
    expect(splitStatements("SELECT 'it''s; fine', \"q\\\";\" /* ; */; SELECT 2")).toEqual(["SELECT 'it''s; fine', \"q\\\";\" /* ; */", 'SELECT 2']);
  });

  it('drops empty and comment-only statements', () => {
    expect(splitStatements(';; -- nothing\n; /* hi */')).toEqual([]);
  });
});

describe('classifyStatement', () => {
  it.each([
    'SELECT * FROM users',
    '  select 1',
    'SHOW TABLES',
    'DESCRIBE users',
    'EXPLAIN SELECT * FROM t',
    'EXPLAIN ANALYZE SELECT * FROM t',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "SELECT 'DELETE FROM users' AS s",
    'SELECT `update` FROM t',
    '-- DROP TABLE x\nSELECT 1',
    'USE shop',
  ])('treats %j as read-only', (sql) => {
    expect(isReadOnlyStatement(sql)).toBe(true);
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'update t set a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'TRUNCATE t',
    'ALTER TABLE t ADD c INT',
    'CREATE TABLE x (id int)',
    'GRANT ALL ON *.* TO x',
    'CALL do_things()',
    'SET @a = 1',
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    'SELECT * FROM t FOR UPDATE',
    'WITH x AS (SELECT 1) DELETE FROM t',
    'SELECT 1 /*! ; DROP TABLE users */',
    'LOCK TABLES t WRITE',
    'something weird',
    '',
  ])('treats %j as a write', (sql) => {
    expect(isReadOnlyStatement(sql)).toBe(false);
  });

  it('reports the first keyword and a reason', () => {
    const c = classifyStatement('DELETE FROM t');
    expect(c.keyword).toBe('DELETE');
    expect(c.reason).toMatch(/DELETE/);
  });
});
