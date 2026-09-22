/**
 * One-time upgrade of a policy written before the document became a strict
 * subset of the OpenCollection schema.
 *
 * This is deliberately not part of parsing. The accepted format stays strict —
 * a field the schema does not define is an unknown key, always — and this
 * rewrites what is already stored, once, so nobody loses a policy to a format
 * change they did not ask for. The result is saved back, so it runs exactly
 * once per policy.
 *
 * What moves where:
 *
 * | Old | New |
 * | --- | --- |
 * | `name`, `version` | `info.name`, `info.version` |
 * | root `runtime` | an item scoped to `*` |
 * | `folders[].match.hosts` / `.urls` | `items[].http.url` |
 * | `match.methods` | `items[].http.method` |
 * | `match.resourceTypes` | `items[].info.tags` |
 * | `settings` | `extensions.residency` |
 *
 * Anything with no home says so rather than vanishing: the notes come back with
 * the migrated text and are shown to the user.
 */

import { parse as parseYaml, stringify } from 'yaml';

export interface Migration {
  readonly text: string;
  /** What could not be carried across, in the user's words rather than paths. */
  readonly notes: readonly string[];
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** True when the document is in the pre-subset shape and has something to move. */
function isLegacy(document: unknown): boolean {
  if (!isRecord(document)) {
    return false;
  }
  if (document['items'] !== undefined || document['info'] !== undefined) {
    return false;
  }
  return ['name', 'version', 'settings', 'runtime', 'folders', 'groups', 'ignore', 'ipRanges'].some(
    (key) => document[key] !== undefined,
  );
}

/**
 * Turns several host or URL patterns into the one `http.url` an item has.
 *
 * A single pattern carries across as-is. Several become a `regex:` alternation,
 * because the schema gives an item one url and losing the rest would silently
 * widen the policy.
 */
function toUrlPattern(match: Raw, notes: string[], where: string): string | undefined {
  const hosts = asList(match['hosts']);
  const urls = asList(match['urls']);
  const patterns = [...hosts, ...urls];
  if (patterns.length === 0) {
    return undefined;
  }
  if (patterns.length === 1) {
    return patterns[0];
  }
  const alternation = patterns
    .map((pattern) => pattern.replace(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll('*', '.*'))
    .join('|');
  notes.push(`${where}: ${String(patterns.length)} patterns became one regex.`);
  return `regex:^(?:${alternation})$`;
}

function migrateAssertion(raw: unknown): Raw | null {
  if (!isRecord(raw)) {
    return null;
  }
  const expression = raw['expression'] ?? raw['expr'];
  const operator = raw['operator'] ?? raw['op'];
  if (typeof expression !== 'string' || typeof operator !== 'string') {
    return null;
  }
  const out: Raw = { expression, operator };

  const value = raw['value'] ?? raw['expected'];
  if (Array.isArray(value)) {
    out['value'] = value.map((entry) => String(entry)).join(', ');
  } else if (value !== undefined && value !== null) {
    out['value'] = String(value);
  }

  // `name` was the label; `description` is the schema's field for one.
  const description = raw['description'] ?? raw['name'];
  if (typeof description === 'string' && description.trim() !== '') {
    out['description'] = description.trim();
  }
  if (raw['disabled'] === true || raw['enabled'] === false) {
    out['disabled'] = true;
  }
  return out;
}

function migrateScripts(raw: unknown): Raw[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const scripts: Raw[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || entry['enabled'] === false) {
      continue;
    }
    const code = entry['code'] ?? entry['script'];
    if (typeof entry['type'] === 'string' && typeof code === 'string') {
      scripts.push({ type: entry['type'], code });
    }
  }
  return scripts;
}

function runtimeOf(container: Raw): { assertions: Raw[]; scripts: Raw[] } {
  const runtime = isRecord(container['runtime']) ? container['runtime'] : {};
  const rawAssertions = runtime['assertions'] ?? container['assertions'];
  const assertions = Array.isArray(rawAssertions)
    ? rawAssertions.map(migrateAssertion).filter((entry): entry is Raw => entry !== null)
    : [];
  return { assertions, scripts: migrateScripts(runtime['scripts'] ?? container['scripts']) };
}

function itemFor(name: string, folder: Raw, notes: string[]): Raw | null {
  const { assertions, scripts } = runtimeOf(folder);
  if (assertions.length === 0 && scripts.length === 0) {
    return null;
  }
  const match = isRecord(folder['match']) ? folder['match'] : {};
  const info: Raw = { name, type: 'http' };
  if (typeof folder['description'] === 'string') {
    info['description'] = folder['description'];
  }
  const tags = asList(match['resourceTypes']);
  if (tags.length > 0) {
    info['tags'] = tags;
  }

  const http: Raw = { url: toUrlPattern(match, notes, name) ?? '*' };
  const methods = asList(match['methods']);
  if (methods.length === 1) {
    http['method'] = methods[0];
  } else if (methods.length > 1) {
    notes.push(`${name}: an item takes one method, so ${methods.join('/')} was dropped.`);
  }
  if (asList(match['excludeHosts']).length > 0 || asList(match['excludeUrls']).length > 0) {
    notes.push(`${name}: exclusions were dropped — use a regex: url with a negative lookahead.`);
  }

  const runtime: Raw = {};
  if (assertions.length > 0) {
    runtime['assertions'] = assertions;
  }
  if (scripts.length > 0) {
    runtime['scripts'] = scripts;
  }
  return { info, http, runtime };
}

/** The old format's folder name, prefixed by the path it sits under. */
function folderName(entry: Raw, parentName: string, index: number): string {
  const own =
    typeof entry['name'] === 'string' && entry['name'].trim() !== ''
      ? entry['name'].trim()
      : `item-${String(index)}`;
  return parentName === '' ? own : `${parentName} / ${own}`;
}

/**
 * Walks a folder's children. The old format let a folder's `match` cover
 * everything inside it; the schema gives a folder no scope at all, so that
 * inheritance is lost and the caller is told.
 */
function nestedOf(entry: Raw, name: string, notes: string[]): Raw[] {
  const nested = entry['folders'] ?? entry['groups'];
  if (nested === undefined) {
    return [];
  }
  if (isRecord(entry['match'])) {
    notes.push(`${name}: nested items no longer inherit its scope; each carries its own url.`);
  }
  return walkFolders(nested, name, notes);
}

function walkFolders(raw: unknown, parentName: string, notes: string[]): Raw[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: Raw[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = folderName(entry, parentName, index);
    const item = itemFor(name, entry, notes);
    if (item !== null) {
      items.push(item);
    }
    items.push(...nestedOf(entry, name, notes));
  }
  return items;
}

const SETTING_KEYS = ['grouping', 'clearOnNavigate', 'recordUnscoped', 'recordByDefault', 'debug'];

/**
 * The old format's top-level `runtime` applied to everything, which the schema
 * expresses as one item scoped to `*`.
 */
function globalItemFor(document: Raw): Raw | null {
  const global = runtimeOf(document);
  if (global.assertions.length === 0 && global.scripts.length === 0) {
    return null;
  }
  const runtime: Raw = {};
  if (global.assertions.length > 0) {
    runtime['assertions'] = global.assertions;
  }
  if (global.scripts.length > 0) {
    runtime['scripts'] = global.scripts;
  }
  return { info: { name: 'Every request', type: 'http' }, http: { url: '*' }, runtime };
}

/** Everything the old format could say that the schema has nowhere to put. */
function droppedFieldNotes(document: Raw, settings: Raw): string[] {
  const notes: string[] = [];
  if (settings['mergePreflights'] !== undefined) {
    notes.push(
      '`mergePreflights` was dropped: CORS preflights are now listed as their own rows and shown or hidden with the toolbar checkbox.',
    );
  }
  if (document['ignore'] !== undefined) {
    notes.push('`ignore` was dropped: the schema has no field for it.');
  }
  if (document['ipRanges'] !== undefined) {
    notes.push('`ipRanges` was dropped; inCidr now takes the ranges directly.');
  }
  if (Object.keys(settings).some((key) => !SETTING_KEYS.includes(key))) {
    notes.push('Unrecognised settings were dropped.');
  }
  return notes;
}

/**
 * Rewrites a pre-subset policy onto the schema's shape.
 *
 * Returns `null` when the document is already in the current shape, or is not
 * something this can safely rewrite.
 */
export function migrateLegacy(text: string): Migration | null {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    // Unparseable text is the editor's problem to report, not this one's.
    return null;
  }
  if (!(isLegacy(document) && isRecord(document))) {
    return null;
  }

  const notes: string[] = [];
  const out: Raw = { opencollection: '1.0.0' };

  const info: Raw = {
    name: typeof document['name'] === 'string' ? document['name'] : 'Migrated policy',
  };
  if (document['version'] !== undefined) {
    info['version'] = String(document['version']);
  }
  out['info'] = info;

  const items: Raw[] = [];
  const globalItem = globalItemFor(document);
  if (globalItem !== null) {
    items.push(globalItem);
  }
  items.push(...walkFolders(document['folders'] ?? document['groups'], '', notes));
  out['items'] = items;

  const settings = isRecord(document['settings']) ? document['settings'] : {};
  const carried: Raw = {};
  for (const key of SETTING_KEYS) {
    if (settings[key] !== undefined) {
      carried[key] = settings[key];
    }
  }
  if (Object.keys(carried).length > 0) {
    out['extensions'] = { residency: carried };
  }

  notes.push(...droppedFieldNotes(document, settings));

  const header = '# Migrated to the OpenCollection document shape. Review before relying on it.\n';
  return { text: header + stringify(out, { lineWidth: 0 }), notes };
}
