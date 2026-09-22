/**
 * Shared scaffolding for the verification scripts.
 *
 * These run the real modules under `node --experimental-strip-types` against a
 * stubbed `chrome`, so they exercise the shipped code rather than a copy of it.
 * They are deliberately not a unit-test suite: each one drives a whole seam —
 * the engine, the worker, the capture boundary — and prints what it proved.
 */

import process from 'node:process';

/** Session storage's real ceiling, so a write that would fail in Chrome fails here. */
const SESSION_QUOTA_BYTES = 10 * 1024 * 1024;

type PortListener = (...args: unknown[]) => void;

export interface Stub {
  /** The last value written to `chrome.storage.session`, as Chrome would store it. */
  readonly written: () => string | null;
  /** The worker's `onConnect` handler, once a module has registered one. */
  readonly connect: (port: unknown) => void;
}

/**
 * Installs a `chrome` global covering every API the worker touches.
 *
 * Call before importing any module under test: they read `chrome` at import
 * time when they register listeners.
 */
export function installChrome(): Stub {
  let written: string | null = null;
  let onConnect: PortListener | null = null;

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: async () => ({}),
        set: async (items: Record<string, string>) => {
          const payload = Object.values(items)[0] ?? '';
          if (payload.length > SESSION_QUOTA_BYTES) {
            throw new Error('Session storage quota bytes exceeded. Values were not stored.');
          }
          written = payload;
        },
      },
      local: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
    tabs: { sendMessage: async () => undefined, query: async () => [{ id: 7 }] },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async () => undefined,
    },
    runtime: {
      id: 'test',
      onMessage: { addListener: () => undefined },
      onConnect: {
        addListener: (fn: PortListener) => {
          onConnect = fn;
        },
      },
    },
  };

  return {
    written: () => written,
    connect: (port) => {
      if (onConnect === null) {
        throw new Error('nothing registered an onConnect listener');
      }
      onConnect(port);
    },
  };
}

/** A `chrome.runtime.Port` the test drives from both ends. */
export interface FakePort {
  readonly name: string;
  readonly sender: { readonly id: string };
  /** Messages the worker sent to this port. */
  readonly sent: Record<string, unknown>[];
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: PortListener) => void };
  onDisconnect: { addListener: (fn: PortListener) => void };
  /** Delivers a message to the worker as though the page had sent it. */
  readonly deliver: (message: unknown) => void;
  /** Closes the port from the page's side. */
  readonly drop: () => void;
}

export function makePort(name: string, senderId = 'test'): FakePort {
  const messageListeners: PortListener[] = [];
  const disconnectListeners: PortListener[] = [];
  const sent: Record<string, unknown>[] = [];
  return {
    name,
    sender: { id: senderId },
    sent,
    postMessage: (message) => {
      sent.push(message as Record<string, unknown>);
    },
    disconnect: () => {
      for (const fn of disconnectListeners) {
        fn();
      }
    },
    onMessage: {
      addListener: (fn) => {
        messageListeners.push(fn);
      },
    },
    onDisconnect: {
      addListener: (fn) => {
        disconnectListeners.push(fn);
      },
    },
    deliver: (message) => {
      for (const fn of messageListeners) {
        fn(message);
      }
    },
    drop: () => {
      for (const fn of disconnectListeners) {
        fn();
      }
    },
  };
}

let failures = 0;

/** Asserts deep equality and prints the outcome. */
export function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log('ok  ', label);
    return;
  }
  failures += 1;
  console.log('FAIL', label, '=>', JSON.stringify(actual), 'want', JSON.stringify(expected));
}

/** Prints a heading so a long run stays readable. */
export function section(title: string): void {
  console.log(`\n── ${title}`);
}

/** Exits non-zero when anything failed. Call at the end of a script. */
export function report(name: string): never {
  console.log(
    failures === 0 ? `\n${name.toUpperCase()} PASSED` : `\n${String(failures)} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Lets the worker's coalescing timers fire. */
export function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drives `chrome.devtools.network` and the worker port for a capture test. */
export interface DevtoolsStub {
  /** Fires `onRequestFinished` with a HAR-shaped entry. */
  readonly finish: (entry: unknown) => void;
  /** What the next `getHAR()` call hands back. */
  readonly setHar: (entries: readonly unknown[]) => void;
  /** Holds `getHAR()` callbacks until `releaseHar`, to interleave two backfills. */
  readonly deferHar: (defer: boolean) => void;
  /** Runs the oldest held `getHAR()` callback, so two can be interleaved. */
  readonly releaseHar: () => void;
  /** Tells the capture side whether to record, as the worker's port would. */
  readonly setRecording: (recording: boolean, needsBodies?: boolean) => void;
  /** Bodies the capture side asked for, as `attachBody` messages. */
  readonly bodies: () => unknown[];
  /** Every `ingest` message the capture side sent, flattened to its records. */
  readonly ingested: () => { readonly id: string; readonly url: string; readonly method: string }[];
}

/**
 * Adds a `chrome.devtools` surface to the stub installed by `installChrome`.
 *
 * `startCapture` registers its listeners at import time, so this has to be in
 * place before the module is imported.
 */
export function installDevtools(): DevtoolsStub {
  const chromeStub = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  let finished: ((entry: unknown) => void) | null = null;
  let har: readonly unknown[] = [];
  let deferred = false;
  const held: (() => void)[] = [];
  let portMessage: ((message: unknown) => void) | null = null;
  const ingested: { id: string; url: string; method: string }[] = [];
  const bodies: unknown[] = [];

  chromeStub['devtools'] = {
    inspectedWindow: { tabId: 7 },
    panels: { create: () => undefined },
    network: {
      onRequestFinished: {
        addListener: (fn: (entry: unknown) => void) => {
          finished = fn;
        },
      },
      onNavigated: { addListener: () => undefined },
      getHAR: (callback: (result: { entries: readonly unknown[] }) => void) => {
        // The snapshot is taken now; the callback lands later. That gap is
        // where a live event can race the backfill, so it is preserved here.
        const snapshot = har;
        const deliver = (): void => {
          callback({ entries: snapshot });
        };
        if (deferred) {
          held.push(deliver);
          return;
        }
        setTimeout(deliver, 0);
      },
    },
  };

  const runtime = chromeStub['runtime'] as Record<string, unknown>;
  runtime['connect'] = () => ({
    postMessage: () => undefined,
    onMessage: {
      addListener: (fn: (message: unknown) => void) => {
        portMessage = fn;
      },
    },
    onDisconnect: { addListener: () => undefined },
  });
  runtime['sendMessage'] = async (request: {
    type: string;
    records?: { id: string; url: string; method: string }[];
  }) => {
    if (request.type === 'ingest') {
      ingested.push(...(request.records ?? []));
    }
    if (request.type === 'attachBody') {
      bodies.push(request);
    }
    return { ok: true, data: { accepted: true } };
  };

  return {
    finish: (entry) => finished?.(entry),
    setHar: (entries) => {
      har = entries;
    },
    deferHar: (defer) => {
      deferred = defer;
    },
    releaseHar: () => {
      held.shift()?.();
    },
    setRecording: (recording, needsBodies = false) => {
      portMessage?.({ type: 'capture', recording, needsBodies, debug: false });
    },
    bodies: () => bodies,
    ingested: () => ingested,
  };
}
