/**
 * Escalates a waiting message once the wait stops looking instant.
 *
 * An MV3 service worker may be asleep when a surface opens, so the first
 * message can take a beat. Saying why after a moment is the difference between
 * "loading" and "stuck".
 */

import { useEffect, useState } from 'preact/compat';

export function useSlowHint(quick: string, slow: string, afterMs = 1200): string {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLate(true);
    }, afterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [afterMs]);
  return late ? slow : quick;
}
