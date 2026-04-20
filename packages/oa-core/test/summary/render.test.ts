import { describe, it, expect } from 'vitest';
import { renderSummary } from '../../src/summary/render.js';

describe('renderSummary', () => {
  it('renders the morning-report fixture', () => {
    const events = [
      { ts: '2026-04-20T00:00:00Z', kind: 'run.start', planId: 'p_1' },
      { ts: '2026-04-20T00:00:05Z', kind: 'task.start', taskId: 't_A' },
      { ts: '2026-04-20T00:00:10Z', kind: 'step.start', taskId: 't_A', stepN: 1 },
      { ts: '2026-04-20T00:00:11Z', kind: 'step.attempt.start', taskId: 't_A', stepN: 1, attempt: 1 },
      { ts: '2026-04-20T00:01:00Z', kind: 'step.end', taskId: 't_A', stepN: 1, status: 'done' },
      {
        ts: '2026-04-20T00:02:00Z',
        kind: 'task.end',
        taskId: 't_A',
        status: 'done',
      },
      { ts: '2026-04-20T00:02:05Z', kind: 'task.start', taskId: 't_B' },
      { ts: '2026-04-20T00:02:10Z', kind: 'step.start', taskId: 't_B', stepN: 1 },
      { ts: '2026-04-20T00:02:11Z', kind: 'step.attempt.start', taskId: 't_B', stepN: 1, attempt: 1 },
      { ts: '2026-04-20T00:03:00Z', kind: 'step.attempt.start', taskId: 't_B', stepN: 1, attempt: 2 },
      {
        ts: '2026-04-20T00:03:10Z',
        kind: 'step.verify.review.fail',
        taskId: 't_B',
        stepN: 1,
        attempt: 2,
        issues: [
          { priority: 'P0', summary: 'missing null check' },
          { priority: 'P2', summary: 'minor style' },
        ],
      },
      { ts: '2026-04-20T00:04:00Z', kind: 'step.end', taskId: 't_B', stepN: 1, status: 'blocked' },
      { ts: '2026-04-20T00:04:05Z', kind: 'task.end', taskId: 't_B', status: 'blocked-needs-human' },
      { ts: '2026-04-20T00:05:00Z', kind: 'run.stop', reason: 'partial' },
    ];
    const md = renderSummary({ planId: 'p_1', events });
    expect(md).toContain('# SUMMARY — p_1');
    expect(md).toContain('duration=5m0s');
    expect(md).toContain('reason=partial');
    expect(md).toContain('| t_A | done |');
    expect(md).toContain('| t_B | blocked-needs-human |');
    expect(md).toContain('### t_A');
    expect(md).toContain('### t_B');
    // P0 issue listed, P2 filtered out.
    expect(md).toContain('[P0] missing null check');
    expect(md).not.toContain('minor style');
    // Attempt count reflects the 2 attempts for t_B step 1.
    expect(md).toMatch(/\| 1 \| blocked \| 2 \|/);
  });

  it('tolerates empty events (sealed-never-run)', () => {
    const md = renderSummary({ planId: 'p_empty', events: [] });
    expect(md).toContain('# SUMMARY — p_empty');
    expect(md).toContain('(none)');
  });

  it('ignores unknown event kinds for forward compat', () => {
    const md = renderSummary({
      planId: 'p_fw',
      events: [
        { ts: '2026-04-20T00:00:00Z', kind: 'run.start' },
        { ts: '2026-04-20T00:00:01Z', kind: 'future.kind', weird: 123 },
        { ts: '2026-04-20T00:00:02Z', kind: 'run.stop', reason: 'done' },
      ],
    });
    expect(md).toContain('# SUMMARY — p_fw');
    expect(md).not.toContain('future.kind');
  });

  it('marks a step that stalled then recovered with ⚠ stalled', () => {
    const events = [
      { ts: '2026-04-20T00:00:00Z', kind: 'run.start' },
      { ts: '2026-04-20T00:00:05Z', kind: 'task.start', taskId: 't_A' },
      { ts: '2026-04-20T00:00:10Z', kind: 'step.start', taskId: 't_A', stepN: 1 },
      { ts: '2026-04-20T00:00:11Z', kind: 'step.attempt.start', taskId: 't_A', stepN: 1, attempt: 1 },
      { ts: '2026-04-20T00:00:20Z', kind: 'step.attempt.start', taskId: 't_A', stepN: 1, attempt: 2 },
      { ts: '2026-04-20T00:00:30Z', kind: 'step.attempt.start', taskId: 't_A', stepN: 1, attempt: 3 },
      // step.stall fires at attempt=3 (crossing soft threshold)
      { ts: '2026-04-20T00:00:35Z', kind: 'step.stall', taskId: 't_A', stepN: 1, attempt: 3, soft: 3, hard: 5 },
      // ... but eventually succeeds
      { ts: '2026-04-20T00:01:00Z', kind: 'step.end', taskId: 't_A', stepN: 1, status: 'done' },
      { ts: '2026-04-20T00:01:05Z', kind: 'task.end', taskId: 't_A', status: 'done' },
      { ts: '2026-04-20T00:01:10Z', kind: 'run.stop', reason: 'done' },
    ];
    const md = renderSummary({ planId: 'p_stall_recover', events });
    // The step row should show "done ⚠ stalled"
    expect(md).toMatch(/\| 1 \| done ⚠ stalled \|/);
  });

  it('marks a step that stalled then blocked with ⚠ stalled→blocked', () => {
    const events = [
      { ts: '2026-04-20T00:00:00Z', kind: 'run.start' },
      { ts: '2026-04-20T00:00:05Z', kind: 'task.start', taskId: 't_B' },
      { ts: '2026-04-20T00:00:10Z', kind: 'step.start', taskId: 't_B', stepN: 1 },
      { ts: '2026-04-20T00:00:11Z', kind: 'step.attempt.start', taskId: 't_B', stepN: 1, attempt: 1 },
      { ts: '2026-04-20T00:00:20Z', kind: 'step.attempt.start', taskId: 't_B', stepN: 1, attempt: 2 },
      { ts: '2026-04-20T00:00:30Z', kind: 'step.attempt.start', taskId: 't_B', stepN: 1, attempt: 3 },
      { ts: '2026-04-20T00:00:35Z', kind: 'step.stall', taskId: 't_B', stepN: 1, attempt: 3, soft: 3, hard: 5 },
      // exhausted all attempts, ended blocked
      { ts: '2026-04-20T00:01:00Z', kind: 'step.end', taskId: 't_B', stepN: 1, status: 'blocked' },
      { ts: '2026-04-20T00:01:05Z', kind: 'task.end', taskId: 't_B', status: 'blocked-needs-human' },
      { ts: '2026-04-20T00:01:10Z', kind: 'run.stop', reason: 'partial' },
    ];
    const md = renderSummary({ planId: 'p_stall_blocked', events });
    // The step row should show "blocked ⚠ stalled→blocked"
    expect(md).toMatch(/\| 1 \| blocked ⚠ stalled→blocked \|/);
  });

  it('does not add stall marker when no step.stall event exists', () => {
    const events = [
      { ts: '2026-04-20T00:00:00Z', kind: 'run.start' },
      { ts: '2026-04-20T00:00:05Z', kind: 'task.start', taskId: 't_A' },
      { ts: '2026-04-20T00:00:10Z', kind: 'step.start', taskId: 't_A', stepN: 1 },
      { ts: '2026-04-20T00:00:11Z', kind: 'step.attempt.start', taskId: 't_A', stepN: 1, attempt: 1 },
      { ts: '2026-04-20T00:01:00Z', kind: 'step.end', taskId: 't_A', stepN: 1, status: 'done' },
      { ts: '2026-04-20T00:01:05Z', kind: 'task.end', taskId: 't_A', status: 'done' },
      { ts: '2026-04-20T00:01:10Z', kind: 'run.stop', reason: 'done' },
    ];
    const md = renderSummary({ planId: 'p_no_stall', events });
    // Normal step row — no stall marker
    expect(md).toMatch(/\| 1 \| done \|/);
    expect(md).not.toContain('⚠');
  });
});
