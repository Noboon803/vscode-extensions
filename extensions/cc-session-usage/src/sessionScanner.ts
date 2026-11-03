import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { SessionParser } from './sessionParser';
import type { SessionSummary } from './types';

export interface SessionFiles {
  key: string;
  id: string;
  projectDir: string;
  transcript: string;
  subagents: string[];
  /** ファイルの更新を検知するための値。変わっていなければ読み直さない */
  fingerprint: string;
}

export interface ScanResult {
  /** 読み直したセッション */
  changed: { key: string; fingerprint: string; summary: SessionSummary }[];
  /** 今もファイルが存在するセッション */
  presentKeys: string[];
  failures: { key: string; message: string }[];
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function listJsonl(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir, { recursive: true });
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)).sort();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

export async function discoverSessions(configDir: string): Promise<SessionFiles[]> {
  const projectsDir = path.join(configDir, 'projects');
  let projects: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projects = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const sessions: SessionFiles[] = [];
  for (const projectDir of projects) {
    const projectPath = path.join(projectsDir, projectDir);
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      // `.orphaned-` は Claude Code が退避した古い履歴で、再開の一覧にも出ない
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.includes('.orphaned-')) {
        continue;
      }
      const id = entry.name.slice(0, -'.jsonl'.length);
      const transcript = path.join(projectPath, entry.name);
      const subagents = await listJsonl(path.join(projectPath, id, 'subagents'));
      const stats = await Promise.all([transcript, ...subagents].map((file) => stat(file)));
      const fingerprint = stats.map((item) => `${item.size}:${item.mtimeMs}`).join('|');
      sessions.push({ key: `${projectDir}/${id}`, id, projectDir, transcript, subagents, fingerprint });
    }
  }
  return sessions;
}

async function readLines(file: string, onLine: (line: string) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    onLine(line);
  }
}

async function readToolUseId(transcript: string): Promise<string | undefined> {
  try {
    const meta: unknown = JSON.parse(await readFile(`${transcript.slice(0, -'.jsonl'.length)}.meta.json`, 'utf8'));
    const toolUseId = (meta as { toolUseId?: unknown } | null)?.toolUseId;
    return typeof toolUseId === 'string' ? toolUseId : undefined;
  } catch {
    return undefined;
  }
}

export async function parseSession(files: SessionFiles): Promise<SessionSummary> {
  const parser = new SessionParser(files.id, files.projectDir);
  await readLines(files.transcript, (line) => parser.addLine(line));
  parser.endFile();
  // 親の履歴を先に読み、起動元のツール呼び出しを把握してからサブエージェントを読む
  for (const file of files.subagents) {
    const source = { isSubagent: true, toolUseId: await readToolUseId(file) };
    await readLines(file, (line) => parser.addLine(line, source));
    parser.endFile();
  }
  return parser.finish();
}

export async function scanSessions(configDir: string, known: Record<string, string>): Promise<ScanResult> {
  const sessions = await discoverSessions(configDir);
  const result: ScanResult = { changed: [], presentKeys: sessions.map((session) => session.key), failures: [] };
  for (const session of sessions) {
    if (known[session.key] === session.fingerprint) {
      continue;
    }
    try {
      result.changed.push({ key: session.key, fingerprint: session.fingerprint, summary: await parseSession(session) });
    } catch (error) {
      // 読んでいる途中で削除されることがある。1 件のために全体を止めない
      result.failures.push({ key: session.key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
