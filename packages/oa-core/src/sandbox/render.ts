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

; --- System read-only paths ---
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/opt/homebrew"))
(allow file-read* (subpath "/usr/local"))
(allow file-read* (subpath "/private/tmp"))
(allow file-read* (subpath "/private/var"))
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/var"))

; --- Worktree: read + write ---
(allow file-read* file-write* (subpath "${worktreeAbs}"))

; --- Temp directories: read + write ---
(allow file-read* file-write* (subpath "/tmp"))
(allow file-read* file-write* (subpath "/private/tmp"))

; --- Home toolchain / config dirs: read-only ---
(allow file-read* (subpath "${homeAbs}/.claude"))
(allow file-read* (subpath "${homeAbs}/.npm-global"))
(allow file-read* (subpath "${homeAbs}/.config"))
(allow file-read* (subpath "${homeAbs}/.bun"))
(allow file-read* (subpath "${homeAbs}/.nvm"))
(allow file-read* (subpath "${homeAbs}/.cargo"))
(allow file-read* (subpath "${homeAbs}/.rustup"))

; --- Network ---
(allow network-outbound (tcp "*:443"))

; --- System entitlements ---
(allow system-socket)
(allow sysctl-read)
(allow mach-lookup)

; --- Extra allow paths ---
${extraAllows}
`;
}
