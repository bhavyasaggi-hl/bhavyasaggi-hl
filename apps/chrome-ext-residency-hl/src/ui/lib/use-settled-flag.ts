/**
 * True only once `value` has stayed true for `afterMs`.
 *
 * A dropped worker port is normal and usually reconnects within a few hundred
 * milliseconds. Announcing every one of those would be noise, so the surfaces
 * wait to see whether it lasts before saying anything.
 */

import { useEffect, useState } from 'preact/compat';

export function useSettledFlag(value: boolean, afterMs = 1200): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!value) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => {
      setSettled(true);
    }, afterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, afterMs]);
  return settled && value;
}
