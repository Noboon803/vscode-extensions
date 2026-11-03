import { localDay } from './dates';
import { normalizeModel, type RawUsage, requestCost } from './pricing';
import type { ConversationTurn, DailyUsage, SessionSummary, TokenCounts, TurnSummary } from './types';

/** 集計方法を変えたら上げる。保存済みの集計を作り直す */
export const PARSER_VERSION = 2;

const PROMPT_PREVIEW_LENGTH = 200;
/** ユーザーの発言の形で記録されるが、Claude Code が差し込んだもの */
const INJECTED_PREFIXES = [
  '<local-command',
  '<task-notification',
  '<system-reminder',
  '<bash-input',
  '<bash-stdout',
  '[Request interrupted',
];

/** 発言の中に差し込まれるブロック。分析の邪魔になるうえ、長いことがある */
const INJECTED_BLOCKS = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>/g;
/** 貼り付けた内容を囲むタグ。中身は発言の一部なので残す */
const PASTE_TAGS = /<\/?pasted_content[^>]*>/g;
const MAX_USER_CHARS = 4000;
/** 最後のメッセージが結論なので、長い応答は末尾を残す */
const MAX_ASSISTANT_CHARS = 2000;
const NO_PROMPT = '（最初の発言より前）';

type JsonRecord = Record<string, unknown>;

interface RequestEntry {
  model: string;
  usage: RawUsage;
  turn: MutableTurn;
  timestamp: number;
  isSubagent: boolean;
}

interface MutableTurn {
  startedAt: number;
  prompt: string;
  /** 分析に渡す発言の本文 */
  fullText: string;
  isCommand: boolean;
  /** 応答の本文の末尾。サブエージェントは含まない */
  assistant: string;
  toolCounts: Record<string, number>;
  tools: number;
  linesAdded: number;
  linesRemoved: number;
  files: Set<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(target: TokenCounts, source: TokenCounts): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function readUsage(usage: JsonRecord): RawUsage {
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const breakdown = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const cacheWrite1h = count(breakdown.ephemeral_1h_input_tokens);
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite,
    cacheWrite1h,
    // 内訳がなければ、単価の低い 5 分側として数える
    cacheWrite5m: Math.max(cacheWrite - cacheWrite1h, 0),
    speed: typeof usage.speed === 'string' ? usage.speed : undefined,
    inferenceGeo: typeof usage.inference_geo === 'string' ? usage.inference_geo : undefined,
  };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is JsonRecord => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join(' ');
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'tool_result');
}

function hasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'image');
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PROMPT_PREVIEW_LENGTH ? `${collapsed.slice(0, PROMPT_PREVIEW_LENGTH)}…` : collapsed;
}

/** ユーザーが始めたターンなら表示用の文字列を返す。それ以外は undefined */
function cleanText(text: string): string {
  const cleaned = text.replace(INJECTED_BLOCKS, '').replace(PASTE_TAGS, '').trim();
  if (cleaned.length <= MAX_USER_CHARS) {
    return cleaned;
  }
  const head = Math.floor(MAX_USER_CHARS * 0.7);
  return `${cleaned.slice(0, head)}\n…（中略）…\n${cleaned.slice(-(MAX_USER_CHARS - head))}`;
}

function promptOf(record: JsonRecord, message: JsonRecord): { text: string; fullText: string; isCommand: boolean } | undefined {
  if (record.isMeta === true || record.isCompactSummary === true || record.isSidechain === true) {
    return undefined;
  }
  const content = message.content;
  if (hasToolResult(content)) {
    return undefined;
  }
  // 通知や他のセッションからのメッセージは、ユーザーの発言ではない
  if (isRecord(record.origin) && record.origin.kind !== 'human') {
    return undefined;
  }
  const text = messageText(content);
  const trimmed = text.trimStart();
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined;
  }
  // スラッシュコマンドは `<command-message>` などに続いて記録される。文中の引用と区別するため先頭だけを見る
  if (trimmed.startsWith('<command-')) {
    const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed);
    const name = command ? command[1] : 'コマンド';
    return { text: name, fullText: name, isCommand: true };
  }
  if (trimmed === '') {
    return hasImage(content) ? { text: '（画像）', fullText: '（画像）', isCommand: false } : undefined;
  }
  return { text: preview(text), fullText: cleanText(text), isCommand: false };
}

