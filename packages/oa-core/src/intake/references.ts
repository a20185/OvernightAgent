/**
 * Tiered reference materializer per ADR-0007.
 *
 * Three reference kinds, each with deliberately different cost/reproducibility
 * trade-offs:
 *
 *  - `file`   — copied into `<taskFolder>/references/` and hashed. Cheap copies
 *               buy full reproducibility for single docs.
 *  - `dir`    — NOT copied. We record `src` plus, when the path is inside a git
 *               repo, the repo toplevel (`gitRepo`) and current `gitHead`. The
 *               context injector compares `gitHead` against the live repo at
 *               run time to surface drift (`reference.driftDetected`). O(1) at
 *               intake regardless of directory size — the entire reason this
 *               module is split-by-kind (ADR-0007 § Decision).
 *  - `memory` — NOT copied. We record `src` plus a sha256 of the content. The
 *               injector reads the file at run time; the recorded hash lets it
 *               detect drift the same way the dir kind does.
 *
 * The function returns objects shaped to match `ReferenceSchema` from
 * `schemas.ts` exactly — that schema's union variants are `.strict()`, so any
 * extra keys (or wrong-kind keys leaking in) would be rejected by the writer
 * downstream. Keep the output objects minimal and per-kind.
 *
 * All `src` paths are validated absolute via `assertAbs`; `taskFolderAbs` is
 * likewise asserted. Source-not-found errors are wrapped with the kind label
 * and the offending path so log-grep parity matches the worktree primitives.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { assertAbs } from '../paths.js';

/** Input shape used by the source-agent shim during intake Q&A. */
export type ReferenceInput =
  | { kind: 'file'; src: string }
  | { kind: 'dir'; src: string }
  | { kind: 'memory'; src: string };

/**
 * Output shape — discriminated union mirroring `ReferenceSchema` in
 * `schemas.ts`. Per-kind keys only; no extras (the schema is `.strict()`).
 */
export type MaterializedRef =
  | { kind: 'file'; src: string; copiedTo: string; sha256: string }
  | { kind: 'dir'; src: string; gitRepo?: string; gitHead?: string }
  | { kind: 'memory'; src: string; sha256: string };

/** sha256 hex digest of a file's bytes. Reads the whole file into memory; v0
 * intake refs are small (single docs / memory entries), so streaming would be
 * over-engineering for the call site. Revisit if a per-ref size cap lands. */
async function sha256OfFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const hash = createHash('sha256');
  hash.update(buf);
  return hash.digest('hex');
}

/**
 * Picks a non-colliding destination name in `referencesDir`. If `basename`
 * doesn't exist, returns it as-is. Otherwise tries `<stem>-2<ext>`, `-3`, …
 * until a free slot is found. The split keeps the extension at the end so
 * downstream tools (markdown viewers, etc.) still see `spec-2.md`, not
 * `spec.md-2`.
 *
 * NOTE: this is best-effort — between the `access` check and the eventual
 * `copyFile`, a concurrent caller could grab the same name. Intake is
 * single-writer in v0 (the source-agent shim runs one Q&A pass at a time),
 * so a check-then-write race isn't worth a lockfile here. If batched intake
 * lands later, wrap the whole materialize call under the inbox lock.
 */
async function uniqueDest(referencesDir: string, basename: string): Promise<string> {
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  let candidate = basename;
  let n = 2;
  // Bounded by available filenames; no realistic infinite loop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(path.resolve(referencesDir, candidate));
      // Exists — try the next suffix.
      candidate = `${stem}-${n}${ext}`;
      n++;
    } catch {
      return candidate;
    }
  }
}

/**
 * Returns `{gitRepo, gitHead}` if `absDir` resolves inside a git working tree,
 * else `null`. We deliberately swallow the simple-git error rather than
 * distinguishing "not a repo" from other failures: the only way to know
 * authoritatively is to invoke git, and any git failure here just means "no
 * git metadata to record" — the dir reference is still valid (ADR-0007
 * permits dir refs outside repos).
 */
async function detectGit(
  absDir: string,
): Promise<{ gitRepo: string; gitHead: string } | null> {
  try {
    const git = simpleGit(absDir);
    const toplevel = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    if (!toplevel || !head) return null;
    return { gitRepo: toplevel, gitHead: head };
  } catch {
    return null;
  }
}

