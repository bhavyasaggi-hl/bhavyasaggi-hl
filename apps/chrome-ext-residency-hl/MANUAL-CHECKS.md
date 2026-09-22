# Manual verification

Everything here needs a real extension load. The automated suites drive the
shipped modules against a stubbed `chrome`, which cannot reproduce an extension
origin, a DevTools session, or a wedged renderer — so these are the checks that
only a browser can settle.

Run `yarn build` first. Load `dist/` at `chrome://extensions` → **Developer
mode** → **Load unpacked**.

There is a policy built for this: **[`manual-test-policy.yaml`](manual-test-policy.yaml)**.
Paste it into the options page and save. It exercises every field the extension
reads, 27 of the 30 operators, every expression, every scope form and both
script paths — written so its assertions pass on any https site, which means a
red row is a real finding rather than a contrived one. The three operators it
leaves off need a JSON response body no site guarantees; they are in the file,
disabled, ready to enable against an API you control.

Each check says what to do and what you should see. Anything else is a finding —
note what you saw and I will take it from there.

---

## 0. The capture test page — do this one first

`manual-test-policy.yaml` checks the policy engine. This checks the **capture**
layer, which is where the open bug is.

```
yarn testpage          # serves tools/manual/ on :8080
```

1. Open `http://localhost:8080/test-page.html`.
2. Load `tools/manual/test-page-policy.yaml` into the options page and save.
3. **Record the tab** and open the Residency panel *before* firing anything.
4. Press **Run every case**. It fires 24 labelled cases — 6 browser-initiated
   and 18 script-initiated — each tagged `?case=NN`. Case 27 is five identical
   requests fired in parallel, which is the shape that used to be collapsed
   into one row.
5. Press **Download expectations**.
6. In the panel, clear every filter, tick **Preflights**, and **Export**.

Then diff the two:

```
yarn ingest ~/Downloads/residency-tab-<id>.json ~/Downloads/residency-expectations.json
```

It prints a line per case — expected against captured — and names every
discrepancy: requests that produced no record, wrong resource type or method,
missing `net::ERR_*`, and preflights whose request never appeared. Send me that
output; it is the whole bug report.

The page covers `document`, `stylesheet`, `script`, `image`, `font`, `ping`,
`fetch`, `xhr`, `preflight` and `websocket`; GET/POST/PUT/DELETE; JSON request
and response bodies; 404, 500, an unresolvable host, a two-second response, a
redirect, a preflight that is refused so no request follows it, and five
identical requests sharing a method, a url and a millisecond.

**What I expect to see, and want confirmed:** every `fetch` and `xhr` case
reporting `NOTHING CAPTURED`, while the browser-initiated ones come through. Run
against your real export, the analyser already says exactly that:

```
  ✗ not one "fetch" record was captured — script-initiated requests are being missed
  ✗ not one "xhr" record was captured — script-initiated requests are being missed
  preflights whose request was never captured: 58
```

### If requests are still missing, this says where

Set `debug: true` under `extensions.residency` in your policy and save. The
DevTools **page** then traces every capture. To read it: right-click inside the
DevTools window → **Inspect** (DevTools on DevTools) → Console.

```
[residency] backfill: 41 in the panel's log, 12 adopted, 29 left to the live stream
[residency] live GET fetch https://api.example.com/v1/orders?case=12
```

One line per request the extension is handed. Compare it against the Network
panel:

- **A request is in the Network panel but has no `live` line and was not
  adopted** — `chrome.devtools.network` never handed it to us. That is upstream
  of this extension; see below.
- **It has a `live` line but no row in the panel** — that one is ours, and the
  trace is the bug report.

The panel says so too. When a CORS preflight arrives and no request to the same
URL follows it, the footer adds **`N preflights unanswered`** in amber, with the
explanation on hover. One or two is ordinary — a refused preflight looks the
same. Dozens means the requests are being made where this extension cannot see
them.

> **Confirmed conflict: Requestly.** It patches `fetch` and `XMLHttpRequest` on
> the page, and requests it re-issues are attributed to its own extension
> context, so `chrome.devtools.network` never reports them to us — the missing
> entries' `_initiator` points at `chrome-extension://mdnleld…`. Nothing this
> extension can do about it. In a profile without it, every case is captured.
> Any extension that wraps the fetch APIs (proxies, mockers, interceptors) will
> do the same, so rule those out before reporting a capture gap.

