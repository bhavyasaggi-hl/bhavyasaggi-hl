/**
 * Hosts the sandboxed test runner, and keeps it from being overwhelmed.
 *
 * A service worker cannot own a frame, so the DevTools page does: it is already
 * the context that captured the request, and it lives exactly as long as
 * DevTools is open on the tab. The frame is created lazily, the first time a
 * policy actually has scripts, so a policy without them never loads chai.
 *
 * Running a script is cheap — about 12 µs — so throughput was never the
 * constraint. Two other things are, and both are handled here rather than left
 * to chance:
 *
 * - **Round trips.** A page load finishes hundreds of requests at once. Records
 *   are batched over `BATCH_MS`, and only one batch is ever in the sandbox, so a
 *   burst costs a handful of messages rather than one per request.
 * - **A script that never returns.** An opaque origin cannot spawn a Worker, so
 *   there is nothing to `terminate()`. The batch carries one deadline; when it
 *   fires, its records are reported as timed out, the wedged frame is discarded
 *   and the queue drains into a fresh one.
 *
 * The queue is bounded. Past `MAX_QUEUE` the oldest waiting records are reported
 * as skipped rather than dropped: a request this extension did not check has to
 * say so, because an audit that silently omits what it could not keep up with is
 * worse than one that admits it.
 */

import { errorMessage, logger } from '../shared/logger.ts';
import {
  BATCH_MS,
  MAX_BATCH,
  MAX_QUEUE,
  type RunItem,
  type RunRequest,
  type SandboxOutbound,
  SCRIPT_TIMEOUT_MS,
} from '../shared/scripts.ts';
import type { TestOutcome } from '../shared/types.ts';

const SANDBOX_URL = 'sandbox.html';

type Settle = (outcomes: readonly TestOutcome[]) => void;

interface Pending {
  readonly item: RunItem;
  readonly settle: Settle;
}

let frame: HTMLIFrameElement | null = null;
let ready: Promise<HTMLIFrameElement> | null = null;
let sequence = 0;

const queue: Pending[] = [];
/** The batch currently in the sandbox, by record id. Null when idle. */
let inFlight: Map<string, Pending> | null = null;
let inFlightId = 0;
let inFlightTimer: ReturnType<typeof setTimeout> | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** What a record reports when its scripts never got to run. */
function unrun(item: RunItem, name: string, error: string): TestOutcome[] {
  return item.scripts.map((script) => ({
    id: `${script.id}#unrun`,
    name,
    passed: false,
    error,
  }));
}

function destroyFrame(): void {
  frame?.remove();
  frame = null;
  ready = null;
}

/** Creates the frame and resolves once it says it can accept work. */
function open(): Promise<HTMLIFrameElement> {
  ready ??= new Promise<HTMLIFrameElement>((resolve, reject) => {
    const created = document.createElement('iframe');
    created.setAttribute('sandbox', 'allow-scripts');
    created.src = SANDBOX_URL;
    created.style.display = 'none';

    const onReady = (event: MessageEvent<SandboxOutbound>): void => {
      if (event.source !== created.contentWindow || event.data.type !== 'ready') {
        return;
      }
      removeEventListener('message', onReady);
      frame = created;
      resolve(created);
    };
    addEventListener('message', onReady);
    created.addEventListener('error', () => {
      removeEventListener('message', onReady);
      reject(new Error('the sandboxed test runner could not load'));
    });
    document.body.append(created);
  });
  return ready;
}

/** Sends the next batch, if there is one and the sandbox is free. */
function pump(): void {
  if (inFlight !== null || queue.length === 0) {
    return;
  }
  const batch = queue.splice(0, MAX_BATCH);
  sequence += 1;
  const id = sequence;
  inFlightId = id;
  inFlight = new Map(batch.map((entry) => [entry.item.recordId, entry]));

  void open().then(
    (host) => {
      if (inFlightId !== id) {
        // The batch timed out while the frame was still loading.
        return;
      }
      const request: RunRequest = { type: 'run', id, items: batch.map((entry) => entry.item) };
      inFlightTimer = setTimeout(() => {
        finish(id, (item) =>
          unrun(
            item,
            'script timed out',
            `Did not finish within ${String(SCRIPT_TIMEOUT_MS)} ms and was stopped.`,
          ),
        );
        // The frame's thread is wedged; nothing will come back from it.
        destroyFrame();
      }, SCRIPT_TIMEOUT_MS);
      host.contentWindow?.postMessage(request, '*');
    },
    (cause: unknown) => {
      logger.debug('sandbox unavailable', errorMessage(cause));
      finish(id, (item) => unrun(item, 'script did not run', errorMessage(cause)));
    },
  );
}

/** Settles whatever is in flight, then lets the next batch go. */
function finish(id: number, outcomesFor: (item: RunItem) => readonly TestOutcome[]): void {
  if (inFlight === null || inFlightId !== id) {
    return;
  }
  const settled = inFlight;
  inFlight = null;
  if (inFlightTimer !== null) {
    clearTimeout(inFlightTimer);
    inFlightTimer = null;
  }
  for (const entry of settled.values()) {
    entry.settle(outcomesFor(entry.item));
  }
  pump();
}

/** Routes a sandbox reply to the batch waiting for it. */
addEventListener('message', (event: MessageEvent<SandboxOutbound>) => {
  const message = event.data;
  if (message.type !== 'result' || inFlight === null || message.id !== inFlightId) {
    // A late reply from a batch that already timed out; its frame is gone.
    return;
  }
  const settled = inFlight;
  inFlight = null;
  if (inFlightTimer !== null) {
    clearTimeout(inFlightTimer);
    inFlightTimer = null;
  }
  for (const result of message.results) {
    settled.get(result.recordId)?.settle(result.outcomes);
    settled.delete(result.recordId);
  }
  // A record the runner did not answer for still has to be settled, or the
  // worker would wait on it for ever.
  for (const entry of settled.values()) {
    entry.settle(unrun(entry.item, 'script did not run', 'The runner returned no result.'));
  }
  pump();
});

/**
 * Runs a record's scripts and resolves with what they reported.
 *
 * Never rejects: a policy that could not run is a result the panel should show,
 * not an error that loses the record.
 */
export function runScripts(
  recordId: string,
  scripts: readonly { readonly id: string; readonly code: string }[],
  context: Readonly<Record<string, unknown>>,
): Promise<readonly TestOutcome[]> {
  return new Promise<readonly TestOutcome[]>((resolve) => {
    const item: RunItem = { recordId, scripts, context };

    if (queue.length >= MAX_QUEUE) {
      const dropped = queue.shift();
      dropped?.settle(
        unrun(
          dropped.item,
          'script did not run',
          `Skipped: more than ${String(MAX_QUEUE)} requests were waiting to be checked.`,
        ),
      );
    }
    queue.push({ item, settle: resolve });

    if (queue.length >= MAX_BATCH) {
      // Enough for a full batch; no reason to wait out the window.
      if (batchTimer !== null) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      pump();
      return;
    }
    batchTimer ??= setTimeout(() => {
      batchTimer = null;
      pump();
    }, BATCH_MS);
  });
}
