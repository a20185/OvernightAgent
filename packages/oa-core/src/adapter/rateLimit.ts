import type { AgentAdapter, AgentRunOpts, AgentRunResult } from './types.js';
import type { RateLimitBackoff } from '../schemas.js';

/**
 * ADR-0017 — Rate-limit backoff helpers.
 *
 * Two exports:
 *
 *   - `detectRateLimitInStderr(text)` — the shared regex-based detector
 *     used by the codex and opencode adapters (neither emits structured
 *     error events; stderr string-matching is the only signal available).
 *     Kept in oa-core so both adapters import the same behavior — tightening
 *     the regex in one place updates both without an adapter version bump.
 *
 *   - `runAdapterWithRateLimitBackoff(...)` — the supervisor-side wrapper
 *     that invokes `adapter.run(opts)`, inspects the result for
 *     `rateLimited: true`, and sleeps + retries up to
 *     `config.maxRetries` times before propagating the final result.
 *     Emits `step.ratelimit.wait/retry/give_up` events; does NOT increment
 *     the verify attempt counter (see ADR-0017 "Verify attempt counter is
 *     untouched").
 */

// Canonical set of provider phrases we treat as "rate-limited; safe to retry
// after a wait". Ordered from most specific to most generic so logs can hint
// at which signature fired (the matcher below captures the first group). The
// list is deliberately conservative — over-matching costs one wait, but a
// badly-worded real failure could leak in on a wide regex. Tighten per
// adapter as error surfaces stabilize.
const RATE_LIMIT_PATTERNS = [
  /rate[_ -]?limit/i,
  /quota\s+exceeded/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /try again (in|later)/i,
  /service unavailable/i,
];

// Numeric retry-after hints that sometimes appear alongside the phrases
// above. Example matches: "retry after 45s", "retry-after: 30", "try again
// in 60 seconds". Stops at the first match; absent, supervisor uses the
// configured default wait.
const RETRY_AFTER_PATTERNS = [
  /retry[\s_-]?after[:\s]+(\d+)\s*(s|sec|secs|seconds|ms|milliseconds)?/i,
  /try again in\s+(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes)?/i,
];

export interface RateLimitDetection {
  rateLimited: boolean;
  retryAfterMs?: number;
}

export function detectRateLimitInStderr(text: string): RateLimitDetection {
  if (text.length === 0) return { rateLimited: false };

  let rateLimited = false;
  for (const re of RATE_LIMIT_PATTERNS) {
    if (re.test(text)) {
      rateLimited = true;
      break;
    }
  }
  if (!rateLimited) return { rateLimited: false };

  let retryAfterMs: number | undefined;
  for (const re of RETRY_AFTER_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(n) || n < 0) continue;
    const unit = (m[2] ?? 's').toLowerCase();
    if (unit.startsWith('ms') || unit === 'milliseconds') {
      retryAfterMs = n;
    } else if (unit.startsWith('m') && !unit.startsWith('ms')) {
      // "m", "min", "mins", "minutes"
      retryAfterMs = n * 60 * 1000;
    } else {
      retryAfterMs = n * 1000;
    }
    break;
  }

  return retryAfterMs !== undefined
    ? { rateLimited: true, retryAfterMs }
    : { rateLimited: true };
}

export interface RateLimitBackoffContext {
  taskId: string;
  stepN: number;
  /**
   * The *verify* attempt number this rate-limit wrapper is guarding. Carried
   * purely for context in emitted events — the wrapper's own retry counter
   * (`attempt` on the emitted events) is independent.
   */
  verifyAttempt: number;
}

export interface RateLimitEventEmitter {
  emit(event: {
    kind: 'step.ratelimit.wait' | 'step.ratelimit.retry' | 'step.ratelimit.give_up';
    taskId: string;
    stepN: number;
    attempt: number;
    waitMs?: number;
    source?: string;
    retryAfterMs?: number;
    reason?: string;
  }): Promise<void>;
}

export interface RunWithRateLimitBackoffArgs {
  adapter: AgentAdapter;
  opts: AgentRunOpts;
  config: RateLimitBackoff;
  context: RateLimitBackoffContext;
  events: RateLimitEventEmitter;
  /**
   * Signal honoured during the sleep between retries. When the parent aborts
   * (e.g. `oa stop`), the wait returns early with the abort error so the
   * supervisor can short-circuit the retry loop cleanly.
   */
  abortSignal: AbortSignal;
  /**
   * Optional injection point for tests. Defaults to a real setTimeout-based
   * wait honouring `abortSignal`. Tests swap in a fake to keep suites fast.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function runAdapterWithRateLimitBackoff(
  args: RunWithRateLimitBackoffArgs,
): Promise<AgentRunResult> {
  const { adapter, opts, config, context, events, abortSignal } = args;
  const sleep = args.sleep ?? defaultSleep;

  // Retry loop: the FIRST run is attempt #1 of the rate-limit counter; each
  // subsequent retry bumps it. The loop exits when either the adapter returns
  // a non-rate-limited result OR we've exhausted `maxRetries`.
  let retryCount = 0;

  for (;;) {
    const result = await adapter.run(opts);

    if (!result.rateLimited) {
      return result;
    }

    // If the caller asked for detection-only (`maxRetries: 0`), emit
    // give_up immediately and propagate the rate-limited result. The
    // supervisor's existing failure path takes over.
    if (retryCount >= config.maxRetries) {
      await events.emit({
        kind: 'step.ratelimit.give_up',
        taskId: context.taskId,
        stepN: context.stepN,
        attempt: retryCount + 1,
        reason: `exceeded maxRetries=${String(config.maxRetries)}`,
      });
      return result;
    }

    retryCount += 1;

    const hinted = result.retryAfterMs;
    let waitMs = hinted ?? config.defaultWaitMs;
    if (config.maxWaitMs !== undefined && waitMs > config.maxWaitMs) {
      waitMs = config.maxWaitMs;
    }

    await events.emit({
      kind: 'step.ratelimit.wait',
      taskId: context.taskId,
      stepN: context.stepN,
      attempt: retryCount,
      waitMs,
      source: hinted !== undefined ? 'adapter-hint' : 'default',
      ...(hinted !== undefined ? { retryAfterMs: hinted } : {}),
    });

    try {
      await sleep(waitMs, abortSignal);
    } catch (err) {
      if ((err as Error).name === 'AbortError' || abortSignal.aborted) {
        await events.emit({
          kind: 'step.ratelimit.give_up',
          taskId: context.taskId,
          stepN: context.stepN,
          attempt: retryCount,
          reason: 'aborted during wait',
        });
        return result;
      }
      throw err;
    }

    await events.emit({
      kind: 'step.ratelimit.retry',
      taskId: context.taskId,
      stepN: context.stepN,
      attempt: retryCount,
    });
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