/**
 * Claude Code の履歴（JSONL）を 1 行ずつ受け取って集計する。
 * 履歴の形式は Claude Code の内部仕様で、リリースごとに変わりうる。
 * 知らない行は読み飛ばし、読めるはずなのに読めなかった行だけを unreadableLines で知らせる。
 */
export class SessionParser {
  private readonly requests = new Map<string, RequestEntry>();
  private readonly turns: MutableTurn[] = [];
  private readonly turnByToolUse = new Map<string, MutableTurn>();
  private readonly seenToolUses = new Set<string>();
  private readonly seenEdits = new Set<string>();
  private unreadableLines = 0;
  private title: string | undefined;
  private cwd: string | undefined;
  private entrypoint: string | undefined;
  /** 直前の行が読めなかった。書き込み途中の最終行かもしれないので、次の行が来るまで数えない */
  private pendingUnreadable = false;
  private recordedCostUsd: number | undefined;
  private recordedStart = 0;
  private firstAt = 0;
  private lastAt = 0;

  constructor(
    private readonly id: string,
    private readonly projectDir: string,
  ) {}

  /** source.toolUseId はサブエージェントを起動したツール呼び出しの ID。親のターンに結びつける */
  addLine(line: string, source?: { isSubagent: boolean; toolUseId?: string }): void {
    if (line.trim() === '') {
      return;
    }
    if (this.pendingUnreadable) {
      this.unreadableLines++;
      this.pendingUnreadable = false;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.pendingUnreadable = true;
      return;
    }
    if (!isRecord(record)) {
      this.unreadableLines++;
      return;
    }
    const isSubagent = source?.isSubagent === true;
    switch (record.type) {
      case 'ai-title':
      case 'custom-title':
        if (!isSubagent) {
          const title = record.aiTitle ?? record.customTitle;
          if (typeof title === 'string') {
            this.title = title;
          }
        }
        break;
      case 'cost-state':
        if (!isSubagent && typeof record.totalCostUSD === 'number') {
          this.recordedCostUsd = record.totalCostUSD;
          this.recordedStart = count(record.startTime);
        }
        break;
      case 'user':
        this.addUser(record, isSubagent, source?.toolUseId);
        break;
      case 'assistant':
        this.addAssistant(record, isSubagent, source?.toolUseId);
        break;
      default:
        break;
    }
  }

  /** ファイルの区切りで呼ぶ。最終行は Claude Code が書き込んでいる途中のことがある */
  endFile(): void {
    this.pendingUnreadable = false;
  }

  private timestampOf(record: JsonRecord): number {
    const parsed = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (Number.isNaN(parsed)) {
      return 0;
    }
    if (this.firstAt === 0 || parsed < this.firstAt) {
      this.firstAt = parsed;
    }
    if (parsed > this.lastAt) {
      this.lastAt = parsed;
    }
    return parsed;
  }

  private newTurn(startedAt: number, prompt: string, fullText: string, isCommand: boolean): MutableTurn {
    const turn: MutableTurn = { startedAt, prompt, fullText, isCommand, assistant: '', toolCounts: {}, tools: 0, linesAdded: 0, linesRemoved: 0, files: new Set() };
    this.turns.push(turn);
    return turn;
  }

