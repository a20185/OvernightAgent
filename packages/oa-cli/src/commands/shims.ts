import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { writeFileAtomic } from '@soulerou/oa-core';

/**
 * `oa shims install` (ADR-0014, ADR-0015). Copies host-specific slash-command
 * markdown (and, for claude, skill bundles and hooks) out of
 * `@soulerou/oa-cli`'s bundled `dist/shims/<host>/` tree into whatever
 * directory the host reads from.
 *
 * Host conventions baked in here:
 *   - claude   → `.claude/commands/` + `.claude/skills/` + `.claude/settings.json` (hooks merge, ADR-0015)
 *   - codex    → `~/.codex/prompts/`                       (user only in v0; project refused)
 *   - opencode → `~/.config/opencode/commands/`            (user only in v0; project refused)
 *
 * v0 limitations worth flagging:
 *   - Per-host target dirs are hardcoded; we don't consult host config files
 *     for overridden paths. A future version should honor e.g.
 *     `~/.config/opencode/config.json`'s `commandsDir` field if set.
 *   - Scope is a two-value enum (`project | user`). Host installs with only
 *     one legitimate scope will throw if the caller demands the other.
 *   - No uninstall command. To reverse, rm the copied files manually.
 *
 * Injectable `sourceRoot`, `home`, `cwd` make this unit-testable without
 * touching the developer's real home dir. Production callers use the
 * defaults, which resolve to the bundled shims and the live host env.
 */

export type Host = 'claude' | 'codex' | 'opencode';
export type Scope = 'project' | 'user';

export interface ShimsInstallOpts {
  /** Which host(s) to install. `'all'` fans out to every host with its default scope. */
  host: Host | 'all';
  /** Target scope. Host-dependent default when omitted (see module JSDoc). */
  scope?: Scope;
  /** Report the plan without writing. */
  dryRun?: boolean;
  /** Overwrite existing destination files. Default: skip. */
  force?: boolean;
  /** Absolute path to the bundled shim source root. Defaults to `<cli-dist>/shims/`. */
  sourceRoot?: string;
  /** Absolute HOME directory. Defaults to `os.homedir()`. */
  home?: string;
  /** Absolute CWD. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Output sink for human-facing lines. Defaults to `process.stdout.write(line + '\n')`. */
  log?: (line: string) => void;
}

export interface ShimsInstallResult {
  host: Host;
  scope: Scope;
  /** Absolute dest paths that were written this invocation. */
  copied: string[];
  /** Absolute dest paths that existed and were not overwritten (no --force). */
  skipped: string[];
  /** Absolute dest paths that WOULD be copied under --dry-run. Empty otherwise. */
  planned: string[];
}

// Per-host v0 conventions. Anywhere that needs to branch on host behavior
// reads from this table rather than open-coding strings.
interface HostSpec {
  defaultScope: Scope;
  supportedScopes: ReadonlySet<Scope>;
  /** Build absolute target paths from resolved home+cwd. `skills` and `settings` are optional per host. */
  target: (home: string, cwd: string, scope: Scope) => { commands: string; skills?: string; settings?: string };
}

const HOSTS: Record<Host, HostSpec> = {
  claude: {
    defaultScope: 'project',
    supportedScopes: new Set<Scope>(['project', 'user']),
    target: (home, cwd, scope) => {
      const base = scope === 'project' ? cwd : home;
      return {
        commands: path.resolve(base, '.claude', 'commands'),
        skills: path.resolve(base, '.claude', 'skills'),
        settings: path.resolve(base, '.claude', 'settings.json'),
      };
    },
  },
  codex: {
    defaultScope: 'user',
    supportedScopes: new Set<Scope>(['user']),
    target: (home) => ({
      commands: path.resolve(home, '.codex', 'prompts'),
    }),
  },
  opencode: {
    defaultScope: 'user',
    supportedScopes: new Set<Scope>(['user']),
    target: (home) => ({
      commands: path.resolve(home, '.config', 'opencode', 'commands'),
    }),
  },
};

