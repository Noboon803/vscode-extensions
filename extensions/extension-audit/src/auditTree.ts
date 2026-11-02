import * as vscode from 'vscode';
import { LEVEL_LABELS, LEVEL_ORDER, RULES } from './scanner/rules';
import type { AuditRecord, Snapshot } from './scanner/snapshot';
import { compareRecords, describeRecord, highestLevel, UNINSPECTED_LABELS } from './scanner/summary';
import type { ExcludedExtension, Finding, Level, RuleId, Uninspected } from './scanner/types';

export const OPEN_FINDING_COMMAND = 'extensionAudit.openFinding';

type AuditNode =
  | { kind: 'excluded-group'; excluded: ExcludedExtension[] }
  | { kind: 'excluded'; item: ExcludedExtension }
  | { kind: 'extension'; record: AuditRecord }
  | { kind: 'added'; record: AuditRecord }
  | { kind: 'uninspected-group'; record: AuditRecord }
  | { kind: 'uninspected'; record: AuditRecord; item: Uninspected }
  | { kind: 'rule'; record: AuditRecord; rule: RuleId; findings: Finding[] }
  | { kind: 'finding'; record: AuditRecord; finding: Finding; showRule: boolean };

const LEVEL_ICONS: Record<Level, vscode.ThemeIcon> = {
  high: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
  review: new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')),
  info: new vscode.ThemeIcon('info'),
};

/** 検出していないものに、安全を連想させるチェックマークを使わない */
const NO_FINDINGS_ICON = new vscode.ThemeIcon('circle-outline');
const UNINSPECTED_ICON = new vscode.ThemeIcon('question');
const EXCLUDED_ICON = new vscode.ThemeIcon('circle-slash');
const EXCLUDED_REASONS: Record<ExcludedExtension['reason'], string> = {
  extension: '拡張機能の指定で除外',
  publisher: '信頼する開発元',
};

function levelIcon(level: Level | undefined): vscode.ThemeIcon {
  return level ? LEVEL_ICONS[level] : NO_FINDINGS_ICON;
}

