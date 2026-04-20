import { describe, it, expect } from 'vitest';
import { adapter } from '../src/index.js';

describe('oa-adapter-opencode', () => {
  it('exports an AgentAdapter with id=opencode', () => {
    expect(adapter.id).toBe('opencode');
    expect(typeof adapter.defaultModel).toBe('string');
    expect(typeof adapter.run).toBe('function');
    expect(typeof adapter.capabilities).toBe('function');
  });

  it('capabilities reports correct flags', () => {
    const c = adapter.capabilities();
    expect(c.supportsSessionId).toBe(false);
    expect(c.supportsStructuredOutput).toBe(false);
  });
});