function defaultSourceRoot(): string {
  // `cli.js` ships at `<pkg>/dist/cli.js`; shims are bundled as `<pkg>/dist/shims/…`.
  // Using `import.meta.url` keeps this working regardless of where the user
  // installed `@soulerou/oa-cli` (global vs local, pnpm vs npm vs yarn).
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From `dist/commands/shims.js`, shims live at `dist/shims/`.
  return path.resolve(here, '..', 'shims');
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function walkFiles(absRoot: string): Promise<string[]> {
  // Returns absolute file paths under absRoot, recursively. Symlinks are not
  // followed — shim content is plain markdown by convention and anything else
  // indicates a source-tree bug we'd rather surface loudly.
  const out: string[] = [];
  const entries = await fs.readdir(absRoot, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.resolve(absRoot, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(abs)));
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sentinel-based settings.json merge (ADR-0015). Upserts hook entries into
// Claude Code's `.claude/settings.json` using a `# oa:hook=<id>:` sentinel
// embedded in each hook's `command` string. The sentinel survives version
// bumps — `# oa:hook=compact-recovery:v1` and `# oa:hook=compact-recovery:v99`
// both match the prefix `# oa:hook=compact-recovery:`.
// ---------------------------------------------------------------------------

/** Regex that captures the hook id from a sentinel like `# oa:hook=compact-recovery:v1`. */
const OA_HOOK_SENTINEL_RE = /# oa:hook=([^:]+):/;

/**
 * Extracts the OvernightAgent hook id from the first sentinel found across
 * all `hooks[].command` strings in a hook entry. Returns `undefined` if the
 * entry has no oa sentinel (i.e. it belongs to the user or another tool).
 */
function extractHookId(entry: { hooks?: { command?: string }[] }): string | undefined {
  for (const h of entry.hooks ?? []) {
    if (typeof h.command === 'string') {
      const m = OA_HOOK_SENTINEL_RE.exec(h.command);
      if (m) return m[1];
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookEntry = Record<string, any>;

/**
 * Merges new hook entries (from a bundled `<host>/hooks/*.json` file) into
 * the existing `settings.json` at `settingsPath`.
 *
 * For each top-level key in `newHookObj` (e.g. `"SessionStart"`):
 *   1. Ensure `existing.hooks[key]` is an array.
 *   2. For each new entry, extract its hook id from the sentinel.
 *   3. Remove existing entries whose sentinel matches the same id.
 *   4. Append the new entry.
 *   5. Write atomically via `writeFileAtomic`.
 */
export async function mergeClaudeSettings(
  settingsPath: string,
  newHookObj: Record<string, HookEntry[]>,
): Promise<void> {
  // Read existing settings, defaulting to empty object on ENOENT.
  let existing: Record<string, unknown>;
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      existing = {};
    } else {
      throw err;
    }
  }

  // Ensure hooks container exists.
  if (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks)) {
    existing.hooks = {};
  }
  const hooks = existing.hooks as Record<string, HookEntry[]>;

  for (const [key, newEntries] of Object.entries(newHookObj)) {
    if (!Array.isArray(hooks[key])) {
      hooks[key] = [];
    }

    for (const newEntry of newEntries) {
      const hookId = extractHookId(newEntry);

      if (hookId !== undefined) {
        // Remove all prior entries we own with this hook id (sentinel-based).
        hooks[key] = hooks[key].filter((existing: HookEntry) => {
          const existingId = extractHookId(existing);
          return existingId !== hookId;
        });
      }

      // Append our new entry.
      hooks[key].push(newEntry);
    }
  }

  await writeFileAtomic(settingsPath, JSON.stringify(existing, null, 2));
}

async function installOne(
  host: Host,
  opts: Required<Pick<ShimsInstallOpts, 'sourceRoot' | 'home' | 'cwd' | 'log'>> &
    Pick<ShimsInstallOpts, 'scope' | 'dryRun' | 'force'>,
): Promise<ShimsInstallResult> {
  const spec = HOSTS[host];
  const scope = opts.scope ?? spec.defaultScope;
  if (!spec.supportedScopes.has(scope)) {
    // Explicit refusal keeps the blast radius small: we don't want to silently
    // install codex prompts into `<cwd>/.codex/` just because someone typed
    // `--scope project`, since codex doesn't read that path and the user will
    // spend five minutes wondering why nothing works.
    throw new Error(
      `${host} does not support scope "${scope}"; supported: ${[...spec.supportedScopes].join(', ')}`,
    );
  }

  const hostSrc = path.resolve(opts.sourceRoot, host);
  if (!(await exists(hostSrc))) {
    throw new Error(
      `shim source not found for ${host}: ${hostSrc} (expected under --source-root)`,
    );
  }

  const target = spec.target(opts.home, opts.cwd, scope);
  const result: ShimsInstallResult = {
    host,
    scope,
    copied: [],
    skipped: [],
    planned: [],
  };

  // Commands — present for every host.
  const cmdSrc = path.resolve(hostSrc, 'commands');
  if (await exists(cmdSrc)) {
    await copyTree(cmdSrc, target.commands, opts, result);
  }

  // Skills — claude-only in v0; target.skills is undefined for hosts that
  // don't use this directory convention. A host could in principle gain a
  // skills tree later (e.g. codex agents) without any change here, just by
  // populating target.skills in HOSTS and shipping a `skills/` source tree.
  if (target.skills !== undefined) {
    const skillsSrc = path.resolve(hostSrc, 'skills');
    if (await exists(skillsSrc)) {
      await copyTree(skillsSrc, target.skills, opts, result);
    }
  }

  // Hooks — claude-only in v0. Unlike commands/skills (simple file copies),
  // hooks are JSON fragments that get merged into `.claude/settings.json`
  // using a sentinel-based upsert (ADR-0015).
  if (target.settings !== undefined) {
    const hooksSrc = path.resolve(hostSrc, 'hooks');
    if (await exists(hooksSrc)) {
      const hookFiles = await walkFiles(hooksSrc);
      for (const hookFile of hookFiles) {
        if (!hookFile.endsWith('.json')) continue;
        const raw = await fs.readFile(hookFile, 'utf8');
        const hookObj = JSON.parse(raw) as Record<string, HookEntry[]>;

        if (opts.dryRun === true) {
          result.planned.push(target.settings);
          opts.log(`[dry-run] would merge hooks from ${path.basename(hookFile)} into ${target.settings}`);
          continue;
        }

        await mergeClaudeSettings(target.settings, hookObj);
        result.copied.push(target.settings);
        opts.log(`merged hooks from ${path.basename(hookFile)} into ${target.settings}`);
      }
    }
  }

  return result;
}

async function copyTree(
  srcRoot: string,
  destRoot: string,
  opts: Required<Pick<ShimsInstallOpts, 'log'>> & Pick<ShimsInstallOpts, 'dryRun' | 'force'>,
  result: ShimsInstallResult,
): Promise<void> {
  const files = await walkFiles(srcRoot);
  for (const srcAbs of files) {
    const rel = path.relative(srcRoot, srcAbs);
    const destAbs = path.resolve(destRoot, rel);

    if (opts.dryRun === true) {
      result.planned.push(destAbs);
      opts.log(`[dry-run] would copy ${srcAbs} -> ${destAbs}`);
      continue;
    }

    const destExists = await exists(destAbs);
    if (destExists && opts.force !== true) {
      result.skipped.push(destAbs);
      opts.log(`exists, skipping ${destAbs}`);
      continue;
    }

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(srcAbs, destAbs);
    result.copied.push(destAbs);
    opts.log(`${destExists ? 'overwrote' : 'wrote'} ${destAbs}`);
  }
}

export async function installShims(opts: ShimsInstallOpts): Promise<ShimsInstallResult[]> {
  // Resolve injectable defaults once. Every downstream path is absolute —
  // this is the boundary where we normalize user-provided (or env-derived)
  // values, so nothing past here has to second-guess.
  const sourceRoot = path.resolve(opts.sourceRoot ?? defaultSourceRoot());
  const home = path.resolve(opts.home ?? os.homedir());
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));

  const targetHosts: Host[] =
    opts.host === 'all' ? (['claude', 'codex', 'opencode'] satisfies Host[]) : [opts.host];

  const results: ShimsInstallResult[] = [];
  for (const h of targetHosts) {
    // Note: for --host all we intentionally IGNORE an explicit `opts.scope`
    // at the outer level — each host uses its own default scope, because
    // forcing e.g. `--scope project` across all hosts would fail for codex
    // and opencode. A user who wants a non-default scope should install
    // one host at a time.
    const scope = opts.host === 'all' ? undefined : opts.scope;
    results.push(
      await installOne(h, {
        sourceRoot,
        home,
        cwd,
        log,
        scope,
        dryRun: opts.dryRun,
        force: opts.force,
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Commander wiring. Kept in the same module as `installShims` so the CLI
// surface is one import away from the library surface; callers that want
// programmatic access (e.g. a future `postinstall` hook) can use the library
// function directly without re-parsing argv.
// ---------------------------------------------------------------------------

export function registerShimsCommands(program: Command): void {
  const shims = program
    .command('shims')
    .description('install slash-command resources into host agents (claude/codex/opencode)');

  shims
    .command('install')
    .description('copy bundled shim markdown into host-specific target dirs')
    .option(
      '--host <host>',
      'claude | codex | opencode | all (default: all)',
      (raw) => {
        const v = String(raw);
        if (v !== 'claude' && v !== 'codex' && v !== 'opencode' && v !== 'all') {
          throw new Error(`--host must be one of claude|codex|opencode|all; got ${v}`);
        }
        return v;
      },
      'all',
    )
    .option(
      '--scope <scope>',
      'project | user (default: host-specific)',
      (raw) => {
        const v = String(raw);
        if (v !== 'project' && v !== 'user') {
          throw new Error(`--scope must be project|user; got ${v}`);
        }
        return v;
      },
    )
    .option('--dry-run', 'print the plan without writing anything')
    .option('--force', 'overwrite existing files at the destination')
    .action(
      async (opts: {
        host: Host | 'all';
        scope?: Scope;
        dryRun?: boolean;
        force?: boolean;
      }) => {
        const results = await installShims({
          host: opts.host,
          scope: opts.scope,
          dryRun: opts.dryRun,
          force: opts.force,
        });

        // Human-readable summary at the tail. Per-file progress was already
        // streamed by the default log sink above.
        for (const r of results) {
          process.stdout.write(
            `\n${r.host} (${r.scope}): ${r.copied.length} copied, ${r.skipped.length} skipped` +
              (r.planned.length > 0 ? `, ${r.planned.length} planned (dry-run)` : '') +
              '\n',
          );
        }
      },
    );
}
