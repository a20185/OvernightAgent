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
}

export interface AgentRunControl {
  killNow(): void;
}

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
