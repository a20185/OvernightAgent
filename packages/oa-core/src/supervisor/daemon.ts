import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assertAbs, runDir } from '../paths.js';
import { assertId } from '../ids.js';

/**
 * Task 7.4 — detached daemon launcher.
 *
 * `detachAndRun(planId)` is the small process boundary that hands a plan over
 * to the long-lived supervisor entrypoint. It does exactly three things:
 *
 *   1. resolves the supervisor entry and run log path,
 *   2. spawns `process.execPath` detached with stdio wired to the events log,
 *   3. unrefs the child and exits the launcher process.
 *
 * The child entry is responsible for writing its pidfile on startup and
 * handling SIGTERM/SIGINT. The launcher stays intentionally dumb so the
 * supervisor loop can evolve independently in later tasks.
 */
export interface DetachAndRunOpts {
  /** Absolute path to the emitted JS supervisor entry. Defaults to dist/supervisor/entry.js. */
  supervisorEntry?: string;
  /** Absolute path to `<runDir>/events.jsonl`. Defaults from `planId`. */
  eventsLogPath?: string;
  /** Test seam: override process.exit so integration tests can keep running. */
  exit?: (code: number) => void;
  /** Test seam: inject extra environment variables for the spawned child. */
  env?: NodeJS.ProcessEnv;
}

function defaultSupervisorEntry(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'dist',
    'supervisor',
    'entry.js',
  );
}

function defaultEventsLogPath(planId: string): string {
  return path.resolve(runDir(planId), 'events.jsonl');
}

export function detachAndRun(planId: string, opts: DetachAndRunOpts = {}): void {
  assertId(planId);

  const supervisorEntry = opts.supervisorEntry ?? defaultSupervisorEntry();
  const eventsLogPath = opts.eventsLogPath ?? defaultEventsLogPath(planId);
  assertAbs(supervisorEntry);
  assertAbs(eventsLogPath);
  try {
    fs.accessSync(supervisorEntry, fs.constants.R_OK);
  } catch (err) {
    throw new Error(`supervisor entry missing or unreadable: ${supervisorEntry}`, {
      cause: err,
    });
  }

  fs.mkdirSync(path.dirname(eventsLogPath), { recursive: true });
  const stdoutFd = fs.openSync(eventsLogPath, 'a');
  const stderrFd = fs.openSync(eventsLogPath, 'a');

  try {
    const child = spawn(process.execPath, [supervisorEntry, planId], {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    child.unref();
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  (opts.exit ?? process.exit)(0);
}
