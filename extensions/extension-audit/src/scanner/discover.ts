import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionScan, ScanTarget, Uninspected } from './types';

/** 拡張機能の起動時に読み込むので、構文解析器（acorn）に依存させない */

export function fallbackIdentity(dirName: string): { id: string; version: string } {
  const match = /^(.+?)-(\d+\.\d+\.\d+.*)$/.exec(dirName);
  return match ? { id: match[1].toLowerCase(), version: match[2] } : { id: dirName.toLowerCase(), version: '' };
}

/** ワーカーが異常終了した場合など、検査そのものができなかったときの結果 */
export function failedScan(target: ScanTarget, reason: Uninspected['reason'], message: string): ExtensionScan {
  const { id, version } = fallbackIdentity(target.dirName);
  return {
    dirName: target.dirName,
    id,
    version,
    displayName: target.dirName,
    status: 'failed',
    findings: [],
    uninspected: [{ file: '', reason, message }],
    filesScanned: 0,
    bytesScanned: 0,
  };
}

/**
 * インストール先の直下にあるフォルダを列挙する。
 * VS Code が削除待ちにしている古いバージョン（.obsolete に記録）は除く
 */
export function discoverExtensions(extensionsRoot: string): ScanTarget[] {
  let obsolete: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(extensionsRoot, '.obsolete'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      obsolete = parsed as Record<string, unknown>;
    }
  } catch {
    // .obsolete がなければ削除待ちはない。壊れていても、全部を検査すれば見落としにはならない
  }
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !obsolete[entry.name])
    .filter((entry) => {
      const absolute = path.join(extensionsRoot, entry.name);
      return entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory());
    })
    .map((entry) => ({ dirName: entry.name, path: path.join(extensionsRoot, entry.name) }))
    .sort((a, b) => (a.dirName < b.dirName ? -1 : 1));
}
