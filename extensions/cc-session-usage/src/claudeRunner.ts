import { spawn } from 'node:child_process';

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 20 * 1024 * 1024;
/** 1 回の呼び出しの費用の上限。最も高いモデルでも想定を上回る値で、暴走したときだけ止まる */
const MAX_BUDGET_USD = '2';

export interface ClaudeRequest {
  claudePath: string;
  model: string;
  systemPrompt: string;
  schema: object;
  input: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface ClaudeResult {
  output: unknown;
  costUsd: number;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    /** 失敗しても課金された分 */
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/**
 * 会話履歴の本文を扱うので、モデルに何もさせないよう隔離して呼ぶ。
 * ツール、MCP、スラッシュコマンド、利用者の設定（フック、CLAUDE.md）をすべて切り、
 * 履歴にも残さない。履歴に残すと、この呼び出し自体が使用量と分析の対象になる。
 */
export function claudeArgs(request: Pick<ClaudeRequest, 'model' | 'systemPrompt' | 'schema'>): string[] {
  return [
    '-p',
    '--model',
    request.model,
    '--output-format',
    'json',
    '--system-prompt',
    request.systemPrompt,
    '--json-schema',
    JSON.stringify(request.schema),
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-budget-usd',
    MAX_BUDGET_USD,
  ];
}

export function parseResult(stdout: string): ClaudeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ClaudeError(`claude の出力を解釈できませんでした: ${stdout.slice(0, 200)}`);
  }
  const result = parsed as { is_error?: unknown; subtype?: unknown; result?: unknown; total_cost_usd?: unknown; structured_output?: unknown } | null;
  const costUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : 0;
  if (result?.is_error === true || result?.structured_output === undefined) {
    const detail = typeof result?.result === 'string' ? result.result : String(result?.subtype ?? '構造化された出力がありません');
    throw new ClaudeError(`claude がエラーを返しました: ${detail.slice(0, 300)}`, costUsd);
  }
  return { output: result.structured_output, costUsd };
}

export function runClaude(request: ClaudeRequest): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    // Claude Code の中から VS Code を起動していても、入れ子の実行として扱われないようにする
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // シェルを介さないので、引数の中身は解釈されない
    const child = spawn(request.claudePath, claudeArgs(request), {
      cwd: request.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: request.signal,
    });
    let stdout = '';
    let stderr = '';
    let failure: ClaudeError | undefined;
    const fail = (message: string) => {
      failure ??= new ClaudeError(message);
      child.kill();
    };
    const timer = setTimeout(() => fail('claude の応答が時間内に終わりませんでした'), TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      if (stdout.length + data.length > MAX_OUTPUT_CHARS) {
        fail('claude の出力が大きすぎます');
      } else {
        stdout += data;
      }
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-2000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.name === 'AbortError') {
        reject(new ClaudeError('取り消しました'));
      } else if (error.code === 'ENOENT') {
        reject(new ClaudeError(`claude コマンドが見つかりません（${request.claudePath}）。設定 ccSessionUsage.claudePath を確認してください`));
      } else {
        reject(new ClaudeError(`claude を起動できませんでした: ${error.message}`));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      try {
        resolve(parseResult(stdout));
      } catch (error) {
        // 出力がないときは stderr のほうが原因を示している
        reject(stdout.trim() === '' ? new ClaudeError(`claude が終了コード ${code} で終了しました: ${stderr.trim().slice(0, 300)}`) : error);
      }
    });
    // 先に終了すると stdin への書き込みが失敗する。原因は close 側で報告する
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.input);
  });
}
