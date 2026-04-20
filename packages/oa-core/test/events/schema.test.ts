import { describe, it, expect } from 'vitest';
import { EventSchema } from '../../src/schemas.js';

/**
 * Task 3.2 — step.stall event kind schema tests.
 *
 * `step.stall` is emitted when the supervisor detects that an attempt count
 * has crossed a stall-detection threshold (soft or hard). The event carries
 * the current `attempt` number and both `soft` / `hard` thresholds so the
 * SUMMARY renderer and downstream consumers can reason about stall state
 * without re-deriving the thresholds from config.
 */

describe('EventSchema — step.stall', () => {
  it('parses a valid step.stall event', () => {
    const ev = {
      ts: '2026-04-20T12:00:00Z',
      kind: 'step.stall',
      taskId: 't1',
      stepN: 1,
      attempt: 3,
      soft: 3,
      hard: 5,
    };
    const result = EventSchema.safeParse(ev);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        kind: 'step.stall',
        taskId: 't1',
        stepN: 1,
        attempt: 3,
        soft: 3,
        hard: 5,
      });
    }
  });

  it('rejects a step.stall event missing soft', () => {
    const ev = {
      ts: '2026-04-20T12:00:00Z',
      kind: 'step.stall',
      taskId: 't1',
      stepN: 1,
      attempt: 3,
      hard: 5,
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it('rejects a step.stall event missing hard', () => {
    const ev = {
      ts: '2026-04-20T12:00:00Z',
      kind: 'step.stall',
      taskId: 't1',
      stepN: 1,
      attempt: 3,
      soft: 3,
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it('allows extra fields (passthrough, consistent with other variants)', () => {
    const ev = {
      ts: '2026-04-20T12:00:00Z',
      kind: 'step.stall',
      taskId: 't1',
      stepN: 1,
      attempt: 3,
      soft: 3,
      hard: 5,
      extraInfo: 'passthrough allows this',
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('rejects a step.stall event with non-positive attempt', () => {
    const ev = {
      ts: '2026-04-20T12:00:00Z',
      kind: 'step.stall',
      taskId: 't1',
      stepN: 1,
      attempt: 0,
      soft: 3,
      hard: 5,
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });
});