/**
 * Materializes a batch of `ReferenceInput`s into `MaterializedRef`s, applying
 * per-kind handling per ADR-0007. Returns the array in input order so callers
 * can correlate by index (the source-agent shim asks the user one ref at a
 * time and stores them in order; preserving that order keeps the on-disk
 * intake.json deterministic).
 *
 * Side effects:
 *  - Creates `<taskFolderAbs>/references/` LAZILY — only when at least one
 *    `kind: 'file'` ref needs to be copied. Keeps the on-disk layout minimal
 *    for tasks that have no file refs (dir + memory kinds don't need it).
 *  - Copies each file ref with `fs.copyFile`. Permission bits are NOT
 *    preserved; the destination inherits the umask. Intake refs are read-only
 *    artifacts, so the umask default (typically 0644) is what we want.
 *
 * Boundary contract:
 *  - `taskFolderAbs` must be absolute (`assertAbs`).
 *  - Every `ref.src` must be absolute (`assertAbs`); enforced per-ref so the
 *    error message points at the offending input.
 *  - `kind: 'file'` and `kind: 'memory'` source paths must resolve to a
 *    regular file; `kind: 'dir'` must resolve to a directory. Wrong-type
 *    sources surface a clear "is not a regular file/directory" error rather
 *    than corrupting downstream state.
 */
export async function materializeReferences(
  taskFolderAbs: string,
  refs: ReferenceInput[],
): Promise<MaterializedRef[]> {
  assertAbs(taskFolderAbs);
  const referencesDir = path.resolve(taskFolderAbs, 'references');
  // Lazy mkdir — only the file kind needs the directory. Tracking with a flag
  // (vs. unconditional mkdir) keeps the on-disk layout minimal for refs-free
  // or dir/memory-only intakes. mkdir is idempotent under recursive:true so
  // re-creating across calls is cheap, but we still skip when not needed.
  let referencesDirCreated = false;

  const out: MaterializedRef[] = [];

  for (const ref of refs) {
    assertAbs(ref.src);

    if (ref.kind === 'file') {
      const stat = await fs.stat(ref.src).catch((err: unknown) => {
        throw new Error(`reference file not found: ${ref.src}`, { cause: err });
      });
      if (!stat.isFile()) {
        throw new Error(`reference file is not a regular file: ${ref.src}`);
      }
      if (!referencesDirCreated) {
        await fs.mkdir(referencesDir, { recursive: true });
        referencesDirCreated = true;
      }
      const basename = path.basename(ref.src);
      const destName = await uniqueDest(referencesDir, basename);
      const destAbs = path.resolve(referencesDir, destName);
      await fs.copyFile(ref.src, destAbs);
      // Hash the COPIED bytes (not the source) so the recorded sha256 is a
      // true witness for what landed under `references/`. In practice the
      // bytes match — `copyFile` is byte-exact — but pinning the on-disk copy
      // is the contractually correct choice if anyone ever swaps the copy
      // implementation (e.g. CoW reflink with mode translation).
      const sha256 = await sha256OfFile(destAbs);
      out.push({
        kind: 'file',
        src: ref.src,
        copiedTo: `references/${destName}`,
        sha256,
      });
      continue;
    }

    if (ref.kind === 'dir') {
      const stat = await fs.stat(ref.src).catch((err: unknown) => {
        throw new Error(`reference dir not found: ${ref.src}`, { cause: err });
      });
      if (!stat.isDirectory()) {
        throw new Error(`reference dir is not a directory: ${ref.src}`);
      }
      const gitInfo = await detectGit(ref.src);
      if (gitInfo) {
        out.push({
          kind: 'dir',
          src: ref.src,
          gitRepo: gitInfo.gitRepo,
          gitHead: gitInfo.gitHead,
        });
      } else {
        // Strict schema: omit the optional keys entirely rather than setting
        // them to `undefined`. `ReferenceSchema` for dir is `.strict()`, but
        // the keys themselves are optional — present-but-undefined would still
        // serialize cleanly through JSON, but we want the on-disk record to
        // reflect "no git metadata captured" by absence, not by a `null`/
        // `undefined` sentinel. Match the doc-example shape exactly.
        out.push({ kind: 'dir', src: ref.src });
      }
      continue;
    }

    if (ref.kind === 'memory') {
      const stat = await fs.stat(ref.src).catch((err: unknown) => {
        throw new Error(`memory reference file not found: ${ref.src}`, { cause: err });
      });
      if (!stat.isFile()) {
        throw new Error(`memory reference is not a regular file: ${ref.src}`);
      }
      const sha256 = await sha256OfFile(ref.src);
      out.push({ kind: 'memory', src: ref.src, sha256 });
      continue;
    }

    // Exhaustiveness guard: if a new kind is added to ReferenceInput without
    // updating this switch, TS will narrow `ref` to `never` and the assignment
    // below will fail to compile. The runtime throw is a defense-in-depth in
    // case the type is widened with a cast at a call site.
    const _exhaustive: never = ref;
    throw new Error(`unknown reference kind: ${JSON.stringify(_exhaustive)}`);
  }

  return out;
}
