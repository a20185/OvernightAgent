# ADR-0016 — macOS sandbox-exec profile around adapter runs

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** OvernightAgent maintainers
**Related:** ADR-0002 (worktree absolute paths), ADR-0015 (harness hardening)

## Context

OvernightAgent isolates each task in its own git worktree (ADR-0002), but git worktrees provide branch isolation, not filesystem isolation. A drifted or misbehaving agent subprocess can:

- Read secrets outside the worktree (`~/.ssh/id_rsa`, `~/.gnupg/`, cloud credentials in `~/.aws/`, `~/.config/gcloud/`).
- Write to the user's home directory (`~/.zshrc`, `~/.gitconfig`, `~/.npmrc`), persisting side effects beyond the task.
- Modify `$OA_HOME` state files (`runs/`, `plans/`) directly, bypassing the supervisor's atomic-write contract.

This is an inherent limitation of the worktree model: the worktree constrains *where the task code lives*, but the agent process itself runs with the full UID permissions of the invoking user.

macOS ships `sandbox-exec(1)`, a front-end to the Apple Sandbox (Seatbelt) kernel facility. A Seatbelt profile is a declarative allowlist/denylist of filesystem paths, network endpoints, and process capabilities. The kernel enforces it with zero per-call overhead — no syscall interposition, no ptrace, no userspace wrapping. The profile is specified at process spawn time and cannot be escaped by the sandboxed process.

NightShift's existing infrastructure can render a per-attempt profile and prepend `sandbox-exec -f <profile>` to the adapter spawn argv, gaining kernel-level filesystem confinement for the adapter subprocess with no changes to the adapter binaries themselves.

## Decision

### New subsystem: `@soulerou/oa-core/src/sandbox/`

Add an inline sandbox-profile template and a `render.ts` module under `oa-core/src/sandbox/`:

- **Template:** A compile-time constant string containing the Seatbelt profile skeleton. It defines broad deny-all defaults (`deny default`) then opens the minimal allowlist: the worktree root, `$OA_HOME`, temp directories, and standard toolchain paths (`/usr/bin/*`, `/usr/lib/*`, Xcode toolchain, Homebrew prefix, Node.js prefix).
- **`render.ts`:** Exports a single function `renderSandboxProfile(worktreeRoot: string, oaHome: string, extraAllowPaths?: string[]): string`. It interpolates the paths into the template and returns the complete `.sb` profile text.

The subsystem is intentionally self-contained: no runtime dependencies beyond `node:fs`, no external binaries beyond `sandbox-exec` itself.

### Per-attempt profile rendering

The rendered profile is written to `<runDir>/<taskId>/step-NN/attempt-NN/sandbox.sb`. This follows the existing per-attempt directory convention, ensuring parallel-safe isolation — each concurrent attempt gets its own profile file. No shared mutable state between attempts.

### Integration point: `spawnHeadless`

The sandbox wraps only the adapter run, applied at the `spawnHeadless` level in `@soulerou/oa-core`. When `opts.sandboxProfile` is set and `process.platform === 'darwin'`, the adapter's argv is prepended with `['sandbox-exec', '-f', opts.sandboxProfile]` before spawning. This is a single integration point that benefits all three adapters (claude, codex, opencode) without per-adapter changes.

Operations that run **outside** the sandbox:

- `bootstrap.script` — runs before the adapter and sets up the worktree.
- `verify.cmd` — the user-supplied verification command, which may need broader filesystem access.
- Git operations by the supervisor (commit, diff, status).

This scoping ensures the sandbox constrains only the AI agent's filesystem access, not the infrastructure that orchestrates around it.

### Opt-in for v0.2

The sandbox is opt-in during v0.2. It is activated by either:

1. CLI flag: `oa run --sandbox`
2. Intake field: `intake.sandbox.enabled: boolean`

Both must agree: if the CLI flag is absent and the intake field is `false` (or missing), the sandbox is not applied. If either is set to enable, the sandbox is rendered and enforced.

Default in v0.2 is **off**. Default will flip to **on** in v0.3 after collecting usage data and confidence in the template's compatibility with common toolchains.

### Extensibility: `extraAllowPaths`

The intake schema gains an optional field:

```ts
sandbox: z.object({
  enabled: z.boolean(),
  extraAllowPaths: z.array(z.string()).optional()
}).optional()
```

Each entry in `extraAllowPaths` is inlined into the rendered profile as:

```
(allow file-read* file-write* (subpath "<path>"))
```

This supports project-specific directories (e.g., a shared artifact cache, a monorepo root outside the worktree) without requiring template edits. No arbitrary Seatbelt sexp input is accepted in v0.2 — only path strings rendered into the fixed allow-line pattern. This prevents injection of unintended sandbox rules.

### Non-macOS: fail-fast, not partial run

On non-macOS platforms (Linux, Windows), if sandbox is requested, the supervisor fails fast **before the plan starts** with the error:

```
sandbox requested but unsupported on <platform>
```

This is a pre-plan validation check, not a per-task check. The supervisor does not partially execute a plan with some tasks sandboxed and others not. Users on non-macOS must either remove the sandbox opt-in or wait for platform-specific sandbox support (see Follow-ups).

## Consequences

**Positive.**

- Kernel-level filesystem confinement is orthogonal to git isolation and provides defense-in-depth against agent drift.
- Zero per-call overhead: Seatbelt enforcement is in-kernel, not userspace interposition.
- Single integration point (`spawnHeadless`) keeps the change localized; all three adapters benefit without per-adapter modifications.
- Per-attempt profile files are parallel-safe by design, aligning with the existing directory convention.
- `extraAllowPaths` gives users an escape hatch for project-specific needs without template forks.
- Fail-fast on unsupported platforms prevents silent partial-sandbox runs.

**Negative.**

- macOS-only in v0.2. Linux and Windows users who request sandbox get a hard error, not sandboxing.
- The template's allowlist is maintained by OvernightAgent, not auto-discovered. As toolchains shift install paths (e.g., Homebrew on Apple Silicon vs. Intel, Volta vs. nvm for Node.js), the template must be updated. Incorrect allowlists manifest as opaque "permission denied" failures inside the agent run.
- `sandbox-exec` is documented as deprecated by Apple in favor of the App Sandbox API, but remains functional and is the only programmatic interface available to CLI tools. If Apple removes `sandbox-exec` in a future macOS release, this mechanism breaks.
- Opt-in in v0.2 means most users will not benefit until v0.3 flips the default.

**Follow-ups.**

- Linux Landlock-based sandbox for adapter subprocesses (separate ADR when implemented; noted in ADR-0015 follow-ups).
- Flip sandbox default to **on** in v0.3 after usage data confirms template compatibility.
- Auto-detect common toolchain paths at render time (e.g., `which node`, `brew --prefix`) to reduce template maintenance burden.
- Consider Seatbelt network deny rules (`deny network*`) as a future hardening layer, with an opt-out for tasks that require network access.