  /** リクエストや編集が属するターンを決める。サブエージェントは起動元のターンに数える */
  private turnFor(timestamp: number, isSubagent: boolean, toolUseId: string | undefined): MutableTurn {
    if (isSubagent) {
      const linked = toolUseId ? this.turnByToolUse.get(toolUseId) : undefined;
      if (linked) {
        return linked;
      }
      // 孫エージェントなど起動元が親の履歴にないものは、時刻で割り当てる
      const byTime = [...this.turns].reverse().find((turn) => turn.startedAt <= timestamp);
      if (byTime) {
        return byTime;
      }
    }
    return this.turns.at(-1) ?? this.newTurn(timestamp, NO_PROMPT, NO_PROMPT, false);
  }

  private addUser(record: JsonRecord, isSubagent: boolean, toolUseId: string | undefined): void {
    const timestamp = this.timestampOf(record);
    this.captureCwd(record, isSubagent);
    const message = record.message;
    if (!isRecord(message)) {
      return;
    }
    if (!isSubagent) {
      const prompt = promptOf(record, message);
      if (prompt) {
        this.newTurn(timestamp, prompt.text, prompt.fullText, prompt.isCommand);
        return;
      }
    }
    this.addEdit(record, timestamp, isSubagent, toolUseId);
  }

  private addEdit(record: JsonRecord, timestamp: number, isSubagent: boolean, toolUseId: string | undefined): void {
    const result = record.toolUseResult;
    if (!isRecord(result) || typeof result.filePath !== 'string' || !('structuredPatch' in result)) {
      return;
    }
    const uuid = typeof record.uuid === 'string' ? record.uuid : undefined;
    if (uuid) {
      if (this.seenEdits.has(uuid)) {
        return;
      }
      this.seenEdits.add(uuid);
    }
    const turn = this.turnFor(timestamp, isSubagent, toolUseId);
    turn.files.add(result.filePath);
    // 新規作成では差分（structuredPatch）が空になる
    if (result.type === 'create') {
      const content = typeof result.content === 'string' ? result.content : '';
      turn.linesAdded += content === '' ? 0 : content.split('\n').length;
      return;
    }
    if (!Array.isArray(result.structuredPatch)) {
      return;
    }
    for (const hunk of result.structuredPatch) {
      if (!isRecord(hunk) || !Array.isArray(hunk.lines)) {
        continue;
      }
      for (const patchLine of hunk.lines) {
        if (typeof patchLine === 'string' && patchLine.startsWith('+')) {
          turn.linesAdded++;
        } else if (typeof patchLine === 'string' && patchLine.startsWith('-')) {
          turn.linesRemoved++;
        }
      }
    }
  }

  private captureCwd(record: JsonRecord, isSubagent: boolean): void {
    if (isSubagent) {
      return;
    }
    if (this.cwd === undefined && typeof record.cwd === 'string') {
      this.cwd = record.cwd;
    }
    if (this.entrypoint === undefined && typeof record.entrypoint === 'string') {
      this.entrypoint = record.entrypoint;
    }
  }

