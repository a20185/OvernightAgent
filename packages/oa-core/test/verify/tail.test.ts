import { describe, it, expect } from 'vitest';
import { parseTail } from '../../src/verify/tail.js';

// -----------------------------------------------------------------------------
// ADR-0008 tail-message parser. The agent ends its stdout with a fenced
// ```oa-status block, the reviewer with ```oa-review. The parser must:
//
//   - find ALL fenced blocks of the requested kind (agents may print
//     intermediate examples in their narrative output);
//   - pick the LAST match (the real terminal block — examples come earlier);
//   - JSON.parse the body and validate it against the matching Zod schema;
//   - report a typed reason on every failure mode.
//
// These tests pin the 10 contracts the parser owes Tasks 6.2 / 6.3.
// -----------------------------------------------------------------------------

// `bt(3)` — three backticks. Cleaner than `\`\`\`` for fence construction
// inside template literals, and avoids escaping mistakes that would change
// what the test is actually asserting.
const bt = (n: number) => '`'.repeat(n);
const fence = (kind: string, body: string) => `${bt(3)}${kind}\n${body}\n${bt(3)}`;

describe('parseTail oa-status', () => {
  // (1) Missing block — empty haystack of fences should produce a `no <kind>`
  // reason. The downstream verifyTail gate (Task 6.2) emits this on
  // step.verify.tail.fail; keep the substring stable so callers can assert
  // against it without coupling to the exact wording.
  it('returns ok=false with a "no oa-status" reason when no block is present', () => {
    const md = 'agent did some work but forgot the tail message\n';
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no oa-status block/);
  });

  // (2) Single valid status block. Happy path; locks the parsed shape.
  it('returns the parsed object for a single valid status block', () => {
    const md = `prelude\n${fence('oa-status', '{"status":"done","summary":"all good"}')}\n`;
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'all good' });
  });

  // (5) Multiple status blocks → last one wins. This is the load-bearing
  // ADR-0008 invariant: agents demonstrating the protocol mid-response must
  // not poison the terminal status.
  it('picks the LAST oa-status block when multiple are present', () => {
    const md = [
      'first attempt:',
      fence('oa-status', '{"status":"done","summary":"first"}'),
      'then I changed my mind:',
      fence('oa-status', '{"status":"blocked","summary":"second"}'),
      '',
    ].join('\n');
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'blocked', summary: 'second' });
  });

  // (6) Last block contains invalid JSON → invalid-JSON reason. Earlier
  // blocks are NOT a fallback; once we've selected the terminal block, its
  // failures are the parser's failures.
  it('returns ok=false with an "invalid JSON" reason when the last block is malformed', () => {
    const md = [
      fence('oa-status', '{"status":"done","summary":"first"}'),
      fence('oa-status', '{"status":"done", oops not json'),
    ].join('\n');
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid JSON/);
  });

  // (7) JSON parses but fails schema (status='maybe'). Gives the supervisor a
  // distinct "schema" reason so the fix-loop can prompt with a corrective
  // hint rather than treating it like a parse error.
  it('returns ok=false with a "schema" reason when the JSON violates the schema', () => {
    const md = fence('oa-status', '{"status":"maybe","summary":"x"}');
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/schema/);
  });

  // (8) Info-string strictness. v0 is case-sensitive, exact-match: only
  // ```oa-status (no leading whitespace, no trailing chars on the same line)
  // counts. ` oa-status` and `oa-status-ish` are both ignored. Trailing
  // whitespace on the info-string line IS tolerated (markdown renderers do).
  it('treats only exact `oa-status` info-strings as matches (case-sensitive, no leading ws, trailing ws ok)', () => {
    // Leading space in the info string — must be ignored.
    const leading = `${bt(3)} oa-status\n{"status":"done","summary":"x"}\n${bt(3)}`;
    expect(parseTail(leading, 'oa-status').ok).toBe(false);

    // Different case — must be ignored.
    const upper = fence('OA-STATUS', '{"status":"done","summary":"x"}');
    expect(parseTail(upper, 'oa-status').ok).toBe(false);

    // Suffix on the info string — must be ignored.
    const suffix = fence('oa-status-ish', '{"status":"done","summary":"x"}');
    expect(parseTail(suffix, 'oa-status').ok).toBe(false);

    // Trailing whitespace on the info-string line — must be tolerated.
    const trailing = `${bt(3)}oa-status   \n{"status":"done","summary":"trail"}\n${bt(3)}`;
    const r = parseTail(trailing, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'trail' });
  });

  // (9) Realistic narrative: the agent first explains the protocol with an
  // example fenced block, then emits the real terminal block. Last-wins
  // semantics let the example pass through unharmed.
  it('ignores intermediate documentation blocks and uses the real terminal block', () => {
    const md = [
      "Here's how I'll report status (per ADR-0008):",
      '',
      fence('oa-status', '{"status":"done","summary":"<example>"}'),
      '',
      'OK, doing the real work now…',
      'Done. Final tail:',
      '',
      fence('oa-status', '{"status":"done","summary":"shipped feature X","notes":"see PR"}'),
      '',
    ].join('\n');
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        status: 'done',
        summary: 'shipped feature X',
        notes: 'see PR',
      });
  });

  // (10) Empty stdout — same shape as (1) but a degenerate haystack;
  // explicit because the regex must not match empty input.
  it('returns ok=false on empty stdout', () => {
    const r = parseTail('', 'oa-status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no oa-status block/);
  });
});

