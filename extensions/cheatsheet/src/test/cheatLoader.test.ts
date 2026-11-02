import * as assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { loadContent, mergeCategories, mergeTechniqueFile, parseCategory, watchContentFolder } from '../cheatLoader';
import { applyTechniques, TECHNIQUE_GROUPS } from '../command';

suite('parseCategory', () => {
  test('全項目を読み、id の省略時はタイトルを使い、コード末尾の改行を除く', () => {
    const { category, errors } = parseCategory(
      'git',
      'name: Git\ncheats:\n  - title: A\n    description: d\n    code: |\n      a\n      b\n    notes: n\n  - title: B\n    id: b-id\n',
      'git.yaml',
    );
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(category?.name, 'Git');
    assert.deepStrictEqual(category?.cheats[0], {
      id: 'A',
      title: 'A',
      description: 'd',
      code: 'a\nb',
      language: undefined,
      options: undefined,
      notes: 'n',
    });
    assert.strictEqual(category?.cheats[1].id, 'b-id');
  });

  test('name を省略するとファイル名になる', () => {
    assert.strictEqual(parseCategory('docker', 'cheats: []', 'f').category?.name, 'docker');
  });

  test('不正なチートだけを除き、他は読み込む', () => {
    const { category, errors } = parseCategory('x', 'cheats:\n  - title: ok\n  - code: no-title\n  - title: bad\n    code: 1\n', 'f');
    assert.deepStrictEqual(category?.cheats.map((c) => c.title), ['ok']);
    assert.strictEqual(errors.length, 2);
    assert.ok(errors[0].includes('cheats[1]'));
    assert.ok(errors[1].includes('code'));
  });

  test('構文エラーと形式違いはエラーになり、空ファイルは何も返さない', () => {
    assert.strictEqual(parseCategory('x', 'a: [', 'f').errors.length, 1);
    assert.strictEqual(parseCategory('x', '- a', 'f').errors.length, 1);
    assert.strictEqual(parseCategory('x', 'name: 1\ncheats: []', 'f').errors.length, 1);
    assert.deepStrictEqual(parseCategory('x', '', 'f'), { errors: [] });
  });
});

suite('parseCategory のオプション', () => {
  const parseOne = (body: string) => parseCategory('x', `cheats:\n  - title: t\n${body}`, 'f');

  test('language と options を読み、既定値を正規化する', () => {
    const { category, errors } = parseOne(
      '    code: run\n    language: python\n    options:\n      - flag: -n\n        default: 20\n      - flag: --all\n        type: flag\n        default: true\n      - label: path\n        separator: "="\n',
    );
    assert.deepStrictEqual(errors, []);
    const cheat = category?.cheats[0];
    assert.strictEqual(cheat?.language, 'python');
    assert.strictEqual(cheat?.options?.[0].label, '-n');
    assert.strictEqual(cheat?.options?.[0].type, 'text');
    assert.strictEqual(cheat?.options?.[0].default, '20');
    assert.strictEqual(cheat?.options?.[1].default, true);
    assert.strictEqual(cheat?.options?.[2].flag, undefined);
    assert.strictEqual(cheat?.options?.[2].separator, '=');
  });

  test('required を読み、省略時は false にする', () => {
    const { category, errors } = parseOne('    code: run\n    options:\n      - flag: -a\n        required: true\n      - flag: -b\n');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(category?.cheats[0].options?.[0].required, true);
    assert.strictEqual(category?.cheats[0].options?.[1].required, false);
  });

  test('multiple を読み、省略時は false にして、不正な指定はエラーにする', () => {
    const { category } = parseOne('    code: run\n    options:\n      - flag: -e\n        multiple: true\n      - flag: -a\n');
    assert.strictEqual(category?.cheats[0].options?.[0].multiple, true);
    assert.strictEqual(category?.cheats[0].options?.[1].multiple, false);

    const notBoolean = parseOne('    code: run\n    options:\n      - flag: -e\n        multiple: "yes"\n');
    assert.match(notBoolean.errors[0], /multiple は true か false/);
    const onFlag = parseOne('    code: run\n    options:\n      - flag: -v\n        type: flag\n        multiple: true\n');
    assert.match(onFlag.errors[0], /multiple は type が text/);
  });

  test('placeholder は数値でも受け付ける', () => {
    const { category, errors } = parseOne('    code: run\n    options:\n      - flag: -a\n        placeholder: -7\n');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(category?.cheats[0].options?.[0].placeholder, '-7');
  });

  test('不正な options を持つチートはエラーにする', () => {
    const invalid = [
      '    options:\n      - flag: -a\n',
      '    code: run\n    options: -a\n',
      '    code: run\n    options:\n      - placeholder: x\n',
      '    code: run\n    options:\n      - label: x\n        type: flag\n',
      '    code: run\n    options:\n      - flag: -a\n        type: other\n',
      '    code: run\n    options:\n      - flag: 1\n',
      '    code: run\n    options:\n      - flag: -a\n        required: "yes"\n',
      '    code: run\n    options:\n      - flag: -a\n        placeholder: [1]\n',
      '    code: run\n    options:\n      - flag: -a\n        default: [1]\n',
    ];
    for (const body of invalid) {
      const { category, errors } = parseOne(body);
      assert.deepStrictEqual(category?.cheats, [], body);
      assert.strictEqual(errors.length, 1, body);
    }
  });
});

