// Worker for the cross-process serialization test in test/locks.test.ts.
//
// argv[2] — absolute path to OA_HOME (the per-test tmpdir).
//
// Imports the BUILT module (../../dist/index.js) because child_process.fork
// runs under plain node, not vitest's TS transformer. The parent test ensures
// the build is fresh in beforeAll.
//
// Sends two IPC messages to the parent — { kind: 'start', ts, pid } and
// { kind: 'end', ts, pid } — bracketing a 150ms hold inside the lock. The
// parent sorts events by ts and asserts adjacent (start, end) pairs come from
// the same pid, proving the critical sections did not overlap across procs.

import { withInboxLock } from '../../dist/index.js';

const oaHome = process.argv[2];
if (!oaHome) {
  console.error('lock-worker: missing OA_HOME argv[2]');
  process.exit(2);
}
process.env.OA_HOME = oaHome;

try {
  await withInboxLock(async () => {
    process.send?.({ kind: 'start', ts: Date.now(), pid: process.pid });
    await new Promise((r) => setTimeout(r, 150));
    process.send?.({ kind: 'end', ts: Date.now(), pid: process.pid });
  });
  process.exit(0);
} catch (err) {
  console.error('lock-worker: error', err);
  process.exit(1);
}
