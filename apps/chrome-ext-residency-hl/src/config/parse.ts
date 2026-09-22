/**
 * Turns a policy document into the compiled config the engine runs.
 *
 * Input is user-authored and therefore untrusted: every field is checked before
 * use, unknown keys are reported as warnings, and nothing is executed. A failed
 * parse never replaces the config that is already in effect.
 */

import { parse as parseYaml } from 'yaml';
import { errorMessage } from '../shared/logger.ts';
import { parseAssertionList, parseScriptList } from './assertions.ts';
import {
  asStringList,
  Collector,
  isRecord,
  KNOWN_FOLDER_KEYS,
  KNOWN_HTTP_KEYS,
  KNOWN_INFO_KEYS,
  KNOWN_ITEM_INFO_KEYS,
  KNOWN_REQUEST_KEYS,
  KNOWN_ROOT_KEYS,
  KNOWN_RUNTIME_KEYS,
  type RawRecord,
  readDescription,
  warnUnknownKeys,
} from './collect.ts';
import { type CompiledMatch, type CompiledPattern, compilePattern, PatternError } from './match.ts';
import {
  type AssertionGroup,
  DEFAULT_SETTINGS,
  type Grouping,
  type ParseOutcome,
  type Settings,
} from './schema.ts';

function parseItemScope(entry: RawRecord, path: string, into: Collector): CompiledMatch {
  const info = isRecord(entry['info']) ? entry['info'] : {};
  const http = isRecord(entry['http']) ? entry['http'] : {};
  warnUnknownKeys(info, KNOWN_ITEM_INFO_KEYS, `${path}.info`, into);
  warnUnknownKeys(http, KNOWN_HTTP_KEYS, `${path}.http`, into);

  const scope: {
    url?: CompiledPattern;
    method?: string;
    resourceTypes?: ReadonlySet<string>;
  } = {};

  const url = http['url'];
  if (typeof url === 'string' && url.trim() !== '' && url.trim() !== '*') {
    try {
      scope.url = compilePattern(url.trim(), 'url');
    } catch (cause) {
      const detail = cause instanceof PatternError ? cause.message : errorMessage(cause);
      into.error(`${path}.http.url`, detail);
    }
  } else if (url !== undefined && typeof url !== 'string') {
    into.error(`${path}.http.url`, 'must be a string');
  }

  const method = http['method'];
  if (typeof method === 'string' && method.trim() !== '') {
    scope.method = method.trim().toUpperCase();
  }

  const tags = asStringList(info['tags']).map((tag) => tag.toLowerCase());
  if (tags.length > 0) {
    scope.resourceTypes = new Set(tags);
  }
  return scope;
}

/** The display name of one item, prefixed by the folder path it sits under. */
function itemName(info: RawRecord, parentName: string, index: number): string {
  const own =
    typeof info['name'] === 'string' && info['name'].trim() !== ''
      ? info['name'].trim()
      : `item-${String(index)}`;
  return parentName === '' ? own : `${parentName} / ${own}`;
}

/** A folder groups items and carries nothing else the policy reads. */
function isFolder(entry: RawRecord, info: RawRecord): boolean {
  return info['type'] === 'folder' || (entry['http'] === undefined && entry['items'] !== undefined);
}

/**
 * Reads one request item into a group, or `null` when it asserts nothing.
 *
 * An item with neither assertions nor scripts still scopes nothing and judges
 * nothing, so it is dropped rather than carried as an empty group.
 */
function parseRequestItem(
  entry: RawRecord,
  info: RawRecord,
  name: string,
  path: string,
  into: Collector,
): AssertionGroup | null {
  warnUnknownKeys(entry, KNOWN_REQUEST_KEYS, path, into);
  const runtime = isRecord(entry['runtime']) ? entry['runtime'] : {};
  if (entry['runtime'] !== undefined && !isRecord(entry['runtime'])) {
    into.error(`${path}.runtime`, 'must be a mapping');
  }
  warnUnknownKeys(runtime, KNOWN_RUNTIME_KEYS, `${path}.runtime`, into);

  const assertions = parseAssertionList(runtime['assertions'], `${path}.runtime.assertions`, into);
  const scripts = parseScriptList(runtime['scripts'], `${path}.runtime.scripts`, into);
  if (assertions.length === 0 && scripts.length === 0) {
    return null;
  }
  const description = readDescription(info['description']);
  return {
    name,
    ...(description === undefined ? {} : { description }),
    scope: [parseItemScope(entry, path, into)],
    assertions,
    scripts,
  };
}

/**
 * Walks `items`, collecting every request item as a group.
 *
 * A `Folder` item carries no `runtime` in the schema, so it only nests — its
 * own items are walked, and its name prefixes theirs.
 */
