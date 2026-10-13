import { describe, expect, it } from 'vitest';
import { formatLiteral, inlineParams } from '../../src/core/sql/literals';

describe('literals', () => {
  it('formats scalars', () => {
    expect(formatLiteral(null, 'mysql')).toBe('NULL');
    expect(formatLiteral(true, 'mysql')).toBe('1');
    expect(formatLiteral(12.5, 'mysql')).toBe('12.5');
  });

  it('escapes strings per dialect', () => {
    expect(formatLiteral("o'neil\\", 'mysql')).toBe("'o''neil\\\\'");
    expect(formatLiteral("o'neil\\", 'sqlite')).toBe("'o''neil\\'");
    expect(formatLiteral('a\nb', 'mysql')).toBe("'a\\nb'");
  });

  it('replaces only code placeholders', () => {
    expect(inlineParams("SELECT `a?` FROM t WHERE x = ? AND y = '?' -- ?\n AND z = ?", ['v', 2], 'mysql')).toBe(
      "SELECT `a?` FROM t WHERE x = 'v' AND y = '?' -- ?\n AND z = 2",
    );
  });

  it('validates parameter counts', () => {
    expect(() => inlineParams('SELECT ?', [], 'mysql')).toThrow();
    expect(() => inlineParams('SELECT 1', [1], 'mysql')).toThrow();
  });
});
