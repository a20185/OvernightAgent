import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { adapter } from '../src/index.js';
import type { AgentRunOpts } from '@soulerou/oa-core';

// -----------------------------------------------------------------------------
// Tests for the headless `claude` AgentAdapter.
//
// We never spawn the real `claude` binary — it isn't guaranteed to be installed
// on CI hosts and would be non-deterministic anyway. Instead we PATH-shim a
// tiny POSIX shell script (test/fixtures/bin/claude) that emits a known
// stream-json line then exits 0. The adapter's `run()` calls `claude` via
// PATH lookup, so prepending the fixtures dir to PATH is sufficient — no
// symlinks, no global installs, no platform-specific dance.
// -----------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BIN_DIR = path.resolve(HERE, 'fixtures/bin');

let TMP: string;
let ORIGINAL_PATH: string | undefined;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-claude-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
  ORIGINAL_PATH = process.env.PATH;
  // Prepend so our mock wins over any real `claude` on the developer's host.
  process.env.PATH = `${FIXTURE_BIN_DIR}${path.delimiter}${ORIGINAL_PATH ?? ''}`;
});

afterEach(async () => {
  // Always restore PATH even if a test threw; PATH is process-global.
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  delete process.env.MOCK_CLAUDE_NO_SESSION;
  delete process.env.MOCK_CLAUDE_EMPTY;
  await fs.rm(TMP, { recursive: true, force: true });
});

async function makeOpts(overrides?: Partial<AgentRunOpts>): Promise<AgentRunOpts> {
  const promptPath = path.resolve(TMP, 'prompt.md');
  await fs.writeFile(promptPath, '# test prompt\n\nDo a thing.\n', 'utf8');
  return {
    cwd: TMP,
    promptPath,
    model: 'opus',
    extraArgs: [],
    timeoutSec: 10,
    stdoutCapBytes: 1_000_000,
    stdoutPath: path.resolve(TMP, 'stdout.log'),
    stderrPath: path.resolve(TMP, 'stderr.log'),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('oa-adapter-claude', () => {
  it('capabilities() reports session + structured-output support; defaultModel is opus', () => {
    expect(adapter.id).toBe('claude');
    expect(adapter.defaultModel).toBe('opus');
    expect(adapter.capabilities()).toEqual({
      supportsSessionId: true,
      supportsStructuredOutput: true,
    });
  });

  it('run() returns AgentRunResult with exitCode 0 and no killer when the mock exits cleanly', async () => {
    // The fixture bin always exits 0; pass MOCK_CLAUDE_EMPTY so the assertions
    // here don't depend on the parser test (covered separately below).
    process.env.MOCK_CLAUDE_EMPTY = '1';
    const opts = await makeOpts({ env: { MOCK_CLAUDE_EMPTY: '1' } });
    const result = await adapter.run(opts);
    expect(result.exitCode).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdoutCapHit).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('run() parses sessionId from stream-json init event when present', async () => {
    const opts = await makeOpts();
    const result = await adapter.run(opts);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe('sess_test_123');
  });

  it('run() returns sessionId undefined when stream-json contains no init event', async () => {
    process.env.MOCK_CLAUDE_NO_SESSION = '1';
    const opts = await makeOpts({ env: { MOCK_CLAUDE_NO_SESSION: '1' } });
    const result = await adapter.run(opts);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBeUndefined();
  });

  it('run() rejects relative cwd / promptPath via assertAbs', async () => {
    const absOpts = await makeOpts();
    // Relative cwd → spawnHeadless throws non-absolute.
    await expect(adapter.run({ ...absOpts, cwd: 'rel/cwd' })).rejects.toThrow(/non-absolute/);
    // Relative promptPath → adapter throws non-absolute.
    await expect(adapter.run({ ...absOpts, promptPath: 'rel/prompt.md' })).rejects.toThrow(
      /non-absolute/,
    );
  });
});
