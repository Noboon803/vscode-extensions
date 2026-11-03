import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverExtensions } from '../../scanner/discover';
import { classifyTargets, type ExclusionSettings } from '../../scanner/exclusion';

interface FakeInstall {
  dirName: string;
  /** package.json の publisher.name */
  manifestId?: string;
  /** extensions.json に記録する内容。省略すると記録しない */
  record?: { id: string; source?: string };
}

suite('classifyTargets', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-audit-test-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** インストールしない架空のフォルダと extensions.json を作る */
  function install(items: FakeInstall[]): void {
    for (const { dirName, manifestId } of items) {
      fs.mkdirSync(path.join(root, dirName));
      if (manifestId) {
        const [publisher, name] = manifestId.split('.');
        fs.writeFileSync(path.join(root, dirName, 'package.json'), JSON.stringify({ publisher, name, version: '1.0.0' }));
      }
    }
    const records = items
      .filter((item) => item.record)
      .map((item) => ({
        identifier: { id: item.record?.id },
        relativeLocation: item.dirName,
        metadata: { source: item.record?.source },
      }));
    fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify(records));
  }

  function classify(settings: Partial<ExclusionSettings>) {
    const result = classifyTargets(root, discoverExtensions(root), {
      trustedPublishers: [],
      excludedExtensions: [],
      ...settings,
    });
    return {
      scanned: result.targets.map((target) => target.dirName),
      excluded: result.excluded,
    };
  }

  const MARKETPLACE = {
    dirName: 'ms-python.python-1.0.0',
    manifestId: 'ms-python.python',
    record: { id: 'ms-python.python', source: 'gallery' },
  };

  test('設定が空なら何も除外しない', () => {
    install([MARKETPLACE]);
    assert.deepStrictEqual(classify({}), { scanned: [MARKETPLACE.dirName], excluded: [] });
  });

  test('信頼する開発元の、Marketplace からのインストールを除外する', () => {
    install([
      MARKETPLACE,
      { dirName: 'other.tool-1.0.0', manifestId: 'other.tool', record: { id: 'other.tool', source: 'gallery' } },
    ]);
    assert.deepStrictEqual(classify({ trustedPublishers: ['ms-python'] }), {
      scanned: ['other.tool-1.0.0'],
      excluded: [{ dirName: MARKETPLACE.dirName, id: 'ms-python.python', reason: 'publisher' }],
    });
  });

  test('開発元を名乗るだけの VSIX は、信頼する開発元でも検査する', () => {
    const dirName = 'ms-python.fake-1.0.0';
    install([{ dirName, manifestId: 'ms-python.fake', record: { id: 'ms-python.fake', source: 'vsix' } }]);
    assert.deepStrictEqual(classify({ trustedPublishers: ['ms-python'] }).scanned, [dirName]);
  });

  test('インストール元の記録がなければ、信頼する開発元でも検査する', () => {
    const noRecord = 'ms-python.a-1.0.0';
    const noSource = 'ms-python.b-1.0.0';
    install([
      { dirName: noRecord, manifestId: 'ms-python.a' },
      { dirName: noSource, manifestId: 'ms-python.b', record: { id: 'ms-python.b' } },
    ]);
    assert.deepStrictEqual(classify({ trustedPublishers: ['ms-python'] }).scanned, [noRecord, noSource]);
  });

  test('extensions.json が壊れていれば、開発元では除外しない', () => {
    install([MARKETPLACE]);
    fs.writeFileSync(path.join(root, 'extensions.json'), '{ broken');
    assert.deepStrictEqual(classify({ trustedPublishers: ['ms-python'] }).scanned, [MARKETPLACE.dirName]);
  });

  test('記録と package.json の ID が違うフォルダは、どちらの設定でも除外しない', () => {
    const dirName = 'ms-python.python-9.9.9';
    install([{ dirName, manifestId: 'evil.tool', record: { id: 'ms-python.python', source: 'gallery' } }]);
    assert.deepStrictEqual(
      classify({ trustedPublishers: ['ms-python'], excludedExtensions: ['ms-python.python', 'evil.tool'] }).scanned,
      [dirName],
    );
  });

  test('package.json を読めないフォルダは、開発元では除外しない', () => {
    const dirName = 'ms-python.broken-1.0.0';
    install([{ dirName, record: { id: 'ms-python.broken', source: 'gallery' } }]);
    assert.deepStrictEqual(classify({ trustedPublishers: ['ms-python'] }).scanned, [dirName]);
  });

  test('開発元は完全一致で、似た名前やワイルドカードは一致しない', () => {
    install([MARKETPLACE]);
    for (const value of ['ms', 'ms-', 'ms-*', '*', 'ms-pytho', 'ms-python-tools', 'ms-python.python']) {
      assert.deepStrictEqual(classify({ trustedPublishers: [value] }).excluded, [], value);
    }
  });

  test('大文字と小文字、前後の空白を区別しない', () => {
    install([MARKETPLACE]);
    assert.strictEqual(classify({ trustedPublishers: [' MS-Python '] }).excluded.length, 1);
    assert.strictEqual(classify({ excludedExtensions: ['MS-PYTHON.Python'] }).excluded.length, 1);
  });

  test('拡張機能 ID の指定はインストール元を問わず除外する', () => {
    const dirName = 'noboon.cheatsheet-0.0.1';
    install([
      { dirName, manifestId: 'noboon.cheatsheet', record: { id: 'noboon.cheatsheet', source: 'vsix' } },
      MARKETPLACE,
    ]);
    assert.deepStrictEqual(classify({ excludedExtensions: ['noboon.cheatsheet'] }), {
      scanned: [MARKETPLACE.dirName],
      excluded: [{ dirName, id: 'noboon.cheatsheet', reason: 'extension' }],
    });
  });

  test('拡張機能 ID の指定は完全一致で、ワイルドカードは一致しない', () => {
    install([MARKETPLACE]);
    for (const value of ['ms-python.*', 'ms-python.pyth', 'ms-python']) {
      assert.deepStrictEqual(classify({ excludedExtensions: [value] }).excluded, [], value);
    }
  });

  test('extensions.json がなくても、拡張機能 ID の指定は package.json で判定する', () => {
    const dirName = 'noboon.cheatsheet-0.0.1';
    install([{ dirName, manifestId: 'noboon.cheatsheet' }]);
    fs.rmSync(path.join(root, 'extensions.json'));
    assert.strictEqual(classify({ excludedExtensions: ['noboon.cheatsheet'] }).excluded.length, 1);
  });
});
