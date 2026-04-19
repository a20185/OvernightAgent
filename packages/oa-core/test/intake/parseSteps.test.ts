import { describe, it, expect } from 'vitest';
import { parseTopLevelSteps } from '../../src/intake/parseSteps.js';

describe('parseTopLevelSteps', () => {
  it('returns empty + warning for empty input', () => {
    const r = parseTopLevelSteps('');
    expect(r.steps).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('no top-level steps'))).toBe(true);
  });

  it('returns empty + warning for whitespace-only input', () => {
    const r = parseTopLevelSteps('   \n\n\t \n  ');
    expect(r.steps).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('no top-level steps'))).toBe(true);
  });

  it('parses a pure-checkbox plan (3 items, in order)', () => {
    const md = `- [ ] First step
- [ ] Second step
- [x] Third step`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(3);
    expect(r.steps[0]).toMatchObject({ n: 1, title: 'First step' });
    expect(r.steps[1]).toMatchObject({ n: 2, title: 'Second step' });
    expect(r.steps[2]).toMatchObject({ n: 3, title: 'Third step' });
    // Checkbox style mismatch warning should NOT fire on a pure checkbox plan.
    expect(r.warnings.filter((w) => w.includes('mixed top-level markers'))).toHaveLength(0);
  });

  it('parses a pure-numbered plan (3 items, in order)', () => {
    const md = `1. Alpha
2. Beta
3. Gamma`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(3);
    expect(r.steps[0]).toMatchObject({ n: 1, title: 'Alpha' });
    expect(r.steps[1]).toMatchObject({ n: 2, title: 'Beta' });
    expect(r.steps[2]).toMatchObject({ n: 3, title: 'Gamma' });
  });

  it("step's spec includes the marker line and title text without losing the marker", () => {
    const md = `- [ ] Do the thing
- [x] Done thing`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(2);
    // Title is the user-visible text (marker stripped):
    expect(r.steps[0]?.title).toBe('Do the thing');
    // Spec preserves the original line content (marker INCLUDED):
    expect(r.steps[0]?.spec).toContain('- [ ] Do the thing');
    expect(r.steps[1]?.spec).toContain('- [x] Done thing');
  });

  it('attaches indented sub-bullets to the parent step', () => {
    const md = `- [ ] Parent step
  - sub one
  - sub two
- [ ] Next step`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]?.spec).toContain('- sub one');
    expect(r.steps[0]?.spec).toContain('- sub two');
    // Sub-bullets must NOT bleed into the next step:
    expect(r.steps[1]?.spec).not.toContain('sub one');
    expect(r.steps[1]?.spec).not.toContain('sub two');
  });

  it('attaches indented prose paragraphs to the parent step', () => {
    const md = `- [ ] Parent step
  some prose
  more prose
- [ ] Next step`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]?.spec).toContain('some prose');
    expect(r.steps[0]?.spec).toContain('more prose');
    expect(r.steps[1]?.spec).not.toContain('some prose');
  });

  it('preserves code fences verbatim and does not mis-detect step markers inside them', () => {
    const md = `- [ ] real step
  here is some code:
  \`\`\`
  - [ ] not a step (inside fence)
  1. also not a step
  \`\`\`
- [ ] second real step`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]?.title).toBe('real step');
    expect(r.steps[0]?.spec).toContain('- [ ] not a step (inside fence)');
    expect(r.steps[0]?.spec).toContain('1. also not a step');
    expect(r.steps[1]?.title).toBe('second real step');
  });

  it('mixed checkbox+numbered emits the mixed warning AND parses both as steps', () => {
    const md = `- [ ] First (checkbox)
1. Second (numbered)
- [ ] Third (checkbox)`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(3);
    expect(r.steps[0]?.title).toBe('First (checkbox)');
    expect(r.steps[1]?.title).toBe('Second (numbered)');
    expect(r.steps[2]?.title).toBe('Third (checkbox)');
    expect(r.warnings.some((w) => w.includes('mixed top-level markers'))).toBe(true);
  });

  it('mixed checkbox+heading emits the heading warning', () => {
    const md = `# Plan title
## A heading that looks like a step
- [ ] real step one
- [ ] real step two`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(2);
    expect(
      r.warnings.some((w) =>
        w.includes('top-level headings present alongside checkbox/numbered items'),
      ),
    ).toBe(true);
  });

  it('does NOT treat indented `  - [ ] ...` as a top-level step', () => {
    const md = `- [ ] Real top-level step
  - [ ] indented checkbox (sub-bullet)
  - [ ] another indented checkbox`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.title).toBe('Real top-level step');
    expect(r.steps[0]?.spec).toContain('- [ ] indented checkbox (sub-bullet)');
  });

  it('uses 1-indexed `n` (first step is n=1)', () => {
    const md = `- [ ] only step`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.n).toBe(1);
  });

  it('case-insensitive on the checkbox `x` (both `[x]` and `[X]` parse)', () => {
    const md = `- [x] lower x
- [X] upper X
* [ ] asterisk bullet`;
    const r = parseTopLevelSteps(md);
    expect(r.steps).toHaveLength(3);
    expect(r.steps[0]?.title).toBe('lower x');
    expect(r.steps[1]?.title).toBe('upper X');
    expect(r.steps[2]?.title).toBe('asterisk bullet');
  });
});
