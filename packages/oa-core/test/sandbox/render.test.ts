import { describe, it, expect } from 'vitest';
import { renderSandboxProfile } from '../../src/sandbox/render.js';

describe('renderSandboxProfile', () => {
  it('renders worktree write rule and broad read access', () => {
    const out = renderSandboxProfile({
      worktreeAbs: '/abs/worktrees/foo',
      homeAbs: '/Users/souler',
      extraAllowPaths: [],
    });
    expect(out).toMatch(/\(allow file-write\* \(subpath "\/abs\/worktrees\/foo"\)\)/);
    expect(out).toMatch(/\(allow file-read\* \(subpath "\/"\)\)/);
    expect(out).toMatch(/\(allow network-outbound\)/);
  });

  it('emits one extraAllowPaths line per entry with subpath syntax', () => {
    const out = renderSandboxProfile({
      worktreeAbs: '/abs/w',
      homeAbs: '/Users/u',
      extraAllowPaths: ['/opt/data', '/Users/u/.shared-cache'],
    });
    expect(out).toMatch(/\(subpath "\/opt\/data"\)/);
    expect(out).toMatch(/\(subpath "\/Users\/u\/\.shared-cache"\)/);
  });

  it('throws if worktreeAbs or homeAbs are not absolute', () => {
    expect(() =>
      renderSandboxProfile({ worktreeAbs: 'rel', homeAbs: '/h', extraAllowPaths: [] }),
    ).toThrow(/absolute/);
  });
});
