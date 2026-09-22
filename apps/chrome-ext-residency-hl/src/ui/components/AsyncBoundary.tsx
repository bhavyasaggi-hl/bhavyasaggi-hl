/** Renders the uninitialized / loading / error states so each page does not reinvent them. */

import type { ReactNode } from 'preact/compat';
import type { AsyncState } from '../lib/async-state.ts';
import { Banner } from './ui.tsx';

export function AsyncBoundary<T>({
  state,
  fallback,
  children,
}: {
  readonly state: AsyncState<T>;
  /** Shown for both `uninitialized` and `loading`; they look the same to a user. */
  readonly fallback: ReactNode;
  readonly children: (data: T) => ReactNode;
}): ReactNode {
  if (state.status === 'error') {
    return (
      <div className="p-3">
        <Banner tone="error" headline={state.message} />
      </div>
    );
  }
  return state.status === 'success' ? children(state.data) : fallback;
}
