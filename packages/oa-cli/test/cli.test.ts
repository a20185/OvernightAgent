import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

describe('oa-cli bin', () => {
  beforeAll(() => {
    // NOTE: assumes this test lives directly under <package>/test/. Update when tests nest deeper.
    const tsconfigDir = fileURLToPath(new URL('..', import.meta.url));
    const require = createRequire(import.meta.url);
    const tscBin = require.resolve('typescript/bin/tsc');
    const result = spawnSync(process.execPath, [tscBin, '--build', tsconfigDir, '--force'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`tsc build failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    }
    if (!existsSync(cliPath)) {
      throw new Error(
        `tsc reported success but did not emit ${cliPath} (stale tsbuildinfo? mismatched include?)`,
      );
    }
  });

  it('built cli artifact exists at dist/cli.js', () => {
    expect(existsSync(cliPath)).toBe(true);
  });

  it('prints version on --version with exit code 0', () => {
    const result = spawnSync(process.execPath, [cliPath, '--version'], {
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
