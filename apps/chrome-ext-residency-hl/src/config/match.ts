/**
 * Pattern and scope matching for config items.
 *
 * An item's scope comes from the fields OpenCollection already gives a request:
 * `http.url` says which requests it describes, `http.method` narrows by verb,
 * and `info.tags` carries the resource types it covers. There are no
 * exclusion lists, because the schema has nowhere to put them — a `regex:`
 * pattern with a negative lookahead does the same job in one field.
 *
 * Patterns are globs by default (`*` matches any run of characters). A
 * `regex:` prefix switches to a full regular expression, and a pattern may
 * start with `.` as shorthand for "this domain and its subdomains".
 */

export interface CompiledPattern {
  readonly source: string;
  readonly test: (value: string) => boolean;
}

export interface CompiledMatch {
  /** From `http.url`. Absent means the item describes every request. */
  readonly url?: CompiledPattern;
  /** From `http.method`. */
  readonly method?: string;
  /** From `info.tags`. */
  readonly resourceTypes?: ReadonlySet<string>;
}

export interface MatchTarget {
  readonly host: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
}

const REGEX_ESCAPE = /[.+?^${}()|[\]\\]/gu;

export class PatternError extends Error {}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEX_ESCAPE, String.raw`\$&`).replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'iu');
}

/** Compiles one glob / regex / dotted-suffix pattern. Throws `PatternError` on bad input. */
export function compilePattern(raw: string, kind: 'host' | 'url'): CompiledPattern {
  const source = raw.trim();
  if (source === '') {
    throw new PatternError('Pattern must not be empty');
  }
  if (source.startsWith('regex:')) {
    const body = source.slice('regex:'.length);
    try {
      const expression = new RegExp(body, 'iu');
      return { source, test: (value) => expression.test(value) };
    } catch (cause) {
      throw new PatternError(`Invalid regular expression "${body}"`, { cause });
    }
  }
  if (kind === 'host' && source.startsWith('.') && !source.includes('*')) {
    const suffix = source.toLowerCase();
    const bare = suffix.slice(1);
    return {
      source,
      test: (value) => value.toLowerCase() === bare || value.toLowerCase().endsWith(suffix),
    };
  }
  const expression = globToRegExp(source);
  return { source, test: (value) => expression.test(value) };
}

/** True when `target` falls inside `rule`. An empty rule matches every request. */
export function matchesScope(rule: CompiledMatch, target: MatchTarget): boolean {
  // A pattern with no scheme is matched against the host as well as the URL, so
  // `*.api.example.com` keeps working without spelling out a full URL glob.
  if (rule.url !== undefined && !(rule.url.test(target.url) || rule.url.test(target.host))) {
    return false;
  }
  if (rule.method !== undefined && rule.method !== target.method.toUpperCase()) {
    return false;
  }
  if (
    rule.resourceTypes !== undefined &&
    rule.resourceTypes.size > 0 &&
    !rule.resourceTypes.has(target.resourceType.toLowerCase())
  ) {
    return false;
  }
  return true;
}
