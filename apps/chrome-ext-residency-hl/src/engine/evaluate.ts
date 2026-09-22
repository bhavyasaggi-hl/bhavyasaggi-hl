/** Runs a resolved policy against a captured request and explains every outcome. */

import { type MatchTarget, matchesScope } from '../config/match.ts';
import type { AssertionGroup, CompiledAssertion, ResolvedConfig } from '../config/schema.ts';
import { errorMessage } from '../shared/logger.ts';
import type {
  AssertionDefinition,
  AssertionOutcome,
  Evaluation,
  PolicyIndex,
  RequestRecord,
  TestOutcome,
  Verdict,
} from '../shared/types.ts';
import { buildContext, type EvaluationContext, resolveExpression } from './expression.ts';
import { display, type ExpectedValue, OPERATORS } from './operators.ts';

/** True when every scope in the group's inheritance chain matches the target. */
function groupAppliesTo(group: AssertionGroup, target: MatchTarget): boolean {
  return group.scope.every((scope) => matchesScope(scope, target));
}

function targetOf(record: RequestRecord): MatchTarget {
  return {
    host: record.host,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
  };
}

/** True when at least one group in `config` scopes `target`. */
export function isScoped(config: ResolvedConfig, target: MatchTarget): boolean {
  return config.groups.some((group) => groupAppliesTo(group, target));
}

function expectedValue(assertion: CompiledAssertion): ExpectedValue {
  return {
    raw: assertion.expectedRaw,
    text: assertion.expected ?? '',
    list: assertion.expectedList,
  };
}

function runAssertion(assertion: CompiledAssertion, context: EvaluationContext): AssertionOutcome {
  let actual: unknown;
  try {
    actual = resolveExpression(assertion.expression, context);
  } catch (cause) {
    const detail = errorMessage(cause);
    return {
      id: assertion.id,
      actual: 'undefined',
      passed: false,
      detail: `Could not evaluate "${assertion.expression}" — ${detail}`,
      error: detail,
    };
  }

  const operator = OPERATORS[assertion.operator];
  if (operator === undefined) {
    const detail = `Operator "${assertion.operator}" is not implemented`;
    return { id: assertion.id, actual: display(actual), passed: false, detail, error: detail };
  }

  try {
    const outcome = operator(actual, expectedValue(assertion));
    return {
      id: assertion.id,
      actual: display(actual),
      passed: outcome.passed,
      detail: outcome.detail,
    };
  } catch (cause) {
    const detail = errorMessage(cause);
    return {
      id: assertion.id,
      actual: display(actual),
      passed: false,
      detail: `Operator "${assertion.operator}" threw — ${detail}`,
      error: detail,
    };
  }
}

/**
 * Builds the id-to-definition map the panel joins outcomes against.
 *
 * One of these describes a whole policy, so it travels once per policy change
 * rather than once per request.
 */
export function indexPolicy(config: ResolvedConfig): PolicyIndex {
  const index: Record<string, AssertionDefinition> = {};
  for (const group of config.groups) {
    for (const assertion of group.assertions) {
      index[assertion.id] = {
        id: assertion.id,
        name: assertion.name,
        ...(assertion.description === undefined ? {} : { description: assertion.description }),
        expression: assertion.expression,
        operator: assertion.operator,
        ...(assertion.expected === undefined ? {} : { expected: assertion.expected }),
        group: group.name,
      };
    }
  }
  return index;
}

/**
 * A request passes when every applicable assertion passed.
 *
 * There is no advisory tier: OpenCollection's `Assertion` has no severity, and
 * this config is a subset of that schema, so an assertion that fails is a
 * failure. Nothing here can produce a softer verdict.
 */
function verdictFor(results: readonly AssertionOutcome[]): Verdict {
  if (results.length === 0) {
    return 'not-applicable';
  }
  return results.some((result) => !result.passed) ? 'fail' : 'pass';
}

/**
 * Folds script outcomes into a verdict that was computed without them.
 *
 * Tests run in the sandbox after the assertions have already been judged, so
 * this recomputes rather than re-evaluates: a failing test can only make a
 * verdict worse, never better, and a record with no scripts is untouched.
 */
export function withTests(evaluation: Evaluation, tests: readonly TestOutcome[]): Evaluation {
  const failed = tests.some((outcome) => !outcome.passed);
  if (!failed) {
    return { ...evaluation, tests };
  }
  // The policy author wrote code saying this request is wrong, so it is.
  return { ...evaluation, tests, verdict: 'fail' };
}

/** Scripts from every group that scopes the record, in document order. */
export function scriptsFor(
  record: RequestRecord,
  config: ResolvedConfig,
): readonly { readonly id: string; readonly code: string }[] {
  const target = targetOf(record);
  return config.groups
    .filter((group) => groupAppliesTo(group, target))
    .flatMap((group) => group.scripts);
}

/** True when enough of the exchange is known to judge it. */
function isSettled(record: RequestRecord): boolean {
  return record.status !== undefined || record.error !== undefined;
}

/** Evaluates `record` against `config`, producing a verdict and per-assertion detail. */
export function evaluateRecord(record: RequestRecord, config: ResolvedConfig): Evaluation {
  const now = Date.now();
  if (!isSettled(record)) {
    return {
      verdict: 'pending',
      results: [],
      groups: [],
      evaluatedAt: now,
      configRevision: config.revision,
    };
  }

  const target = targetOf(record);
  const applicable = config.groups.filter((group) => groupAppliesTo(group, target));
  const context = buildContext(record);
  const results: AssertionOutcome[] = [];
  for (const group of applicable) {
    for (const assertion of group.assertions) {
      results.push(runAssertion(assertion, context));
    }
  }

  return {
    verdict: verdictFor(results),
    results,
    groups: applicable.map((group) => group.name),
    evaluatedAt: now,
    configRevision: config.revision,
  };
}
