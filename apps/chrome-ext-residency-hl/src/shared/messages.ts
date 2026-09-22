/** Typed request/response contract for `chrome.runtime` messaging. */

import type {
  BodyCapture,
  ConfigStatus,
  LiteRecord,
  PolicyIndex,
  RequestRecord,
  TabSummary,
  TestOutcome,
} from './types.ts';

/**
 * Long-lived port every extension page subscribes on.
 *
 * The worker pushes; nothing polls. The panel asks for records, the popup asks
 * for the tab summary alone, and both get the same state updates.
 */
export const UI_PORT = 'residency-ui';

/**
 * Port held open by the DevTools page for as long as DevTools is open.
 *
 * Capture depends on `chrome.devtools.network`, which only exists while
 * DevTools is attached, so this port is the extension's ground truth for
 * whether the tab can be recorded at all. It is separate from the panel port
 * because the panel's page is not created until the user first selects the
 * Residency tab, and capture should not wait for that.
 */
export const DEVTOOLS_PORT = 'residency-devtools';

export type Request =
  | { readonly type: 'getConfig' }
  | { readonly type: 'setConfig'; readonly text: string }
  | { readonly type: 'resetConfig' }
  | { readonly type: 'ingest'; readonly records: readonly RequestRecord[] }
  | { readonly type: 'attachBody'; readonly id: string; readonly body: BodyCapture }
  | { readonly type: 'setPage'; readonly tabId: number; readonly url: string };

interface ConfigResponse {
  readonly text: string;
  readonly status: ConfigStatus;
}

export interface ResponseMap {
  readonly getConfig: ConfigResponse;
  readonly setConfig: ConfigResponse;
  readonly resetConfig: ConfigResponse;
  /** False when the tab stopped recording, so the panel can stop sending. */
  readonly ingest: { readonly accepted: boolean };
  readonly attachBody: { readonly ok: true };
  readonly setPage: { readonly ok: true };
}

/** Messages the DevTools page sends over its lifecycle port. */
export type DevtoolsInbound =
  | { readonly type: 'attach'; readonly tabId: number }
  | {
      readonly type: 'scriptResults';
      readonly recordId: string;
      readonly outcomes: readonly TestOutcome[];
    };

/** What the worker pushes back to the DevTools page. */
export type DevtoolsOutbound =
  | {
      readonly type: 'capture';
      readonly recording: boolean;
      readonly needsBodies: boolean;
      /** Mirrors `extensions.residency.debug`; turns on capture tracing. */
      readonly debug: boolean;
    }
  /**
   * A record whose policy has `tests` scripts, sent back out to be run.
   *
   * The worker knows which groups matched, so it decides what runs; the
   * DevTools page owns the sandbox because a service worker cannot host a
   * frame. The context travels back to the page that captured it, so nothing
   * is exposed that was not already there.
   */
  | {
      readonly type: 'runScripts';
      readonly recordId: string;
      readonly scripts: readonly { readonly id: string; readonly code: string }[];
      readonly context: Readonly<Record<string, unknown>>;
    };

/** Messages an extension page sends over its port. */
export type UiInbound =
  | {
      readonly type: 'subscribe';
      readonly tabId: number;
      /** False for the popup, which renders totals and never the request list. */
      readonly records: boolean;
    }
  | { readonly type: 'setRecording'; readonly recording: boolean }
  | { readonly type: 'setPreserveLog'; readonly preserveLog: boolean }
  | { readonly type: 'clear' };

/** Messages the service worker pushes to a subscribed panel. */
export type UiOutbound =
  | {
      readonly type: 'snapshot';
      readonly records: readonly LiteRecord[];
      readonly tab: TabSummary;
      readonly config: ConfigStatus;
      /**
       * Assertion wording, sent with the snapshot and on a policy change only.
       * It describes the policy, not the requests, so it must not ride along
       * with the coalesced state flush.
       */
      readonly policy: PolicyIndex;
    }
  | { readonly type: 'upsert'; readonly records: readonly LiteRecord[] }
  | { readonly type: 'state'; readonly tab: TabSummary; readonly config: ConfigStatus };

export type Response<T extends Request['type']> =
  | { readonly ok: true; readonly data: ResponseMap[T] }
  | { readonly ok: false; readonly error: string };

/** Sends a typed message to the service worker and unwraps the envelope. */
export async function sendMessage<T extends Request['type']>(
  request: Extract<Request, { type: T }>,
): Promise<ResponseMap[T]> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (response === undefined) {
    throw new Error('The extension service worker did not respond.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.data;
}
