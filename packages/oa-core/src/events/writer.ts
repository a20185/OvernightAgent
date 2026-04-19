import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertAbs } from '../paths.js';
import { EventSchema, type Event } from '../schemas.js';

/**
 * Task 7.1 — events.jsonl writer.
 *
 * The Phase 7 supervisor opens exactly one writer per run (`<runDir>/events.jsonl`)
 * and emits a structured event for every state transition: `run.start` →
 * `task.start` → `step.start` → `step.attempt.start` → `step.verify.*` → …
 * The file is the source of truth for resume, the SUMMARY renderer (Phase 9),
 * and any post-mortem analysis tooling, so the writer's contract is small but
 * load-bearing:
 *
 *   - **One JSON object per line, append-only.** No partial lines, no in-place
 *     edits. JSONL stays trivially streamable + tail-able.
 *   - **`emit()` auto-stamps `ts`.** Call sites stay terse (just `kind` + payload),
 *     and we get a single canonical timestamp source (`new Date().toISOString()`),
 *     so consumers can rely on monotonic-ish ordering without trusting callers.
 *   - **Validation is opt-in.** The supervisor's hot path skips zod for perf;
 *     dev/test set `validate: true` to catch shape drift early. The writer never
 *     swallows a validation failure — `EventSchema.parse` throws and the bad
 *     line is *not* written (so `validate: true` doubles as a fast canary in
 *     CI without polluting the run log).
 *   - **Atomic at the line level via the POSIX append-mode guarantee.** Files
 *     opened with O_APPEND get atomic writes up to PIPE_BUF (≥4 KiB on every
 *     POSIX). Our event lines (a few hundred bytes max) are well under that, so
 *     a single `appendFile` call cannot interleave with another writer's append
 *     to the same fd — even from a different process. We don't strictly need
 *     cross-process safety in v0 (one supervisor per run), but the property
 *     comes for free with `mode: 'a'` and is worth preserving for future
 *     cross-process readers/writers (e.g., a side-car tail printer).
 *   - **In-process ordering is FIFO.** `emit()` awaits the underlying
 *     `appendFile`, so when a single caller fires N emits in parallel
 *     (`Promise.all`), the V8 microtask queue drains them in issuance order;
 *     each subsequent `appendFile` runs after the prior one resolves. The
 *     parallel-stress test in writer.test.ts pins this behavior.
 *   - **`close()` is idempotent.** The supervisor's shutdown sequence calls
 *     close() from multiple unwind paths (signal handler, finally block,
 *     resume bookkeeping) — making it safe to double-call avoids a class of
 *     spurious EBADF surprises.
 *   - **emit-after-close throws.** A programmer error in the supervisor (a
 *     stray emit after the shutdown barrier) should fail loudly, not silently
 *     drop the event.
 */

export interface EventWriterOpts {
  /** Absolute path to the target events.jsonl. Parent dir is auto-created. */
  absPath: string;
  /**
   * If true, every emit() runs `EventSchema.parse(stamped)` before the write.
   * Use in dev/test; leave false in prod (the supervisor's hot path).
   */
  validate?: boolean;
}

export interface EventWriter {
  /**
   * Append one event to the JSONL file. The writer auto-stamps `ts` so callers
   * supply only the kind-discriminated payload. Throws after `close()`.
   */
  emit(event: Omit<Event, 'ts'>): Promise<void>;
  /**
   * Flush + close the underlying fd. Safe to call more than once. After
   * close, `emit()` throws.
   */
  close(): Promise<void>;
}

/**
 * Open a writer for `opts.absPath`. The path must be absolute (assertAbs throws
 * otherwise). The parent directory is created if missing — convenient for the
 * supervisor, which can blindly point at `<runDir>/events.jsonl` without
 * pre-bootstrapping the runs subtree.
 */
export async function openEventWriter(opts: EventWriterOpts): Promise<EventWriter> {
  assertAbs(opts.absPath);
  await fs.mkdir(path.dirname(opts.absPath), { recursive: true });
  // 'a' = O_APPEND. The kernel atomically positions each write at end-of-file,
  // and writes ≤ PIPE_BUF (≥4 KiB) are atomic against other writers sharing
  // the same fd. Our event lines are well under that.
  let fh: fs.FileHandle | null = await fs.open(opts.absPath, 'a');

  // Serialize emits via a chained promise. POSIX O_APPEND gives us cross-
  // process atomicity at the line level, but `FileHandle.appendFile` in Node
  // is not internally serialized — concurrent calls on the same handle race
  // on internal bookkeeping (offset hints, partial chunk writes) and can
  // produce out-of-order lines under load. Chaining each emit's `appendFile`
  // off the prior tail forces FIFO ordering matching call-issuance order,
  // which the parallel-stress test pins.
  let tail: Promise<void> = Promise.resolve();

  return {
    async emit(event) {
      if (!fh) throw new Error('event writer is closed');
      // `ts` last so an authoritative stamp wins even if a (mis-typed) caller
      // sneaks one in. The Omit<Event,'ts'> signature already discourages
      // this, but defense-in-depth costs us nothing.
      const stamped = { ...event, ts: new Date().toISOString() } as Event;
      if (opts.validate) {
        EventSchema.parse(stamped);
      }
      const line = JSON.stringify(stamped) + '\n';
      // Capture the current handle so a mid-flight close() can't surprise us.
      const handle = fh;
      // Splice this emit onto the serial chain and update `tail` synchronously
      // so the *next* caller in the same microtask tick sees us as already
      // queued. We swallow prior errors here (they were surfaced to the
      // emitter that owned them) to keep the chain alive.
      const next = tail.then(
        () => handle.appendFile(line),
        () => handle.appendFile(line),
      );
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      await next;
    },
    async close() {
      if (fh) {
        const local = fh;
        fh = null; // null first so a concurrent close() observes the no-op fast path
        // Drain in-flight emits before closing the fd, so we don't EBADF a
        // pending write. Errors on the tail are owned by the emitter that
        // produced them — close() should not re-throw them.
        await tail.catch(() => undefined);
        await local.close();
      }
    },
  };
}
