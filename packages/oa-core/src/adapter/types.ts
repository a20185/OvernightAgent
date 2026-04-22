/**
 * AgentAdapter — the single small interface every executor adapter implements.
 *
 * Per ADR-0009 the supervisor stays agent-agnostic by depending only on this
 * interface; each concrete adapter (Claude, Codex, opencode) lives in its own
 * monorepo package and depends only on `oa-core`'s public types. This file is
 * types-only on purpose — no runtime logic, no imports from the rest of
 * `oa-core`. Phase 5 follow-ups (Tasks 5.2 spawnHeadless, 5.3 oa-adapter-claude,
 * 5.4 registry) all consume the contract defined here.
 *
 * Cross-reference: `schemas.ts` defines an `AgentId` *zod enum* with the same
 * literal set; the literal-string union below is duplicated rather than
 * re-derived so this file has zero `oa-core` imports. A compile-only test in
 * `test/adapter/types.test.ts` asserts both definitions stay aligned — if the
 * sets ever drift, the assignability check fails to compile.
 */

export type AgentId = 'claude' | 'codex' | 'opencode';

/**
 * Inputs handed to `AgentAdapter.run`. All path fields are absolute and the
 * adapter is expected to assert that with `assertAbs` (or equivalent) before
 * spawning — the supervisor constructs them under the worktree root, but
 * defence-in-depth keeps a misuse from spawning under `cwd=process.cwd()`.
 *
 * `signal` is the supervisor's graceful-stop channel; `timeoutSec` /
 * `stdoutCapBytes` are the hard wall-clock and byte budgets the adapter
 * enforces with `kill -KILL` if exceeded (see Task 5.2 spawnHeadless).
 */
export interface AgentRunOpts {
  cwd: string;
  promptPath: string;
  model: string;
  extraArgs: string[];
  env?: Record<string, string>;
  timeoutSec: number;
  stdoutCapBytes: number;
  stdoutPath: string;
  stderrPath: string;
  signal: AbortSignal;
  onSpawned?: (control: AgentRunControl) => void;
  /** Absolute path to a per-attempt sandbox-exec profile (macOS only). See ADR-0016. */
  sandboxProfile?: string;
  /**
   * Live progress callback invoked by the adapter as it parses the child's
   * output stream. The supervisor forwards each heartbeat to `events.jsonl`
   * as `step.heartbeat` so operators can distinguish "child is working slowly"
   * from "child is wedged" without waiting for `step.agent.exit`.
   *
   * Contract: best-effort, never blocks the adapter. Adapters that don't
   * implement live parsing simply never call this. Emission cadence is
   * adapter-specific — some events (session.init, tool.use, api.retry,
   * ratelimited) fire on every signal; high-frequency ones (assistant.delta)
   * are debounced inside the adapter.
   */
  onHeartbeat?: (h: AgentHeartbeat) => void;
}

export interface AgentRunControl {
  killNow(): void;
}

/**
 * Live heartbeat payload emitted by adapters while the child runs. The set is
 * a discriminated union; forward-compat consumers should default-case to
 * "ignore / emit as-is" to tolerate new `kind`s added in later adapter
 * versions.
 *
 * - `session.init` — agent-assigned session/request id parsed from first
 *   structured event. Fires once. Claude: `session_id` from `type=system
 *   subtype=init`; codex doesn't emit one (adapter skips).
 * - `assistant.delta` — cumulative bytes of assistant-authored output
 *   (text + thinking) since session start. Debounced per-adapter; used purely
 *   as a liveness signal — a growing counter means the child is producing.
 * - `tool.use` — a tool invocation by the agent. Emitted every time; useful
 *   for seeing *what* the agent is doing, not just that it's alive.
 * - `api.retry` — the child's SDK is retrying a provider request. This is the
 *   single most useful signal for post-mortem of rate-limit storms like the
 *   one that surfaced the need for this heartbeat in the first place.
 * - `ratelimited` — structured rate-limit exit detected mid-stream (parallel
 *   to the post-hoc detection the supervisor already does — we emit this for
 *   observability; the authoritative rate-limit decision still comes from the
 *   adapter's return value).
 */
export type AgentHeartbeat =
  | { kind: 'session.init'; sessionId: string; model?: string }
  | { kind: 'assistant.delta'; cumulativeBytes: number }
  | { kind: 'tool.use'; name: string }
  | {
      kind: 'api.retry';
      attempt: number;
      maxRetries?: number;
      errorStatus?: number | null;
      retryDelayMs?: number;
    }
  | { kind: 'ratelimited'; retryAfterMs?: number };

/**
 * Outcome of a single `AgentAdapter.run` invocation.
 *
 * `exitCode` is `null` precisely when the process was killed (timeout,
 * stdout-cap, or signal) — `killedBy` names which one. `sessionId` is set when
 * the adapter parses one out of the agent's headless output (e.g. Claude
 * `--session-id`); the supervisor logs it to `events.jsonl` per design §3.6
 * (`step.agent.exit`).
 */
export interface AgentRunResult {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutCapHit: boolean;
  killedBy: 'timeout' | 'stdoutCap' | 'signal' | null;
  sessionId?: string;
  /**
   * ADR-0017 — adapter detected a rate-limit signature in the run output.
   * Supervisor wraps this in a backoff-and-retry loop before the verify
   * pipeline sees the result. Undefined = no detection performed / no signal
   * found; adapters that don't implement detection leave this unset.
   */
  rateLimited?: boolean;
  /**
   * ADR-0017 — provider-supplied retry-after hint in ms. Only meaningful
   * when `rateLimited === true`. Undefined = use the supervisor's
   * configured default wait.
   */
  retryAfterMs?: number;
}

/**
 * The single small adapter interface. Every executor package implements this
 * and exports a constructed instance the registry (Task 5.4) can pick up.
 *
 * `capabilities()` is a method (not a property) so adapters can compute it
 * lazily — e.g. by sniffing the installed agent CLI version. The shape is
 * pinned here rather than left open so the registry can render a static
 * capability matrix without inspecting each adapter's bag-of-bools.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly defaultModel: string;
  capabilities(): { supportsSessionId: boolean; supportsStructuredOutput: boolean };
  run(opts: AgentRunOpts): Promise<AgentRunResult>;
}
