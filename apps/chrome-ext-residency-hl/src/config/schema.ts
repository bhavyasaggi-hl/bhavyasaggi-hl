/** Shape of a validated residency config, after YAML parsing and compilation. */

import type { CompiledMatch } from './match.ts';

export type Grouping = 'host' | 'domain';

export interface Settings {
  /** How the report groups requests: exact hostname, or approximate eTLD+1. */
  readonly grouping: Grouping;
  /** Drop a tab's records when its top-level document navigates. */
  readonly clearOnNavigate: boolean;
  /** Record requests that no group scopes; they are reported as "not applicable". */
  readonly recordUnscoped: boolean;
  /** Start recording a tab as soon as it is seen, rather than waiting to be asked. */
  readonly recordByDefault: boolean;
  /** Emit verbose diagnostics to the service worker console. */
  readonly debug: boolean;
}

export interface CompiledAssertion {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly expression: string;
  readonly operator: string;
  readonly expected?: string;
  readonly expectedList: readonly string[];
  readonly expectedRaw: unknown;
}

/**
 * A `runtime.scripts` entry.
 *
 * OpenCollection defines three types. Only `tests` is supported: this extension
 * watches traffic a page already sent, so there is no "before the request" to
 * run in, and `after-response` exists to mutate variables for the next request
 * in a sequence, which has no meaning for observed traffic. The other two are
 * rejected at parse time rather than silently ignored.
 */
export interface CompiledScript {
  /** Stable id within the document, matching how assertions are identified. */
  readonly id: string;
  readonly code: string;
}

export interface AssertionGroup {
  readonly name: string;
  readonly description?: string;
  /** Every scope in the chain must match (parent folder scopes are inherited). */
  readonly scope: readonly CompiledMatch[];
  readonly assertions: readonly CompiledAssertion[];
  readonly scripts: readonly CompiledScript[];
}

export interface ResolvedConfig {
  /** Monotonic revision, bumped on every successful load. */
  readonly revision: number;
  readonly name: string;
  readonly settings: Settings;
  readonly groups: readonly AssertionGroup[];
  readonly source: 'user' | 'default';
  readonly text: string;
  readonly loadedAt: number;
}

/** A validation finding tied to the document path that produced it. */
export interface ConfigProblem {
  /** Dotted/bracketed path into the document, e.g. `folders[0].match.hosts[1]`. */
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

export interface ParseOutcome {
  /** `null` when the document could not be turned into a usable config. */
  readonly config: Omit<ResolvedConfig, 'revision' | 'source' | 'loadedAt'> | null;
  /** Formatted `path: message` lines, for the message channel and plain lists. */
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** The same findings with the path kept separate, for editor diagnostics. */
  readonly problems: readonly ConfigProblem[];
}

export const DEFAULT_SETTINGS: Settings = {
  grouping: 'host',
  clearOnNavigate: true,
  recordUnscoped: true,
  recordByDefault: false,
  debug: false,
};
