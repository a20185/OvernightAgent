import type { AgentHeartbeat } from '@soulerou/oa-core';

/**
 * Live stream-json classifier for the claude headless adapter.
 *
 * Claude's `--output-format stream-json` emits one JSON object per line. We
 * peek at each line as it arrives (via the spawn line-tap) and forward a
 * small set of meaningful events to the supervisor as AgentHeartbeats. This
 * is what makes "child is producing output but slowly" distinguishable from
 * "child is wedged" in `events.jsonl`, which is the k8m7 post-mortem gap
 * that motivated the heartbeat feature.
 *
 * Emission rules:
 *   - `session.init`  fires once, on the first `type=system subtype=init`
 *                     line (captures `session_id` + `model`).
 *   - `api.retry`     fires every time, on `type=system subtype=api_retry`.
 *                     These are the single most-useful liveness signal during
 *                     rate-limit storms — never debounce them.
 *   - `tool.use`      fires every time, on assistant content blocks of
 *                     type `tool_use`. Cheap and rare relative to text.
 *   - `assistant.delta` is *debounced* — we accumulate cumulative text/thinking
 *                     bytes per line and only emit at most once per
 *                     `debounceMs`. Pure liveness signal; the counter's
 *                     growth is the signal, not the value.
 *   - `ratelimited`   fires on the terminal `type=result` event when
 *                     `is_error=true api_error_status=429`. The supervisor
 *                     still gets the authoritative rate-limit decision from
 *                     the adapter's return value — we emit this purely for
 *                     observability parity with per-line events.
 *
 * Robustness: malformed / non-JSON lines are silently skipped. Parser
 * exceptions cannot escape (the spawn's line-tap wraps us in try/catch), but
 * we still guard the JSON-walk so a weird shape doesn't bleed between lines.
 */
export interface StreamJsonHeartbeatParserOpts {
  emit: (h: AgentHeartbeat) => void;
  /** Minimum ms between successive assistant.delta emissions. Defaults to 45 s. */
  debounceMs?: number;
  /** Injection point for tests — defaults to `Date.now`. */
  now?: () => number;
}

export interface StreamJsonHeartbeatParser {
  onLine(line: string): void;
  /** Force-emit any pending debounced assistant.delta on spawn exit. */
  flush(): void;
}

const DEFAULT_DEBOUNCE_MS = 45_000;

export function createStreamJsonHeartbeatParser(
  opts: StreamJsonHeartbeatParserOpts,
): StreamJsonHeartbeatParser {
  const emit = opts.emit;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = opts.now ?? ((): number => Date.now());

  let sessionInitEmitted = false;
  let cumulativeAssistantBytes = 0;
  let pendingDeltaBytes = 0;
  let lastDeltaEmitMs = 0;
  let deltaEmittedOnce = false;

  // The first delta fires immediately — it's the "child produced its first
  // token" signal, which is the most useful liveness edge we can surface.
  // Subsequent emits are rate-limited by `debounceMs`.
  const maybeFlushDelta = (force: boolean): void => {
    if (pendingDeltaBytes === 0) return;
    const t = now();
    if (!force && deltaEmittedOnce && t - lastDeltaEmitMs < debounceMs) return;
    emit({ kind: 'assistant.delta', cumulativeBytes: cumulativeAssistantBytes });
    pendingDeltaBytes = 0;
    lastDeltaEmitMs = t;
    deltaEmittedOnce = true;
  };

  const handleAssistantContent = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const bType = b.type;
      if (bType === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : '<unknown>';
        emit({ kind: 'tool.use', name });
      } else if (bType === 'text' && typeof b.text === 'string') {
        const n = Buffer.byteLength(b.text, 'utf8');
        cumulativeAssistantBytes += n;
        pendingDeltaBytes += n;
      } else if (bType === 'thinking' && typeof b.thinking === 'string') {
        const n = Buffer.byteLength(b.thinking, 'utf8');
        cumulativeAssistantBytes += n;
        pendingDeltaBytes += n;
      }
    }
    maybeFlushDelta(false);
  };

  return {
    onLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      const type = obj.type;
      if (type === 'system') {
        const subtype = obj.subtype;
        if (subtype === 'init' && !sessionInitEmitted) {
          const sessionId = typeof obj.session_id === 'string' ? obj.session_id : '';
          if (sessionId.length > 0) {
            const model = typeof obj.model === 'string' ? obj.model : undefined;
            sessionInitEmitted = true;
            emit(model !== undefined ? { kind: 'session.init', sessionId, model } : { kind: 'session.init', sessionId });
          }
        } else if (subtype === 'api_retry') {
          const attempt = typeof obj.attempt === 'number' ? obj.attempt : 0;
          const maxRetries = typeof obj.max_retries === 'number' ? obj.max_retries : undefined;
          const retryDelayMs =
            typeof obj.retry_delay_ms === 'number' ? obj.retry_delay_ms : undefined;
          const rawStatus = obj.error_status;
          const errorStatus =
            typeof rawStatus === 'number' ? rawStatus : rawStatus === null ? null : undefined;
          emit({
            kind: 'api.retry',
            attempt,
            ...(maxRetries !== undefined ? { maxRetries } : {}),
            ...(errorStatus !== undefined ? { errorStatus } : {}),
            ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
          });
        }
      } else if (type === 'assistant') {
        const message = obj.message;
        if (message !== null && typeof message === 'object') {
          handleAssistantContent((message as Record<string, unknown>).content);
        } else {
          handleAssistantContent(obj.content);
        }
      } else if (type === 'result') {
        if (
          obj.is_error === true &&
          (obj.api_error_status === 429 || obj.api_error_status === '429')
        ) {
          const retryAfter = obj.retry_after_seconds;
          const retryAfterMs =
            typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
              ? Math.floor(retryAfter * 1000)
              : undefined;
          emit(retryAfterMs !== undefined ? { kind: 'ratelimited', retryAfterMs } : { kind: 'ratelimited' });
        }
      }
    },
    flush(): void {
      maybeFlushDelta(true);
    },
  };
}
