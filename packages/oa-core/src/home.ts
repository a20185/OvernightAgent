import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { oaHome } from './paths.js';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * Default `config.json` content per design §3.1.
 *
 * NOTE: `Object.freeze` + `as const` produces deep-readonly typing, but
 * spread (`{ ...DEFAULT_CONFIG }`) only does a shallow copy. Nested objects
 * (`defaultModel`, `defaultReviewer`, `defaults`, etc.) remain frozen and
 * mutating them throws TypeError at runtime. Use `structuredClone(DEFAULT_CONFIG)`
 * for a fully mutable copy.
 */
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  defaultAgent: 'claude',
  defaultModel: { claude: 'opus', codex: 'gpt-5', opencode: 'sonnet' },
  defaultReviewer: {
    agent: 'claude',
    model: { claude: 'opus', codex: 'gpt-5', opencode: 'sonnet' },
  },
  defaults: {
    stepTimeoutSec: 1800,
    planBudgetSec: 28800,
    stepStdoutCapBytes: 52428800,
    reviewFixLoop: { enabled: true, maxLoops: 5, blockOn: ['P0', 'P1'] },
    commitMode: 'per-step',
    onFailure: 'markBlocked',
    parallel: { enabled: false, max: 1 },
    references: { strict: false },
  },
} as const);

const SUBDIRS = ['tasks', 'plans', 'runs', 'worktrees'] as const;

/**
 * Module-level in-flight promise for `ensureHomeLayout`. Coalesces concurrent
 * callers within a single process onto the same async work so N defensive
 * call sites cost the same as one. Reset to `null` after the promise settles
 * (success OR failure) so a later call still re-checks the filesystem — this
 * is intentional: the layout can be deleted out from under us between calls.
 *
 * Safe because OvernightAgent is a single-process supervisor; cross-process
 * races are out of scope (see Phase-3 TODO inside the bootstrap below).
 */
let inflight: Promise<void> | null = null;

/**
 * Bootstraps the OvernightAgent home directory.
 *
 * Creates `oaHome()` plus the `tasks/`, `plans/`, `runs/`, and `worktrees/`
 * subdirectories, and writes a default `config.json` (per design §3.1) if
 * absent. Idempotent: a subsequent call is a no-op — `mkdir({ recursive: true })`
 * naturally tolerates existing dirs, and an existing `config.json` is left
 * untouched so user customizations survive. Concurrent in-process callers
 * coalesce onto a single in-flight bootstrap (see `inflight` above).
 */
export function ensureHomeLayout(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const home = oaHome();
    // `oaHome()` already asserts absolute. Create the home dir first so that
    // a missing OA_HOME parent (e.g. fresh tmpdir) is materialized before we
    // try to stat config.json beneath it.
    await fs.mkdir(home, { recursive: true });
    for (const sub of SUBDIRS) {
      await fs.mkdir(path.resolve(home, sub), { recursive: true });
    }

    const cfgPath = path.resolve(home, 'config.json');
    // Preserve user customizations: only write if config.json is absent.
    // We probe with stat rather than readJson because a user-edited file might
    // be transiently invalid JSON, and we still must not clobber it.
    //
    // TODO(phase-3): the stat-then-writeJsonAtomic window is a TOCTOU. If two
    // processes race here, last writer wins (atomic); both are writing
    // DEFAULT_CONFIG so this is harmless in practice. For true create-if-absent,
    // use fs.open(cfgPath, 'wx') instead. Defer until a real concurrent-init
    // scenario surfaces.
    let cfgExists = true;
    try {
      await fs.stat(cfgPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cfgExists = false;
      } else {
        throw err;
      }
    }
    if (!cfgExists) {
      await writeJsonAtomic(cfgPath, DEFAULT_CONFIG);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
