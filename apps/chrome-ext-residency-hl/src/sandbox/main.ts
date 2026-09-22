/**
 * Runs a policy's `tests` scripts.
 *
 * This is the only place in the extension where `eval` is reachable. MV3 forbids
 * it everywhere else, and the `sandbox` manifest key exists exactly for this: the
 * page loads at an opaque origin with no `chrome` APIs, and its CSP denies
 * everything — including the network — so a policy someone shared with you can
 * read the request it is judging and can neither reach the extension nor send
 * what it found anywhere.
 *
 * A script sees `req`, `res`, `test` and chai's `expect`, plus the ordinary
 * browser globals it needs to do the work — `JSON`, `atob`, `TextDecoder` — so
 * decoding a token or a body is possible without a special-purpose operator for
 * every format.
 */

import { expect } from 'chai';
import {
  MAX_TESTS_PER_SCRIPT,
  type SandboxInbound,
  type SandboxOutbound,
} from '../shared/scripts.ts';
import type { TestOutcome } from '../shared/types.ts';

/**
 * Compiled scripts, keyed by their source.
 *
 * A policy's scripts are the same text for every request they judge, so
 * compiling per record would repeat the same parse thousands of times over a
 * page load. Keying on the source rather than the id means an edited policy
 * simply misses the cache instead of reusing a stale compile.
 */
const compiled = new Map<string, (...args: unknown[]) => void>();

type Compiled = (
  req: unknown,
  res: unknown,
  test: (name: unknown, body: unknown) => void,
  expect: unknown,
) => void;

function compile(code: string): Compiled {
  const cached = compiled.get(code);
  if (cached !== undefined) {
    return cached as Compiled;
  }
  // `new Function` rather than `eval` so the script cannot see this scope: its
  // only bindings are the four arguments named here, plus globals.
  const fn = new Function('req', 'res', 'test', 'expect', code) as Compiled;
  compiled.set(code, fn as (...args: unknown[]) => void);
  return fn;
}

/** Trims a thrown value to something safe to render and cheap to store. */
function messageOf(cause: unknown): string {
  const text =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function runScript(
  script: { readonly id: string; readonly code: string },
  context: Readonly<Record<string, unknown>>,
): TestOutcome[] {
  const outcomes: TestOutcome[] = [];

  const test = (name: unknown, body: unknown): void => {
    if (outcomes.length >= MAX_TESTS_PER_SCRIPT) {
      return;
    }
    const label = typeof name === 'string' && name.trim() !== '' ? name : 'unnamed test';
    const id = `${script.id}#${String(outcomes.length)}`;
    if (typeof body !== 'function') {
      outcomes.push({ id, name: label, passed: false, error: 'test() needs a function' });
      return;
    }
    try {
      (body as () => void)();
      outcomes.push({ id, name: label, passed: true });
    } catch (cause) {
      outcomes.push({ id, name: label, passed: false, error: messageOf(cause) });
    }
  };

  try {
    compile(script.code)(context['req'], context['res'], test, expect);
  } catch (cause) {
    // A script that throws outside a test still has to report something, or a
    // typo would look like a policy with no tests in it.
    outcomes.push({
      id: `${script.id}#error`,
      name: 'script did not run',
      passed: false,
      error: messageOf(cause),
    });
  }
  return outcomes;
}

function send(message: SandboxOutbound): void {
  parent.postMessage(message, '*');
}

addEventListener('message', (event: MessageEvent<SandboxInbound>) => {
  const request = event.data;
  if (request.type !== 'run') {
    return;
  }
  send({
    type: 'result',
    id: request.id,
    results: request.items.map((item) => ({
      recordId: item.recordId,
      outcomes: item.scripts.flatMap((script) => runScript(script, item.context)),
    })),
  });
});

send({ type: 'ready' });
