/**
 * Runs axe-core against every UI page, in both colour schemes.
 *
 * Chrome 153 no longer honours `--load-extension` from the command line, so the
 * pages are audited from the offline preview instead: `dist/` re-bundled as
 * plain pages with a stubbed `chrome`. The options page is also audited with the
 * on-device model removed, because that is the only way to reach the disabled
 * states — a dimmed control that no longer meets contrast is invisible to an
 * audit that never disables anything.
 *
 * Needs a local Chrome. Override the binary with `CHROME_BIN` if it is not in
 * the usual place.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const preview = join(here, '..', '..', 'build', 'preview');

const CANDIDATES = [
  process.env['CHROME_BIN'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((path) => typeof path === 'string' && path !== '');

const chrome = CANDIDATES.find((path) => existsSync(path));
if (chrome === undefined) {
  console.error('No Chrome found. Set CHROME_BIN to its path.');
  process.exit(2);
}

if (!existsSync(join(preview, 'popup-axe.html'))) {
  console.error('No preview to audit. Run `yarn preview` first (it needs axe-core installed).');
  process.exit(2);
}

/** The options page with the Prompt API removed, so disabled controls render. */
const noAiPage = join(preview, 'options-noai.html');
const source = readFileSync(join(preview, 'options-axe.html'), 'utf8');
const stubTag = '<script src="stub.js"></script>';
writeFileSync(
  noAiPage,
  source.replace(stubTag, `${stubTag}<script>delete globalThis.LanguageModel;</script>`),
);

/** A page that crashed or fell back to an error banner has nothing to audit. */
const PAGES = [
  { file: 'popup-axe.html', expect: 'Pass rate' },
  { file: 'panel-axe.html', expect: 'Preserve log' },
  { file: 'options-axe.html', expect: 'Policy document' },
  { file: 'options-noai.html', expect: 'Policy document' },
];
const SCHEMES = ['light', 'dark'];

async function audit({ file: page, expect }, scheme) {
  const { stdout } = await run(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--force-prefers-color-scheme=${scheme}`,
      '--virtual-time-budget=6000',
      '--dump-dom',
      `file://${join(preview, page)}`,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const title = /<title>(.*?)<\/title>/s.exec(stdout)?.[1] ?? '';
  if (title.startsWith('ERROR')) {
    return { page, scheme, violations: [{ id: 'page-threw', help: title }] };
  }
  if (!stdout.includes(expect)) {
    return {
      page,
      scheme,
      violations: [{ id: 'page-did-not-render', help: `expected to find "${expect}"` }],
    };
  }
  const found = /id="axe-out">AXE_RESULT:(.*?)<\/pre>/s.exec(stdout);
  if (found === null) {
    return { page, scheme, violations: [{ id: 'no-result', help: 'axe did not report' }] };
  }
  const decoded = found[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  return { page, scheme, violations: JSON.parse(decoded) };
}

let failed = 0;
for (const scheme of SCHEMES) {
  for (const page of PAGES) {
    const result = await audit(page, scheme);
    const label = `${scheme.padEnd(5)} ${page.file.replace('.html', '').padEnd(14)}`;
    if (result.violations.length === 0) {
      console.log(`ok   ${label}`);
      continue;
    }
    failed += result.violations.length;
    console.log(`FAIL ${label}`);
    for (const violation of result.violations) {
      console.log(`       ${violation.id} — ${violation.help}`);
      for (const node of violation.nodes ?? []) {
        console.log(`         ${typeof node === 'string' ? node : JSON.stringify(node)}`);
      }
    }
  }
}

console.log(failed === 0 ? '\nNO ACCESSIBILITY VIOLATIONS' : `\n${failed} VIOLATION(S)`);
process.exit(failed === 0 ? 0 : 1);
