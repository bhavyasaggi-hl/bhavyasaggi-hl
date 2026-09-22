/**
 * Reads `runtime.assertions` and `runtime.scripts` from one item.
 *
 * Each field is validated by its own function rather than in one pass: the
 * rules differ per field, and a single function covering all of them is a
 * chain of unrelated bail-outs nobody can hold in their head.
 */

import { parseExpression } from '../engine/expression.ts';
import { canonicalOperator, isUnaryOperator } from '../engine/operators.ts';
import { catastrophicRisk } from '../engine/regex-safety.ts';
import { errorMessage } from '../shared/logger.ts';
import {
  asStringList,
  type Collector,
  isRecord,
  KNOWN_ASSERTION_KEYS,
  KNOWN_SCRIPT_KEYS,
  type RawRecord,
  readDescription,
  warnUnknownKeys,
} from './collect.ts';
import type { CompiledAssertion, CompiledScript } from './schema.ts';

function readExpression(raw: RawRecord, path: string, into: Collector): string | null {
  const value = raw['expression'];
  if (typeof value !== 'string' || value.trim() === '') {
    into.error(path, '"expression" is required and must be a non-empty string');
    return null;
  }
  const expression = value.trim();
  try {
    parseExpression(expression);
  } catch (cause) {
    into.error(`${path}.expression`, errorMessage(cause));
    return null;
  }
  return expression;
}

/** Reads the operator and resolves any alias to its canonical name. */
function readOperator(raw: RawRecord, path: string, into: Collector): string | null {
  const value = raw['operator'];
  if (typeof value !== 'string' || value.trim() === '') {
    into.error(path, '"operator" is required');
    return null;
  }
  const operator = canonicalOperator(value);
  if (operator === null) {
    into.error(`${path}.operator`, `unknown operator "${value}"`);
    return null;
  }
  return operator;
}

/** True when the operator and its value agree about whether one is needed. */
function valueFitsOperator(
  operator: string,
  value: unknown,
  path: string,
  into: Collector,
): boolean {
  const unary = isUnaryOperator(operator);
  const missing = value === undefined || value === null;
  if (!unary && missing) {
    into.error(path, `operator "${operator}" requires a "value"`);
    return false;
  }
  if (unary && !missing) {
    into.warn(path, `operator "${operator}" ignores "value"`);
  }
  return true;
}

/**
 * Screens a regex operator's pattern before it can reach a request.
 *
 * Compiled here so an invalid pattern is a config error the editor shows, not a
 * silent per-request failure later, and screened for catastrophic backtracking
 * because a policy author should not be able to hang the worker.
 */
function patternIsSafe(operator: string, value: unknown, path: string, into: Collector): boolean {
  if (!(operator === 'matches' || operator === 'notMatches') || typeof value !== 'string') {
    return true;
  }
  const risk = catastrophicRisk(value);
  if (risk !== null) {
    into.error(`${path}.value`, risk);
    return false;
  }
  try {
    void new RegExp(value, 'u');
  } catch (cause) {
    into.error(`${path}.value`, `not a valid regular expression — ${errorMessage(cause)}`);
    return false;
  }
  return true;
}

function parseAssertion(raw: unknown, path: string, into: Collector): CompiledAssertion | null {
  if (!isRecord(raw)) {
    into.error(path, 'must be a mapping with expression/operator/value');
    return null;
  }
  warnUnknownKeys(raw, KNOWN_ASSERTION_KEYS, path, into);
  // The schema spells this `disabled: true`, not `enabled: false`.
  if (raw['disabled'] === true) {
    return null;
  }

  const expression = readExpression(raw, path, into);
  const operator = expression === null ? null : readOperator(raw, path, into);
  if (expression === null || operator === null) {
    return null;
  }

  const valueRaw = raw['value'];
  // The schema types `value` as a string. A list is not a shorthand this config
  // may invent, so `in` takes its members comma separated.
  if (Array.isArray(valueRaw)) {
    into.error(`${path}.value`, 'must be a string; list members go in one comma-separated value');
    return null;
  }
  if (
    !(
      valueFitsOperator(operator, valueRaw, path, into) &&
      patternIsSafe(operator, valueRaw, path, into)
    )
  ) {
    return null;
  }

  const expectedList = asStringList(valueRaw);
  const expected = valueRaw === undefined || valueRaw === null ? undefined : String(valueRaw);
  // `description` is the schema's own field, and the only place a human label
  // can live; without one the expression speaks for itself.
  const description = readDescription(raw['description']);
  const name = description ?? `${expression} ${operator}`;

  return {
    // The document path is unique by construction; a group name is not —
    // two folders may share one, and colliding ids merge unrelated findings.
    id: path,
    name,
    ...(description === undefined ? {} : { description }),
    expression,
    operator,
    ...(expected === undefined ? {} : { expected }),
    expectedList,
    expectedRaw: valueRaw,
  };
}

export function parseAssertionList(
  raw: unknown,
  path: string,
  into: Collector,
): readonly CompiledAssertion[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    into.error(path, 'must be a list of assertions');
    return [];
  }
  const parsed: CompiledAssertion[] = [];
  for (const [index, entry] of raw.entries()) {
    const assertion = parseAssertion(entry, `${path}[${index}]`, into);
    if (assertion !== null) {
      parsed.push(assertion);
    }
  }
  return parsed;
}

/** Script types OpenCollection defines but this extension cannot honour. */
const UNSUPPORTED_SCRIPT_TYPES: Readonly<Record<string, string>> = {
  'before-request': 'requests are observed after the page sent them, so there is no "before"',
  'after-response':
    'it exists to pass variables to a later request, which observed traffic has no notion of',
};

/** Reads one entry of `runtime.scripts`, or `null` once it has reported why not. */
function parseScript(entry: unknown, path: string, into: Collector): CompiledScript | null {
  if (!isRecord(entry)) {
    into.error(path, 'must be a mapping with type/code');
    return null;
  }
  warnUnknownKeys(entry, KNOWN_SCRIPT_KEYS, path, into);

  const type = typeof entry['type'] === 'string' ? entry['type'].trim() : '';
  const why = UNSUPPORTED_SCRIPT_TYPES[type];
  if (type === '') {
    into.error(path, '"type" is required; only "tests" is supported');
    return null;
  }
  if (why !== undefined) {
    into.error(`${path}.type`, `"${type}" is not supported here — ${why}`);
    return null;
  }
  if (type !== 'tests') {
    into.error(`${path}.type`, `unknown script type "${type}"; only "tests" is supported`);
    return null;
  }

  const code = entry['code'];
  if (typeof code !== 'string' || code.trim() === '') {
    into.error(path, '"code" is required and must be a non-empty string');
    return null;
  }
  return { id: path, code };
}

export function parseScriptList(
  raw: unknown,
  path: string,
  into: Collector,
): readonly CompiledScript[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    into.error(path, 'must be a list of scripts');
    return [];
  }
  const scripts: CompiledScript[] = [];
  for (const [index, entry] of raw.entries()) {
    const script = parseScript(entry, `${path}[${String(index)}]`, into);
    if (script !== null) {
      scripts.push(script);
    }
  }
  return scripts;
}
