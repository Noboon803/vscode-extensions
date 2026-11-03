import type { TokenCounts } from './types';

/** 1M トークンあたりの米ドル（Anthropic の定価、2026-10-06 時点） */
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES_AS_OF = '2026-10-06';

const RATES: Record<string, Rates> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

/** Haiku 5.5 はプロンプトが 10 万トークンを超えると単価が 5 倍になる */
const HAIKU_5_5_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_5_5_LONG_PROMPT_MULTIPLIER = 5;
const FAST_MODE_MULTIPLIER = 2;
const DATA_RESIDENCY_MULTIPLIER = 1.1;
/** キャッシュ書き込みは保持期間で単価が変わる。ほとんどのリクエストは 1 時間側 */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

export interface RawUsage extends TokenCounts {
  cacheWrite5m: number;
  cacheWrite1h: number;
  speed?: string;
  inferenceGeo?: string;
}

/** `claude-haiku-4-5-20251001` や `claude-opus-5[1m]` を単価表のキーにそろえる */
export function normalizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/** 単価が分からないモデルは undefined を返す。0 円として扱うと気づけないため */
export function requestCost(model: string, usage: RawUsage): number | undefined {
  const normalized = normalizeModel(model);
  const rates = RATES[normalized];
  if (!rates) {
    return undefined;
  }
  let multiplier = 1;
  if (normalized === 'claude-haiku-5-5') {
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > HAIKU_5_5_LONG_PROMPT_TOKENS) {
      multiplier *= HAIKU_5_5_LONG_PROMPT_MULTIPLIER;
    }
  }
  if (usage.speed === 'fast') {
    multiplier *= FAST_MODE_MULTIPLIER;
  }
  if (usage.inferenceGeo === 'us') {
    multiplier *= DATA_RESIDENCY_MULTIPLIER;
  }
  const perMillion =
    usage.input * rates.input +
    usage.output * rates.output +
    usage.cacheRead * rates.cacheRead +
    usage.cacheWrite5m * rates.input * CACHE_WRITE_5M_MULTIPLIER +
    usage.cacheWrite1h * rates.input * CACHE_WRITE_1H_MULTIPLIER;
  return (perMillion * multiplier) / 1_000_000;
}
