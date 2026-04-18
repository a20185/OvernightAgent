/**
 * Converts an arbitrary user-supplied string into a branch-safe fragment.
 *
 * Used by the worktree manager to build branch names of the form
 * `oa/<slug(taskTitle)>-<shortid>`. Pure — no I/O, no side effects.
 *
 * Steps:
 *   1. Unicode-normalize via NFKD and strip combining diacritical marks
 *      (U+0300–U+036F). This decomposes accented Latin letters into a base
 *      letter + combining mark, then drops the mark — so `'café'` → `'cafe'`
 *      and `'héllo wörld'` → `'hello world'` (still ASCII before kebabing).
 *   2. Lowercase.
 *   3. Replace each run of non-`[a-z0-9]` characters with a single `-`.
 *      Non-Latin scripts (Chinese, emoji, etc.) survive step 1 unchanged
 *      and are dropped here, becoming `-` separators.
 *   4. Trim leading/trailing `-`.
 *   5. Cap at `maxLength` characters (default 32).
 *   6. Re-trim trailing `-` in case the cap landed mid-separator — keeps
 *      branch names like `oa/foo-bar-` from leaking out.
 *
 * Returns `''` for empty input, all-symbol input, or any input that contains
 * no `[a-z0-9]` characters after normalization. Callers should fall back to
 * a default (e.g. `'untitled'`) when they need a non-empty fragment.
 */
export function slug(input: string, maxLength = 32): string {
  const normalized = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const kebabed = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const capped = kebabed.slice(0, maxLength);
  return capped.replace(/-+$/, '');
}
