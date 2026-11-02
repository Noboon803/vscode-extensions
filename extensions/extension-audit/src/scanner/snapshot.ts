import { RULESET_VERSION } from './rules';
import type { ExcludedExtension, ExtensionScan, Finding } from './types';

export interface AuditRecord {
  scan: ExtensionScan;
  scannedAt: string;
  /** 比較した以前のバージョン。初回や同じバージョンのみの場合は undefined */
  previousVersion?: string;
  /** 以前のバージョンから増えた項目 */
  added: Finding[];
}

export interface Snapshot {
  rulesetVersion: number;
  records: Record<string, AuditRecord>;
  /** 設定により検査していない拡張機能。以前のバージョンの結果には存在しない */
  excluded?: ExcludedExtension[];
}

export function emptySnapshot(): Snapshot {
  return { rulesetVersion: RULESET_VERSION, records: {} };
}

/** ビルドごとに変わるファイル名のハッシュは、差分の判定では無視する */
function normalizeFile(file: string): string {
  return file.replace(/[.-][0-9a-f]{8,}(?=\.[a-z]+$)/i, '');
}

function findingKey(finding: Finding): string {
  return `${finding.rule}\u0000${finding.detail}\u0000${normalizeFile(finding.file)}`;
}

function latestRecordOf(records: AuditRecord[]): AuditRecord | undefined {
  return records.reduce<AuditRecord | undefined>(
    (latest, record) => (!latest || record.scannedAt > latest.scannedAt ? record : latest),
    undefined,
  );
}

function diffRecord(scan: ExtensionScan, scannedAt: string, prior: AuditRecord[]): AuditRecord {
  const sameDir = prior.find((record) => record.scan.dirName === scan.dirName);
  const previous = sameDir ?? latestRecordOf(prior.filter((record) => record.scan.id === scan.id));
  // 前回が検査できていなければ、比較すると全項目が「増えた」ことになってしまう
  if (!previous || previous.scan.status === 'failed') {
    return { scan, scannedAt, added: [] };
  }

  const currentKeys = new Set(scan.findings.map(findingKey));
  const previousKeys = new Set(previous.scan.findings.map(findingKey));
  const added = scan.findings.filter((finding) => !previousKeys.has(findingKey(finding)));

  if (sameDir) {
    // 同じバージョンの再検査で、前回のバージョンアップの差分を消さない
    const carried = sameDir.added.filter((finding) => currentKeys.has(findingKey(finding)));
    const carriedKeys = new Set(carried.map(findingKey));
    return {
      scan,
      scannedAt,
      previousVersion: sameDir.previousVersion,
      added: [...carried, ...added.filter((finding) => !carriedKeys.has(findingKey(finding)))],
    };
  }
  return { scan, scannedAt, previousVersion: previous.scan.version, added };
}

/**
 * 検査結果を以前のスナップショットと比べて、次のスナップショットを作る。
 * currentDirNames は検査対象のフォルダの一覧で、今回検査していないものは以前の結果を引き継ぐ。
 * 含まれないフォルダ（削除や除外）の結果は消えるので、除外を解除すると差分の比較元もなくなる
 */
export function mergeSnapshot(
  previous: Snapshot,
  scans: ExtensionScan[],
  currentDirNames: string[],
  scannedAt: string,
  excluded: ExcludedExtension[] = [],
): Snapshot {
  // ルールが変わった結果と比べると、変化していない項目まで「増えた」ことになる
  const comparable = previous.rulesetVersion === RULESET_VERSION;
  const priorRecords = comparable ? Object.values(previous.records) : [];
  const records: Record<string, AuditRecord> = {};

  for (const dirName of currentDirNames) {
    const prior = comparable ? previous.records[dirName] : undefined;
    if (prior) {
      records[dirName] = prior;
    }
  }
  for (const scan of scans) {
    records[scan.dirName] = diffRecord(scan, scannedAt, priorRecords);
  }
  return { rulesetVersion: RULESET_VERSION, records, excluded };
}
