/**
 * Assertion operators.
 *
 * The set mirrors Bruno's OpenCollection `runtime.assertions` operators and adds
 * two residency-specific extensions (`inCidr` / `notInCidr`). Every operator
 * returns a short human sentence so the report can explain the outcome without
 * re-running the comparison.
 */

import { type CidrRange, ipInCidr, parseCidr } from './ip.ts';
import { MAX_MATCH_INPUT } from './regex-safety.ts';

export interface ExpectedValue {
  /** The raw YAML value, kept so lists written as YAML sequences survive. */
  readonly raw: unknown;
  /** Single-line textual form used for display and string comparisons. */
  readonly text: string;
  /** `raw` normalized to a list (comma-splitting a scalar string). */
  readonly list: readonly string[];
}

interface OperatorOutcome {
  readonly passed: boolean;
  /** Sentence fragment completing "… because <detail>". */
  readonly detail: string;
}

export type OperatorFn = (actual: unknown, expected: ExpectedValue) => OperatorOutcome;

/** True when the operator ignores `value`, so a missing `value` is not a config error. */
const UNARY_OPERATORS = new Set([
  'isNull',
  'isUndefined',
  'isDefined',
  'isEmpty',
  'isNotEmpty',
  'isTruthy',
  'isFalsy',
  'isNumber',
  'isString',
  'isBoolean',
  'isArray',
  'isJson',
]);

export function isUnaryOperator(operator: string): boolean {
  return UNARY_OPERATORS.has(operator);
}

export function display(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/** Loose equality: numeric when both sides are numeric, boolean/null aware, else textual. */
function looseEquals(actual: unknown, expectedText: string): boolean {
  const normalized = expectedText.trim();
  if (normalized === 'null') {
    return actual === null;
  }
  if (normalized === 'undefined') {
    return actual === undefined;
  }
  if (normalized === 'true' || normalized === 'false') {
    const wanted = normalized === 'true';
    return typeof actual === 'boolean' ? actual === wanted : asText(actual) === normalized;
  }
  const actualNumber = asNumber(actual);
  const expectedNumber = asNumber(normalized);
  if (actualNumber !== null && expectedNumber !== null) {
    return actualNumber === expectedNumber;
  }
  return asText(actual) === normalized;
}

function compareNumeric(
  actual: unknown,
  expected: ExpectedValue,
  symbol: string,
  compare: (left: number, right: number) => boolean,
): OperatorOutcome {
  const left = asNumber(actual);
  const right = asNumber(expected.text);
  if (left === null || right === null) {
    return {
      passed: false,
      detail: `${display(actual)} and ${display(expected.text)} are not both numeric`,
    };
  }
  return {
    passed: compare(left, right),
    detail: `${left} ${compare(left, right) ? symbol : `not ${symbol}`} ${right}`,
  };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}

function lengthOf(value: unknown): number | null {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length;
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).length;
  }
  return null;
}

const LENGTH_COMPARATORS: Readonly<Record<string, (left: number, right: number) => boolean>> = {
  '=': (left, right) => left === right,
  '==': (left, right) => left === right,
  '!=': (left, right) => left !== right,
  '>': (left, right) => left > right,
  '>=': (left, right) => left >= right,
  '<': (left, right) => left < right,
  '<=': (left, right) => left <= right,
};

function typeCheck(actual: unknown, label: string, predicate: boolean): OperatorOutcome {
  return {
    passed: predicate,
    detail: `${display(actual)} is ${predicate ? '' : 'not '}a ${label}`,
  };
}

function resolveRanges(expected: ExpectedValue): {
  readonly ranges: readonly CidrRange[];
  readonly unresolved: readonly string[];
} {
  const ranges: CidrRange[] = [];
  const unresolved: string[] = [];
  for (const entry of expected.list) {
    const parsed = parseCidr(entry);
    if (parsed === null) {
      unresolved.push(entry);
    } else {
      ranges.push(parsed);
    }
  }
  return { ranges, unresolved };
}

