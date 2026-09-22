/**
 * Tracks DevTools attachment and tells the DevTools page when to capture.
 *
 * Capture is only possible while DevTools is open, so this port is the
 * extension's ground truth for it. The popup can arm a tab before DevTools
 * exists; the moment the page connects, the arming takes effect. When the port
 * drops — DevTools closed, or the tab navigated away from — recording stops,
 * because leaving it on would show a tab as recording while nothing is watching.
 */

import { buildContext } from '../engine/expression.ts';
import { errorMessage, logger } from '../shared/logger.ts';
import { DEVTOOLS_PORT, type DevtoolsInbound, type DevtoolsOutbound } from '../shared/messages.ts';
import type { RequestRecord, TestOutcome } from '../shared/types.ts';
import { whenReady } from './bootstrap.ts';
import { getConfig, getConfigStatus, onConfigChange } from './config-store.ts';
import { isRecording, setDevtoolsAttached, setRecording } from './store.ts';

const links = new Map<number, chrome.runtime.Port>();

function push(tabId: number, port: chrome.runtime.Port): void {
  const message: DevtoolsOutbound = {
    type: 'capture',
    recording: isRecording(tabId),
    needsBodies: getConfigStatus().needsBodies,
    debug: getConfig().settings.debug,
  };
  try {
    port.postMessage(message);
  } catch (cause) {
    logger.debug('devtools port send failed', errorMessage(cause));
  }
}

type ResultListener = (recordId: string, outcomes: readonly TestOutcome[]) => void;

const resultListeners = new Set<ResultListener>();

/**
 * Subscribes to sandbox results.
 *
 * Wired up in the worker entry point rather than imported here, so this module
 * does not have to know about ingest — the same shape `onRecordingChanged`
 * uses, and for the same reason: it would be an import cycle.
 */
export function onScriptResults(listener: ResultListener): void {
  resultListeners.add(listener);
}

/**
 * Asks the DevTools page to run a record's scripts in its sandbox.
 *
 * Silently does nothing when no page is attached: scripts need a frame, and a
 * tab with DevTools closed is not capturing anyway.
 */
export function requestScriptRun(
  record: RequestRecord,
  scripts: readonly { readonly id: string; readonly code: string }[],
): void {
  const port = links.get(record.tabId);
  if (port === undefined) {
    return;
  }
  const message: DevtoolsOutbound = {
    type: 'runScripts',
    recordId: record.id,
    scripts,
    context: buildContext(record) as unknown as Readonly<Record<string, unknown>>,
  };
  try {
    port.postMessage(message);
  } catch (cause) {
    logger.debug('script run not dispatched', errorMessage(cause));
  }
}

/** Re-sends the capture state to the DevTools page watching one tab, if any. */
export function notifyCaptureState(tabId: number): void {
  const port = links.get(tabId);
  if (port !== undefined) {
    push(tabId, port);
  }
}

/** Re-sends the capture state to every attached DevTools page. */
function notifyAllCaptureStates(): void {
  for (const [tabId, port] of links) {
    push(tabId, port);
  }
}

/** Registers the DevTools lifecycle port. Must run synchronously at start-up. */
export function registerDevtoolsLink(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== DEVTOOLS_PORT || port.sender?.id !== chrome.runtime.id) {
      return;
    }
    let linked: number | null = null;

    port.onMessage.addListener((message: DevtoolsInbound) => {
      if (message.type === 'scriptResults') {
        void whenReady().then(() => {
          for (const listener of resultListeners) {
            listener(message.recordId, message.outcomes);
          }
        });
        return;
      }
      void whenReady().then(() => {
        linked = message.tabId;
        // A second DevTools window on the same tab replaces the first; the
        // stale port is dropped rather than left to double every message.
        links.get(linked)?.disconnect();
        links.set(linked, port);
        setDevtoolsAttached(linked, true);
        push(linked, port);
      });
    });

    port.onDisconnect.addListener(() => {
      // A port that has already been replaced must not tear down the tab its
      // successor is now serving — reopening DevTools in a second window would
      // otherwise detach the tab a moment after attaching it.
      if (linked === null || links.get(linked) !== port) {
        return;
      }
      const tabId = linked;
      links.delete(tabId);
      void whenReady().then(() => {
        if (links.has(tabId)) {
          return;
        }
        setDevtoolsAttached(tabId, false);
        // Nothing can capture now, so the tab must not keep claiming it is.
        setRecording(tabId, false);
      });
    });
  });

  // `needsBodies` is a property of the policy, so a policy change has to reach
  // the pages that decide whether to pull payloads.
  onConfigChange(() => {
    notifyAllCaptureStates();
  });
}
