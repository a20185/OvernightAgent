import { detectRateLimitInStderr } from '@soulerou/oa-core';
import type { AgentHeartbeat } from '@soulerou/oa-core';

/**
 * Live liveness classifier for the codex headless adapter.
 *
 * Codex `exec` emits plain text — no structured event stream — so we can't
 * surface anything as rich as the claude parser's tool.use / session.init /
 * api.retry signals. What we *can* do is:
 *
 *   1. Count bytes as assistant output accumulates, emit `assistant.delta`
 *      (debounced) to prove the child is producing tokens rather than stuck.
 *   2. Sniff stderr lines for rate-limit phrases using the same
 *      `detectRateLimitInStderr` the post-hoc adapter already relies on,
 *      and emit `ratelimited` the first time we see one.
 *
 * That's enough to distinguish the two failure modes we cared about in the
 * k8m7 post-mortem ("producing but slow" vs "wedged"). Richer classification
 * would need a codex-side JSON stream mode, which doesn't exist today.
 *
 * Emission rules mirror the claude parser:
 *   - `assistant.delta`  debounced `debounceMs` (default 45 s), cumulative
 *                        byte counter. Pure liveness signal.
 *   - `ratelimited`      fires at most once per run (a second detection
 *                        wouldn't add information — the supervisor only
 *                        needs to know it happened).
 */
export interface CodexHeartbeatParserOpts {
  emit: (h: AgentHeartbeat) => void;
  debounceMs?: number;
  now?: () => number;
}

export interface CodexHeartbeatParser {
  onStdoutLine(line: string): void;
  onStderrLine(line: string): void;
  flush(): void;
}

const DEFAULT_DEBOUNCE_MS = 45_000;

export function createCodexHeartbeatParser(
  opts: CodexHeartbeatParserOpts,
): CodexHeartbeatParser {
  const emit = opts.emit;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = opts.now ?? ((): number => Date.now());

  let cumulativeBytes = 0;
  let pendingBytes = 0;
  let lastEmitMs = 0;
  let deltaEmittedOnce = false;
  let rateLimitEmitted = false;

  // First delta fires immediately so "child produced its first line" is an
  // observable edge; later emits are gated by `debounceMs`.
  const maybeFlushDelta = (force: boolean): void => {
    if (pendingBytes === 0) return;
    const t = now();
    if (!force && deltaEmittedOnce && t - lastEmitMs < debounceMs) return;
    emit({ kind: 'assistant.delta', cumulativeBytes });
    pendingBytes = 0;
    lastEmitMs = t;
    deltaEmittedOnce = true;
  };

  return {
    onStdoutLine(line: string): void {
      // Count the full line (plus one implied newline) as assistant bytes.
      // Codex stdout is the model's output verbatim — no per-line sidebar
      // metadata we'd need to exclude, unlike claude's stream-json.
      const n = Buffer.byteLength(line, 'utf8') + 1;
      cumulativeBytes += n;
      pendingBytes += n;
      maybeFlushDelta(false);
    },
    onStderrLine(line: string): void {
      if (rateLimitEmitted) return;
      const detection = detectRateLimitInStderr(line);
      if (!detection.rateLimited) return;
      rateLimitEmitted = true;
      emit(
        detection.retryAfterMs !== undefined
          ? { kind: 'ratelimited', retryAfterMs: detection.retryAfterMs }
          : { kind: 'ratelimited' },
      );
    },
    flush(): void {
      maybeFlushDelta(true);
    },
  };
}