function parseItems(
  raw: unknown,
  parentName: string,
  path: string,
  into: Collector,
): readonly AssertionGroup[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    into.error(path, 'must be a list of items');
    return [];
  }
  const groups: AssertionGroup[] = [];
  for (const [index, entry] of raw.entries()) {
    const entryPath = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      into.error(entryPath, 'must be a mapping');
      continue;
    }
    const info = isRecord(entry['info']) ? entry['info'] : {};
    const name = itemName(info, parentName, index);

    if (isFolder(entry, info)) {
      warnUnknownKeys(entry, KNOWN_FOLDER_KEYS, entryPath, into);
      groups.push(...parseItems(entry['items'], name, `${entryPath}.items`, into));
      continue;
    }

    const group = parseRequestItem(entry, info, name, entryPath, into);
    if (group !== null) {
      groups.push(group);
    }
    groups.push(...parseItems(entry['items'], name, `${entryPath}.items`, into));
  }
  return groups;
}

/**
 * Reads the extension's own settings from `extensions.residency`.
 *
 * `extensions` is the schema's own escape hatch — "a free-form object that
 * allows implementers to extend the spec" — so this is the one place a field
 * OpenCollection does not define is allowed to live.
 */
function parseSettings(rootExtensions: unknown, into: Collector): Settings {
  const extensions = isRecord(rootExtensions) ? rootExtensions : {};
  const raw = extensions['residency'];
  if (raw === undefined || raw === null) {
    return DEFAULT_SETTINGS;
  }
  if (!isRecord(raw)) {
    into.error('extensions.residency', 'must be a mapping');
    return DEFAULT_SETTINGS;
  }
  const grouping = raw['grouping'];
  const resolvedGrouping: Grouping = grouping === 'domain' ? 'domain' : 'host';
  if (grouping !== undefined && grouping !== 'host' && grouping !== 'domain') {
    into.warn(
      'extensions.residency.grouping',
      `expected "host" or "domain", got "${String(grouping)}"`,
    );
  }
  const bool = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value !== 'boolean') {
      into.warn(`extensions.residency.${key}`, `expected a boolean, got "${String(value)}"`);
      return fallback;
    }
    return value;
  };
  return {
    grouping: resolvedGrouping,
    clearOnNavigate: bool('clearOnNavigate', DEFAULT_SETTINGS.clearOnNavigate),
    recordUnscoped: bool('recordUnscoped', DEFAULT_SETTINGS.recordUnscoped),
    recordByDefault: bool('recordByDefault', DEFAULT_SETTINGS.recordByDefault),
    debug: bool('debug', DEFAULT_SETTINGS.debug),
  };
}

/** A document that could not be read at all: one problem, no config. */
function fatal(message: string): ParseOutcome {
  return {
    config: null,
    errors: [message],
    warnings: [],
    problems: [{ path: 'root', message, severity: 'error' }],
  };
}

/**
 * Parses the YAML and checks it is a mapping, or says why it is not.
 *
 * Tagged rather than returning `RawRecord | ParseOutcome`: a policy is free to
 * have a top-level `problems` key, so sniffing the shape would misread that
 * document as a failure.
 */
type DocumentRead =
  | { readonly ok: true; readonly document: RawRecord }
  | { readonly ok: false; readonly outcome: ParseOutcome };

function readDocument(text: string): DocumentRead {
  let document: unknown;
  try {
    document = parseYaml(text, { prettyErrors: true });
  } catch (cause) {
    return { ok: false, outcome: fatal(`YAML syntax error — ${errorMessage(cause)}`) };
  }
  if (document === null || document === undefined) {
    return { ok: false, outcome: fatal('Config is empty') };
  }
  if (!isRecord(document)) {
    return { ok: false, outcome: fatal('Config root must be a mapping') };
  }
  return { ok: true, document };
}

/** Parses and validates a residency policy document. */
export function parseConfig(text: string): ParseOutcome {
  const read = readDocument(text);
  if (!read.ok) {
    return read.outcome;
  }
  const { document } = read;

  const into = new Collector();
  warnUnknownKeys(document, KNOWN_ROOT_KEYS, 'root', into);

  const info = isRecord(document['info']) ? document['info'] : {};
  if (document['info'] !== undefined && !isRecord(document['info'])) {
    into.error('info', 'must be a mapping');
  }
  warnUnknownKeys(info, KNOWN_INFO_KEYS, 'info', into);

  const settings = parseSettings(document['extensions'], into);
  const groups = parseItems(document['items'], '', 'items', into);

  if (into.errors.length > 0) {
    return { config: null, errors: into.errors, warnings: into.warnings, problems: into.problems };
  }
  if (groups.length === 0) {
    into.warn(
      'root',
      'no enabled assertions were found; every request will be reported as "not applicable"',
    );
  }

  const name =
    typeof info['name'] === 'string' && info['name'].trim() !== ''
      ? info['name'].trim()
      : 'Untitled policy';

  return {
    config: { name, settings, groups, text },
    errors: [],
    warnings: into.warnings,
    problems: into.problems,
  };
}
