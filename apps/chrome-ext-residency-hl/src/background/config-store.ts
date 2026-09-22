/**
 * Holds the active residency policy.
 *
 * The user's YAML lives in `chrome.storage.local`. A document that fails to
 * parse is reported back to the options page but never installed, so the worker
 * always has a usable policy in memory.
 */

import { DEFAULT_CONFIG_YAML } from '../config/default-config.ts';
import { migrateLegacy } from '../config/migrate.ts';
import { parseConfig } from '../config/parse.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import { indexPolicy } from '../engine/evaluate.ts';
import { CONFIG_TEXT_KEY } from '../shared/constants.ts';
import { errorMessage, logger, setDebugLogging } from '../shared/logger.ts';
import type { ConfigStatus, PolicyIndex } from '../shared/types.ts';

type Listener = (config: ResolvedConfig) => void;

let revision = 0;

/**
 * Notes from a migration that ran this session, shown once on the options page.
 *
 * Declared before `status`, which is built at module load and reads it.
 */
let migrationNotes: readonly string[] = [];

let active: ResolvedConfig = buildFallback();
let status: ConfigStatus = statusFor(active, [], []);
const listeners = new Set<Listener>();

function statusFor(
  config: ResolvedConfig,
  errors: readonly string[],
  warnings: readonly string[],
): ConfigStatus {
  return {
    revision: config.revision,
    valid: errors.length === 0,
    source: config.source,
    name: config.name,
    groupCount: config.groups.length,
    assertionCount: config.groups.reduce((sum, group) => sum + group.assertions.length, 0),
    needsBodies: config.groups.some((group) =>
      group.assertions.some((assertion) => /^(?:res|req)\.body/u.test(assertion.expression)),
    ),
    errors,
    warnings,
    migrationNotes,
    updatedAt: config.loadedAt,
  };
}

function buildFallback(): ResolvedConfig {
  const outcome = parseConfig(DEFAULT_CONFIG_YAML);
  revision += 1;
  if (outcome.config === null) {
    // Unreachable in a shipped build; keeps the worker alive if the default is edited badly.
    logger.error('bundled default config failed to parse', outcome.errors);
    return {
      revision,
      name: 'Invalid default policy',
      settings: {
        grouping: 'host',
        clearOnNavigate: true,
        recordUnscoped: true,
        recordByDefault: false,
        debug: false,
      },
      groups: [],
      source: 'default',
      text: DEFAULT_CONFIG_YAML,
      loadedAt: Date.now(),
    };
  }
  return { ...outcome.config, revision, source: 'default', loadedAt: Date.now() };
}

function install(
  config: ResolvedConfig,
  errors: readonly string[],
  warnings: readonly string[],
): void {
  active = config;
  policyIndex = indexPolicy(config);
  status = statusFor(config, errors, warnings);
  setDebugLogging(config.settings.debug);
  for (const listener of listeners) {
    listener(config);
  }
}

function apply(
  text: string,
  source: 'user' | 'default',
): { readonly errors: readonly string[]; readonly warnings: readonly string[] } {
  const outcome = parseConfig(text);
  if (outcome.config === null) {
    status = { ...status, valid: false, errors: outcome.errors, warnings: outcome.warnings };
    return { errors: outcome.errors, warnings: outcome.warnings };
  }
  revision += 1;
  install({ ...outcome.config, revision, source, loadedAt: Date.now() }, [], outcome.warnings);
  return { errors: [], warnings: outcome.warnings };
}

/**
 * Reads the stored policy once at worker start-up.
 *
 * A policy written before the document became a subset of the OpenCollection
 * schema is rewritten here and saved back, so the upgrade happens once and
 * nobody loses a policy to a format change. Parsing itself stays strict.
 */
export async function initConfig(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(CONFIG_TEXT_KEY);
    const text = stored[CONFIG_TEXT_KEY];
    if (typeof text === 'string' && text.trim() !== '') {
      const migration = migrateLegacy(text);
      if (migration !== null) {
        migrationNotes = migration.notes;
        logger.info('policy migrated to the OpenCollection document shape', migration.notes);
        const { errors } = apply(migration.text, 'user');
        if (errors.length > 0) {
          // The rewrite produced something this cannot load; keep the original
          // so the user still has it to fix by hand.
          logger.error('migrated policy did not parse; keeping the stored one', errors);
          migrationNotes = [];
          apply(text, 'user');
          return;
        }
        await chrome.storage.local.set({ [CONFIG_TEXT_KEY]: migration.text });
        return;
      }
      const { errors } = apply(text, 'user');
      if (errors.length > 0) {
        logger.warn('stored config is invalid; keeping the bundled default', errors);
      }
      return;
    }
  } catch (cause) {
    logger.error('failed to read the stored config', errorMessage(cause));
  }
  install(buildFallback(), [], []);
}

export function getConfig(): ResolvedConfig {
  return active;
}

/**
 * Assertion definitions by id, rebuilt only when the policy changes.
 *
 * The panel joins these against each record's outcomes, so the wording of an
 * assertion is held once per policy instead of once per request.
 */
let policyIndex: PolicyIndex = {};

/** The current policy's assertion definitions, for joining outcomes to names. */
export function getPolicyIndex(): PolicyIndex {
  return policyIndex;
}

/** Display name for one assertion id; falls back to the id when it is gone. */
export function assertionName(id: string): string {
  const definition = policyIndex[id];
  return definition === undefined ? id : definition.name;
}

export function getConfigStatus(): ConfigStatus {
  return status;
}

export function getConfigText(): string {
  return active.source === 'user' ? active.text : DEFAULT_CONFIG_YAML;
}

/** Validates and persists a new policy. Invalid input leaves the active policy untouched. */
export async function setConfigText(text: string): Promise<ConfigStatus> {
  // The user has seen the migrated document and acted on it; the notice has
  // done its job.
  migrationNotes = [];
  const { errors } = apply(text, 'user');
  if (errors.length === 0) {
    await chrome.storage.local.set({ [CONFIG_TEXT_KEY]: text });
  }
  return status;
}

/** Restores the bundled starter policy. */
export async function resetConfig(): Promise<ConfigStatus> {
  migrationNotes = [];
  await chrome.storage.local.remove(CONFIG_TEXT_KEY);
  install(buildFallback(), [], []);
  return status;
}

export function onConfigChange(listener: Listener): void {
  listeners.add(listener);
}