/** 検査結果の一覧。ラベルは対象の拡張機能に由来するので、Markdown としては解釈させない */
export class AuditTreeProvider implements vscode.TreeDataProvider<AuditNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private snapshot: Snapshot | undefined;

  setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.changed.fire();
  }

  getChildren(node?: AuditNode): AuditNode[] {
    if (!node) {
      const records = Object.values(this.snapshot?.records ?? {})
        .sort(compareRecords)
        .map((record): AuditNode => ({ kind: 'extension', record }));
      // 除外したものも一覧から消さず、検査していないことが分かるようにする
      const excluded = this.snapshot?.excluded ?? [];
      return excluded.length > 0 ? [...records, { kind: 'excluded-group', excluded }] : records;
    }
    switch (node.kind) {
      case 'excluded-group':
        return node.excluded.map((item) => ({ kind: 'excluded', item }));
      case 'extension':
        return this.extensionChildren(node.record);
      case 'added':
        return sortFindings(node.record.added).map((finding) => ({ kind: 'finding', record: node.record, finding, showRule: true }));
      case 'uninspected-group':
        return node.record.scan.uninspected.map((item) => ({ kind: 'uninspected', record: node.record, item }));
      case 'rule':
        return node.findings.map((finding) => ({ kind: 'finding', record: node.record, finding, showRule: false }));
      default:
        return [];
    }
  }

  getTreeItem(node: AuditNode): vscode.TreeItem {
    switch (node.kind) {
      case 'excluded-group': {
        const item = new vscode.TreeItem('検査していない拡張機能', vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${node.excluded.length} 個`;
        item.tooltip = '設定により検査を省略しています。問題がないことを確認したものではありません。';
        item.iconPath = EXCLUDED_ICON;
        return item;
      }
      case 'excluded': {
        const item = new vscode.TreeItem(node.item.id, vscode.TreeItemCollapsibleState.None);
        item.description = EXCLUDED_REASONS[node.item.reason];
        item.tooltip = `${node.item.dirName}\n設定により検査を省略しています。`;
        item.iconPath = EXCLUDED_ICON;
        return item;
      }
      case 'extension':
        return this.extensionItem(node.record);
      case 'added': {
        const from = node.record.previousVersion ? `v${node.record.previousVersion} から` : '前回から';
        const item = new vscode.TreeItem(`${from}増えた項目`, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${node.record.added.length} 件`;
        item.iconPath = new vscode.ThemeIcon('diff-added');
        return item;
      }
      case 'uninspected-group': {
        const item = new vscode.TreeItem('検査できなかったファイル', vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${node.record.scan.uninspected.length} 件`;
        item.iconPath = UNINSPECTED_ICON;
        item.tooltip = 'このファイルの内容は確認できていません。問題がないという意味ではありません。';
        return item;
      }
      case 'uninspected': {
        const item = new vscode.TreeItem(node.item.file || '拡張機能全体', vscode.TreeItemCollapsibleState.None);
        item.description = UNINSPECTED_LABELS[node.item.reason];
        item.tooltip = node.item.message ?? UNINSPECTED_LABELS[node.item.reason];
        item.iconPath = UNINSPECTED_ICON;
        return item;
      }
      case 'rule': {
        const rule = RULES[node.rule];
        const item = new vscode.TreeItem(rule.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${LEVEL_LABELS[rule.level]} · ${node.findings.length} 件`;
        item.tooltip = rule.explanation;
        item.iconPath = LEVEL_ICONS[rule.level];
        return item;
      }
      case 'finding':
        return this.findingItem(node.record, node.finding, node.showRule);
    }
  }

  private extensionChildren(record: AuditRecord): AuditNode[] {
    const children: AuditNode[] = [];
    if (record.added.length > 0) {
      children.push({ kind: 'added', record });
    }
    if (record.scan.uninspected.length > 0) {
      children.push({ kind: 'uninspected-group', record });
    }
    const groups = new Map<RuleId, Finding[]>();
    for (const finding of record.scan.findings) {
      groups.set(finding.rule, [...(groups.get(finding.rule) ?? []), finding]);
    }
    const rules = [...groups.keys()].sort(
      (a, b) => LEVEL_ORDER[RULES[a].level] - LEVEL_ORDER[RULES[b].level] || RULES[a].title.localeCompare(RULES[b].title),
    );
    for (const rule of rules) {
      children.push({ kind: 'rule', record, rule, findings: groups.get(rule) ?? [] });
    }
    return children;
  }

  private extensionItem(record: AuditRecord): vscode.TreeItem {
    const { scan } = record;
    const item = new vscode.TreeItem(scan.displayName, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = describeRecord(record);
    item.tooltip = [
      scan.id,
      `コード ${scan.filesScanned} ファイルを検査`,
      `検査日時: ${new Date(record.scannedAt).toLocaleString()}`,
      '検出がなくても、安全であることの証明ではありません。',
    ].join('\n');
    item.iconPath = scan.status === 'failed' ? UNINSPECTED_ICON : levelIcon(highestLevel(scan.findings));
    if (scan.findings.length === 0 && scan.uninspected.length === 0) {
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
    }
    return item;
  }

  private findingItem(record: AuditRecord, finding: Finding, showRule: boolean): vscode.TreeItem {
    const rule = RULES[finding.rule];
    const location = finding.locations[0];
    const position = location ? `${finding.file}:${location.line}` : finding.file;
    const label = showRule ? rule.title : finding.detail || position;
    const item = new vscode.TreeItem(label.slice(0, 200), vscode.TreeItemCollapsibleState.None);

    const description = [];
    if (showRule && finding.detail) {
      description.push(finding.detail.slice(0, 200));
    }
    if (showRule || finding.detail) {
      description.push(position);
    }
    if (finding.count > 1) {
      description.push(`全 ${finding.count} 箇所`);
    }
    item.description = description.join(' · ');
    item.tooltip = [rule.explanation, finding.excerpt].filter(Boolean).join('\n\n');
    item.iconPath = showRule ? LEVEL_ICONS[rule.level] : undefined;
    item.command = {
      command: OPEN_FINDING_COMMAND,
      title: '検出箇所を開く',
      arguments: [record.scan.dirName, finding],
    };
    return item;
  }
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => LEVEL_ORDER[RULES[a.rule].level] - LEVEL_ORDER[RULES[b.rule].level]);
}
