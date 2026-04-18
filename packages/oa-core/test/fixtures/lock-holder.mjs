// Holds the inbox lock until the parent IPC-sends { kind: 'release' }.
//
// Used by the ELOCKED-timeout test in test/locks.test.ts. We hold from a
// child process (not in-process) because proper-lockfile keeps a per-file
// in-memory `locks` map keyed by the resolved path; an in-process call
// would short-circuit at unlock(), bypassing the cross-process retry path
// we want to exercise.
//
// argv[2] — absolute OA_HOME path.
// IPC: emits { kind: 'acquired' } once the lock is held; releases and
// exits cleanly on { kind: 'release' }.

import { withInboxLock } from '../../dist/index.js';

const oaHome = process.argv[2];
if (!oaHome) {
  console.error('lock-holder: missing OA_HOME argv[2]');
  process.exit(2);
}
process.env.OA_HOME = oaHome;

const releaseSignal = new Promise((resolve) => {
  process.on('message', (msg) => {
    if (msg && typeof msg === 'object' && msg.kind === 'release') resolve();
  });
});

try {
  await withInboxLock(async () => {
    process.send?.({ kind: 'acquired' });
    await releaseSignal;
  });
  process.exit(0);
} catch (err) {
  console.error('lock-holder: error', err);
  process.exit(1);
}
