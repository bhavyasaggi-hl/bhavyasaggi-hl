# Residency Auditor

A Manifest V3 Chrome extension that records every network request a tab makes,
evaluates each one against a policy written in the OpenCollection YAML
[runtime-assertions](https://docs.usebruno.com/opencollection-yaml/structure-reference#runtime-assertions)
dialect, and reports how much of the traffic to each domain satisfies it.

- **DevTools panel** — the Network panel, with residency verdicts.
- **Popup** — pass rate per domain for the active tab.
- **Options** — the policy: an editor that lints it, and an on-device AI that drafts it.

## Quick start

```bash
yarn install
yarn workspace chrome-ext-residency-hl build
```

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `dist/`.
2. Open the options page and point an item's `http.url` at a host you can reload.
3. Open DevTools on that page, pick the **Residency** panel, and press **Record**.
4. Reload. Rows appear with a verdict; click one to see which assertion failed and why.

**Nothing is recorded until you ask.** A tab is audited only after you press
Record — in the panel or in the popup — and stays audited until you stop it or
close it. A new tab starts off again. Capture runs through the DevTools panel,
so it also stops when you close DevTools.

Needs Chrome 111+. `yarn workspace chrome-ext-residency-hl dev` rebuilds on
change; reload the extension to pick up service-worker changes.

## Policy

A policy is a **strict subset of the [OpenCollection
schema](https://schema.opencollection.com/opencollection/v1.0.0.json)**: every
field is one the schema defines, and none is added. `yarn verify` validates the
shipped starter policy against the published schema on every run, so that claim
cannot quietly stop being true.

The trick is reading the spec for what it is. A collection describes requests;
this describes requests too — as patterns to match rather than calls to send. So
an item's `http.url` is the glob it covers, `http.method` narrows it to a verb,
and `info.tags` names the resource types. Its `runtime.assertions` and
`runtime.scripts` are the schema's own constructs, in the only place the schema
puts them.

```yaml
opencollection: '1.0.0'

info:
  name: EU residency
  version: '1'

items:
  - info:
      name: Every request
      type: http
    http:
      url: '*'                # a glob; '*' covers everything
    runtime:
      assertions:
        - description: Transport is encrypted
          expression: req.url
          operator: startsWith
          value: 'https://'

  - info:
      name: First-party API
      type: http
      tags: [fetch, xhr]      # resource types this item covers
    http:
      url: '*.api.example.com'
      method: GET             # optional
    runtime:
      assertions:
        - description: Served from an approved EU region
          expression: res.headers['x-data-region']
          operator: in
          value: 'eu-west-1, eu-central-1'   # a string; members comma separated

        - description: Fast enough
          expression: res.responseTime
          operator: lt
          value: '2000'
          disabled: true      # kept in the file, not applied

extensions:                   # the schema's own escape hatch
  residency:
    grouping: host            # 'host' or 'domain' (approximate eTLD+1)
    clearOnNavigate: true     # drop captures on top-level navigation
    recordUnscoped: true      # keep requests no item scopes
    recordByDefault: false    # record every tab on sight instead of on request
```

**An assertion takes exactly five keys** — `expression`, `operator`, `value`,
`description`, `disabled` — because that is what OpenCollection's `Assertion`
allows, and it is sealed with `additionalProperties: false`. A script takes
exactly `type` and `code`. Anything else is reported as an unknown key.

Settings live under `extensions`, which the schema defines as "a free-form
object that allows implementers to extend the spec" — the one place a field it
does not define is allowed to be.

**Upgrading an older policy.** A policy written before the document moved onto
the schema's shape is rewritten once, on load, and saved back — the accepted
format stays strict, but nobody loses a policy to a format change. The options
page says what was rewritten and what could not be carried across: `ignore` and
`ipRanges` have no home in the schema, several host patterns become one `regex:`
url, and exclusion lists have to be re-expressed as a negative lookahead. Review
it and save to keep it.

The extension ships a worked starter policy — **Restore starter policy** on the
options page brings it back at any time. Its source is
[`src/config/default-config.ts`](src/config/default-config.ts).

**Scoping.** An item covers the requests its `http.url` glob matches, narrowed
by `http.method` and by the resource types in `info.tags`. A pattern with no
scheme is matched against the host as well as the URL, so `*.api.example.com`
works without spelling out a full URL. A leading `.` means "this domain and its
subdomains", and `regex:<pattern>` switches to a regular expression — which is
also how you exclude, since the schema has nowhere to put an exclusion list. A
request is judged by the union of every item whose scope it falls inside.

A `Folder` item nests others and carries no `runtime` of its own, because the
schema gives it none; its name prefixes the items inside it.

**Verdicts.** `pass` (something applied and all of it passed) · `fail` ·
`not-applicable` (nothing scopes it) · `pending`. Pass rate is
`pass / (pass + fail)`, so unscoped third-party traffic cannot move the number.

There is no advisory tier. `Assertion` has no severity field, so an assertion
that fails is a failure — a check you want to watch without enforcing belongs
behind `disabled: true`, or in a script that reports it as its own test.

**Expressions** are property paths, not code. `req.method` `req.url` `req.host`
`req.domain` `req.path` `req.query['k']` `req.headers['x']` `req.body`
`req.type` · `res.status` `res.headers['x']` `res.body` `res.bodyText`
`res.ip` `res.protocol` `res.responseTime` `res.fromCache` `res.error`
Indexing (`res.body.items[0]`) and `.length` work; a missing path is
`undefined`; header lookups ignore case.

**Operators** are Bruno's set — `equals` `notEquals` `gt` `gte` `lt` `lte`
`contains` `notContains` `startsWith` `endsWith` `matches` `notMatches`
`isNull` `isUndefined` `isDefined` `isEmpty` `isNotEmpty` `isTruthy` `isFalsy`
`isNumber` `isString` `isBoolean` `isArray` `isJson` `in` `notIn` `between`
`length` — plus **`inCidr`** / **`notInCidr`**, which take CIDRs or bare
addresses (IPv4 or IPv6), comma separated. `eq`, `neq`, `>=` and
friends are accepted as aliases.

`matches` / `notMatches` patterns are screened when the policy loads and
rejected if they can backtrack catastrophically — a nested quantifier such as
`^(a+)+$` takes over a minute on forty characters, and a regex cannot be
interrupted once running. Invalid patterns are rejected there too, rather than
failing quietly on every request.

## Scripts

Assertions cover most policies. When a check needs logic, `runtime.scripts` runs
JavaScript instead:

```yaml
runtime:
  scripts:
    - type: tests
      code: |-
        test("every approved region is in the EU", function () {
          const region = res.headers['x-data-region'];
          expect(region).to.be.a('string');
          expect(region.startsWith('eu-')).to.equal(true);
        });
```

**Only `type: tests` is supported.** OpenCollection also defines
`before-request` and `after-response`; both are rejected at parse time with the
reason, rather than silently ignored. This audits requests a page already sent,
so there is no "before" to run in, and `after-response` exists to pass variables
to a later request in a sequence — which observed traffic has no notion of.

A script sees `req`, `res`, `test(name, fn)` and chai's `expect`. Nothing else
is in scope. A failing test fails the request; a script that throws outside a
test is reported as "script did not run" rather than vanishing.

### Where they run, and why it is not simple

MV3 forbids `eval` and `new Function` in every extension page, so a policy's
JavaScript cannot run in the service worker. The supported exception is the
`sandbox` manifest key: a page that loads at an opaque origin with no extension
APIs, reachable only by `postMessage`. That is where scripts run, and it is the
only place in this extension where `eval` is available at all.

A service worker cannot own a frame, so the DevTools page hosts it — the same
context that captured the request. The worker decides *what* runs (it knows
which groups scope a record), hands the scripts and the request back to the page
that captured them, and merges the outcomes when they land. Nothing is exposed
that was not already there.

The frame is created lazily, the first time a policy actually has scripts, so a
policy without them never loads chai. Chai adds **17 KB gzipped**, in a chunk no
other page pulls in. It is also what the OpenCollection spec names for `tests`,
so a script written for Bruno behaves the same here; `@jest/expect` was measured
as an alternative and does not bundle for a browser at all — it needs nine Node
builtins shimmed and is 4x the size.

### Keeping up with traffic

A script run costs about 7 µs once compiled, so throughput was never the
constraint. Two other things are:

| | |
| --- | --- |
| Round trips | records batch over 100 ms, up to 50 at a time; one batch is ever in the sandbox |
| Compilation | each script compiles once and is cached by its source, not per request |
| A wedged script | one deadline per batch, then the frame is discarded and the queue drains into a fresh one |
| A flood | the queue is bounded at 1000; past that the oldest are reported as **skipped**, never dropped |

That last one matters for an audit tool: a request the extension did not check
has to say so. Silently omitting what it could not keep up with would be worse
than admitting it. Measured, 200 records run in one batch in 1.4 ms — a whole
page load of scripts, well inside a frame.

A script that never returns is still the one failure the sandbox cannot
delegate: an opaque origin cannot spawn a Worker, so there is nothing to
`terminate()`. The batch times out after two seconds, its records are reported
as timed out, and the frame is replaced. While a script is wedged the DevTools
page is wedged with it — capture resumes when the frame is replaced.

### What a script cannot do

The sandbox CSP is `default-src 'none'`, and that is the load-bearing part. A
policy is a file people share, and a test script legitimately reads request
headers — including `authorization`. Every directive a CSP omits falls back to
*allowed*, so without an explicit deny `fetch(url, { mode: 'no-cors' })` would
be enough to send a captured token anywhere. Verified against a real Chrome with
that CSP applied: `eval` works, while `fetch`, an `<img>` beacon,
`navigator.sendBeacon` and a WebSocket are all refused with `connect-src` /
`img-src` violations.

The extension's **own** pages carry the same deny. MV3's default policy
restricts scripts but leaves `connect-src` wide open, and those pages hold
captured request headers too, so `extension_pages` pins it shut:

```
script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self' data:;
style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self';
child-src 'self'; form-action 'none'; base-uri 'none'
```

Nothing here makes a network request — there is no `fetch`, `XMLHttpRequest`,
`WebSocket`, `sendBeacon` or `EventSource` anywhere outside the sandbox, and AI
assist runs on-device — so the deny costs nothing and a future import that
quietly added one would fail rather than gain the ability to phone home. The
build refuses to package a manifest whose CSP is missing any of these directives.
Verified in a real Chrome: the sandbox frame still loads, and
`fetch('https://example.com', { mode: 'no-cors' })` from the options page is
refused with *"violates the following Content Security Policy directive:
connect-src 'none'"*.

## Editor

CodeMirror 6, wired to the extension's own validator rather than a generic YAML
schema check. `parseConfig` reports each problem with the document path that
produced it; the path resolves back to a source range through the YAML CST, so
an unknown operator underlines that operator.

- Errors and warnings in the gutter, the squiggle and the header count
- `Ctrl/Cmd+Space` completes operators, expression paths, enum values and keys
- **Format** re-indents through the CST, preserving comments
- `Ctrl/Cmd+F` search, folding, history, bracket matching

CodeMirror picks its light or dark base theme from a static flag, which cannot
follow `prefers-color-scheme`, so every surface it paints — panels, the search
field, buttons, tooltips, diagnostics — is restyled from the extension's own
tokens and matches the editor in both schemes.

CodeMirror rather than Monaco or Ace: no web workers to bundle under MV3, an
order of magnitude smaller, and `@codemirror/lint` takes our parser as its
diagnostic source directly.

## AI assist

Describe the rules and press **Draft policy**, or **Improve current** to revise
the editor's contents. Uses Chrome's built-in
[Prompt API](https://developer.chrome.com/docs/extensions/ai/prompt-api)
(Gemini Nano) — no manifest permission is required; the page feature-detects
`LanguageModel` and disables the card when it is absent. Requests declare
English input and output, which Chrome requires to attest output safety.

- **On device.** Nothing leaves the browser.
- **Constrained output.** The model answers a JSON schema whose operator list is
  generated from the engine's own operator table; the extension writes the YAML.
- **Validated, never auto-applied.** The draft is parsed and reported before
  "Use this draft" fills the editor. You still press Save.
- The existing policy is fenced as data when revising, so an instruction hidden
  in a comment cannot steer the model.

`downloadable` means the first draft fetches the model once (several GB);
`unavailable` means the device cannot run it. Everything else works without it.

## Capture

Requests are captured by the DevTools page through
[`chrome.devtools.network`](https://developer.chrome.com/docs/extensions/reference/api/devtools/network),
which is already scoped to the inspected tab and needs **no permission at all**.
That is why the extension asks only for `storage` and raises no install warning
despite reading every request a page makes.

| | |
| --- | --- |
| Metadata | method, URL, resource type, request and response headers, status, **remote IP**, timing, and `net::ERR_*` on failure |
| Payloads | any resource type, via `getContent()` — images included, not only fetch and XHR |
| Preflights | a first-class `preflight` resource type, so no sniffing of `access-control-allow-methods` |

`onRequestFinished` is a push event — nothing polls, and no HAR document is
ever serialized or parsed; the payload is a live object that happens to follow
the HAR entry shape. `getHAR()` is called once, on the transition into
recording. Mapping an entry to a record costs ~3 µs, and mapping plus judging
it ~8 µs, so a 500-request page spends under 4 ms in the extension. Records are
batched over 100 ms before crossing to the worker, because one message per
request was the only part of this path with a cost worth avoiding.

Payloads are fetched **only when the active policy asserts on one**
(`res.body`, `req.body`); most policies never do, and pulling a body moves it
across the DevTools bridge. `getContent()` returns nothing for a request that
failed and for a preflight, which has no body.

**Capture requires DevTools to be open on that tab**, and that is the whole
condition — capture is driven from the DevTools page, not the Residency panel,
so it does not wait for you to select the panel's tab.

No extension API can open DevTools, so the popup's Record button *arms* the tab
instead: the intent is stored immediately, the popup reports `armed` rather than
`recording`, and capture begins the moment DevTools attaches. Starting a
recording adopts whatever the Network panel already holds (`getHAR()`), so a
page loaded beforehand is not lost.

That snapshot is the only thing capture deduplicates against, and only until
its callback returns. DevTools gives an extension no request id, so the best
key available is start time, method and url — which five requests fired
together legitimately share. Treating that key as an identity meant the live
stream deduplicated against *itself* and reported one of the five; a preflight
survived only because `OPTIONS` differs from the method it authorised. The
reconciliation now counts rather than flags, and the counter is discarded when
the backfill lands, so a live event is never weighed against another live
event and nothing accumulates across a session.

The capture page reopens its worker port when MV3 evicts the service worker,
with the same backoff the panel uses. Recording is the worker's to declare and
travels down that port, so a port that died and was not replaced left capture
deaf: the tab kept showing as recording while every request was dropped. An
idle worker is evicted after about thirty seconds — the length of an ordinary
pause between opening DevTools and pressing Record.

**Closing DevTools stops the recording.** Nothing can capture once the DevTools
page is gone, so a tab that kept claiming to record would be lying. Everything
already captured stays — the worker owns the store, so the popup and the badge
keep working. Re-arm from the popup or the panel when you reopen.

**CORS preflights are rows of their own.** An `OPTIONS` is a real request to
that host, so it is captured, judged and counted like any other. It is hidden by
default because most runs do not care about it, and the **Preflights** checkbox
in the toolbar shows it. Nothing is merged into anything: a preflight's row
carries its own method, status and remote address, and the request it authorized
carries that request's.

**What another extension can hide.** Capture is scoped to the inspected page,
so a request issued from a *different* extension's context is not reported to
this one. Extensions that replace `fetch`/`XMLHttpRequest` — proxies, mockers,
interceptors such as Requestly — re-issue the page's calls from their own
context, and those calls do not appear here. The browser's own preflight often
still does, so the panel counts preflights with no matching request and reports
them as `N preflights unanswered`: a handful is ordinary, a great many is this.
Seeing that traffic would mean `chrome.webRequest` and host permissions on every
site, which is the install warning this extension exists without. Audit in a
profile without such an extension instead — traffic an interceptor has rewritten
is not the traffic your app actually sends.

## Retention

**A request is judged once, on arrival, and only the verdict is kept.** The
headers, query and payload the policy read have no reader after it runs, so a
sweep releases them ~15s later — long enough to cover a late response payload,
and short enough that they are gone while you are still on the page. What stays is the row the list draws, the timings, and
the per-assertion outcome.

The outcome is split from the assertion that produced it. An assertion's name,
description, expression, operator, expected value and group belong to
the **policy** and are identical across every request it judges, so they are
held once per policy and joined back by id in the panel; the record keeps only
`{id, passed, actual, detail}`. The sentence under each assertion card is
rebuilt from those two halves rather than stored.

| | live record | retained |
| --- | --- | --- |
| Realistic request, 5 assertions | 3564 B | **1457 B** |
| 1500 requests × 20 tabs | 102 MB | **42 MB** |

Against the original full record the same request was 4888 B, so retention is
**3.4x** smaller than before this change.

Captures live in memory, capped at 1500 requests per tab and 20 tabs. Payloads
are bounded at 24 MB while they are still in flight, but the sweep, not that
ceiling, is normally what releases them.

A snapshot is mirrored to `chrome.storage.session` so an evicted service worker
resumes where it left off. Because the in-memory record is already only the row
and its verdict, storage holds exactly the same thing — there is no second,
leaner shape and no "restored" record that is worth less than a live one. It
never contains a header, so a credential a page sends in `authorization` is
never written anywhere. A failed write costs a warm restart, never data: the
in-memory store is the source of truth and is never trimmed to satisfy it.

**A policy change applies to requests captured after it.** Re-judging older ones
would mean comparing against observations that no longer exist, which would
report compliant requests as failures, so the extension does not pretend to.

The UI is written against the React API but runs on **Preact** via
`preact/compat`, which is aliased in Vite for third-party code and in `tsconfig`
for the type checker. That is 195 KB off the chunk every page loads — the whole
extension is 748 KB unpacked, 221 KB gzipped — and the only source-level cost is
Preact's JSX types, which use the DOM's own attribute casing and give handlers a
typed `currentTarget` rather than a nullable `target`.

## Security

- No network client, telemetry or remote config. Nothing leaves the browser.
- Policies are data: expressions are parsed property paths and operators a fixed
  table. `eval` and `Function` are never used.
- Header values never leave the service worker at all. Nothing in the UI shows
  them, so they are not sent — which is stronger than the masking it replaced.
- The renderer escapes by default and no surface sets `dangerouslySetInnerHTML`.
- `chrome.runtime` messages and ports are rejected unless `sender.id` matches.
- Capture is read-only. `chrome.devtools.network` reports requests the page
  already made; nothing is intercepted, blocked or rewritten.
- Header maps are built with a null prototype and URLs are bounded, so a server
  cannot reach `Object.prototype` or a page's memory through a header it sends.
- Records are shape-checked at the worker boundary; a malformed one is dropped
  rather than trusted because it arrived over the extension's own port.
- Observations are released on a timer, so a credential in a request header
  exists in the worker for seconds rather than for the life of the tab.
- The only permission is `storage`. There is no host permission and there are
  no content scripts — nothing of this extension runs inside a page.
- Extension pages are served under `connect-src 'none'`, so even a compromised
  dependency on those pages has nowhere to send what it can read.

## Project

```
vite.config.ts            build: CRXJS + Preact + Tailwind, icons, packaging check
manifest.config.ts        MV3 manifest
tools/                    icon rasterizer, dist validator
*.html                    page shells
src/styles/tailwind.css   design tokens (contrast-checked in both schemes)
src/shared/               types, message contract, constants, URL helpers, logger
src/config/               YAML parsing, validation, scope matching, starter policy
src/engine/               expressions, operators, IP/CIDR, evaluation, aggregation
src/background/           ingest, policy, store, reduce, stream, devtools link, RPC, badge
src/devtools/             registers the panel, drives capture, maps entries to records
src/ui/lib/               port subscription, async state, timing hooks
src/ui/                   Preact: components, panel, options, popup
```

## State, without polling

Nothing in the extension is on a clock. Every surface is pushed to, and every
timer that remains exists to coalesce a burst of events or to wait out a
deliberate delay:

| | driven by |
| --- | --- |
| Panel and popup | one long-lived port; the worker pushes snapshots and state |
| Releasing observations | armed by capture, re-armed only while records are pending |
| Badge, persistence, record batching | debounces on the events that cause them |
| Reconnect | port disconnect, with a capped backoff |

The popup used to re-ask the worker for a snapshot every 1.5 seconds. It now
subscribes for the tab summary alone — the worker never sends it a request
record — and both pages share one port and one set of updates, so acting on a
tab in either is reflected in the other.

Every asynchronous surface models `uninitialized | loading | success | error`
explicitly (`src/ui/lib/async-state.ts`), so "no data yet" is never rendered as
"no data". A loading state never blocks input: `aria-busy` marks the region and
the controls stay live. A dropped port keeps the data on screen and says
`reconnecting…` only once the drop has lasted long enough to notice — an evicted
worker is back in a few hundred milliseconds and is not worth announcing.

Effects own exactly what they create. The port effect opens one port, tears it
and its retry timer down in cleanup, and holds a `disposed` flag so an in-flight
reconnect cannot resurrect one; the caller's handlers are read through refs, so
re-rendering never reconnects and replays a subscription. Where state can be
derived it is derived rather than synchronised — the selected request is a
lookup, not an effect chasing an id. Each page shell also ships a static skeleton inside `#root`, so the
popup and panel paint their real layout on the first frame rather than a blank
box while the bundle parses; the app renders the same skeleton for its loading
state, and the message escalates to "Waking the recorder…" if an idle service
worker takes a moment to answer.

| Script | Does |
| --- | --- |
| `yarn build` | Vite build, then fail if `dist/` would not load as an extension |
| `yarn dev` | the same, in watch mode |
| `yarn typecheck` | `tsc --build`, over `src/` **and** `tools/` |
| `yarn knip` | unused files, exports and dependencies |
| `yarn verify` | engine, capture, worker and hydration checks — 163 of them |
| `yarn bench` | per-request and per-keystroke timings |
| `yarn preview` | builds the offline UI preview the audits run against |
| `yarn audit:a11y` | axe-core over every page, both colour schemes |
| `yarn qa` | typecheck + knip + verify + a11y (`audit` is a yarn builtin) |
| `yarn lint` (root) | Biome across the workspace |

`tools/verify/` runs the shipped modules under `node --experimental-strip-types`
against a stubbed `chrome`, so it exercises the real code rather than a copy.
It is not a unit-test suite: each script drives a whole seam — the engine, the
capture boundary, the worker — and prints what it proved.

`tools/preview/` re-bundles `dist/` as plain pages with the same stub, because
Chrome 153 no longer honours `--load-extension` from the command line. That is
what `audit:a11y` audits, including an options page with the on-device model
removed so the disabled controls are reachable. It needs a local Chrome; set
`CHROME_BIN` if it is somewhere unusual.

## Publishing

`yarn build` produces a loadable, store-uploadable `dist/`. Zip that directory.

Listing notes:

- **Single purpose.** Auditing a tab's network requests against a user-written
  data-residency policy.
- **Privacy policy.** [`PRIVACY.md`](PRIVACY.md) — publish it and link it in the
  dashboard. The extension collects nothing and has no network client.
- **Permission justifications.**
  - `storage` — hold the user's policy and the current session's records.
  - No host permission, no `webRequest`, no `tabs`, no content scripts. Capture
    goes through `chrome.devtools.network`, which is scoped to the inspected
    tab and requires none. **The extension installs with no warning.**
  - Remote code: **none**. Nothing is fetched and executed; every byte that
    runs ships in the package.
- **`unsafe-eval` in the sandbox CSP.** Expect this to be asked about. It
  applies only to `sandbox.html`, never to the extension's own pages, and it
  exists so a policy's `runtime.scripts` can run. Those scripts are the user's
  own file, held in `chrome.storage.local` — user data, not remote code. The
  page they run in has `default-src 'none'`, no `chrome` APIs and no network, so
  a policy someone shared cannot reach the extension or send anything out.
- **Data disclosures.** Nothing is collected, transmitted or sold. Captured
  requests never leave `chrome.storage.session`, which is memory-backed and
  cleared when the browser closes.

### Measured before submission

| | popup | panel | options |
| --- | --- | --- | --- |
| Lighthouse performance | 100 | 100 | 100 |
| Lighthouse accessibility | 100 | 100 | 100 |
| Lighthouse best practices | 96 | 96 | 96 |
| Cumulative layout shift | 0 | 0 | 0.026 |
| Total blocking time | 0 ms | 0 ms | 0 ms |

Desktop preset, no artificial throttling — an extension page loads from disk, so
Lighthouse's default mobile 3G emulation is not the right model. The four best
practices points are the harness, not the product: `python -m http.server` sends
no compression or cache headers and 404s on `/favicon.ico`, none of which apply
to a page served from `chrome-extension://`.

## Verification

`yarn qa` runs the lot: types, dead code, six verification suites and the
accessibility audit. `yarn verify` drives the shipped modules against a stubbed
`chrome` — schema conformance, engine, capture boundary, sandbox runner, worker
and hydration.

axe-core reports zero violations on the popup, panel and options pages, in both
colour schemes and with the on-device model both present and absent.

The rest needs a browser, because a stubbed `chrome` cannot reproduce an
extension origin, a DevTools session or a wedged renderer: install warnings, the
capture lifecycle, preflight rows on live traffic, sandbox containment and
recovery from a worker eviction. Those are a tickable list in
[`MANUAL-CHECKS.md`](MANUAL-CHECKS.md).
