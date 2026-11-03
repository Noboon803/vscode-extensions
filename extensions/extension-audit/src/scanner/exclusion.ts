import * as fs from 'node:fs';
import * as path from 'node:path';
import { fallbackIdentity } from './discover';
import type { ExcludedExtension, ScanTarget } from './types';

/** 拡張機能の起動時に読み込むので、構文解析器（acorn）に依存させない */

export interface ExclusionSettings {
  /** 開発元 ID（完全一致）。Marketplace からインストールしたものだけを除外する */
  trustedPublishers: readonly string[];
  /** 拡張機能 ID（完全一致）。インストール元を問わず除外する */
  excludedExtensions: readonly string[];
}

export interface ClassifiedTargets {
  targets: ScanTarget[];
  excluded: ExcludedExtension[];
}

interface InstallRecord {
  id: string;
  source: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** VS Code が記録しているインストール情報を、フォルダ名で引けるようにする */
function readInstallRecords(extensionsRoot: string): Map<string, InstallRecord> {
  const records = new Map<string, InstallRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(extensionsRoot, 'extensions.json'), 'utf8'));
  } catch {
    // 読めなければインストール元を確認できないので、開発元による除外は行わない
    return records;
  }
  if (!Array.isArray(parsed)) {
    return records;
  }
  for (const entry of parsed) {
    if (!isRecord(entry) || !isRecord(entry.identifier) || typeof entry.identifier.id !== 'string') {
      continue;
    }
    const location = isRecord(entry.location) ? entry.location.path : undefined;
    const dirName =
      typeof entry.relativeLocation === 'string'
        ? entry.relativeLocation
        : typeof location === 'string'
          ? path.posix.basename(location)
          : undefined;
    if (dirName) {
      records.set(dirName, {
        id: entry.identifier.id.toLowerCase(),
        source: isRecord(entry.metadata) ? entry.metadata.source : undefined,
      });
    }
  }
  return records;
}

function readManifestId(directory: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8').replace(/^﻿/, ''));
    if (isRecord(manifest) && typeof manifest.publisher === 'string' && typeof manifest.name === 'string') {
      return `${manifest.publisher}.${manifest.name}`.toLowerCase();
    }
  } catch {
    // 読めないものは ID を確認できないので、除外の判定で一致しない
  }
  return undefined;
}

function normalized(values: readonly string[]): Set<string> {
  return new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim().toLowerCase()));
}

/**
 * 検査対象と除外対象に分ける。
 *
 * 誰でも自作の VSIX で他の開発元を名乗れるので、開発元による除外は
 * Marketplace からのインストールで、VS Code の記録と package.json の ID が一致するものに限る。
 * 判断できないものは常に検査対象に残す
 */
export function classifyTargets(
  extensionsRoot: string,
  targets: ScanTarget[],
  settings: ExclusionSettings,
): ClassifiedTargets {
  const trusted = normalized(settings.trustedPublishers);
  const excludedIds = normalized(settings.excludedExtensions);
  if (trusted.size === 0 && excludedIds.size === 0) {
    return { targets, excluded: [] };
  }

  const installRecords = readInstallRecords(extensionsRoot);
  const result: ClassifiedTargets = { targets: [], excluded: [] };

  for (const target of targets) {
    const record = installRecords.get(target.dirName);
    const manifestId = readManifestId(target.path);
    const consistent = !record || !manifestId || record.id === manifestId;
    const id = record?.id ?? manifestId ?? fallbackIdentity(target.dirName).id;

    if (consistent && excludedIds.has(id)) {
      result.excluded.push({ dirName: target.dirName, id, reason: 'extension' });
    } else if (
      consistent &&
      record?.source === 'gallery' &&
      manifestId !== undefined &&
      trusted.has(id.slice(0, id.indexOf('.')))
    ) {
      result.excluded.push({ dirName: target.dirName, id, reason: 'publisher' });
    } else {
      result.targets.push(target);
    }
  }
  return result;
}
