/**
 * Shared scaffolding for reading an untrusted policy document.
 *
 * The parser is split by what it reads — this file holds the pieces every part
 * of it needs: where problems are collected, the sets of keys the schema
 * allows, and the few coercions that turn a YAML scalar into something typed.
 */

import type { ConfigProblem } from './schema.ts';

export const KNOWN_ROOT_KEYS = new Set([
  'opencollection',
  'info',
  'items',
  'extensions',
  // Defined by the schema but not read here; present so a fuller collection
  // does not draw warnings for fields it is entitled to carry.
  'config',
  'request',
  'docs',
  'bundled',
]);
export const KNOWN_INFO_KEYS = new Set(['name', 'summary', 'version', 'authors']);
export const KNOWN_REQUEST_KEYS = new Set([
  'info',
  'http',
  'runtime',
  'settings',
  'examples',
  'docs',
]);
export const KNOWN_FOLDER_KEYS = new Set(['info', 'items', 'request', 'docs']);
export const KNOWN_ITEM_INFO_KEYS = new Set(['name', 'description', 'type', 'seq', 'tags']);
export const KNOWN_HTTP_KEYS = new Set(['method', 'url', 'headers', 'params', 'body', 'auth']);
export const KNOWN_RUNTIME_KEYS = new Set(['variables', 'scripts', 'assertions', 'actions']);
export const KNOWN_SCRIPT_KEYS = new Set(['type', 'code']);
export const KNOWN_ASSERTION_KEYS = new Set([
  'expression',
  'operator',
  'value',
  'disabled',
  'description',
]);

export class Collector {
  readonly problems: ConfigProblem[] = [];

  error(path: string, message: string): void {
    this.problems.push({ path, message, severity: 'error' });
  }

  warn(path: string, message: string): void {
    this.problems.push({ path, message, severity: 'warning' });
  }

  get errors(): string[] {
    return this.format('error');
  }

  get warnings(): string[] {
    return this.format('warning');
  }

  private format(severity: ConfigProblem['severity']): string[] {
    return this.problems
      .filter((problem) => problem.severity === severity)
      .map((problem) => `${problem.path}: ${problem.message}`);
  }
}

/** A YAML mapping, before any of its keys have been validated. */
export type RawRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asStringList(value: unknown): readonly string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== null && entry !== undefined)
      .map((entry) => String(entry));
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function warnUnknownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
  into: Collector,
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      into.warn(path, `unknown key "${key}" was ignored`);
    }
  }
}

/** The schema's `Description`: a string, `{ content, type }`, or absent. */
export function readDescription(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.trim();
  }
  if (isRecord(raw) && typeof raw['content'] === 'string' && raw['content'].trim() !== '') {
    return raw['content'].trim();
  }
  return undefined;
}
