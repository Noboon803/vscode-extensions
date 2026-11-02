import * as assert from 'node:assert';
import type { CheatOption } from '../cheatsheet';
import {
  applyTechniques,
  composeCommand,
  isShellLanguage,
  optionRows,
  quoteShellValue,
  restoreFields,
  snapshotFields,
  supportsTechniques,
  visibleRows,
  withAddedRow,
  withoutRow,
} from '../command';

const text = (option: Partial<CheatOption> = {}): CheatOption => ({ label: 'l', type: 'text', ...option });

suite('quoteShellValue', () => {
  test('安全な値はそのまま、記号を含む値はクォートする', () => {
    assert.strictEqual(quoteShellValue('feature/a-1.txt'), 'feature/a-1.txt');
    assert.strictEqual(quoteShellValue('a b'), "'a b'");
    assert.strictEqual(quoteShellValue('*.log'), "'*.log'");
    assert.strictEqual(quoteShellValue('$(rm -rf x); y'), "'$(rm -rf x); y'");
    assert.strictEqual(quoteShellValue("it's"), "'it'\\''s'");
  });
});

suite('snapshotFields / restoreFields', () => {
  test('定義の順番が変わっても同じオプションへ値を戻し、未入力は既定値に任せる', () => {
    const a = text({ flag: '--a' });
    const b = text({ label: '位置' });
    const c = text({ flag: '-n', default: '20' });
    const saved = snapshotFields([a, b, c], ['1', '2', undefined]);
    assert.deepStrictEqual(saved, { '--a': '1', 位置: '2' });
    assert.deepStrictEqual(restoreFields([c, b, a], saved), [undefined, '2', '1']);
    assert.strictEqual(composeCommand('cmd', [c, b, a], restoreFields([c, b, a], saved)), 'cmd -n 20 2 --a 1');
  });

  test('空にした値や外したチェックも保存する', () => {
    const options = [text({ flag: '-n', default: '20' }), { flag: '--all', label: 'l', type: 'flag', default: true } as CheatOption];
    assert.deepStrictEqual(restoreFields(options, snapshotFields(options, ['', false])), ['', false]);
  });
});

suite('composeCommand', () => {
  test('定義順に連結し、空の値は省略する', () => {
    const options = [text({ flag: '--a' }), text({ flag: '--b' }), text()];
    assert.strictEqual(composeCommand('cmd', options, ['1', '  ', 'pos']), 'cmd --a 1 pos');
  });

  test('入力がなければ既定値を使い、空にすると省略する', () => {
    const options = [text({ flag: '-n', default: '20' })];
    assert.strictEqual(composeCommand('cmd', options, []), 'cmd -n 20');
    assert.strictEqual(composeCommand('cmd', options, ['']), 'cmd');
  });

  test('separator で連結し、値をクォートする', () => {
    const options = [text({ flag: '--author', separator: '=' }), text({ flag: '-x', separator: '' })];
    assert.strictEqual(composeCommand('git log', options, ['a b', '1']), "git log --author='a b' -x1");
  });

  test('flag はチェック時だけ付ける', () => {
    const flag: CheatOption = { flag: '--all', label: 'l', type: 'flag', default: true };
    assert.strictEqual(composeCommand('cmd', [flag], []), 'cmd --all');
    assert.strictEqual(composeCommand('cmd', [flag], [false]), 'cmd');
  });

  test('複数行のコードは最終行の末尾に連結する', () => {
    assert.strictEqual(composeCommand('a\nb\n', [text({ flag: '-x' })], ['1']), 'a\nb -x 1');
  });

  test('同じオプションの値をすべて連結し、空の行は省略する', () => {
    const options = [text({ flag: '-e', multiple: true }), text({ flag: '-p', separator: '=', multiple: true }), text()];
    assert.strictEqual(
      composeCommand('docker run', options, [['A=1', ' ', 'B=a b'], ['80', '443'], ['nginx', 'sh']]),
      "docker run -e A=1 -e 'B=a b' -p=80 -p=443 nginx sh",
    );
  });

  test('空の配列は既定値を使わない', () => {
    assert.strictEqual(composeCommand('cmd', [text({ flag: '-n', default: '20' })], [[]]), 'cmd');
  });
});

