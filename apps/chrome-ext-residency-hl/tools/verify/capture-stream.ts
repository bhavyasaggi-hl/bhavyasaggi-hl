/**
 * Verifies how the capture side reconciles the live event stream against the
 * one-shot `getHAR()` backfill.
 *
 * This is the seam that decides whether a request reaches the worker at all, so
 * its failure mode is silence — a row that never appears. Run with `yarn verify`.
 */

import process from 'node:process';
import { check, installChrome, installDevtools, report, section, settle } from './harness.ts';

installChrome();
const devtools = installDevtools();

// `scripts.ts` is imported by `capture.ts` and registers a window listener at
// module scope; the sandbox itself is covered by its own suite.
(globalThis as unknown as { addEventListener: () => void }).addEventListener = () => undefined;
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    style: {},
    setAttribute: () => undefined,
    addEventListener: () => undefined,
  }),
  body: { append: () => undefined },
};

const { startCapture } = await import('../../src/devtools/capture.ts');
startCapture(7);
devtools.setRecording(true);

/** A HAR entry, as `onRequestFinished` and `getHAR()` both shape one. */
function entry(method: string, url: string, startedDateTime: string): unknown {
  return {
    startedDateTime,
    time: 5,
    _resourceType: method === 'OPTIONS' ? 'preflight' : 'fetch',
    request: { method, url, headers: [] },
    response: { status: 200, statusText: 'OK', headers: [], content: {} },
  };
}

section('the live stream is never deduplicated against itself');

// Requests fired together — `Promise.all` of the same call, a retry burst, a
// row of identical thumbnails — share a method, a url and a millisecond. They
// are still separate requests and every one of them has to be reported.
const SAME_MS = '2026-09-22T10:00:00.000Z';
for (let i = 0; i < 5; i += 1) {
  devtools.finish(entry('GET', 'https://eu.api.acme.com/v1/ping', SAME_MS));
}
await settle();
check(
  'five identical parallel requests all reach the worker',
  devtools.ingested().filter((r) => r.url.endsWith('/v1/ping')).length,
  5,
);

// The reported bug: the OPTIONS shows up, the call it authorised does not.
const PAIR_MS = '2026-09-22T10:00:01.000Z';
devtools.finish(entry('OPTIONS', 'https://eu.api.acme.com/v1/orders', PAIR_MS));
devtools.finish(entry('POST', 'https://eu.api.acme.com/v1/orders', PAIR_MS));
devtools.finish(entry('POST', 'https://eu.api.acme.com/v1/orders', PAIR_MS));
await settle();
const orders = devtools.ingested().filter((r) => r.url.endsWith('/v1/orders'));
check(
  'a preflight and both POSTs it authorised are all kept',
  [
    orders.filter((r) => r.method === 'OPTIONS').length,
    orders.filter((r) => r.method === 'POST').length,
  ],
  [1, 2],
);

check(
  'every record still gets its own id',
  new Set(devtools.ingested().map((r) => r.id)).size,
  devtools.ingested().length,
);

section('the backfill takes what finished before recording started');

// Stopping and restarting is what triggers a fresh `getHAR()`.
devtools.setRecording(false);
await settle();
const beforeRestart = devtools.ingested().length;

// The split is finish time against the moment recording started. Anything that
// finished earlier fired its event while nothing was listening, so the snapshot
// is the only copy; anything still running will arrive live.
const now = Date.now();
const at = (offsetMs: number, durationMs = 5): string =>
  new Date(now + offsetMs - durationMs).toISOString();

devtools.setHar([
  { ...(entry('GET', 'https://eu.api.acme.com/v1/old', at(-60_000)) as object), time: 5 },
  { ...(entry('GET', 'https://eu.api.acme.com/v1/also-old', at(-30_000)) as object), time: 5 },
  // Started before arming but still running, so its event is yet to come.
  { ...(entry('GET', 'https://eu.api.acme.com/v1/in-flight', at(-1000)) as object), time: 60_000 },
]);
devtools.setRecording(true);
// The in-flight one finishes now, as a live event.
devtools.finish(entry('GET', 'https://eu.api.acme.com/v1/in-flight', at(-1000)));
await settle();

const after = devtools.ingested().slice(beforeRestart);
check(
  'requests that finished before arming are adopted',
  [
    after.filter((r) => r.url.endsWith('/v1/old')).length,
    after.filter((r) => r.url.endsWith('/v1/also-old')).length,
  ],
  [1, 1],
);
check(
  'a request still running at arming is taken live, not twice',
  after.filter((r) => r.url.endsWith('/v1/in-flight')).length,
  1,
);

// Two backfills overlapping share no state at all now, so the second cannot
// disturb the first.
devtools.setRecording(false);
await settle();
const beforeOverlap = devtools.ingested().length;
devtools.deferHar(true);
devtools.setHar([
  { ...(entry('GET', 'https://eu.api.acme.com/v1/raced', at(-20_000)) as object), time: 5 },
]);
devtools.setRecording(true);
devtools.setRecording(false);
devtools.setRecording(true);
devtools.releaseHar();
devtools.releaseHar();
await settle();
devtools.deferHar(false);
check(
  'an overlapping backfill does not double-adopt',
  devtools
    .ingested()
    .slice(beforeOverlap)
    .filter((r) => r.url.endsWith('/v1/raced')).length,
  1,
);

section('capture stops when recording does');

devtools.setRecording(false);
const whileStopped = devtools.ingested().length;
devtools.finish(entry('GET', 'https://eu.api.acme.com/v1/after-stop', '2026-09-22T10:00:03.000Z'));
await settle();
check('a request after stop is not sent', devtools.ingested().length, whileStopped);

check(
  'ids stayed unique across the whole run',
  new Set(devtools.ingested().map((r) => r.id)).size,
  devtools.ingested().length,
);

section('a request with no body does not crash the capture page');

// `getContent` is typed as handing back a string, and hands back `null` for
// everything that has no body to give: a failed request, a 304, a redirect, a
// preflight, a websocket. Only policies that assert on a body ask for one,
// which is why this stayed hidden until one did.
devtools.setRecording(false);
await settle();
devtools.setRecording(true, true);

const noBody = {
  ...(entry('GET', 'https://eu.api.acme.com/v1/empty', new Date().toISOString()) as object),
  // Chrome calls this back asynchronously, which is why the throw inside it
  // escapes the promise chain that requested the body and lands as "Uncaught".
  getContent: (callback: (content: string | null, encoding: string) => void) => {
    setTimeout(() => {
      callback(null, '');
    }, 0);
  },
};
const uncaught: string[] = [];
const onUncaught = (cause: unknown): void => {
  uncaught.push(cause instanceof Error ? cause.message : String(cause));
};
process.on('uncaughtException', onUncaught);
process.on('unhandledRejection', onUncaught);
devtools.finish(noBody);
await settle(400);
process.off('uncaughtException', onUncaught);
process.off('unhandledRejection', onUncaught);
check('a null body is not a crash', uncaught, []);
check(
  'the request itself is still recorded',
  devtools.ingested().filter((r) => r.url.endsWith('/v1/empty')).length,
  1,
);
check('and no empty body is attached', devtools.bodies().length, 0);

report('capture stream checks');
