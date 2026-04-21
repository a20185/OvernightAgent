import { OaStatusSchema, OaReviewSchema, type OaStatus, type OaReview } from '../schemas.js';
import type { ZodType } from 'zod';

/**
 * ADR-0008 tail-message parser.
 *
 * Agents (executor / reviewer) end stdout with a fenced code block whose info
 * string is the kind name:
 *
 *   ```oa-status
 *   {"status":"done","summary":"...","notes":"..."}
 *   ```
 *
 * The parser is consumed by the verifyTail gate (Task 6.2) and the review
 * gate (Task 6.3). It is pure (no I/O) so the supervisor can call it directly
 * on captured `agent.stdout` and on synthesized fixtures from the integration
 * tests (Task 6.7) without indirection.
 *
 * Behavior is fixed by the design:
 *
 *   - If stdout looks like Claude's `--output-format stream-json` (the first
 *     non-empty line parses as a JSON object with a string `type` field),
 *     concatenate every assistant-message text block in order into a single
 *     newline-joined string and run the fence regex on THAT. Without this,
 *     the fence's real `\n` around the info-string and closing backticks is
 *     JSON-escaped to the two-byte `\\n` sequence in the raw capture, and the
 *     regex — which anchors on real newlines — never matches. Plain-text
 *     stdout (codex / opencode) is unchanged.
 *   - Find ALL fenced blocks of the requested kind. Agents routinely embed
 *     example fences in their narrative ("here is how I'll report status…")
 *     before emitting the real terminal one.
 *   - Pick the LAST match — last-fence-wins is the load-bearing invariant
 *     that makes intermediate examples harmless.
 *   - JSON.parse the body of that block; validate against the Zod schema.
 *   - Surface failures as `{ok:false, reason}` with substrings the gates
 *     match against to emit `step.verify.tail.fail` events with structured
 *     reasons. Reasons are intentionally human-readable; the gate adds the
 *     event taxonomy on top.
 *
 * Info-string strictness (v0): exact match, case-sensitive. Trailing
 * whitespace on the info-string line is tolerated (markdown renderers
 * routinely emit it); leading whitespace, alternate case, and suffixes are
 * NOT — they would let `oa-status-example` or ` oa-status` accidentally
 * count as terminal blocks.
 */

export type ParseTailResult<T> = { ok: true; value: T } | { ok: false; reason: string };

// `kind` is also the literal info-string we look for. Centralising the schema
// table here keeps the overload bodies tiny and makes adding `oa-progress` (a
// likely Phase 7+ extension) a one-line change.
const SCHEMAS: { 'oa-status': ZodType<OaStatus>; 'oa-review': ZodType<OaReview> } = {
  'oa-status': OaStatusSchema,
  'oa-review': OaReviewSchema,
};

