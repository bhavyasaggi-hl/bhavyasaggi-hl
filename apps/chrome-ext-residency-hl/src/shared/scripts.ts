/** Message contract between the DevTools page and the sandboxed test runner. */

import type { TestOutcome } from './types.ts';

/** One record's scripts, and the request they run against. */
export interface RunItem {
  readonly recordId: string;
  readonly scripts: readonly { readonly id: string; readonly code: string }[];
  /** The same `req`/`res` shape assertions see. */
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * A batch of records to judge.
 *
 * Batched rather than sent one at a time: a page load finishes hundreds of
 * requests at once, and one postMessage round trip plus one deadline per record
 * is the part of this path with a cost worth avoiding.
 */
export interface RunRequest {
  readonly type: 'run';
  readonly id: number;
  readonly items: readonly RunItem[];
}

interface RunResult {
  readonly type: 'result';
  readonly id: number;
  readonly results: readonly {
    readonly recordId: string;
    readonly outcomes: readonly TestOutcome[];
  }[];
}

/** Sent once, when the runner has loaded and can accept work. */
interface RunnerReady {
  readonly type: 'ready';
}

export type SandboxInbound = RunRequest;
export type SandboxOutbound = RunResult | RunnerReady;

/** How long one batch may run before its records are reported as timed out. */
export const SCRIPT_TIMEOUT_MS = 2000;

/** How long records wait for company before a batch is sent. */
export const BATCH_MS = 100;

/** Records per batch. Keeps one wedged script from stalling an unbounded set. */
export const MAX_BATCH = 50;

/**
 * Records that may be waiting at once.
 *
 * Past this the oldest are reported as skipped rather than dropped: a request
 * this extension did not check has to say so, because an audit that silently
 * omits what it could not keep up with is worse than one that admits it.
 */
export const MAX_QUEUE = 1000;

/** Upper bound on tests one script may register, so a loop cannot flood memory. */
export const MAX_TESTS_PER_SCRIPT = 200;
