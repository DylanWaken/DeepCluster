/** Five-second live output rate from locally tokenized stream deltas. */
import type { AgentTokenSample } from './types.ts'

/** Fixed interval displayed by the live worker throughput metric. */
export const TOKEN_WINDOW_MS = 5000

/**
 * Average signed tokenizer deltas observed in the trailing five seconds.
 * @param samples - token deltas retained for the current worker attempt.
 * @param now - current wall-clock milliseconds on the observing client.
 * @returns tokens per second, clamped at zero after tokenizer prefix corrections.
 */
export function rollingTokenRate(samples: readonly AgentTokenSample[], now: number): number {
  const total = samples.reduce((count, sample) => sample.observedAt > now - TOKEN_WINDOW_MS && sample.observedAt <= now
    ? count + sample.tokens : count, 0)
  return Math.max(0, total) / (TOKEN_WINDOW_MS / 1000)
}
