/**
 * Process-wide async mutex. Both `/api/transcribe` and `/api/report` use this
 * to serialise calls to single-resource upstreams (the Whisper Gateway runs
 * one transcription at a time; Ollama runs one generation at a time on a
 * given GPU). Each route owns its own instance — see `transcribe/route.ts`
 * and `report/route.ts`. Lifted verbatim from
 * github.com/HazelnutParadise/super-captions and lives here so both routes
 * stay in sync.
 *
 * Important properties:
 *
 * - `acquire(signal)` returns a release function; callers MUST invoke it
 *   in a `finally`, otherwise the next waiter is stuck forever.
 * - The release function is idempotent — safe to call twice (it no-ops on
 *   the second call).
 * - Abort during the wait: `signal.abort()` pulls the resolver out of the
 *   waiters[] and rejects the promise. There is a tight race between the
 *   abort handler and the resolver being shifted off the queue; if we lose
 *   the race we mark the slot completed and immediately hand off to the
 *   next waiter, so `completedCount` stays consistent.
 * - `pending` = (waiters + currently running). `waiting` = waiters only.
 *   `completed` = monotonically-increasing total of releases. Combining
 *   `completed` snapshot at enqueue with current `completed` lets the
 *   route compute a live "how many jobs finished since I joined" without
 *   tracking positions inside the waiters array.
 */
export class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];
  private completedCount = 0;

  get pending(): number {
    return this.waiters.length + (this.locked ? 1 : 0);
  }
  get waiting(): number {
    return this.waiters.length;
  }
  get completed(): number {
    return this.completedCount;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted before acquire");
    }
    if (this.locked) {
      let myResolver!: () => void;
      try {
        await new Promise<void>((resolve, reject) => {
          myResolver = resolve;
          this.waiters.push(resolve);
          if (signal) {
            const onAbort = () => {
              const idx = this.waiters.indexOf(myResolver);
              if (idx !== -1) this.waiters.splice(idx, 1);
              reject(signal.reason ?? new Error("aborted while queued"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      } catch (e) {
        // Race: if our resolver was already shifted off, the slot is ours
        // even though abort fired. Decline it cleanly so the next waiter
        // moves up and completedCount remains accurate.
        if (this.waiters.indexOf(myResolver) === -1) {
          this.locked = true;
          this.completedCount++;
          this.locked = false;
          const next = this.waiters.shift();
          if (next) next();
        }
        throw e;
      }
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.completedCount++;
      this.locked = false;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
