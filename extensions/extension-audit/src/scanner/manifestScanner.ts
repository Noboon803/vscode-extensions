import type { Finding, RuleId } from './types';

const MANIFEST_FILE = 'package.json';
const PACKAGE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);

export interface ManifestInfo {
  id?: string;
  version?: string;
  displayName?: string;
}

export interface ManifestScanResult {
  info: ManifestInfo;
  findings: Finding[];
  /** package.json を解釈できなかった場合のメッセージ */
  error?: string;
}

function finding(rule: RuleId, detail: string): Finding {
  return { rule, detail, file: MANIFEST_FILE, count: 1, locations: [] };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function scanManifest(text: string): ManifestScanResult {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { info: {}, findings: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(manifest)) {
    return { info: {}, findings: [], error: 'package.json の内容がオブジェクトではありません' };
  }

  const { publisher, name, version, displayName } = manifest;
  const info: ManifestInfo = {
    id: typeof publisher === 'string' && typeof name === 'string' ? `${publisher}.${name}`.toLowerCase() : undefined,
    version: typeof version === 'string' ? version : undefined,
    // %displayName% は翻訳ファイルへの参照で、そのままでは名前にならない
    displayName: typeof displayName === 'string' && !/^%.*%$/.test(displayName) ? displayName : undefined,
  };

  const findings: Finding[] = [];
  const activationEvents = stringsOf(manifest.activationEvents);
  if (activationEvents.includes('*')) {
    findings.push(finding('activation-all', '*'));
  }
  if (activationEvents.includes('onStartupFinished')) {
    findings.push(finding('activation-startup', 'onStartupFinished'));
  }

  if (isRecord(manifest.scripts)) {
    for (const [scriptName, command] of Object.entries(manifest.scripts)) {
      if (typeof command !== 'string') {
        continue;
      }
      if (scriptName === 'vscode:uninstall') {
        findings.push(finding('uninstall-script', command));
      } else if (PACKAGE_SCRIPTS.has(scriptName)) {
        findings.push(finding('package-script', `${scriptName}: ${command}`));
      }
    }
  }

  for (const id of [...stringsOf(manifest.extensionPack), ...stringsOf(manifest.extensionDependencies)]) {
    findings.push(finding('bundled-extension', id));
  }

  return { info, findings };
}
