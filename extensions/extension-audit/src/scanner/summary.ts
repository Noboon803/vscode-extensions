import { LEVEL_LABELS, RULES } from './rules';
import type { AuditRecord } from './snapshot';
import type { Finding, Level, UninspectedReason } from './types';

export const UNINSPECTED_LABELS: Record<UninspectedReason, string> = {
  'manifest-error': 'package.json を読めない',
  'too-large': 'ファイルが大きすぎる',
  'parse-error': '構文解析に失敗',
  'read-error': 'ファイルを読めない',
  symlink: 'シンボリックリンク（辿らない）',
  timeout: '時間切れ',
  'worker-error': '検査処理が異常終了',
};

/**
 * レベルごとのルールの種類数。
 * DLL が 1000 個あっても「実行ファイル」1 種類として数え、件数で埋もれないようにする
 */
export function countRulesByLevel(findings: Finding[]): Record<Level, number> {
  const rules: Record<Level, Set<string>> = { high: new Set(), review: new Set(), info: new Set() };
  for (const finding of findings) {
    rules[RULES[finding.rule].level].add(finding.rule);
  }
  return { high: rules.high.size, review: rules.review.size, info: rules.info.size };
}

export function highestLevel(findings: Finding[]): Level | undefined {
  const counts = countRulesByLevel(findings);
  return counts.high > 0 ? 'high' : counts.review > 0 ? 'review' : counts.info > 0 ? 'info' : undefined;
}

/** 更新で参考以外の項目が増えているか */
export function hasNotableAdditions(record: AuditRecord): boolean {
  return record.added.some((finding) => RULES[finding.rule].level !== 'info');
}

/** 確認すべきものを先に並べる。検査できなかったものは問題なしに見えないよう上に置く */
export function compareRecords(a: AuditRecord, b: AuditRecord): number {
  const rank = (record: AuditRecord): number[] => {
    const counts = countRulesByLevel(record.scan.findings);
    return [
      record.scan.status === 'failed' ? 0 : 1,
      hasNotableAdditions(record) ? 0 : 1,
      -counts.high,
      record.scan.status === 'partial' ? 0 : 1,
      -counts.review,
      -counts.info,
    ];
  };
  const left = rank(a);
  const right = rank(b);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return a.scan.displayName.localeCompare(b.scan.displayName);
}

/** 一覧に表示する要約。何も検出しなくても「安全」とは書かない */
export function describeRecord(record: AuditRecord): string {
  const { scan, added } = record;
  const parts = scan.version ? [`v${scan.version}`] : [];
  if (scan.status === 'failed') {
    parts.push('検査不能');
    return parts.join(' · ');
  }
  const counts = countRulesByLevel(scan.findings);
  for (const level of ['high', 'review', 'info'] as const) {
    if (counts[level] > 0) {
      parts.push(`${LEVEL_LABELS[level]} ${counts[level]}`);
    }
  }
  if (added.length > 0) {
    parts.push(`増加 ${added.length}`);
  }
  if (scan.uninspected.length > 0) {
    parts.push(`検査不能 ${scan.uninspected.length}`);
  }
  if (scan.findings.length === 0 && scan.uninspected.length === 0) {
    parts.push('検出なし');
  }
  return parts.join(' · ');
}