> If requests never reach us and no such extension is installed, the trace above
> is the bug report. In the run you sent, the
> missing requests' `_initiator` pointed at another extension's script, which
> had monkey-patched `fetch`/`XHR` on the page. In a clean profile every
> `fetch` and `xhr` case is captured normally.

---

## 1. It installs clean

- [ ] Loading `dist/` shows **no permission warning dialog**.
- [ ] The card lists **Storage** and nothing else. No host access, no "read your
      browsing history", no "read and change data on sites you visit".
- [ ] `chrome://extensions` shows no errors on the card.

Then open the service worker console (**Inspect views: service worker**):

- [ ] No red errors at start-up. `service worker ready` is the expected line.

---

## 2. Capture only happens with DevTools open

Pick a site you can reload that makes XHR/fetch calls.

- [ ] Click the extension icon. The popup says **"This tab is not being
      recorded."** — recording is off by default for every tab.
- [ ] Press **Record this tab** with DevTools **closed**. The footer now reads
      **`armed`**, not `recording`, and a note explains capture needs DevTools.
- [ ] Open DevTools (`⌥⌘I` / `F12`). The footer flips to **`recording`**
      without you touching anything.
- [ ] Reload the page. The popup fills with domains and pass rates.
- [ ] Close DevTools. The footer drops back to **`paused`** — capture stops
      because nothing can observe it any more.
- [ ] Open a second tab. It is **not** recording. Arming is per tab.

> Closing DevTools stopping the recording is deliberate: `chrome.devtools.network`
> is the only capture source, so a tab that kept claiming to record would be
> lying.

---

## 3. The panel

Open DevTools → **Residency** tab.

- [ ] Rows appear as requests finish, without a manual refresh.
- [ ] **Record** / **Clear** / **Preserve log** / **Preflights** all behave.
- [ ] Filter facets (Failing, Passing, Unscoped; Fetch/XHR, Doc, JS, …) narrow
      the list.
- [ ] Clicking a domain on the left scopes the list; the chip clears it.
- [ ] Clicking a row opens the detail pane: **Assertions**, **Request**,
      **Timing**. There is no Headers or Payload tab — those are released
      seconds after the policy reads them.
- [ ] **Preserve log** on, then navigate. Rows survive. Off, then navigate.
      Rows clear.
- [ ] Keyboard: `Tab` into the list, `↑`/`↓` move the selection, and the detail
      pane can be scrolled with the keyboard.

### 3a. Preflights are rows of their own

Nothing is folded into anything any more. An `OPTIONS` is captured, judged and
counted like any other request; the checkbox only decides whether you see it.

- [ ] On a page that makes **cross-origin** XHR/fetch, with **Preflights**
      unticked, no `OPTIONS` rows appear, and the footer says how many are
      hidden.
- [ ] Tick **Preflights**. The `OPTIONS` rows appear, each with its own method,
      status and remote address. The row count grows by exactly that many.
- [ ] Untick. They disappear again and the count returns.
- [ ] A preflight row's detail pane shows its own assertions — it is scoped by
      the policy like anything else, so an item matching that host judges it.

> This replaces the earlier folding behaviour. `settings.mergePreflights` is
> gone; a saved policy that still sets it is rewritten with a note saying so.

---

## 4. The policy, and the schema restructure

Open the options page (**Policy** button in the popup).

- [ ] The editor shows the starter policy with `opencollection`, `info`,
      `items`, `extensions`.
- [ ] The document is valid: green banner, no errors.
- [ ] Point the second item's `http.url` at a host you actually call — replace
      `'*.api.example.com'`. **Save policy.**
- [ ] Reload the page under audit. Its requests are now judged by that item, and
      the panel shows the assertion names from `description`.
- [ ] Break something on purpose (`operator: isInEurope`). The gutter shows the
      error, the header counts it, and the banner says it was not applied.
- [ ] **Format** reflows without changing meaning. **Restore starter policy**
      brings the original back.

