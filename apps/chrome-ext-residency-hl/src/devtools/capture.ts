/**
 * Captures the inspected tab's requests and hands them to the worker.
 *
 * This runs in the DevTools page rather than the panel, because the panel's
 * page is not created until the user first selects the Residency tab. Anchoring
 * capture here makes "DevTools is open" the whole condition — which is also
 * what the popup promises — and gives the worker a port whose disconnect means
 * DevTools closed.
 *
 * `chrome.devtools.network` pushes a finished request to the listener: there is
 * no polling and no HAR document to parse, and the event payload is a live
 * object that happens to follow the HAR entry shape. `getHAR()` is called once
 * when recording starts, to adopt what the Network panel already holds.
 *
 * Records are batched before crossing to the worker: a page load finishes
 * hundreds of requests, and one message per request is the only part of this
 * path with a cost worth avoiding. Bodies are pulled only when the active
 * policy asserts on one, since `getContent()` moves the whole payload across
 * the DevTools bridge.
 */

import { errorMessage, logger, setDebugLogging } from '../shared/logger.ts';
import {
  DEVTOOLS_PORT,
  type DevtoolsInbound,
  type DevtoolsOutbound,
  sendMessage,
} from '../shared/messages.ts';
import type { RequestRecord } from '../shared/types.ts';
import { type HarEntry, responseContentType, toBody, toRecord } from './har.ts';
import { runScripts } from './scripts.ts';

/** How long a finished request waits for company before crossing to the worker. */
const BATCH_MS = 100;

interface Pending {
  readonly record: RequestRecord;
  readonly request: chrome.devtools.network.Request | null;
}

/** When an entry finished, in epoch milliseconds. */
function finishedAt(entry: HarEntry): number {
  const started = Date.parse(entry.startedDateTime ?? '');
  return (Number.isNaN(started) ? 0 : started) + Math.max(entry.time ?? 0, 0);
}

export function startCapture(tabId: number): void {
  let recording = false;
  let needsBodies = false;
  let sequence = 0;
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** When recording started. The backfill's entire bookkeeping. */
  let armedAt = 0;
  /** Which arming a `getHAR()` callback belongs to, so a stale one is ignored. */
  let generation = 0;

  const readBody = (request: chrome.devtools.network.Request, id: string): void => {
    // `getContent` is typed as handing back a string and hands back `null` for
    // everything with no body to give — a failed request, a 304, a redirect, a
    // preflight, a websocket. The callback runs outside the promise that asked
    // for it, so letting `null` through surfaced as an uncaught TypeError on
    // the DevTools page rather than as a rejected send.
    request.getContent((content: string | null, encoding) => {
      if (content === null || content === '') {
        return;
      }
      void sendMessage({
        type: 'attachBody',
        id,
        body: toBody(content, responseContentType(request), encoding),
      }).catch((cause: unknown) => {
        logger.debug('body not attached', errorMessage(cause));
      });
    });
  };

  const flush = (): void => {
    timer = null;
    const batch = queue;
    if (batch.length === 0) {
      return;
    }
    queue = [];
    void sendMessage({ type: 'ingest', records: batch.map((item) => item.record) })
      .then((response) => {
        if (!(response.accepted && needsBodies)) {
          return;
        }
        for (const item of batch) {
          if (item.request !== null) {
            readBody(item.request, item.record.id);
          }
        }
      })
      .catch((cause: unknown) => {
        logger.debug('records not ingested', errorMessage(cause));
      });
  };

  const capture = (entry: HarEntry, request: chrome.devtools.network.Request | null): void => {
    if (!recording) {
      return;
    }
    // Every live event is one finished request. Nothing is deduplicated.
    logger.debug(
      'live',
      entry.request?.method ?? '?',
      entry._resourceType ?? 'other',
      entry.request?.url ?? '',
    );
    sequence += 1;
    queue.push({ record: toRecord(entry, `${String(tabId)}-${String(sequence)}`, tabId), request });
    timer ??= setTimeout(flush, BATCH_MS);
  };

  chrome.devtools.network.onRequestFinished.addListener((request) => {
    capture(request, request);
  });

  chrome.devtools.network.onNavigated.addListener((url) => {
    void sendMessage({ type: 'setPage', tabId, url }).catch(() => undefined);
  });

  /**
   * Adopts what the Network panel already holds, so a page loaded before
   * recording started is not lost. Runs on the transition only, not as a poll.
   *
   * There is no cache and nothing to reconcile, because the two sources cannot
   * overlap. A request that finished before recording started already fired
   * `onRequestFinished` — and that event was ignored, because nothing was
   * recording — so the snapshot is the only place it still exists. Anything
   * finishing from that moment on arrives as a live event. One timestamp
   * separates them, which is the whole of it: no key is synthesised, so no two
   * requests can be mistaken for each other.
   */
  const backfill = (): void => {
    generation += 1;
    const mine = generation;
    const until = armedAt;
    chrome.devtools.network.getHAR((har) => {
      // Recording was toggled again while this was outstanding: a newer
      // backfill owns the log now, and adopting the same snapshot twice would
      // duplicate every row in it.
      if (!recording || mine !== generation) {
        return;
      }
      const entries = (har.entries ?? []) as HarEntry[];
      const adopted: RequestRecord[] = [];
      for (const entry of entries) {
        if (finishedAt(entry) >= until) {
          continue;
        }
        sequence += 1;
        adopted.push(toRecord(entry, `${String(tabId)}-${String(sequence)}`, tabId));
      }
      logger.debug(
        `backfill: ${String(entries.length)} in the panel's log, ${String(adopted.length)} adopted,` +
          ` ${String(entries.length - adopted.length)} left to the live stream`,
      );
      if (adopted.length > 0) {
        void sendMessage({ type: 'ingest', records: adopted }).catch(() => undefined);
      }
    });
  };

  // The worker learns DevTools is open from this port and learns it closed from
  // the disconnect, which is what stops the recording.
  const port = chrome.runtime.connect({ name: DEVTOOLS_PORT });
  port.onMessage.addListener((message: DevtoolsOutbound) => {
    if (message.type === 'runScripts') {
      void runScripts(message.recordId, message.scripts, message.context)
        .then((outcomes) => {
          const results: DevtoolsInbound = {
            type: 'scriptResults',
            recordId: message.recordId,
            outcomes,
          };
          port.postMessage(results);
        })
        .catch((cause: unknown) => {
          // The worker was evicted while the scripts ran; the record keeps its
          // assertion verdict and the next capture reconnects.
          logger.debug('script results not delivered', errorMessage(cause));
        });
      return;
    }
    setDebugLogging(message.debug);
    const started = message.recording && !recording;
    recording = message.recording;
    needsBodies = message.needsBodies;
    if (started) {
      armedAt = Date.now();
      backfill();
      return;
    }
    if (!recording) {
      // Nothing downstream wants these: the worker rejects an ingest for a tab
      // it is not recording. Drop them with the timer rather than waking up to
      // be turned away.
      queue = [];
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  });
  const attach: DevtoolsInbound = { type: 'attach', tabId };
  port.postMessage(attach);
}
