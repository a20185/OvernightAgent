import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { installShims } from '../src/commands/shims.js';

// -----------------------------------------------------------------------------
// Tests for `oa shims install` (ADR-0014). `installShims` accepts injectable
// `sourceRoot`, `home`, and `cwd` so we can exercise every scope/host pair
// without touching the developer's real home directory or CWD. Each test
// builds a fresh tmp tree with a fake bundled-shim layout, runs install, and
// asserts on the resulting filesystem.
// -----------------------------------------------------------------------------

async function buildFakeSourceTree(sourceRoot: string): Promise<void> {
  // Minimal layout mirroring what `scripts/bundle-shims.mjs` produces:
  //   <sourceRoot>/<host>/commands/<file>.md
  //   <sourceRoot>/claude/skills/<skill>/SKILL.md   (claude only has skills)
  for (const host of ['claude', 'codex', 'opencode'] as const) {
    const cmdDir = path.resolve(sourceRoot, host, 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(path.resolve(cmdDir, 'oa-intake.md'), `# ${host} intake\n`, 'utf8');
    await fs.writeFile(path.resolve(cmdDir, 'oa-queue.md'), `# ${host} queue\n`, 'utf8');
  }
  const skillDir = path.resolve(sourceRoot, 'claude', 'skills', 'oa-intake');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.resolve(skillDir, 'SKILL.md'), '# claude skill\n', 'utf8');
}

describe('installShims', () => {
  let tmp: string;
  let home: string;
  let cwd: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-shims-test-'));
    home = path.resolve(tmp, 'home');
    cwd = path.resolve(tmp, 'cwd');
    sourceRoot = path.resolve(tmp, 'shims');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await buildFakeSourceTree(sourceRoot);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('installs claude commands + skills into project scope (default)', async () => {
    const results = await installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} });
    expect(results).toHaveLength(1);
    expect(results[0]!.scope).toBe('project');

    const intakePath = path.resolve(cwd, '.claude', 'commands', 'oa-intake.md');
    const queuePath = path.resolve(cwd, '.claude', 'commands', 'oa-queue.md');
    const skillPath = path.resolve(cwd, '.claude', 'skills', 'oa-intake', 'SKILL.md');
    await expect(fs.readFile(intakePath, 'utf8')).resolves.toBe('# claude intake\n');
    await expect(fs.readFile(queuePath, 'utf8')).resolves.toBe('# claude queue\n');
    await expect(fs.readFile(skillPath, 'utf8')).resolves.toBe('# claude skill\n');
    expect(results[0]!.copied).toContain(intakePath);
    expect(results[0]!.copied).toContain(skillPath);
  });

  it('installs claude into user scope when requested', async () => {
    await installShims({ host: 'claude', scope: 'user', sourceRoot, home, cwd, log: () => {} });
    const intakePath = path.resolve(home, '.claude', 'commands', 'oa-intake.md');
    await expect(fs.readFile(intakePath, 'utf8')).resolves.toBe('# claude intake\n');
    // Must NOT have written to project scope simultaneously.
    await expect(fs.access(path.resolve(cwd, '.claude'))).rejects.toThrow();
  });

  it('installs codex into user scope by default (project scope refused)', async () => {
    const results = await installShims({ host: 'codex', sourceRoot, home, cwd, log: () => {} });
    expect(results[0]!.scope).toBe('user');
    const intakePath = path.resolve(home, '.codex', 'prompts', 'oa-intake.md');
    await expect(fs.readFile(intakePath, 'utf8')).resolves.toBe('# codex intake\n');

    await expect(
      installShims({ host: 'codex', scope: 'project', sourceRoot, home, cwd, log: () => {} }),
    ).rejects.toThrow(/codex.*project/i);
  });

  it('installs opencode into user scope by default', async () => {
    const results = await installShims({ host: 'opencode', sourceRoot, home, cwd, log: () => {} });
    expect(results[0]!.scope).toBe('user');
    const intakePath = path.resolve(home, '.config', 'opencode', 'commands', 'oa-intake.md');
    await expect(fs.readFile(intakePath, 'utf8')).resolves.toBe('# opencode intake\n');
  });

  it('--host all installs every host with its default scope', async () => {
    const results = await installShims({ host: 'all', sourceRoot, home, cwd, log: () => {} });
    const byHost = Object.fromEntries(results.map((r) => [r.host, r]));
    expect(byHost['claude']!.scope).toBe('project');
    expect(byHost['codex']!.scope).toBe('user');
    expect(byHost['opencode']!.scope).toBe('user');

    await expect(
      fs.readFile(path.resolve(cwd, '.claude', 'commands', 'oa-intake.md'), 'utf8'),
    ).resolves.toBe('# claude intake\n');
    await expect(
      fs.readFile(path.resolve(home, '.codex', 'prompts', 'oa-intake.md'), 'utf8'),
    ).resolves.toBe('# codex intake\n');
    await expect(
      fs.readFile(path.resolve(home, '.config', 'opencode', 'commands', 'oa-intake.md'), 'utf8'),
    ).resolves.toBe('# opencode intake\n');
  });

  it('skips existing files on re-run without --force', async () => {
    // First install — writes the files fresh.
    await installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} });
    // Mutate one file so we can detect whether the second run overwrote it.
    const intakePath = path.resolve(cwd, '.claude', 'commands', 'oa-intake.md');
    await fs.writeFile(intakePath, '# locally edited\n', 'utf8');

    const results = await installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} });
    expect(results[0]!.skipped).toContain(intakePath);
    await expect(fs.readFile(intakePath, 'utf8')).resolves.toBe('# locally edited\n');
  });

  it('overwrites existing files with --force', async () => {
    await installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} });
    const intakePath = path.resolve(cwd, '.claude', 'commands', 'oa-intake.md');
    await fs.writeFile(intakePath, '# locally edited\n', 'utf8');

    const results = await installShims({
      host: 'claude',
      sourceRoot,
      home,
      cwd,
      force: true,
      log: () => {},
    });
    expect(results[0]!.copied).toContain(intakePath);
    await expect(fs.readFile(intakePath, 'utf8')).resolves.toBe('# claude intake\n');
  });

  it('--dry-run reports a plan without writing anything', async () => {
    const results = await installShims({
      host: 'claude',
      sourceRoot,
      home,
      cwd,
      dryRun: true,
      log: () => {},
    });
    expect(results[0]!.planned.length).toBeGreaterThan(0);
    expect(results[0]!.copied).toHaveLength(0);
    // Nothing should exist on disk yet.
    await expect(fs.access(path.resolve(cwd, '.claude'))).rejects.toThrow();
  });

  it('throws a clear error when the source tree is missing the host dir', async () => {
    await fs.rm(path.resolve(sourceRoot, 'claude'), { recursive: true, force: true });
    await expect(
      installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} }),
    ).rejects.toThrow(/shim source.*claude/i);
  });
});
