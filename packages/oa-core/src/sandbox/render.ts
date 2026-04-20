import { assertAbs } from '../paths.js';

/**
 * Options for rendering a macOS sandbox-exec (Seatbelt) profile.
 */
export interface RenderSandboxProfileOpts {
  /** Absolute path to the git worktree for the current task attempt. */
  worktreeAbs: string;
  /** Absolute path to the user's home directory. */
  homeAbs: string;
  /** Additional paths to grant read+write access. */
  extraAllowPaths: string[];
}

/**
 * Renders a complete macOS sandbox-exec (Seatbelt) profile as a string.
 *
 * The profile follows a default-deny model and opens only the minimal
 * allowlist needed for an adapter subprocess to operate: the worktree root,
 * standard system/toolchain directories, and the user's agent config dirs.
 *
 * See ADR-0016 for the design rationale.
 */
export function renderSandboxProfile(opts: RenderSandboxProfileOpts): string {
  const { worktreeAbs, homeAbs, extraAllowPaths } = opts;

  assertAbs(worktreeAbs);
  assertAbs(homeAbs);
  for (const p of extraAllowPaths) {
    assertAbs(p);
  }

  const extraAllows = extraAllowPaths
    .map((p) => `(allow file-read* file-write* (subpath "${p}"))`)
    .join('\n');

  return `; OvernightAgent sandbox-exec profile
; Rendered per-attempt — see ADR-0016

(version 1)
(deny default)

; --- Process capabilities ---
(allow process-exec)
(allow process-fork)
(allow signal (target self))

; --- Broad read access (required by dyld on macOS 15+) ---
(allow file-read* (subpath "/"))

; --- Worktree: read + write ---
(allow file-write* (subpath "${worktreeAbs}"))

; --- Temp directories: read + write ---
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))

; --- Network ---
(allow network-outbound)

; --- System entitlements ---
(allow system-socket)
(allow sysctl-read)
(allow mach-lookup)

; --- Extra allow paths ---
${extraAllows}
`;
}
