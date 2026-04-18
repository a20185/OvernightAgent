import { randomBytes } from 'node:crypto';
import { ID_REGEX } from './schemas.js';

/**
 * Asserts `id` is a legal OvernightAgent identifier.
 *
 * Legal ids match the canonical `ID_REGEX` (re-imported from `schemas.ts` so
 * the imperative guard and the Zod validator can never drift) AND are not
 * the bare strings `"."` or `".."`. Empty strings are also rejected; the
 * regex requires at least one character but we check explicitly so the error
 * message is unambiguous.
 *
 * The `asserts id is string` clause is technically redundant (the parameter
 * is already typed `string`) but matches the `assertAbs` pattern from
 * `paths.ts` and becomes load-bearing when callers narrow `unknown` values
 * upstream. See ADR-0002.
 */
export function assertId(id: string): asserts id is string {
  if (id.length === 0 || id === '.' || id === '..' || !ID_REGEX.test(id)) {
    throw new Error(`invalid id: ${JSON.stringify(id)}`);
  }
}

/**
 * Dependency-injection seam for `newTaskId` / `newPlanId`. Both default to
 * the wall clock and `crypto.randomBytes`; tests inject deterministic
 * substitutes.
 *
 * `randomSuffix` must return a 4-character base36 string (`/^[0-9a-z]{4}$/`).
 * `now` returns the moment whose UTC date forms the middle component.
 */
export interface IdGeneratorDeps {
  now?: () => Date;
  randomSuffix?: () => string;
}

/**
 * Generates a 4-character base36 suffix from 24 bits of OS randomness.
 *
 * 36^4 = 1,679,616 distinct values; the birthday bound puts collision
 * probability above 50% somewhere around √(2 · 36^4) ≈ 1830 ids minted in
 * the same UTC day. Plenty of headroom for v0; callers minting at scale
 * should switch to a longer suffix or include a counter.
 */
function defaultRandomSuffix(): string {
  // `readUIntBE` reads a big-endian unsigned int of the given byte length and
  // is exactly typed `number`, sidestepping `noUncheckedIndexedAccess` issues
  // that bite the more obvious `(buf[0] << 16) | ...` formulation.
  const n = randomBytes(3).readUIntBE(0, 3);
  return (n % 36 ** 4).toString(36).padStart(4, '0').slice(-4);
}

/** UTC `YYYY-MM-DD`. Padded so March 5 reads `2026-03-05`, not `2026-3-5`. */
function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const DEFAULT_DEPS: Required<IdGeneratorDeps> = {
  now: () => new Date(),
  randomSuffix: defaultRandomSuffix,
};

/** `t_<YYYY-MM-DD>_<base36>` — the canonical taskId shape. */
export function newTaskId(deps: IdGeneratorDeps = {}): string {
  const { now, randomSuffix } = { ...DEFAULT_DEPS, ...deps };
  return `t_${formatDate(now())}_${randomSuffix()}`;
}

/** `p_<YYYY-MM-DD>_<base36>` — the canonical planId shape. */
export function newPlanId(deps: IdGeneratorDeps = {}): string {
  const { now, randomSuffix } = { ...DEFAULT_DEPS, ...deps };
  return `p_${formatDate(now())}_${randomSuffix()}`;
}
