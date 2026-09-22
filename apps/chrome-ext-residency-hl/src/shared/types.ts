/** Data model shared by the service worker, content scripts and every UI surface. */

export type Verdict = 'pass' | 'fail' | 'not-applicable' | 'pending';

type BodySource = 'devtools';

/** Everything known about a captured body except the payload itself. */
interface BodyMeta {
  readonly contentType?: string;
  /** Byte length reported by the capture site, before truncation. */
  readonly size: number;
  readonly truncated: boolean;
  readonly source: BodySource;
}

export interface BodyCapture extends BodyMeta {
  /** Decoded body text, already truncated to `MAX_BODY_BYTES`. */
  readonly text: string;
  /** Parsed JSON when the payload was valid JSON, otherwise `undefined`. */
  readonly json?: unknown;
}

/**
 * Everything about a judged assertion that is specific to one request.
 *
 * The assertion's name, expression, operator, expected value, severity and
 * group are properties of the policy, identical across every request it judges,
 * so they are not copied onto each record — the panel joins them from
 * `AssertionDefinition` by id. What is left is what only this request can say.
 */
export interface AssertionOutcome {
  /** Stable id of the assertion within the resolved config (its document path). */
  readonly id: string;
  readonly passed: boolean;
  /** Rendered form of the resolved left-hand side, safe to place in the DOM. */
  readonly actual: string;
  /** The operator's own words, e.g. `"eu-west-1" is one of "eu-west-1", …`. */
  readonly detail: string;
  /** Set when the expression or operator could not be evaluated at all. */
  readonly error?: string;
}

/**
 * The policy's half of an assertion result, sent to the panel once per policy
 * rather than once per request.
 */
export interface AssertionDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly expression: string;
  readonly operator: string;
  readonly expected?: string;
  /** Name of the config group that contributed this assertion. */
  readonly group: string;
}

/** Assertion definitions by id, for joining outcomes back to the policy. */
export type PolicyIndex = Readonly<Record<string, AssertionDefinition>>;

/**
 * Rebuilds the sentence that used to be stored on every result.
 *
 * Kept next to the types so the worker and the panel cannot drift on it.
 */
export function explain(
  outcome: AssertionOutcome,
  definition: AssertionDefinition | undefined,
): string {
  if (outcome.error !== undefined) {
    return outcome.detail;
  }
  const because = definition?.description === undefined ? '' : ` ${definition.description}`;
  return `${outcome.passed ? 'Passed' : 'Failed'}: ${outcome.detail}.${because}`;
}

/** One `test(...)` call's outcome, as the sandboxed runner reports it. */
export interface TestOutcome {
  /** The script's document path plus the test's index within it. */
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
  /** Assertion message when it failed, or the thrown error when it blew up. */
  readonly error?: string;
}

export interface Evaluation {
  readonly verdict: Verdict;
  /**
   * Outcomes of the policy's `tests` scripts, when it has any.
   *
   * Scripts cannot run in the worker — MV3 forbids `eval` outside a sandboxed
   * page — so they arrive after the assertions have already been judged, and
   * the verdict is recomputed when they land. `undefined` means the policy has
   * no scripts for this request; an empty array means they ran and registered
   * no tests.
   */
  readonly tests?: readonly TestOutcome[];
  readonly results: readonly AssertionOutcome[];
  readonly groups: readonly string[];
  readonly evaluatedAt: number;
  /** Config revision the evaluation was produced with; used to detect staleness. */
  readonly configRevision: number;
}

export interface RequestRecord {
  readonly id: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly url: string;
  readonly host: string;
  /** Approximate registrable domain (eTLD+1) derived from a bundled suffix list. */
  readonly registrableDomain: string;
  readonly path: string;
  // Released with the headers once the policy has read them.
  query: Record<string, string>;
  readonly method: string;
  readonly resourceType: string;
  readonly initiator?: string;
  readonly startedAt: number;
  completedAt?: number;
  responseTime?: number;
  status?: number;
  statusLine?: string;
  ip?: string;
  protocol?: string;
  fromCache?: boolean;
  /** Response size in bytes, read at capture time so it survives reduction. */
  responseSize?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  // Explicitly `| undefined`: payloads are cleared in place when the memory
  // budget is reached, and reassigning beats `delete`, which deoptimises the
  // object's shape.
  requestBody?: BodyCapture | undefined;
  responseBody?: BodyCapture | undefined;
  /** Network-level failure reason (`net::ERR_*`) when the request never completed. */
  error?: string;
  evaluation?: Evaluation;
}

/**
 * What the panel receives.
 *
 * Headers, query and payloads are read by the policy inside the worker and
 * released once it has; nothing in the UI renders them, so they are not sent.
 * No header value ever reaches an extension page, which is a stronger guarantee
 * than masking the credential-bearing ones was.
 */
export type LiteRecord = Omit<
  RequestRecord,
  'requestBody' | 'responseBody' | 'requestHeaders' | 'responseHeaders' | 'query'
>;

export interface DomainStats {
  readonly host: string;
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly notApplicable: number;
  readonly pending: number;
  /** Share of evaluated requests that passed, in `[0, 1]`; `null` when nothing was evaluated. */
  readonly passRate: number | null;
  readonly lastActivityAt: number;
  /** Assertion ids that failed at least once, with their failure counts. */
  readonly topFailures: readonly {
    readonly id: string;
    readonly name: string;
    readonly count: number;
  }[];
}

export interface TabSummary {
  readonly tabId: number;
  readonly title?: string;
  readonly pageUrl?: string;
  readonly closed: boolean;
  /** Whether new requests in this tab are being captured. */
  readonly recording: boolean;
  /**
   * Whether DevTools is open on this tab.
   *
   * Capture reads `chrome.devtools.network`, so recording without this is an
   * armed intention rather than an active capture, and the popup says so.
   */
  readonly devtoolsAttached: boolean;
  /** When the current recording window opened — what "since" means in the UI. */
  readonly recordingStartedAt: number;
  /** Keep records across top-level navigations, overriding the policy default. */
  readonly preserveLog: boolean;
  readonly lastActivityAt: number;
  readonly totals: Omit<DomainStats, 'host' | 'topFailures'>;
  readonly domains: readonly DomainStats[];
}

export interface ConfigStatus {
  readonly revision: number;
  readonly valid: boolean;
  readonly source: 'user' | 'default';
  readonly name: string;
  readonly groupCount: number;
  readonly assertionCount: number;
  /** True when some assertion reads a payload, so the panel must fetch bodies. */
  readonly needsBodies: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /**
   * What a one-time migration could not carry across, when one ran.
   *
   * Empty on every load after the first: the migrated document is saved back,
   * so it is only ever rewritten once.
   */
  readonly migrationNotes: readonly string[];
  readonly updatedAt: number;
}
