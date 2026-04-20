import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readAll } from '../../src/events/reader.js';

describe('events.jsonl reader', () => {
  let TMP: string;
  let FILE: string;

  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-events-read-'));
    FILE = path.resolve(TMP, 'events.jsonl');
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('returns [] if file is missing', async () => {
    const out = await readAll({ absPath: FILE });
    expect(out).toEqual([]);
  });

  it('parses each line as a JSON object', async () => {
    await fs.writeFile(
      FILE,
      [
        JSON.stringify({ kind: 'run.start', planId: 'p1' }),
        JSON.stringify({ kind: 'task.start', taskId: 't1' }),
        JSON.stringify({ kind: 'run.stop' }),
      ].join('\n') + '\n',
    );
    const out = await readAll({ absPath: FILE });
    expect(out).toHaveLength(3);
    expect(out[0]?.kind).toBe('run.start');
    expect(out[2]?.kind).toBe('run.stop');
  });

  it('skips malformed lines via onInvalid', async () => {
    const invalidCalls: Array<[number, string]> = [];
    await fs.writeFile(
      FILE,
      [
        JSON.stringify({ kind: 'run.start' }),
        'not a json line',
        JSON.stringify({ kind: 'run.stop' }),
      ].join('\n') + '\n',
    );
    const out = await readAll({
      absPath: FILE,
      onInvalid: (n, line) => invalidCalls.push([n, line]),
    });
    expect(out).toHaveLength(2);
    expect(invalidCalls).toEqual([[2, 'not a json line']]);
  });

  it('skips non-object JSON values (arrays, primitives)', async () => {
    await fs.writeFile(
      FILE,
      [
        JSON.stringify({ kind: 'run.start' }),
        '42',
        JSON.stringify(['not', 'an', 'object']),
      ].join('\n') + '\n',
    );
    const out = await readAll({
      absPath: FILE,
      onInvalid: () => undefined,
    });
    expect(out).toHaveLength(1);
  });

  it('tolerates trailing newline + empty final line', async () => {
    await fs.writeFile(FILE, `${JSON.stringify({ kind: 'run.start' })}\n\n`);
    const out = await readAll({ absPath: FILE });
    expect(out).toHaveLength(1);
  });
});
