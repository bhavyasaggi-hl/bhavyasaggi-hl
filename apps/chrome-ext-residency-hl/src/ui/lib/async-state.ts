/**
 * The four states every asynchronous surface in this extension can be in.
 *
 * Client-rendered pages start with nothing: the popup has not resolved the
 * active tab, the panel has not opened its port, the options page has not read
 * the stored policy. Modelling that explicitly keeps "no data yet" from being
 * rendered as "no data".
 */

export type AsyncState<T> =
  | { readonly status: 'uninitialized' }
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly message: string };

export const UNINITIALIZED = { status: 'uninitialized' } as const;
export const LOADING = { status: 'loading' } as const;

export function success<T>(data: T): AsyncState<T> {
  return { status: 'success', data };
}

export function failure<T>(message: string): AsyncState<T> {
  return { status: 'error', message };
}
