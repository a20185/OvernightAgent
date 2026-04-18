import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { oaHome } from './paths.js';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * Default `config.json` shape, per design §3.1. Encoded as a frozen TS literal
 * so the source-of-truth ships with the package and can be diffed/imported by
 * tests and downstream code without a JSON file load at runtime.
 *
 * If you change this, bump `schemaVersion` and add a migration in Phase 1.5.
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
 * Bootstraps the OvernightAgent home directory.
 *
 * Creates `oaHome()` plus the `tasks/`, `plans/`, `runs/`, and `worktrees/`
 * subdirectories, and writes a default `config.json` (per design §3.1) if
 * absent. Idempotent: a subsequent call is a no-op — `mkdir({ recursive: true })`
 * naturally tolerates existing dirs, and an existing `config.json` is left
 * untouched so user customizations survive.
 */
export async function ensureHomeLayout(): Promise<void> {
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
}
