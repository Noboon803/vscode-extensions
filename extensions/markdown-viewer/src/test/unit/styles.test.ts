import * as assert from 'node:assert';
import { buildStyleRules } from '../../styles';

suite('buildStyleRules', () => {
  test('要素とプロパティを CSS のルールにする', () => {
    assert.deepStrictEqual(buildStyleRules({ h1: { color: '#f00', lineHeight: 1.8 } }), [
      {
        selector: '#content h1',
        declarations: [
          { property: 'color', value: '#f00', label: 'h1.color' },
          { property: 'line-height', value: '1.8', label: 'h1.lineHeight' },
        ],
      },
    ]);
  });

  test('サイズの数値は px にし、太さや行間の数値は単位を付けない', () => {
    const [rule] = buildStyleRules({ paragraph: { fontSize: 16, marginTop: 8, fontWeight: 700, lineHeight: 2 } });
    assert.deepStrictEqual(
      rule.declarations.map(({ value }) => value),
      ['16px', '8px', '700', '2'],
    );
  });

  test('知らない要素とプロパティは無視する', () => {
    assert.deepStrictEqual(buildStyleRules({ unknown: { color: 'red' } }), []);
    assert.deepStrictEqual(buildStyleRules({ constructor: { color: 'red' } }), []);
    assert.deepStrictEqual(buildStyleRules({ h1: { backgroundImage: 'url(https://example.com/a.png)' } }), []);
  });

  test('値が空や不正な型なら無視する', () => {
    assert.deepStrictEqual(buildStyleRules({ h1: { color: '  ', fontSize: Number.NaN, lineHeight: {} } }), []);
    assert.deepStrictEqual(buildStyleRules({ h1: 'red' }), []);
    assert.deepStrictEqual(buildStyleRules(undefined), []);
  });
});
