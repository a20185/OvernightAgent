import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { renderSandboxProfile } from '../../src/sandbox/render.js';

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('sandbox-exec boundaries (macOS only)', () => {
  it('allows writes inside the declared worktree and denies outside', async () => {
    // sandbox-exec requires real (non-symlink) paths — resolve /tmp → /private/tmp etc.
    const tmp = await fs.realpath(await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-sandbox-')));
    const worktree = path.resolve(tmp, 'wt');
    const outside = path.resolve(tmp, 'outside');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const profile = renderSandboxProfile({ worktreeAbs: worktree, homeAbs: os.homedir(), extraAllowPaths: [] });
    const profilePath = path.resolve(tmp, 'p.sb');
    await fs.writeFile(profilePath, profile, 'utf8');

    // allowed — write inside worktree
    await execa('sandbox-exec', ['-f', profilePath, 'touch', path.resolve(worktree, 'ok.txt')]);
    await expect(fs.access(path.resolve(worktree, 'ok.txt'))).resolves.toBeUndefined();

    // denied — write outside worktree should fail
    await expect(
      execa('sandbox-exec', ['-f', profilePath, 'touch', path.resolve(outside, 'denied.txt')]),
    ).rejects.toThrow();
    await expect(fs.access(path.resolve(outside, 'denied.txt'))).rejects.toThrow();

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