### 4a. Migration from the old format

Only relevant if you have a policy saved from before the restructure.

- [ ] With an old-shape policy stored, reload the extension. The options page
      shows an amber banner: **"This policy was rewritten onto the OpenCollection
      document shape."**
- [ ] The notes name what could not be carried — `ignore`, `ipRanges`,
      exclusions, multiple host patterns collapsed into one `regex:`.
- [ ] The rewritten document is in the editor and is valid.
- [ ] Save. Reload again — the banner is gone. The rewrite happens **once**.

---

## 5. Scripts in the sandbox

Add this to an item's `runtime` (alongside `assertions`), pointed at a host that
sends an `Authorization` header:

```yaml
      scripts:
        - type: tests
          code: |-
            test("request is authenticated", function () {
              expect(req.headers).to.have.property('authorization');
            });
```

- [ ] Save, reload the page, open a matching request. The **Assertions** tab
      shows the scripted test below the assertions, with its own pass/fail.
- [ ] Make it fail (`'authorizationx'`). The message is chai's, naming what it
      got.
- [ ] A request the item does not scope shows **no** test section at all.

### 5a. Containment — the two things I could not prove

**The runaway script.** Replace the code with `while (true) {}`:

- [ ] After ~2 seconds the tests report **"script timed out"** rather than
      hanging for ever.
- [ ] **Watch what the DevTools window does during those 2 seconds.** If the
      panel freezes, tell me — an opaque origin cannot spawn a Worker, so there
      is nothing to `terminate()`, and whether a wedged frame blocks the page
      depends on process allocation I cannot measure headlessly.
- [ ] The next request's scripts run normally. The frame is replaced.

**Isolation.** Replace the code with:

```js
test("no extension APIs", function () {
  expect(typeof chrome === 'undefined' || chrome.runtime === undefined).to.equal(true);
});
test("no network", function () {
  expect(typeof fetch).to.equal('function');
});
```

- [ ] The first test **passes** — the sandbox has no extension APIs.
- [ ] In the DevTools console for the sandbox frame, a `fetch('https://example.com')`
      is refused with a **`connect-src`** CSP violation.

---

## 6. Heavy traffic

On a page that issues a lot of requests (a dashboard, an infinite scroll):

- [ ] The panel stays responsive while rows stream in.
- [ ] The badge count keeps up without flickering.
- [ ] With scripts in the policy, tests still resolve — batched 50 at a time.
- [ ] Nothing in the service worker console about quota or dropped writes.

---

## 7. Survives a worker eviction

MV3 evicts an idle service worker after ~30s. **This is the one that was
broken**: the capture page opened its worker port once and never reopened it,
so a worker evicted before you pressed Record left capture permanently deaf —
the tab showed as recording and every request was silently dropped. Simply
pausing between opening DevTools and pressing Record was enough to hit it.

- [ ] Open a page, open DevTools, then **wait a full minute** before pressing
      Record in the Residency panel. Reload the page. Rows appear.
- [ ] With `debug: true`, the capture page's console shows
      `worker port dropped; reconnecting in 250ms` around the eviction, then
      carries on.

- [ ] Record a tab, then leave it idle until `chrome://extensions` shows the
      service worker as inactive.
- [ ] Interact with the page again. The panel reconnects and keeps recording —
      briefly showing `reconnecting…` only if the wait is long enough to notice.
- [ ] Earlier rows are still there, with their verdicts.
- [ ] The popup still shows the right totals.

---

## 8. AI assist (Chrome 138+ only)

- [ ] The chip reads `available`, `downloadable`, or `unsupported` — never stuck
      on `checking…`.
- [ ] If unsupported: the suggestion chips are **absent** (not greyed out), and
      the reason is stated.
- [ ] If available: **Draft policy** produces a document in the **new** shape
      (`items`, `http.url`, `info.tags`) that parses with no unknown-key
      warnings.
- [ ] **Stop** during generation actually stops it.

---

## What I most want to hear about

1. Whether §3a cleared your `OPTIONS` rows.
2. Whether §5a's runaway script freezes the DevTools window.
3. Anything in §2 where the popup and the panel disagree about state.