function cidrOutcome(
  actual: unknown,
  expected: ExpectedValue,
): {
  readonly inside: boolean;
  readonly detail: string;
} {
  const { ranges, unresolved } = resolveRanges(expected);
  if (unresolved.length > 0) {
    return { inside: false, detail: `cannot resolve CIDR entries: ${unresolved.join(', ')}` };
  }
  if (ranges.length === 0) {
    return { inside: false, detail: 'no CIDR ranges were supplied' };
  }
  const address = asText(actual);
  const hit = ranges.find((range) => ipInCidr(address, range));
  return hit === undefined
    ? {
        inside: false,
        detail: `${display(address)} is outside ${ranges.map((range) => range.source).join(', ')}`,
      }
    : { inside: true, detail: `${display(address)} is inside ${hit.source}` };
}

export const OPERATORS: Readonly<Record<string, OperatorFn>> = {
  equals: (actual, expected) => ({
    passed: looseEquals(actual, expected.text),
    detail: `${display(actual)} ${looseEquals(actual, expected.text) ? '==' : '!='} ${display(expected.text)}`,
  }),
  notEquals: (actual, expected) => ({
    passed: !looseEquals(actual, expected.text),
    detail: `${display(actual)} ${looseEquals(actual, expected.text) ? '==' : '!='} ${display(expected.text)}`,
  }),
  gt: (actual, expected) => compareNumeric(actual, expected, '>', (left, right) => left > right),
  gte: (actual, expected) => compareNumeric(actual, expected, '>=', (left, right) => left >= right),
  lt: (actual, expected) => compareNumeric(actual, expected, '<', (left, right) => left < right),
  lte: (actual, expected) => compareNumeric(actual, expected, '<=', (left, right) => left <= right),

  contains: (actual, expected) => {
    const hit = Array.isArray(actual)
      ? actual.some((entry) => looseEquals(entry, expected.text))
      : asText(actual).includes(expected.text);
    return {
      passed: hit,
      detail: `${display(actual)} does${hit ? '' : ' not'} contain ${display(expected.text)}`,
    };
  },
  notContains: (actual, expected) => {
    const hit = Array.isArray(actual)
      ? actual.some((entry) => looseEquals(entry, expected.text))
      : asText(actual).includes(expected.text);
    return {
      passed: !hit,
      detail: `${display(actual)} does${hit ? '' : ' not'} contain ${display(expected.text)}`,
    };
  },
  startsWith: (actual, expected) => {
    const hit = asText(actual).startsWith(expected.text);
    return {
      passed: hit,
      detail: `${display(actual)} does${hit ? '' : ' not'} start with ${display(expected.text)}`,
    };
  },
  endsWith: (actual, expected) => {
    const hit = asText(actual).endsWith(expected.text);
    return {
      passed: hit,
      detail: `${display(actual)} does${hit ? '' : ' not'} end with ${display(expected.text)}`,
    };
  },
  matches: (actual, expected) => matchRegex(actual, expected, true),
  notMatches: (actual, expected) => matchRegex(actual, expected, false),

  isNull: (actual) => ({
    passed: actual === null,
    detail: `${display(actual)} is ${actual === null ? '' : 'not '}null`,
  }),
  isUndefined: (actual) => ({
    passed: actual === undefined,
    detail: `${display(actual)} is ${actual === undefined ? '' : 'not '}undefined`,
  }),
  isDefined: (actual) => ({
    passed: actual !== undefined,
    detail: `${display(actual)} is ${actual === undefined ? 'not ' : ''}defined`,
  }),
  isEmpty: (actual) => ({
    passed: isEmptyValue(actual),
    detail: `${display(actual)} is ${isEmptyValue(actual) ? '' : 'not '}empty`,
  }),
  isNotEmpty: (actual) => ({
    passed: !isEmptyValue(actual),
    detail: `${display(actual)} is ${isEmptyValue(actual) ? '' : 'not '}empty`,
  }),
  isTruthy: (actual) => ({
    passed: Boolean(actual),
    detail: `${display(actual)} is ${actual ? '' : 'not '}truthy`,
  }),
  isFalsy: (actual) => ({
    passed: !actual,
    detail: `${display(actual)} is ${actual ? 'not ' : ''}falsy`,
  }),
  isNumber: (actual) =>
    typeCheck(actual, 'number', typeof actual === 'number' && Number.isFinite(actual)),
  isString: (actual) => typeCheck(actual, 'string', typeof actual === 'string'),
  isBoolean: (actual) => typeCheck(actual, 'boolean', typeof actual === 'boolean'),
  isArray: (actual) => typeCheck(actual, 'array', Array.isArray(actual)),
  isJson: (actual) => typeCheck(actual, 'JSON object or array', isJsonValue(actual)),

  in: (actual, expected) => {
    const hit = expected.list.some((entry) => looseEquals(actual, entry));
    return {
      passed: hit,
      detail: `${display(actual)} is ${hit ? '' : 'not '}one of [${expected.list.join(', ')}]`,
    };
  },
  notIn: (actual, expected) => {
    const hit = expected.list.some((entry) => looseEquals(actual, entry));
    return {
      passed: !hit,
      detail: `${display(actual)} is ${hit ? '' : 'not '}one of [${expected.list.join(', ')}]`,
    };
  },
  between: (actual, expected) => {
    const bounds = expected.text.split(/[,:]/u).map((part) => Number(part.trim()));
    const value = asNumber(actual);
    const [low, high] = bounds;
    if (
      bounds.length !== 2 ||
      low === undefined ||
      high === undefined ||
      !Number.isFinite(low) ||
      !Number.isFinite(high)
    ) {
      return {
        passed: false,
        detail: `${display(expected.text)} is not a "low,high" numeric range`,
      };
    }
    if (value === null) {
      return { passed: false, detail: `${display(actual)} is not numeric` };
    }
    const inside = value >= low && value <= high;
    return {
      passed: inside,
      detail: `${value} is ${inside ? '' : 'not '}within [${low}, ${high}]`,
    };
  },
  length: (actual, expected) => {
    const size = lengthOf(actual);
    if (size === null) {
      return { passed: false, detail: `${display(actual)} has no length` };
    }
    const parsed = /^\s*(?<symbol>[<>!=]=|[<>=])?\s*(?<amount>-?\d+(?:\.\d+)?)\s*$/u.exec(
      expected.text,
    );
    const symbol = parsed?.groups?.['symbol'] ?? '=';
    const amount = Number(parsed?.groups?.['amount']);
    const compare = LENGTH_COMPARATORS[symbol];
    if (compare === undefined || !Number.isFinite(amount)) {
      return { passed: false, detail: `${display(expected.text)} is not a length comparison` };
    }
    const hit = compare(size, amount);
    return { passed: hit, detail: `length ${size} is ${hit ? '' : 'not '}${symbol} ${amount}` };
  },

  inCidr: (actual, expected) => {
    const { inside, detail } = cidrOutcome(actual, expected);
    return { passed: inside, detail };
  },
  notInCidr: (actual, expected) => {
    const { inside, detail } = cidrOutcome(actual, expected);
    return { passed: !inside, detail };
  },
};

