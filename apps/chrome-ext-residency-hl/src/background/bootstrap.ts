/**
 * Single readiness gate for the service worker.
 *
 * MV3 requires every listener to be registered synchronously at worker
 * start-up, but the config and the rehydrated store are both async. Listeners
 * therefore queue their work behind this promise instead of racing it.
 */

import { errorMessage, logger } from '../shared/logger.ts';
import { initConfig } from './config-store.ts';
import { ready as storeReady } from './store.ts';

let started: Promise<void> | null = null;

/**
 * Resolves once start-up is done, and never rejects.
 *
 * Every listener queues its work behind this one promise, so a rejection here
 * would not fail one operation — it would leave the worker permanently inert,
 * with each later event silently doing nothing. Start-up already degrades to
 * the bundled default on its own, so this only guarantees the invariant rather
 * than relying on every path below it staying safe.
 */
export function whenReady(): Promise<void> {
  started ??= Promise.all([initConfig(), storeReady()])
    .then(() => undefined)
    .catch((cause: unknown) => {
      logger.error('start-up failed; continuing with defaults', errorMessage(cause));
    });
  return started;
}
