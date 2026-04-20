#!/usr/bin/env node
// Build-time shim bundler (ADR-0014). Copies `packages/oa-shims/<host>/{commands,skills,hooks}/`
// into `packages/oa-cli/dist/shims/<host>/` so they ship inside the published
// `@soulerou/oa-cli` tarball and `oa shims install` can find them relative to
// the compiled `cli.js` via `new URL('./shims/...', import.meta.url)`.
//
// Pure copy — no transformation. Blows away the dest subtree first so renames
// and deletions in the source propagate. Idempotent; safe to run multiple
// times from the same package.json script chain.
//
// Absolute paths throughout (ADR-0002): every fs op resolves through
// `path.resolve` so we can never clobber a sibling workspace by accident.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, '..');
const SHIMS_SRC = path.resolve(CLI_ROOT, '..', 'oa-shims');
const SHIMS_DEST = path.resolve(CLI_ROOT, 'dist', 'shims');

const HOSTS = ['claude', 'codex', 'opencode'];
// Subdirs we care about per host. A host that doesn't have one is skipped
// without error (codex/opencode currently have `commands/` only).
const SUBDIRS = ['commands', 'skills', 'hooks'];

async function exists(absPath) {
  try {
    await fs.stat(absPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function copyDir(srcAbs, destAbs) {
  await fs.mkdir(destAbs, { recursive: true });
  const entries = await fs.readdir(srcAbs, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.resolve(srcAbs, entry.name);
    const d = path.resolve(destAbs, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
    // Symlinks, sockets, etc. intentionally skipped — shim content should be
    // plain files. If a symlink ever appears here it's either a bug or a
    // source-tree convention we haven't decided about, and silently following
    // it could produce a surprising publish tarball.
  }
}

async function main() {
  if (!(await exists(SHIMS_SRC))) {
    // No shim source at all — either someone deleted packages/oa-shims, or
    // the script is running outside the monorepo. Fail loudly rather than
    // publish a CLI that says `oa shims install` but ships no shims.
    throw new Error(`shim source not found: ${SHIMS_SRC}`);
  }

  // Blow away prior bundle so removals propagate. `rm -rf`-equivalent; scoped
  // to the absolute SHIMS_DEST we just computed so no sibling dir is at risk.
  await fs.rm(SHIMS_DEST, { recursive: true, force: true });
  await fs.mkdir(SHIMS_DEST, { recursive: true });

  let copiedFiles = 0;
  for (const host of HOSTS) {
    const hostSrc = path.resolve(SHIMS_SRC, host);
    if (!(await exists(hostSrc))) {
      // A host directory may legitimately be absent in a future repo state
      // (e.g. someone removed opencode support). Warn rather than fail so
      // the remaining hosts still ship.
      process.stderr.write(`bundle-shims: skipping missing host dir ${hostSrc}\n`);
      continue;
    }

    for (const sub of SUBDIRS) {
      const subSrc = path.resolve(hostSrc, sub);
      if (!(await exists(subSrc))) continue;
      const subDest = path.resolve(SHIMS_DEST, host, sub);
      await copyDir(subSrc, subDest);
      const after = await fs.readdir(subDest, { recursive: true });
      copiedFiles += after.filter((name) => name.endsWith('.md') || name.endsWith('.json')).length;
    }

    // Per-host README.md is handy for `oa shims show` / debugging — copy it
    // alongside the commands/skills trees if present.
    const readmeSrc = path.resolve(hostSrc, 'README.md');
    if (await exists(readmeSrc)) {
      const readmeDest = path.resolve(SHIMS_DEST, host, 'README.md');
      await fs.mkdir(path.dirname(readmeDest), { recursive: true });
      await fs.copyFile(readmeSrc, readmeDest);
    }
  }

  process.stdout.write(`bundle-shims: copied ${copiedFiles} markdown files into ${SHIMS_DEST}\n`);
}

main().catch((err) => {
  process.stderr.write(`bundle-shims failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
