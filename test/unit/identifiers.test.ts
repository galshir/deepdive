import { describe, expect, it } from 'vitest';
import { assertIdentifier, escapeLike, qualifiedTable, quoteIdent } from '../../src/core/sql/identifiers';

describe('identifiers', () => {
  it('quotes plain identifiers with backticks', () => {
    expect(quoteIdent('users')).toBe('`users`');
    expect(qualifiedTable('shop', 'order items')).toBe('`shop`.`order items`');
  });

  it('doubles embedded backticks so identifiers cannot break out', () => {
    expect(quoteIdent('a`b')).toBe('`a``b`');
    expect(quoteIdent('x`; DROP TABLE users; --')).toBe('`x``; DROP TABLE users; --`');
  });

  it('allows unicode and punctuation that MySQL allows in quoted identifiers', () => {
    expect(quoteIdent('קוד')).toBe('`קוד`');
    expect(quoteIdent('a-b.c$d')).toBe('`a-b.c$d`');
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(65), 'too long'],
    ['bad\u0000name', 'NUL'],
    ['trailing ', 'trailing space'],
    ['\uD800x', 'lone surrogate'],
  ])('rejects invalid identifier %j (%s)', (name) => {
    expect(() => quoteIdent(name)).toThrow(/Invalid/);
  });

  it('rejects non-strings', () => {
    expect(() => assertIdentifier(42)).toThrow();
    expect(() => assertIdentifier(undefined)).toThrow();
  });

  it('escapes LIKE wildcards with the portable ! escape character', () => {
    expect(escapeLike('50%_off!')).toBe('50!%!_off!!');
    expect(escapeLike("o'neil")).toBe("o'neil");
  });
});
