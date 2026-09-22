/**
 * Minimal namespaced logger.
 *
 * Extension surfaces have no shared logging infrastructure, so `console` is the
 * transport. Debug output is opt-in so a normal install stays quiet.
 */

const PREFIX = '[residency]';

let debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

export const logger = {
  debug(message: string, ...details: readonly unknown[]): void {
    if (debugEnabled) {
      console.debug(PREFIX, message, ...details);
    }
  },
  info(message: string, ...details: readonly unknown[]): void {
    console.info(PREFIX, message, ...details);
  },
  warn(message: string, ...details: readonly unknown[]): void {
    console.warn(PREFIX, message, ...details);
  },
  error(message: string, ...details: readonly unknown[]): void {
    console.error(PREFIX, message, ...details);
  },
};

/** Normalizes anything thrown into a readable, non-leaking message. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  return 'Unknown error';
}