export function parseTail(stdoutText: string, kind: 'oa-status'): ParseTailResult<OaStatus>;
export function parseTail(stdoutText: string, kind: 'oa-review'): ParseTailResult<OaReview>;
export function parseTail(
  stdoutText: string,
  kind: 'oa-status' | 'oa-review',
): ParseTailResult<unknown> {
  // Claude's `--output-format stream-json` (used by the claude adapter so the
  // supervisor can recover `session_id` from the init event) writes one JSON
  // object per line. Fences are embedded inside JSON string values where
  // newlines are `\\n` escapes, so the fence regex below — which requires
  // real newlines — never matches the raw capture. Detect that shape and
  // unwrap to the user-visible assistant text before running the regex.
  const unwrapped = extractAssistantTextFromStreamJson(stdoutText);
  const haystack = unwrapped ?? stdoutText;

  // Fence regex breakdown:
  //   (^|\n)            — fence opener must start a line. Anchoring to start-
  //                       of-line stops `wrap```oa-status` (no real-world
  //                       example, but cheap insurance) from matching.
  //   ```<kind>         — exact info-string, case-sensitive.
  //   [ \t]*            — tolerate trailing space/tab on the info-string line
  //                       (markdown renderers emit them; agents may too).
  //   \n                — info-string line ends here.
  //   ([\s\S]*?)        — body, non-greedy so the FIRST closing fence after
  //                       this opener wins. The "last-block-wins" outer
  //                       behavior is implemented by `matchAll`+`pop`, NOT
  //                       by greediness here.
  //   \n```             — closing fence on its own line.
  //   (?=\n|$)          — closing fence must be followed by EOL/EOF, again
  //                       to keep `\`\`\`junk` from being mistaken for a
  //                       closer.
  //
  // Note: `m` flag is not needed because we anchor with `(^|\n)` explicitly.
  // `g` is required for `matchAll`.
  const fenceRe = new RegExp(`(?:^|\\n)\`\`\`${kind}[ \\t]*\\n([\\s\\S]*?)\\n\`\`\`(?=\\n|$)`, 'g');

  const matches = Array.from(haystack.matchAll(fenceRe));
  if (matches.length === 0) {
    return { ok: false, reason: `no ${kind} block found in output` };
  }

  // Last-fence-wins per ADR-0008. `at(-1)` is safe — we just verified non-empty.
  const last = matches.at(-1)!;
  // Group 1 is the body. Always present when the regex matched (the group
  // sits inside the matching alternative), but TS's RegExp typings can't
  // express that — coerce to '' to satisfy the checker; JSON.parse('') will
  // route through the catch with a sensible reason if it ever fires.
  const body = last[1] ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `invalid JSON in ${kind} block: ${msg}` };
  }

  const schema = SCHEMAS[kind];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // `result.error.message` is Zod's pretty-printed multiline issue list.
    // Including it verbatim gives the fix-loop synthesizer (Task 6.6)
    // enough to compose a corrective prompt without re-deriving the issues.
    return { ok: false, reason: `${kind} block failed schema: ${result.error.message}` };
  }
  return { ok: true, value: result.data };
}

/**
 * Detects Claude-style stream-json (one JSON object per line, each carrying a
 * string `type` field) and returns the concatenated user-visible text —
 * every `text` block from every `type:"assistant"` message, in order, joined
 * with `\n`. Returns `null` when the input doesn't look like stream-json so
 * the caller falls back to treating stdout as plain text (codex/opencode).
 *
 * Detection is intentionally cheap: we only probe the first non-empty line.
 * If that line parses as an object with `typeof type === "string"`, we
 * commit to stream-json mode and walk every line. Subsequent lines that
 * fail to parse are skipped silently — matching the permissiveness of
 * `parseSessionIdFromStreamJson` in the claude adapter, which is the only
 * other place in the repo that reads this format.
 *
 * Non-text assistant content (tool_use, thinking, tool_result…) is ignored.
 * The ADR-0008 fence lives inside `content[].type === "text"` blocks; that's
 * the only payload that can carry an `oa-status` or `oa-review` block.
 */
function extractAssistantTextFromStreamJson(raw: string): string | null {
  if (raw.length === 0) return null;

  const lines = raw.split('\n');
  let firstNonEmpty: string | undefined;
  for (const line of lines) {
    if (line.trim().length > 0) {
      firstNonEmpty = line;
      break;
    }
  }
  if (firstNonEmpty === undefined) return null;

  let probe: unknown;
  try {
    probe = JSON.parse(firstNonEmpty);
  } catch {
    return null;
  }
  if (
    typeof probe !== 'object' ||
    probe === null ||
    !('type' in probe) ||
    typeof (probe as { type: unknown }).type !== 'string'
  ) {
    return null;
  }

  const chunks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as { type?: unknown; message?: unknown };
    if (obj.type !== 'assistant') continue;
    const message = obj.message;
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      const it = item as { type?: unknown; text?: unknown };
      if (it.type === 'text' && typeof it.text === 'string') {
        chunks.push(it.text);
      }
    }
  }
  return chunks.join('\n');
}
