import * as assert from 'node:assert';
import { nextTheme, normalizeTheme } from '../../theme';

suite('theme', () => {
  test('知らない値は auto として扱う', () => {
    assert.strictEqual(normalizeTheme('light'), 'light');
    assert.strictEqual(normalizeTheme('dark'), 'dark');
    assert.strictEqual(normalizeTheme('sepia'), 'auto');
    assert.strictEqual(normalizeTheme(undefined), 'auto');
  });

  test('auto、light、dark の順に切り替わる', () => {
    assert.strictEqual(nextTheme('auto'), 'light');
    assert.strictEqual(nextTheme('light'), 'dark');
    assert.strictEqual(nextTheme('dark'), 'auto');
  });
});
