/**
 * Drops a record's raw observations once nothing can still need them.
 *
 * A request is judged once, and the verdict is what the extension is for. The
 * headers, query and payloads behind that verdict are the bulk of a record —
 * roughly six sevenths of it — and once the policy has run they have no reader
 * left, so they are released rather than held for the life of the tab.
 *
 * The release is deferred rather than immediate because a response payload
 * arrives after the first evaluation: it crosses the DevTools bridge
 * asynchronously and re-runs the policy when it lands. `RETAIN_MS` is sized to
 * clear that round trip with room to spare.
 *
 * Capture drives the timer rather than a clock: ingest asks for a sweep, each
 * sweep re-arms itself for the oldest record still holding observations, and a
 * tab with nothing left to release runs no timer at all.
 */

import { logger } from '../shared/logger.ts';
import type { RequestRecord } from '../shared/types.ts';
import { allRecords } from './store.ts';

/**
 * How long a record keeps its raw observations after it started.
 *
 * A body round trip is well under a second; this leaves room for a slow one on
 * a loaded page without holding observations for the life of the tab.
 */
const RETAIN_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;

/** Whether a record still holds observations worth releasing. */
function isReducible(record: RequestRecord): boolean {
  return (
    record.requestBody !== undefined ||
    record.responseBody !== undefined ||
    Object.keys(record.requestHeaders).length > 0 ||
    Object.keys(record.responseHeaders).length > 0 ||
    Object.keys(record.query).length > 0
  );
}

/**
 * Releases one record's observations, keeping the verdict and the timings.
 *
 * @public — also driven directly by `build/reduce-check.ts`.
 *
 * Fields are emptied rather than deleted: the shape stays stable, so the hidden
 * class the engine and the serializer were optimised against does not change.
 */
export function reduceRecord(record: RequestRecord): void {
  record.requestHeaders = {};
  record.responseHeaders = {};
  record.query = {};
  record.requestBody = undefined;
  record.responseBody = undefined;
}

/**
 * Reduces every record past the retention window.
 *
 * Returns when the next record becomes due, or `null` when none is waiting.
 *
 * @public — also driven directly by `build/reduce-check.ts`.
 */
export function sweep(now = Date.now()): {
  readonly reduced: number;
  readonly nextDueIn: number | null;
} {
  let reduced = 0;
  let oldestPending: number | null = null;
  for (const record of allRecords()) {
    if (!isReducible(record)) {
      continue;
    }
    if (now - record.startedAt >= RETAIN_MS) {
      reduceRecord(record);
      reduced += 1;
    } else if (oldestPending === null || record.startedAt < oldestPending) {
      oldestPending = record.startedAt;
    }
  }
  if (reduced > 0) {
    logger.debug(`released observations for ${String(reduced)} record(s)`);
  }
  return {
    reduced,
    nextDueIn: oldestPending === null ? null : Math.max(oldestPending + RETAIN_MS - now, 0),
  };
}

/** Arms the single sweep timer, which re-arms itself while work remains. */
function arm(delay: number): void {
  if (timer !== null) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    const { nextDueIn } = sweep();
    if (nextDueIn !== null) {
      arm(nextDueIn);
    }
  }, delay);
}

/**
 * Asks for a sweep once the records captured now become due.
 *
 * Called on capture, so the timer exists only while there is something to
 * release. An already-armed timer is left alone: when it fires it re-arms for
 * whatever is still pending.
 */
export function scheduleSweep(): void {
  arm(RETAIN_MS);
}