suite('mergeCategories', () => {
  test('後のカテゴリを優先し、同じ ID は元の位置で置き換え、名前順に並べる', () => {
    const merged = mergeCategories([
      { id: 'z', name: 'z', cheats: [] },
      { id: 'a', name: 'old', cheats: [{ id: '1', title: 'one' }, { id: '2', title: 'two' }] },
      { id: 'a', name: 'a', cheats: [{ id: '1', title: 'ONE' }, { id: '3', title: 'three' }] },
    ]);
    assert.deepStrictEqual(merged.map((c) => c.name), ['a', 'z']);
    assert.deepStrictEqual(merged[0].cheats.map((c) => c.title), ['ONE', 'two', 'three']);
  });
});

suite('mergeTechniqueFile', () => {
  const choices = (id: string, groups = TECHNIQUE_GROUPS) => groups.find((g) => g.id === id)?.choices ?? [];

  test('選択肢を追加し、既定の選択肢は残す', () => {
    const { groups, errors } = mergeTechniqueFile(
      TECHNIQUE_GROUPS,
      'pipe:\n  - label: 整形\n    id: jq\n    template: "| jq {}"\n    argLabel: フィルタ\n    defaultArg: .\nstderr:\n  - label: ログ\n    template: 2>> e.log\n',
      'f',
    );
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(choices('pipe', groups).length, choices('pipe').length + 1);
    assert.strictEqual(applyTechniques('cmd', { pipe: 'jq' }, groups), 'cmd | jq .');
    assert.strictEqual(applyTechniques('cmd', { pipe: 'jq', pipeArg: 'a b' }, groups), "cmd | jq 'a b'");
    assert.strictEqual(applyTechniques('cmd', { stderr: 'ログ' }, groups), 'cmd 2>> e.log');
  });

  test('{} があれば argLabel を省略でき、同じ id は上書きする', () => {
    const { groups, errors } = mergeTechniqueFile(TECHNIQUE_GROUPS, 'stdout:\n  - id: discard\n    label: 捨てる2\n    template: "> {}"\n', 'f');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(choices('stdout', groups).length, choices('stdout').length);
    const replaced = choices('stdout', groups).find((c) => c.id === 'discard');
    assert.strictEqual(replaced?.argLabel, '値');
    assert.strictEqual(choices('stdout').find((c) => c.id === 'discard')?.template, '> /dev/null', '既定値を書き換えない');
  });

  test('不正な内容はエラーにして、他は読み込む', () => {
    const { groups, errors } = mergeTechniqueFile(
      TECHNIQUE_GROUPS,
      'other: []\nstdout: x\npipe:\n  - label: ok\n    template: "| ok"\n  - label: no-template\n  - label: bad\n    template: "| x"\n    argLabel: y\n',
      'f',
    );
    assert.strictEqual(errors.length, 4);
    assert.ok(choices('pipe', groups).some((c) => c.id === 'ok'));
    assert.strictEqual(mergeTechniqueFile(TECHNIQUE_GROUPS, 'a: [', 'f').errors.length, 1);
    assert.deepStrictEqual(mergeTechniqueFile(TECHNIQUE_GROUPS, '', 'f'), { groups: TECHNIQUE_GROUPS, errors: [] });
  });
});

suite('ファイルからの読み込み', () => {
  let dir: string;

  setup(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cheatsheet-'));
  });

  teardown(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('同梱の YAML は問題なく読み込める', async () => {
    const extension = vscode.extensions.getExtension('noboon.cheatsheet');
    assert.ok(extension);
    const { categories, errors } = await loadContent([vscode.Uri.joinPath(extension.extensionUri, 'cheats')]);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(categories.map((c) => c.id), ['bash', 'docker', 'git', 'npm', 'pip', 'python', 'uv']);
  });

  test('YAML 以外は無視し、壊れたファイルがあっても他を読み込む', async () => {
    await writeFile(path.join(dir, 'ok.yml'), 'cheats:\n  - title: A\n');
    await writeFile(path.join(dir, 'broken.yaml'), 'a: [');
    await writeFile(path.join(dir, 'README.md'), '# readme');
    const { categories, errors } = await loadContent([vscode.Uri.file(dir)]);
    assert.deepStrictEqual(categories.map((c) => c.id), ['ok']);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('broken.yaml'));
  });

  test('_techniques.yaml はカテゴリにせず、選択肢として読み込む', async () => {
    await writeFile(path.join(dir, '_techniques.yaml'), 'pipe:\n  - label: 整形\n    id: jq\n    template: "| jq ."\n');
    await writeFile(path.join(dir, 'ok.yaml'), 'cheats: []\n');
    const { categories, techniqueGroups, errors } = await loadContent([vscode.Uri.file(dir)]);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(categories.map((c) => c.id), ['ok']);
    assert.strictEqual(applyTechniques('cmd', { pipe: 'jq' }, techniqueGroups), 'cmd | jq .');
  });

  test('存在しないフォルダはエラーとして報告する', async () => {
    const { categories, errors } = await loadContent([vscode.Uri.file(path.join(dir, 'missing'))]);
    assert.deepStrictEqual(categories, []);
    assert.strictEqual(errors.length, 1);
  });

  test('YAML の変更を検知する', async () => {
    const changed = new Promise<void>((resolve) => {
      const watcher = watchContentFolder(vscode.Uri.file(dir), () => {
        watcher.dispose();
        resolve();
      });
    });
    // 監視の開始には少し時間がかかるので、検知されるまで書き込みを繰り返す
    const writer = setInterval(() => void writeFile(path.join(dir, 'a.yaml'), `cheats: [] # ${Date.now()}\n`), 500);
    try {
      await changed;
    } finally {
      clearInterval(writer);
    }
  });
});
