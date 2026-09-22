/** MV3 manifest. Paths are source paths; the build rewrites them to emitted assets. */

import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

const ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'Residency Auditor',
  version: pkg.version,
  description:
    'Audits every network request a tab makes against an OpenCollection runtime-assertions policy and reports per-domain compliance.',
  minimum_chrome_version: '111',
  icons: ICONS,
  /*
   * Capture happens through `chrome.devtools.network`, which is scoped to the
   * inspected tab and needs no permission at all. That leaves only the policy
   * and the session's records to store — so the extension asks for nothing
   * that would raise an install warning.
   */
  permissions: ['storage'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  action: { default_popup: 'popup.html', default_title: 'Residency Auditor', default_icon: ICONS },
  options_ui: { page: 'options.html', open_in_tab: true },
  devtools_page: 'devtools.html',
  /*
   * `runtime.scripts` is user-authored JavaScript, and MV3 forbids `eval` in
   * extension pages. A sandboxed page is the supported exception: an opaque
   * origin with no `chrome` APIs, reachable only over postMessage.
   */
  sandbox: { pages: ['sandbox.html'] },
  content_security_policy: {
    /*
     * MV3's default for extension pages restricts scripts but leaves
     * `connect-src` wide open. These pages hold captured request headers —
     * `authorization` among them — so the one directive worth pinning down is
     * the one that could send them somewhere. Nothing here makes a network
     * request: there is no `fetch`, `XMLHttpRequest`, `WebSocket`,
     * `sendBeacon` or `EventSource` anywhere outside the sandbox, and the AI
     * assist runs on-device. `'unsafe-inline'` is kept for styles only, which
     * CSP scopes to style attributes — the waterfall bars and the skeletons
     * are positioned that way.
     */
    extension_pages: [
      "script-src 'self'",
      "object-src 'none'",
      "connect-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "frame-src 'self'",
      "child-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; '),
    /*
     * `default-src 'none'` is the load-bearing part. A policy is a file people
     * share, and a test script legitimately reads request headers — including
     * `authorization`. Without an explicit deny, every directive the sandbox
     * CSP omits falls back to allowed, and `fetch(url, { mode: 'no-cors' })`
     * would be enough to send a captured token anywhere. The runner needs
     * nothing but its own inlined script, so it is granted nothing else.
     */
    sandbox: [
      'sandbox allow-scripts',
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'none'",
      "img-src 'none'",
      "style-src 'none'",
      "child-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; '),
  },
});
