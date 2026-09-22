/**
 * Expression resolution.
 *
 * Expressions are property paths, never JavaScript: the extension parses
 * `res.body.items[0].region` / `res.headers['x-data-region']` into segments and
 * walks the evaluation context. Nothing is ever passed to `eval` or `Function`,
 * so a hostile config cannot execute code inside the service worker.
 */

import type { RequestRecord } from '../shared/types.ts';

export interface EvaluationContext {
  readonly req: Readonly<Record<string, unknown>>;
  readonly res: Readonly<Record<string, unknown>>;
}

type Segment =
  | { readonly kind: 'key'; readonly value: string }
  | { readonly kind: 'index'; readonly value: number };

class ExpressionError extends Error {}

const IDENTIFIER = /[A-Za-z0-9_$-]/u;

/** Splits a dotted/bracketed property path into segments. */
export function parseExpression(expression: string): readonly Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let current = '';

  const flush = (): void => {
    if (current !== '') {
      segments.push({ kind: 'key', value: current });
      current = '';
    }
  };

  while (cursor < expression.length) {
    const char = expression[cursor] ?? '';
    if (char === '.') {
      flush();
      cursor += 1;
      continue;
    }
    if (char === '[') {
      flush();
      const close = findClosingBracket(expression, cursor);
      const inner = expression.slice(cursor + 1, close).trim();
      segments.push(parseBracket(inner, expression));
      cursor = close + 1;
      continue;
    }
    if (!IDENTIFIER.test(char)) {
      throw new ExpressionError(`Unexpected character "${char}" in expression "${expression}"`);
    }
    current += char;
    cursor += 1;
  }
  flush();

  if (segments.length === 0) {
    throw new ExpressionError('Expression is empty');
  }
  return segments;
}

function findClosingBracket(expression: string, open: number): number {
  const close = expression.indexOf(']', open);
  if (close === -1) {
    throw new ExpressionError(`Unclosed "[" in expression "${expression}"`);
  }
  return close;
}

function parseBracket(inner: string, expression: string): Segment {
  const quoted = /^(?<quote>['"])(?<value>.*)\k<quote>$/su.exec(inner);
  if (quoted?.groups?.['value'] !== undefined) {
    return { kind: 'key', value: quoted.groups['value'] };
  }
  if (/^-?\d+$/u.test(inner)) {
    return { kind: 'index', value: Number(inner) };
  }
  throw new ExpressionError(
    `Bracket "[${inner}]" in "${expression}" must be a quoted key or an integer`,
  );
}

/** `items[0]`, and `items[-1]` counting back from the end. */
function stepIndex(target: unknown, offset: number): unknown {
  if (!Array.isArray(target)) {
    return undefined;
  }
  return target[offset < 0 ? target.length + offset : offset];
}

/** A named lookup on an object, falling back to the lowercased key. */
function stepKeyOnObject(target: object, key: string): unknown {
  const record = target as Record<string, unknown>;
  if (Object.hasOwn(record, key)) {
    return record[key];
  }
  // Header lookups are case-insensitive; stored keys are already lowercased.
  const lowered = key.toLowerCase();
  return Object.hasOwn(record, lowered) ? record[lowered] : undefined;
}

function step(target: unknown, segment: Segment): unknown {
  if (target === null || target === undefined) {
    return undefined;
  }
  if (segment.kind === 'index') {
    return stepIndex(target, segment.value);
  }
  // Arrays and strings expose `.length` and nothing else a policy may read.
  if (Array.isArray(target) || typeof target === 'string') {
    return segment.value === 'length' ? target.length : undefined;
  }
  return typeof target === 'object' ? stepKeyOnObject(target, segment.value) : undefined;
}

/** Resolves `expression` against `context`; missing paths yield `undefined`. */
export function resolveExpression(expression: string, context: EvaluationContext): unknown {
  const segments = parseExpression(expression);
  const [root, ...rest] = segments;
  if (root === undefined || root.kind !== 'key') {
    throw new ExpressionError(`Expression "${expression}" must start with "req" or "res"`);
  }
  if (root.value !== 'req' && root.value !== 'res') {
    throw new ExpressionError(
      `Unknown root "${root.value}" in "${expression}"; expected "req" or "res"`,
    );
  }
  let value: unknown = context[root.value];
  for (const segment of rest) {
    value = step(value, segment);
  }
  return value;
}

/** Projects a captured record into the `req` / `res` namespaces used by expressions. */
export function buildContext(record: RequestRecord): EvaluationContext {
  const responseBody = record.responseBody;
  const requestBody = record.requestBody;
  return {
    req: {
      method: record.method,
      url: record.url,
      host: record.host,
      domain: record.registrableDomain,
      path: record.path,
      query: record.query,
      headers: record.requestHeaders,
      body: requestBody === undefined ? undefined : (requestBody.json ?? requestBody.text),
      bodyText: requestBody?.text,
      type: record.resourceType,
      initiator: record.initiator,
      startedAt: record.startedAt,
      frameId: record.frameId,
    },
    res: {
      status: record.status,
      statusText: record.statusLine,
      headers: record.responseHeaders,
      body: responseBody === undefined ? undefined : (responseBody.json ?? responseBody.text),
      bodyText: responseBody?.text,
      contentType: responseBody?.contentType ?? record.responseHeaders['content-type'],
      responseTime: record.responseTime,
      size: responseBody?.size,
      ip: record.ip,
      protocol: record.protocol,
      fromCache: record.fromCache,
      error: record.error,
    },
  };
}