function matchRegex(actual: unknown, expected: ExpectedValue, wantMatch: boolean): OperatorOutcome {
  let pattern: RegExp;
  try {
    pattern = new RegExp(expected.text, 'u');
  } catch {
    return { passed: false, detail: `${display(expected.text)} is not a valid regular expression` };
  }
  // Patterns are screened when the policy loads; the subject is bounded here so
  // an unusually large body cannot turn a linear pattern into a stall.
  const subject = asText(actual).slice(0, MAX_MATCH_INPUT);
  const hit = pattern.test(subject);
  return {
    passed: hit === wantMatch,
    detail: `${display(actual)} does${hit ? '' : ' not'} match /${expected.text}/`,
  };
}

function isJsonValue(actual: unknown): boolean {
  if (Array.isArray(actual) || (typeof actual === 'object' && actual !== null)) {
    return true;
  }
  if (typeof actual !== 'string') {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(actual);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/** Bruno-compatible short aliases mapped onto the canonical operator names. */
const OPERATOR_ALIASES: Readonly<Record<string, string>> = {
  eq: 'equals',
  neq: 'notEquals',
  ne: 'notEquals',
  '==': 'equals',
  '!=': 'notEquals',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  notEqual: 'notEquals',
  equal: 'equals',
  regex: 'matches',
  notRegex: 'notMatches',
};

/** Resolves an operator name (or alias) to its canonical form, or `null` when unknown. */
export function canonicalOperator(name: string): string | null {
  const trimmed = name.trim();
  const aliased = OPERATOR_ALIASES[trimmed] ?? trimmed;
  return aliased in OPERATORS ? aliased : null;
}

export const OPERATOR_NAMES: readonly string[] = Object.keys(OPERATORS);
