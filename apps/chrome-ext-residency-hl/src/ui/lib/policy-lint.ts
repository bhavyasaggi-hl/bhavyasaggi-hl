/**
 * Editor intelligence for the policy document.
 *
 * The linter is the extension's own parser, not a generic YAML schema check:
 * `parseConfig` already reports every problem with the document path that
 * produced it, so the only work here is resolving that path back to a source
 * range through the YAML CST.
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import { type Document, parseDocument } from 'yaml';
import { parseConfig } from '../../config/parse.ts';
import type { ConfigProblem, ParseOutcome } from '../../config/schema.ts';
import { OPERATOR_NAMES } from '../../engine/operators.ts';
import { ASSERTION_FIELDS, EXPRESSIONS, SCRIPT_FIELDS, STRUCTURE } from '../policy-reference.ts';

type Segment = string | number;

/** Splits `items[0].runtime.assertions[1]` into walkable segments. */
function pathSegments(path: string): Segment[] {
  if (path === 'root' || path === '') {
    return [];
  }
  const segments: Segment[] = [];
  for (const part of path.split('.')) {
    const match = /^(?<key>[^[\]]*)(?<indexes>(?:\[\d+\])*)$/u.exec(part);
    const key = match?.groups?.['key'] ?? part;
    if (key !== '') {
      segments.push(key);
    }
    for (const index of (match?.groups?.['indexes'] ?? '').matchAll(/\[(?<value>\d+)\]/gu)) {
      segments.push(Number(index.groups?.['value']));
    }
  }
  return segments;
}

interface Range {
  readonly from: number;
  readonly to: number;
}

function rangeOfNode(node: unknown): Range | null {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (range === undefined) {
    return null;
  }
  return { from: range[0], to: Math.max(range[1], range[0] + 1) };
}

/**
 * Resolves a problem path to a source range, walking up to the nearest
 * ancestor that exists. A path can point at a key the document never wrote —
 * a missing `expression`, say — and the enclosing item is the right place to
 * show that.
 */
function locate(document: Document, path: string, fallback: Range): Range {
  const segments = pathSegments(path);
  for (let depth = segments.length; depth > 0; depth -= 1) {
    try {
      const node: unknown = document.getIn(segments.slice(0, depth), true);
      const range = rangeOfNode(node);
      if (range !== null) {
        return range;
      }
    } catch {
      // A segment that does not address a collection simply does not resolve.
    }
  }
  return fallback;
}

export interface Analysis {
  readonly outcome: ParseOutcome;
  readonly diagnostics: readonly Diagnostic[];
  /** True when the document parsed into an installable policy. */
  readonly valid: boolean;
  readonly assertionCount: number;
  /** How many `tests` scripts the policy carries, across every group. */
  readonly scriptCount: number;
  readonly groupCount: number;
}

function diagnosticFor(document: Document, problem: ConfigProblem, whole: Range): Diagnostic {
  const { from, to } = locate(document, problem.path, whole);
  return {
    from,
    to,
    severity: problem.severity,
    message: problem.message,
    source: problem.path === 'root' ? 'residency' : problem.path,
  };
}

/**
 * One-entry memo. CodeMirror's linter and the editor's problem summary both ask
 * for the same document on every keystroke, and each call is a full YAML parse.
 */
let lastInput: string | null = null;
let lastResult: Analysis | null = null;

/** Parses, validates and produces editor diagnostics for one document. */
export function analyze(text: string): Analysis {
  if (text === lastInput && lastResult !== null) {
    return lastResult;
  }
  const result = analyzeUncached(text);
  lastInput = text;
  lastResult = result;
  return result;
}

function analyzeUncached(text: string): Analysis {
  const outcome = parseConfig(text);
  const whole: Range = { from: 0, to: Math.max(text.length, 1) };
  const document = parseDocument(text, { prettyErrors: true });

  const syntax: Diagnostic[] = document.errors.map((error) => ({
    from: error.pos[0],
    to: Math.max(error.pos[1], error.pos[0] + 1),
    severity: 'error' as const,
    message: error.message,
    source: 'yaml',
  }));

  const semantic =
    syntax.length > 0
      ? []
      : outcome.problems.map((problem) => diagnosticFor(document, problem, whole));

  return {
    outcome,
    diagnostics: [...syntax, ...semantic],
    valid: outcome.config !== null,
    groupCount: outcome.config?.groups.length ?? 0,
    assertionCount:
      outcome.config?.groups.reduce((sum, group) => sum + group.assertions.length, 0) ?? 0,
    scriptCount: outcome.config?.groups.reduce((sum, group) => sum + group.scripts.length, 0) ?? 0,
  };
}

/** Reformats the document while preserving its comments. */
export function formatPolicy(text: string): string {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors[0]?.message ?? 'The document could not be parsed.');
  }
  return document.toString({ indent: 2, lineWidth: 0 });
}

const TOP_LEVEL_KEYS = STRUCTURE.map(
  (row) => row.term.replace(/\[\]$/u, '').split('.')[0] ?? row.term,
);
const ASSERTION_KEYS = ASSERTION_FIELDS.map((row) => row.term);
const SCRIPT_KEYS = SCRIPT_FIELDS.map((row) => row.term);
const RESOURCE_TYPES = [
  'document',
  'fetch',
  'xhr',
  'preflight',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'websocket',
  'ping',
  'manifest',
  'other',
];

function options(
  values: readonly string[],
  type: string,
  detail?: string,
): { label: string; type: string; detail?: string }[] {
  return values.map((label) => ({ label, type, ...(detail === undefined ? {} : { detail }) }));
}

/** Completes operators, expressions, enum values and keys from the policy vocabulary. */
export function policyCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const token = context.matchBefore(/[\w.$'"[\]/-]*/u);
  if (token === null) {
    return null;
  }
  const empty = token.from === token.to;
  if (empty && !context.explicit && !/:\s*$/u.test(before)) {
    return null;
  }

  const from = token.from;
  if (/\b(?:operator|op):\s*\S*$/u.test(before)) {
    return { from, options: options(OPERATOR_NAMES, 'keyword', 'operator') };
  }
  if (/\b(?:expression|expr):\s*\S*$/u.test(before)) {
    return {
      from,
      options: EXPRESSIONS.map((row) => ({
        label: row.term,
        type: 'variable',
        detail: row.meaning,
      })),
    };
  }
  if (/\bgrouping:\s*\S*$/u.test(before)) {
    return { from, options: options(['host', 'domain'], 'enum') };
  }
  if (/\b(?:disabled|clearOnNavigate|recordUnscoped|debug):\s*\S*$/u.test(before)) {
    return { from, options: options(['true', 'false'], 'enum') };
  }
  if (/resourceTypes:/u.test(before) || /^\s*-\s*\S*$/u.test(before)) {
    const indented = /^\s+/u.test(before);
    if (indented) {
      return { from, options: options(RESOURCE_TYPES, 'enum', 'resource type') };
    }
  }
  if (/^\s*[\w-]*$/u.test(before)) {
    const indented = /^\s+/u.test(before);
    return {
      from,
      options: indented
        ? options(
            [
              ...ASSERTION_KEYS,
              ...SCRIPT_KEYS,
              'info',
              'http',
              'runtime',
              'assertions',
              'scripts',
              'items',
              'url',
              'method',
              'tags',
            ],
            'property',
          )
        : options([...new Set(TOP_LEVEL_KEYS)], 'property'),
    };
  }
  return null;
}