suite('オプションの行の追加と削除', () => {
  test('未入力でも 1 行は見せ、既定値があれば入れる', () => {
    assert.deepStrictEqual(visibleRows(text(), undefined), ['']);
    assert.deepStrictEqual(visibleRows(text({ default: '20' }), undefined), ['20']);
    assert.deepStrictEqual(visibleRows(text({ default: '20' }), ''), ['']);
  });

  test('見えている行の下に 1 行足す', () => {
    assert.deepStrictEqual(withAddedRow(text(), undefined), ['', '']);
    assert.deepStrictEqual(withAddedRow(text({ default: '20' }), undefined), ['20', '']);
    assert.deepStrictEqual(withAddedRow(text(), ['a']), ['a', '']);
  });

  test('指定した行だけ外し、元の配列は変更しない', () => {
    const rows = ['a', 'b', 'c'];
    assert.deepStrictEqual(withoutRow(text(), rows, 1), ['a', 'c']);
    assert.deepStrictEqual(rows, ['a', 'b', 'c']);
  });

  test('以前の保存形式の文字列を行として読む', () => {
    assert.deepStrictEqual(optionRows(text(), 'a'), ['a']);
    assert.deepStrictEqual(optionRows(text({ default: '20' }), ''), []);
    assert.deepStrictEqual(optionRows(text({ default: '20' }), undefined), ['20']);
  });

  test('複数の値を保存して復元できる', () => {
    const options = [text({ flag: '-e', multiple: true }), text({ flag: '--name' })];
    const saved = snapshotFields(options, [['A=1', 'B=2'], []]);
    assert.deepStrictEqual(saved, { '-e': ['A=1', 'B=2'], '--name': [] });
    assert.strictEqual(composeCommand('cmd', options, restoreFields(options, saved)), 'cmd -e A=1 -e B=2');
  });
});

suite('isShellLanguage', () => {
  test('省略時とシェル系は true、それ以外は false', () => {
    assert.strictEqual(isShellLanguage(undefined), true);
    assert.strictEqual(isShellLanguage('ZSH'), true);
    assert.strictEqual(isShellLanguage('python'), false);
  });
});

suite('applyTechniques', () => {
  test('何も選ばなければコマンドのまま', () => {
    assert.strictEqual(applyTechniques('cmd', {}), 'cmd');
    assert.strictEqual(applyTechniques('cmd', { stdout: 'keep', stderr: 'keep', pipe: 'none', background: false }), 'cmd');
  });

  test('stdout と stderr を個別に捨てられる', () => {
    assert.strictEqual(applyTechniques('cmd', { stdout: 'discard' }), 'cmd > /dev/null');
    assert.strictEqual(applyTechniques('cmd', { stderr: 'discard' }), 'cmd 2> /dev/null');
  });

  test('パイプなしでは stdout の後に stderr を置く', () => {
    assert.strictEqual(applyTechniques('cmd', { stdout: 'discard', stderr: 'merge' }), 'cmd > /dev/null 2>&1');
    assert.strictEqual(applyTechniques('cmd', { stdout: 'file', stdoutArg: 'a.log', stderr: 'merge' }), 'cmd > a.log 2>&1');
  });

  test('パイプありでは stderr をパイプの前、stdout をパイプの後に置く', () => {
    assert.strictEqual(
      applyTechniques('cmd', { stderr: 'merge', pipe: 'grep', pipeArg: 'x', stdout: 'file', stdoutArg: 'a.log' }),
      'cmd 2>&1 | grep x > a.log',
    );
    assert.strictEqual(applyTechniques('cmd', { stderr: 'discard', pipe: 'wc' }), 'cmd 2> /dev/null | wc -l');
  });

  test('入力が必要な選択肢は、空なら連結せず、既定値があれば使う', () => {
    assert.strictEqual(applyTechniques('cmd', { stdout: 'file' }), 'cmd');
    assert.strictEqual(applyTechniques('cmd', { stdout: 'file', stdoutArg: '  ' }), 'cmd');
    assert.strictEqual(applyTechniques('cmd', { pipe: 'head' }), 'cmd | head -n 20');
    assert.strictEqual(applyTechniques('cmd', { pipe: 'head', pipeArg: '' }), 'cmd');
  });

  test('入力値はクォートし、$ などを置換パターンとして解釈しない', () => {
    assert.strictEqual(applyTechniques('cmd', { pipe: 'grep', pipeArg: 'a b' }), "cmd | grep 'a b'");
    assert.strictEqual(applyTechniques('cmd', { stdout: 'file', stdoutArg: "$&'x" }), "cmd > '$&'\\''x'");
  });

  test('バックグラウンドは末尾に付ける', () => {
    assert.strictEqual(applyTechniques('cmd', { stdout: 'discard', stderr: 'merge', background: true }), 'cmd > /dev/null 2>&1 &');
  });
});

suite('supportsTechniques', () => {
  test('POSIX シェルの 1 行だけ対象にする', () => {
    assert.strictEqual(supportsTechniques(undefined, 'a'), true);
    assert.strictEqual(supportsTechniques('zsh', 'a\n'), true);
    assert.strictEqual(supportsTechniques('bash', 'a\nb'), false);
    assert.strictEqual(supportsTechniques('powershell', 'a'), false);
    assert.strictEqual(supportsTechniques('python', 'a'), false);
  });
});
