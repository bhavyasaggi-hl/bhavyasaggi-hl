/**
 * Post-build validation of the bundle.
 *
 * Chrome only reports a broken unpacked extension at load time, so a missing
 * icon, a stale script reference, an inline script the MV3 CSP would block, or
 * a permission Chrome has retired all fail the build instead.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative } from 'node:path';

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/iu;
const SRC_OR_HREF = /(?:src|href)\s*=\s*"([^"]+)"/giu;
const EXTERNAL = /^(?:https?:|data:|#|mailto:)/iu;
const VERSION = /^\d+(\.\d+){0,3}$/u;

const RETIRED_PERMISSIONS = new Set(['aiLanguageModel', 'aiLanguageModelOriginTrial']);

/**
 * CSP directives the build refuses to ship without.
 *
 * Extension pages hold captured request headers, `authorization` among them,
 * and MV3's default leaves `connect-src` open. Nothing in this extension makes
 * a network request, so the deny is free — and a future import that quietly
 * added one should break the build rather than gain the ability to phone home.
 */
const REQUIRED_CSP: Readonly<Record<'extension_pages' | 'sandbox', readonly string[]>> = {
  extension_pages: ["connect-src 'none'", "object-src 'none'", "script-src 'self'"],
  sandbox: ["default-src 'none'", "connect-src 'none'"],
};

interface Manifest {
  readonly manifest_version?: number;
  readonly version?: string;
  readonly permissions?: readonly string[];
  readonly optional_permissions?: readonly string[];
  readonly icons?: Readonly<Record<string, string>>;
  readonly devtools_page?: string;
  readonly action?: {
    readonly default_popup?: string;
    readonly default_icon?: Readonly<Record<string, string>>;
  };
  readonly options_ui?: { readonly page?: string };
  readonly sandbox?: { readonly pages?: readonly string[] };
  readonly content_security_policy?: {
    readonly extension_pages?: string;
    readonly sandbox?: string;
  };
  readonly background?: { readonly service_worker?: string };
  readonly content_scripts?: readonly {
    readonly js?: readonly string[];
    readonly css?: readonly string[];
  }[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function manifestReferences(manifest: Manifest): readonly string[] {
  const refs = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    manifest.devtools_page,
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((script) => [
      ...(script.js ?? []),
      ...(script.css ?? []),
    ]),
  ].filter((entry): entry is string => entry !== undefined);
  return [...new Set(refs)];
}

async function htmlProblems(
  outDir: string,
  page: string,
  sandboxed: ReadonlySet<string>,
): Promise<readonly string[]> {
  const html = await readFile(join(outDir, page), 'utf8');
  // A sandboxed page has its own CSP and is the one place inline script is
  // allowed — it is also the only way to load code at an opaque origin, where a
  // module script's CORS fetch would fail.
  const problems =
    INLINE_SCRIPT.test(html) && !sandboxed.has(page)
      ? [`${page}: contains an inline <script>, which the MV3 content security policy blocks`]
      : [];
  const references = [...html.matchAll(SRC_OR_HREF)]
    .map(([, reference]) => reference)
    .filter(
      (reference): reference is string => reference !== undefined && !EXTERNAL.test(reference),
    );
  const missing = await Promise.all(
    references.map(async (reference) => {
      const resolved = normalize(join(dirname(join(outDir, page)), reference));
      return (await exists(resolved)) ? null : `${page}: references missing file "${reference}"`;
    }),
  );
  return [...problems, ...missing.filter((entry): entry is string => entry !== null)];
}

/** Every page in the bundle, including ones registered from JavaScript. */
async function allPages(outDir: string): Promise<readonly string[]> {
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
  return (
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
      // `name` is a basename; the path has to be rebuilt for pages in subfolders.
      .map((entry) => relative(outDir, join(entry.parentPath, entry.name)))
  );
}

export interface ValidationSummary {
  readonly pages: number;
  readonly references: number;
}

/** Reports any required CSP directive the manifest has lost. */
function cspProblems(manifest: Manifest): string[] {
  const problems: string[] = [];
  for (const [key, directives] of Object.entries(REQUIRED_CSP)) {
    const policy = manifest.content_security_policy?.[key as keyof typeof REQUIRED_CSP] ?? '';
    for (const directive of directives) {
      if (!policy.includes(directive)) {
        problems.push(`content_security_policy.${key} must contain "${directive}"`);
      }
    }
  }
  return problems;
}

/** Throws when `outDir` is not a loadable unpacked extension. */
export async function validateDist(outDir: string): Promise<ValidationSummary> {
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
  const problems: string[] = [];

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version must be 3, found ${String(manifest.manifest_version)}`);
  }
  if (!VERSION.test(String(manifest.version))) {
    problems.push(`version "${String(manifest.version)}" is not a valid extension version`);
  }
  for (const permission of [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ]) {
    if (RETIRED_PERMISSIONS.has(permission)) {
      problems.push(`permission "${permission}" has been retired and Chrome rejects it`);
    }
  }

  problems.push(...cspProblems(manifest));

  const references = manifestReferences(manifest);
  const missing = await Promise.all(
    references.map(async (reference) =>
      (await exists(join(outDir, reference)))
        ? null
        : `manifest references missing file "${reference}"`,
    ),
  );
  problems.push(...missing.filter((entry): entry is string => entry !== null));

  const pages = await allPages(outDir);
  const sandboxed = new Set(manifest.sandbox?.pages ?? []);
  const pageProblems = await Promise.all(
    pages.map(async (page) => htmlProblems(outDir, page, sandboxed)),
  );
  problems.push(...pageProblems.flat());

  if (problems.length > 0) {
    throw new Error(`Invalid build output:\n  - ${problems.join('\n  - ')}`);
  }
  return { pages: pages.length, references: references.length };
}
