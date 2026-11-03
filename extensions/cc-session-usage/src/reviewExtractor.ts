import { ClaudeError, type ClaudeResult } from './claudeRunner';
import { buildChunks, REVIEW_SCHEMA, REVIEW_SYSTEM_PROMPT, validateItems } from './reviewPrompt';
import type { ConversationTurn, ReviewItem } from './types';

export type ModelCall = (request: { systemPrompt: string; schema: object; input: string }) => Promise<ClaudeResult>;

export interface ChunkOutcome {
  items: ReviewItem[];
  rejected: number;
  costUsd: number;
  /** ここまでのターンを処理した */
  throughTurn: number;
}

/** from より後、until までのターンを順に処理し、チャンクごとに結果を知らせる。失敗したら以降は処理しない */
export async function analyzeTurns(turns: ConversationTurn[], from: number, until: number, call: ModelCall, onChunk: (outcome: ChunkOutcome) => Promise<void>): Promise<void> {
  const targets = turns.filter((turn) => turn.number > from && turn.number <= until);
  if (targets.every((turn) => turn.isCommand)) {
    // コマンドだけなら分類するものがない。費用をかけずに処理済みにする
    await onChunk({ items: [], rejected: 0, costUsd: 0, throughTurn: until });
    return;
  }
  for (const chunk of buildChunks(turns, from, until)) {
    const result = await call({ systemPrompt: REVIEW_SYSTEM_PROMPT, schema: REVIEW_SCHEMA, input: chunk.input });
    let validated;
    try {
      validated = validateItems(result.output, chunk, turns);
    } catch (error) {
      throw new ClaudeError(error instanceof Error ? error.message : String(error), result.costUsd);
    }
    await onChunk({ ...validated, costUsd: result.costUsd, throughTurn: chunk.lastTurn });
  }
}
