# ADR-0009 — Single `AgentAdapter` interface; one package per agent

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 2.3, § 5.1

## Context

`oa` must drive three coding agents (claude / codex / opencode) and may grow more
later. The supervisor must remain agnostic about which CLI is being driven, but
each CLI has its own flags, output conventions, and (sometimes) session model.
We also want to test each adapter in isolation and let core evolve without
breaking adapters.

## Decision

A single small `AgentAdapter` interface lives in `oa-core`. Each adapter is its
own monorepo package depending only on `oa-core`'s public types.

```ts
export interface AgentAdapter {
  readonly id: "claude" | "codex" | "opencode";
  readonly defaultModel: string;
  capabilities(): { supportsSessionId: boolean; supportsStructuredOutput: boolean };
  run(opts: AgentRunOpts): Promise<AgentRunResult>;
}
```

`AgentRunOpts` carries everything an adapter needs to run one headless invocation:
absolute `cwd`, absolute `promptPath`, `model`, `extraArgs`, optional `env`,
hard `timeoutSec`, `stdoutCapBytes`, absolute `stdoutPath`/`stderrPath`, and an
`AbortSignal` for graceful stop. `AgentRunResult` reports `exitCode`, `durationMs`,
`timedOut`, `stdoutCapHit`, `killedBy`, and an optional `sessionId`.

Adapters translate options into the right CLI invocation:
- `oa-adapter-claude` — `claude -p "$(cat <promptPath>)" --model <model> ...`
- `oa-adapter-codex` — `codex exec --model <model> -- <promptPath>`
- `oa-adapter-opencode` — `opencode run --model <model> --prompt-file <promptPath>`

Exact flags verified at implementation time against installed CLI versions.

The supervisor never imports adapter packages directly. `oa-core/adapters.ts`
exposes `getAdapter(id) → AgentAdapter` which lazy-loads the matching module.

## Consequences

- Positive: supervisor stays agent-agnostic; new adapters are isolated work;
  per-adapter tests are simple; reviewer invocations reuse the same interface;
  dependencies are tree-shakeable per adapter.
- Negative: a small amount of boilerplate per adapter (shared via `oa-core`
  helpers for stdout capping, timeout enforcement, signal handling).
- Neutral: capability detection is intentionally minimal — only the two flags
  that meaningfully influence supervisor behavior.

## Alternatives Considered

- **Single all-in-one package with adapters as internal modules.** Rejected:
  harder to test; harder to publish/version adapters independently if needed
  later; weaker isolation.
- **Plugin loader for runtime-discovered adapters.** Deferred to post-v0 — three
  known agents do not justify the loader complexity.
- **Per-agent supervisor codepath (no shared interface).** Rejected: triplicated
  process management, timeout enforcement, and capture logic.

## Notes

The `signal: AbortSignal` lets the supervisor implement `oa stop --now` cleanly:
the supervisor aborts; the adapter is responsible for SIGTERMing its child and
returning a `killedBy: "signal"` result.