// -----------------------------------------------------------------------------
// Stream-json input (Claude adapter, `--output-format stream-json`).
//
// The fence is embedded inside an assistant message's text block, so the raw
// capture contains `...\\n\`\`\`oa-status\\n{...}\\n\`\`\`...` as a JSON
// string value — no real newlines around the fence for the existing regex to
// anchor on. parseTail must detect the stream-json shape, concatenate every
// assistant text block, and run the fence regex on THAT. Plain-text stdout
// (the codex / opencode path) must not regress.
// -----------------------------------------------------------------------------

describe('parseTail stream-json (Claude adapter)', () => {
  // Minimal stream-json line writer — matches the real shape claude emits:
  // one JSON object per line with a string `type` and (for assistants) a
  // `message.content[]` array of `{type:"text"|"tool_use"|..., ...}` items.
  const systemInit = JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'abc-123',
  });
  const assistantText = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  const assistantToolUse = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    },
  });
  const userToolResult = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }],
    },
  });

  // (s1) Reproduces the p_2026-04-21_4rs6 failure mode: the real fence lives
  // inside an assistant text block, so raw-bytes fence matching fails — but
  // parseTail must unwrap stream-json and find it.
  it('extracts the oa-status fence from an assistant text block', () => {
    const finalText =
      'Step done.\n\n```oa-status\n{"status":"done","summary":"shipped"}\n```';
    const stream = [systemInit, assistantToolUse, userToolResult, assistantText(finalText)].join(
      '\n',
    );
    const r = parseTail(stream, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'shipped' });
  });

  // (s2) Fence split across two consecutive assistant text blocks. Chunks must
  // be joined with `\n` so the closing backticks land on their own line and
  // the regex's `\n```(?=\n|$)` anchor holds.
  it('joins assistant text blocks with newlines so a fence split across blocks still matches', () => {
    const a = 'Preamble.\n\n```oa-status\n{"status":"done","summary":"joined"}';
    const b = '```\ntrailing';
    const stream = [systemInit, assistantText(a), assistantText(b)].join('\n');
    const r = parseTail(stream, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'joined' });
  });

  // (s3) Last-fence-wins still holds across stream-json: an example fence in
  // an earlier assistant text must not poison a real terminal fence in a
  // later one.
  it('honors last-fence-wins across multiple assistant text blocks', () => {
    const example = 'Heres how Ill report:\n```oa-status\n{"status":"done","summary":"example"}\n```';
    const real =
      'OK done:\n```oa-status\n{"status":"done","summary":"real terminal"}\n```';
    const stream = [systemInit, assistantText(example), assistantText(real)].join('\n');
    const r = parseTail(stream, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'real terminal' });
  });

  // (s4) Non-text assistant content (tool_use) and user tool_result messages
  // must be skipped — only `content[].type === "text"` carries the fence.
  it('ignores tool_use and user tool_result messages', () => {
    const finalText = 'done\n```oa-status\n{"status":"done","summary":"ok"}\n```';
    const stream = [
      systemInit,
      assistantToolUse,
      userToolResult,
      assistantToolUse,
      userToolResult,
      assistantText(finalText),
    ].join('\n');
    const r = parseTail(stream, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'ok' });
  });

  // (s5) Stream-json with no assistant text containing a fence → "no <kind>"
  // reason, same shape as the plain-text miss. (The regression we shipped
  // against was this exact case reporting correctly.)
  it('returns ok=false with "no oa-status" when stream-json has no fence in any text block', () => {
    const stream = [systemInit, assistantToolUse, userToolResult].join('\n');
    const r = parseTail(stream, 'oa-status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no oa-status block/);
  });

  // (s6) A line that looks like JSON but is not an object with a string
  // `type` field (e.g. a bare number, string, array) must NOT trigger
  // stream-json mode — it stays plain-text and the fence regex runs on raw
  // bytes. This guards against accidental classification of plain-text
  // output that happens to begin with `{` or `[`.
  it('does not classify input as stream-json when the first line lacks a string `type`', () => {
    const md = `[1,2,3]\n\n\`\`\`oa-status\n{"status":"done","summary":"plain"}\n\`\`\``;
    const r = parseTail(md, 'oa-status');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ status: 'done', summary: 'plain' });
  });

  // (s7) oa-review path — the reviewer is typically also claude, so the same
  // unwrap must work for review output.
  it('unwraps stream-json for oa-review blocks as well', () => {
    const finalText =
      'review:\n```oa-review\n{"issues":[{"priority":"P2","file":"a.ts","finding":"nit"}]}\n```';
    const stream = [systemInit, assistantText(finalText)].join('\n');
    const r = parseTail(stream, 'oa-review');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        issues: [{ priority: 'P2', file: 'a.ts', finding: 'nit' }],
      });
  });
});

describe('parseTail oa-review', () => {
  // (1, review variant) — symmetry with status: missing block ⇒ "no
  // oa-review" reason.
  it('returns ok=false with a "no oa-review" reason when no block is present', () => {
    const md = 'reviewer ran but emitted nothing\n';
    const r = parseTail(md, 'oa-review');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no oa-review block/);
  });

  // (3) Empty issues array is the canonical "all clear" review payload —
  // must validate.
  it('returns ok with empty issues when the reviewer found nothing', () => {
    const md = fence('oa-review', '{"issues":[]}');
    const r = parseTail(md, 'oa-review');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ issues: [] });
  });

  // (4) Non-empty issues — locks the per-issue field set the review gate
  // (Task 6.3) will consume.
  it('returns the issues array verbatim for a populated review block', () => {
    const issues = [
      {
        priority: 'P0',
        file: 'src/foo.ts',
        line: 42,
        finding: 'null deref',
        suggestion: 'guard with ?.',
      },
      {
        priority: 'P2',
        file: 'src/bar.ts',
        finding: 'minor: prefer const',
      },
    ];
    const md = fence('oa-review', JSON.stringify({ issues }));
    const r = parseTail(md, 'oa-review');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ issues });
  });
});
