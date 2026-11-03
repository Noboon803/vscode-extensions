import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanSource } from './codeScanner';
import { fallbackIdentity } from './discover';
import { scanManifest, type ManifestInfo } from './manifestScanner';
import type { ExtensionScan, Finding, ScanOptions, ScanTarget, Uninspected } from './types';

const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const EXECUTABLE_EXTENSIONS = new Set([
  '.node',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.sh',
  '.bash',
  '.zsh',
  '.bat',
  '.cmd',
  '.ps1',
  '.jar',
]);

/** ELF、Mach-O、PE の先頭バイト */
const BINARY_MAGICS = ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', '4d5a'];

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { maxFileBytes: 64 * 1024 * 1024 };

interface FileEntry {
  relative: string;
  absolute: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listFiles(root: string, uninspected: Uninspected[]): FileEntry[] {
  const files: FileEntry[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDir = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    } catch (error) {
      uninspected.push({ file: relativeDir, reason: 'read-error', message: toErrorMessage(error) });
      continue;
    }
    for (const entry of entries) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        // フォルダの外を読みに行かない
        uninspected.push({ file: relative, reason: 'symlink' });
      } else if (entry.isDirectory()) {
        pending.push(relative);
      } else if (entry.isFile()) {
        files.push({ relative, absolute: path.join(root, relative) });
      }
    }
  }
  return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/** 拡張子のないファイルは、先頭のバイトで実行ファイルかどうかを判断する */
function describeExtensionlessExecutable(absolute: string): string | undefined {
  const handle = fs.openSync(absolute, 'r');
  try {
    const head = Buffer.alloc(4);
    const length = fs.readSync(handle, head, 0, 4, 0);
    const hex = head.subarray(0, length).toString('hex');
    if (BINARY_MAGICS.some((magic) => hex.startsWith(magic))) {
      return 'バイナリ';
    }
    return hex.startsWith('2321') ? 'シェバン付きスクリプト' : undefined;
  } finally {
    fs.closeSync(handle);
  }
}

function statusOf(uninspected: Uninspected[], filesScanned: number, manifestFailed: boolean): ExtensionScan['status'] {
  if (manifestFailed && filesScanned === 0) {
    return 'failed';
  }
  return uninspected.length > 0 ? 'partial' : 'complete';
}

/** 拡張機能のフォルダを 1 つ検査する。読むだけで、書き込みも実行もしない */
export function scanExtension(target: ScanTarget, options: ScanOptions = DEFAULT_SCAN_OPTIONS): ExtensionScan {
  const uninspected: Uninspected[] = [];
  const findings: Finding[] = [];
  let info: ManifestInfo = {};
  let manifestFailed = false;

  try {
    const manifest = scanManifest(fs.readFileSync(path.join(target.path, 'package.json'), 'utf8'));
    info = manifest.info;
    findings.push(...manifest.findings);
    if (manifest.error) {
      manifestFailed = true;
      uninspected.push({ file: 'package.json', reason: 'manifest-error', message: manifest.error });
    }
  } catch (error) {
    manifestFailed = true;
    uninspected.push({ file: 'package.json', reason: 'manifest-error', message: toErrorMessage(error) });
  }

  let filesScanned = 0;
  let bytesScanned = 0;
  for (const { relative, absolute } of listFiles(target.path, uninspected)) {
    const extension = path.extname(relative).toLowerCase();
    try {
      if (CODE_EXTENSIONS.has(extension)) {
        const { size } = fs.statSync(absolute);
        if (size > options.maxFileBytes) {
          uninspected.push({ file: relative, reason: 'too-large', message: `${size} バイト` });
          continue;
        }
        const result = scanSource(fs.readFileSync(absolute, 'utf8'), relative);
        findings.push(...result.findings);
        if (result.parseError) {
          uninspected.push({ file: relative, reason: 'parse-error', message: result.parseError });
        }
        filesScanned += 1;
        bytesScanned += size;
      } else if (EXECUTABLE_EXTENSIONS.has(extension)) {
        findings.push({ rule: 'executable-file', detail: extension, file: relative, count: 1, locations: [] });
      } else if (extension === '') {
        const description = describeExtensionlessExecutable(absolute);
        if (description) {
          findings.push({ rule: 'executable-file', detail: description, file: relative, count: 1, locations: [] });
        }
      }
    } catch (error) {
      uninspected.push({ file: relative, reason: 'read-error', message: toErrorMessage(error) });
    }
  }

  const fallback = fallbackIdentity(target.dirName);
  return {
    dirName: target.dirName,
    id: info.id ?? fallback.id,
    version: info.version ?? fallback.version,
    displayName: info.displayName ?? info.id ?? target.dirName,
    status: statusOf(uninspected, filesScanned, manifestFailed),
    findings,
    uninspected,
    filesScanned,
    bytesScanned,
  };
}
