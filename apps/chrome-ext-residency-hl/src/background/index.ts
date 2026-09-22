/** Service worker entry point: wires ingest, evaluation, storage and messaging. */

import { errorMessage, logger } from '../shared/logger.ts';
import { refreshBadge } from './badge.ts';
import { whenReady } from './bootstrap.ts';
import { onConfigChange } from './config-store.ts';
import { notifyCaptureState, onScriptResults, registerDevtoolsLink } from './devtools-link.ts';
import { attachTests } from './ingest.ts';
import { registerRpc } from './rpc.ts';
import { markTabClosed, onRecordingChanged, setRecordByDefault } from './store.ts';
import { notifyAllPanels, registerPanelStream } from './stream.ts';

/*
 * A handler that throws would otherwise lose one record silently, and a
 * rejected promise in a service worker leaves no trace a user could report.
 */
self.addEventListener('unhandledrejection', (event) => {
  logger.error('unhandled rejection in the service worker', errorMessage(event.reason));
});

self.addEventListener('error', (event) => {
  logger.error('uncaught error in the service worker', event.message);
});

// Listener registration happens synchronously so an evicted worker can be
// revived by any of these events.
registerRpc();
registerPanelStream();
registerDevtoolsLink();

onScriptResults((recordId, outcomes) => {
  attachTests(recordId, outcomes);
});

onRecordingChanged((tabId) => {
  void refreshBadge(tabId);
  // Whoever flipped it — popup, panel or a closing DevTools window — the page
  // that does the capturing is told from one place.
  notifyCaptureState(tabId);
});

onConfigChange((config) => {
  setRecordByDefault(config.settings.recordByDefault);
  // Records keep the verdict they were captured with — the observations a
  // re-run would need are released once the policy has seen them — so this
  // only refreshes the policy status the panels display.
  notifyAllPanels();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void whenReady().then(() => {
    markTabClosed(tabId);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void whenReady().then(() => refreshBadge(tabId));
});

chrome.runtime.onInstalled.addListener((details) => {
  void whenReady().then(() => {
    logger.info(`installed (${details.reason})`);
  });
});

void whenReady().then(() => {
  logger.debug('service worker ready');
});
