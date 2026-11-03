import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanSource } from '../../scanner/codeScanner';
import type { Finding, RuleId } from '../../scanner/types';

const FIXTURES = path.resolve(__dirname, '../../../test-fixtures/code');

/** テストデータは文字列として読むだけで、実行しない */
function scanFixture(name: string) {
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
  return scanSource(text, `${name}.js`);
}

function details(findings: Finding[], rule: RuleId): string[] {
  return findings
    .filter((finding) => finding.rule === rule)
    .map((finding) => finding.detail)
    .sort();
}

function rulesOf(findings: Finding[]): RuleId[] {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

suite('codeScanner: 検出', () => {
  test('require した child_process を位置つきで検出する', () => {
    const { findings, parseError } = scanFixture('exec-require');
    assert.strictEqual(parseError, undefined);
    const [finding] = findings.filter((item) => item.rule === 'process-exec');
    assert.strictEqual(finding.detail, 'child_process');
    assert.deepStrictEqual(finding.locations[0], { line: 1, column: 19 });
  });

  test('ES モジュールと node: 接頭辞でも検出する', () => {
    const { findings } = scanFixture('exec-node-prefix-import');
    assert.deepStrictEqual(details(findings, 'process-exec'), ['child_process']);
  });

  test('eval と new Function を検出する', () => {
    const { findings } = scanFixture('dynamic-code');
    assert.deepStrictEqual(details(findings, 'dynamic-code'), ['Function', 'eval']);
  });

  test('通信機能と接続先を検出し、グローバル IP を区別する', () => {
    const { findings } = scanFixture('network');
    assert.deepStrictEqual(details(findings, 'network'), ['WebSocket', 'fetch', 'https']);
    assert.deepStrictEqual(details(findings, 'url'), ['198.51.100.7', 'api.example.test', 'socket.example.test']);
    assert.deepStrictEqual(details(findings, 'ip-url'), ['198.51.100.7']);
  });

  test('ローカル宛ての IP は要確認にしない', () => {
    const { findings } = scanSource("fetch('http://10.0.0.5/'); fetch('http://127.0.0.1:3000/');", 'a.js');
    assert.deepStrictEqual(details(findings, 'ip-url'), []);
  });

  test('バンドラーが作る child_process の変数名を検出する', () => {
    for (const name of ['child_process_1', '_child_process', 'child_process__rspack_import_0']) {
      const { findings } = scanSource(`var ${name} = __webpack_require__(13200); ${name}.spawn("ls");`, 'a.js');
      assert.deepStrictEqual(details(findings, 'process-exec'), ['child_process'], name);
    }
  });

  test('常駐に使われるパスを検出する', () => {
    const { findings } = scanFixture('persistence');
    assert.deepStrictEqual(details(findings, 'persistence-path'), ['LaunchAgents']);
  });

  test('動的な require と import を検出する', () => {
    const { findings } = scanFixture('dynamic-require');
    const [finding] = findings.filter((item) => item.rule === 'dynamic-import');
    assert.strictEqual(finding.count, 2);
  });
});

suite('codeScanner: 組み合わせ', () => {
  test('認証情報のパスと通信は優先確認になる', () => {
    const { findings } = scanFixture('credential-network');
    assert.deepStrictEqual(details(findings, 'credential-path'), ['.ssh', 'SSH 秘密鍵']);
    assert.ok(rulesOf(findings).includes('combo-credential-network'));
  });

  test('環境変数の一括取得と通信は優先確認になる', () => {
    const { findings } = scanFixture('env-network');
    assert.deepStrictEqual(details(findings, 'env-dump'), ['JSON.stringify']);
    assert.ok(rulesOf(findings).includes('combo-env-network'));
  });

  test('オブジェクトに入れた環境変数の JSON 化も優先確認になる', () => {
    for (const body of ['{ env: process.env }', '{ ...process.env }']) {
      const { findings } = scanSource(`fetch('https://a.example.test', { body: JSON.stringify(${body}) });`, 'a.js');
      assert.ok(rulesOf(findings).includes('combo-env-network'), body);
    }
  });

  test('環境変数のコピーと通信は優先確認にしない', () => {
    const { findings } = scanSource("const env = Object.assign({}, process.env); Object.keys(process.env); fetch('https://a.example.test');", 'a.js');
    assert.deepStrictEqual(details(findings, 'env-enumerate'), ['Object.assign', 'Object.keys']);
    assert.ok(!rulesOf(findings).includes('combo-env-network'));
  });

  test('デコードと eval は優先確認になる', () => {
    const { findings } = scanFixture('decode-eval');
    assert.deepStrictEqual(details(findings, 'decode'), ['base64']);
    assert.ok(rulesOf(findings).includes('combo-decode-dynamic'));
  });

  test('デコードと eval が離れていれば組み合わせにせず、個別の検出は残す', () => {
    const padding = 'noop();\n'.repeat(200);
    const { findings } = scanSource(`Buffer.from(a, 'base64');\n${padding}eval(b);`, 'a.js');
    assert.deepStrictEqual(rulesOf(findings), ['decode', 'dynamic-code']);
  });

  test('eval が先でも、近ければ組み合わせになる', () => {
    const { findings } = scanSource("eval(b); Buffer.from(a, 'hex');", 'a.js');
    assert.ok(rulesOf(findings).includes('combo-decode-dynamic'));
  });

  test('片方だけでは組み合わせにならない', () => {
    const { findings } = scanSource("const key = '.ssh'; console.log(key);", 'a.js');
    assert.deepStrictEqual(rulesOf(findings), ['credential-path']);
  });
});

suite('codeScanner: 誤検出', () => {
  test('コメント、文章内の言及、プロパティ名、名前空間の URL には反応しない', () => {
    const { findings, parseError } = scanFixture('negative-comment-string');
    assert.strictEqual(parseError, undefined);
    assert.deepStrictEqual(findings, []);
  });

  test('グローバルオブジェクトを取得するだけの定型句は検出しない', () => {
    for (const code of [
      'Function("return this")();',
      'new Function("return this;")();',
      '(0, eval)("this");',
      'eval("(function() { return this; })()");',
    ]) {
      assert.deepStrictEqual(scanSource(code, 'a.js').findings, [], code);
    }
  });

  test('定型句以外の引数なら Function も eval も検出する', () => {
    assert.deepStrictEqual(details(scanSource('Function("return process")();', 'a.js').findings, 'dynamic-code'), ['Function']);
    assert.deepStrictEqual(details(scanSource('(0, eval)(code);', 'a.js').findings, 'dynamic-code'), ['eval']);
  });

  test('get-intrinsic の組み込み関数一覧は検出せず、別名への代入は検出する', () => {
    assert.deepStrictEqual(scanSource('const table = { "%eval%": eval };', 'a.js').findings, []);
    assert.deepStrictEqual(details(scanSource('const run = eval; run(code);', 'a.js').findings, 'dynamic-code'), ['eval']);
  });

  test('認証情報のパスに触れた文章は検出しない', () => {
    const { findings } = scanSource("const help = 'SSH の設定は ~/.ssh/config を確認してください';", 'a.js');
    assert.deepStrictEqual(findings, []);
  });

  test('環境変数を 1 つ読むだけなら検出しない', () => {
    const { findings } = scanSource('console.log(process.env.HOME);', 'a.js');
    assert.deepStrictEqual(findings, []);
  });

  test('絵文字の異体字セレクタは検出しない', () => {
    const { findings } = scanSource("const message = '✔️ 完了 ⚠️ 注意';", 'a.js');
    assert.deepStrictEqual(findings, []);
  });

  test('画像などのデータ URI はランダムな文字列として扱わない', () => {
    const data = `data:image/png;base64,${'iVBORw0KGgo'.repeat(100)}`;
    const { findings } = scanSource(`const image = ${JSON.stringify(data)};`, 'a.js');
    assert.deepStrictEqual(findings, []);
  });
});

suite('codeScanner: 回避手口', () => {
  test('文字列の連結で組み立てた require を検出する', () => {
    const { findings } = scanFixture('evasion-concat');
    assert.deepStrictEqual(details(findings, 'process-exec'), ['child_process']);
    assert.deepStrictEqual(details(findings, 'hidden-module'), ['child_process']);
  });

  test('テンプレート文字列で組み立てた require を検出する', () => {
    const { findings } = scanFixture('evasion-template');
    assert.deepStrictEqual(details(findings, 'hidden-module'), ['child_process']);
  });

  test('require を別名にしても child_process を検出する', () => {
    const { findings } = scanFixture('evasion-alias');
    assert.deepStrictEqual(details(findings, 'process-exec'), ['child_process']);
  });

  test('process.mainModule.require を検出する', () => {
    const { findings } = scanFixture('evasion-main-module');
    assert.deepStrictEqual(details(findings, 'process-exec'), ['child_process']);
  });

  test("globalThis['ev' + 'al'] を検出する", () => {
    const { findings } = scanFixture('evasion-computed-eval');
    assert.deepStrictEqual(details(findings, 'dynamic-code'), ['eval']);
    assert.deepStrictEqual(details(findings, 'hidden-module'), ['eval']);
  });

  test('(0, eval)() を検出する', () => {
    const { findings } = scanFixture('evasion-indirect-eval');
    assert.deepStrictEqual(details(findings, 'dynamic-code'), ['eval']);
  });

  test('文字コードの組み立てとコマンド実行は優先確認になる', () => {
    const { findings } = scanFixture('char-code-exec');
    assert.ok(rulesOf(findings).includes('char-code'));
    assert.ok(rulesOf(findings).includes('combo-obfuscated-exec'));
  });

  test('難読化ツールに特有の変数名が大量にあると検出する', () => {
    const declarations = Array.from({ length: 60 }, (_, index) => `const _0x${(0xa000 + index).toString(16)} = ${index};`);
    const { findings } = scanSource(declarations.join('\n'), 'a.js');
    assert.deepStrictEqual(rulesOf(findings), ['hex-identifiers']);
  });

  test('目に見えない文字の連続を検出する', () => {
    const hidden = String.fromCodePoint(...Array.from({ length: 32 }, (_, index) => 0xe0100 + index));
    const { findings } = scanSource(`const payload = '${hidden}';`, 'a.js');
    assert.deepStrictEqual(rulesOf(findings), ['invisible-chars']);
    assert.ok(!/[\u{E0100}-\u{E01EF}]/u.test(findings[0].excerpt ?? ''), '抜粋に不可視文字を残さない');
  });

  test('ランダムに見える長い文字列を検出する', () => {
    let text = '';
    for (let index = 0; index < 1024; index++) {
      text += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[(index * 7919) % 62];
    }
    const { findings } = scanSource(`const blob = '${text}';`, 'a.js');
    assert.deepStrictEqual(rulesOf(findings), ['high-entropy']);
  });
});

suite('codeScanner: 異常系', () => {
  test('構文エラーは parseError を返し、検出なしと区別できる', () => {
    const { parseError } = scanFixture('broken-syntax');
    assert.ok(parseError);
  });

  test('構文エラーでも目に見えない文字は検出する', () => {
    const hidden = '︀'.repeat(32);
    const { findings, parseError } = scanSource(`function ( { ${hidden}`, 'a.js');
    assert.ok(parseError);
    assert.deepStrictEqual(rulesOf(findings), ['invisible-chars']);
  });

  test('非常に長い文字列の連結でもスタックを溢れさせない', () => {
    const terms = Array.from({ length: 2000 }, () => "'a'").join(' + ');
    const { parseError } = scanSource(`require(${terms});`, 'a.js');
    assert.strictEqual(parseError, undefined);
  });
});