  private addAssistant(record: JsonRecord, isSubagent: boolean, toolUseId: string | undefined): void {
    const timestamp = this.timestampOf(record);
    this.captureCwd(record, isSubagent);
    const message = record.message;
    if (!isRecord(message) || typeof message.model !== 'string') {
      this.unreadableLines++;
      return;
    }
    // API を呼ばずに Claude Code が作ったエラーメッセージなど
    if (message.model === '<synthetic>') {
      return;
    }
    // メイン側のサイドチェーンはサブエージェントと同じ扱いにする
    const sub = isSubagent || record.isSidechain === true;
    const turn = this.turnFor(timestamp, sub, toolUseId);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' && !this.seenToolUses.has(block.id)) {
          this.seenToolUses.add(block.id);
          turn.tools++;
          this.turnByToolUse.set(block.id, turn);
          if (!sub && typeof block.name === 'string') {
            turn.toolCounts[block.name] = (turn.toolCounts[block.name] ?? 0) + 1;
          }
        }
      }
      if (!sub) {
        const text = messageText(message.content).trim();
        if (text !== '') {
          const joined = turn.assistant === '' ? text : `${turn.assistant}\n${text}`;
          turn.assistant = joined.length > MAX_ASSISTANT_CHARS ? `…${joined.slice(-MAX_ASSISTANT_CHARS)}` : joined;
        }
      }
    }
    if (!isRecord(message.usage)) {
      this.unreadableLines++;
      return;
    }
    const id = typeof message.id === 'string' ? message.id : typeof record.uuid === 'string' ? record.uuid : undefined;
    if (!id) {
      this.unreadableLines++;
      return;
    }
    const usage = readUsage(message.usage);
    // 1 回の応答がブロックごとに複数行で記録される。合計すると倍近くに数えてしまう
    const existing = this.requests.get(id);
    if (existing) {
      if (usage.output >= existing.usage.output) {
        existing.usage = usage;
      }
      return;
    }
    this.requests.set(id, { model: normalizeModel(message.model), usage, turn, timestamp, isSubagent: sub });
  }

  /** 分析に渡す会話。番号は finish() が返すターンと一致する */
  conversation(): ConversationTurn[] {
    const called = new Set([...this.requests.values()].map((entry) => entry.turn));
    return this.turns
      .filter((turn) => !turn.isCommand || called.has(turn))
      .map((turn, index) => ({
        number: index + 1,
        at: turn.startedAt,
        user: turn.fullText,
        // 最初の発言より前のターンにはユーザーの発言がないので、コマンドと同じく分類しない
        isCommand: turn.isCommand || turn.prompt === NO_PROMPT,
        assistant: turn.assistant,
        tools: turn.toolCounts,
      }));
  }

  finish(): SessionSummary {
    const summaries = new Map<MutableTurn, TurnSummary>();
    const daily = new Map<string, DailyUsage>();
    let computedCostUsd = 0;
    let unpricedRequests = 0;

    for (const turn of this.turns) {
      summaries.set(turn, {
        startedAt: turn.startedAt,
        prompt: turn.prompt,
        requests: 0,
        tools: turn.tools,
        tokens: emptyTokens(),
        contextTokens: 0,
        costUsd: 0,
        subagentCostUsd: 0,
        linesAdded: turn.linesAdded,
        linesRemoved: turn.linesRemoved,
        filesChanged: turn.files.size,
      });
    }

    for (const entry of this.requests.values()) {
      const cost = requestCost(entry.model, entry.usage);
      if (cost === undefined) {
        unpricedRequests++;
      }
      const costUsd = cost ?? 0;
      computedCostUsd += costUsd;

      const summary = summaries.get(entry.turn);
      if (summary) {
        summary.requests++;
        addTokens(summary.tokens, entry.usage);
        summary.costUsd += costUsd;
        if (entry.isSubagent) {
          summary.subagentCostUsd += costUsd;
        } else {
          summary.contextTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
        }
      }

      const date = localDay(entry.timestamp || entry.turn.startedAt || this.lastAt);
      const key = `${date}\0${entry.model}`;
      const row = daily.get(key) ?? { date, model: entry.model, requests: 0, tokens: emptyTokens(), costUsd: 0 };
      row.requests++;
      addTokens(row.tokens, entry.usage);
      row.costUsd += costUsd;
      daily.set(key, row);
    }

    const turns = this.turns
      // /clear のようなローカルのコマンドはモデルを呼ばないので、ターンとして見せない
      .filter((turn) => !turn.isCommand || (summaries.get(turn)?.requests ?? 0) > 0)
      .map((turn) => summaries.get(turn) as TurnSummary);

    const startedAt = this.firstAt || this.recordedStart;
    return {
      id: this.id,
      projectDir: this.projectDir,
      cwd: this.cwd,
      title: this.title,
      entrypoint: this.entrypoint,
      startedAt,
      endedAt: this.lastAt || startedAt,
      turns,
      daily: [...daily.values()],
      computedCostUsd,
      recordedCostUsd: this.recordedCostUsd,
      unpricedRequests,
      unreadableLines: this.unreadableLines,
    };
  }
}
