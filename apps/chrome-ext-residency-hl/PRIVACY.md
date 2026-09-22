# Privacy policy — Residency Auditor

_Last updated: 2026-09-22_

## What the extension does

Residency Auditor records the network requests a tab makes and checks them
against a policy you write, so you can see which requests satisfy your
data-residency rules.

## What it collects

Nothing is collected. The extension has no server, no analytics, no telemetry
and no network client of its own. It never sends your data anywhere.

While a tab is being recorded, the extension holds in the browser's memory:

- request and response metadata — URL, method, resource type, headers, status,
  remote IP address, timing;
- request and response payloads, truncated at 64 KB, and only when your policy
  asserts on one;
- the verdicts your policy produced for each request.

Headers and payloads are read only to run your policy against them. About
fifteen seconds after a request is captured they are discarded, and what remains
is the request line, the timings and the verdict. They are never written to
storage and never sent to any page of the extension, so a credential your site
puts in an `authorization` header is held briefly in the extension's background
worker and nowhere else.

## Where it is kept and for how long

In memory, and mirrored to `chrome.storage.session`, which is memory-backed and
is cleared when you close the browser. Nothing is written to disk. Nothing
survives a browser restart.

**Headers, query parameters and payloads are never written to session storage.**
The mirror holds what is left after they are discarded: the request line, the
timings and the verdict.

You can clear a tab's records at any time from the popup or the panel.
Recording stops when you close the tab, and also when you close DevTools.

## Policy scripts

A policy may include `runtime.scripts` — JavaScript you write, run against each
request. It executes in a sandboxed page with no access to the extension's APIs,
your policy storage, your captured records or the network. It can read the one
request it is judging and report pass or fail, and nothing else.

## What leaves your browser

Nothing.

Credential-bearing headers (`authorization`, `cookie`, `set-cookie`,
`x-api-key` and similar) are masked before any record is shown in the
extension's own pages.

## AI assist

The optional policy drafting uses Chrome's built-in on-device model
(Prompt API). Your instruction and your policy are processed locally by Chrome
and are not sent to any server by this extension.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Keep your policy (`chrome.storage.local`) and the current session's records (`chrome.storage.session`). |

That is the only permission. The extension requests no host access, does not
use `webRequest`, and injects no content scripts — nothing of it runs inside a
web page. Requests are read through `chrome.devtools.network`, which reports
only the tab you have opened DevTools on, and only while it is open. Closing
DevTools ends the recording.

## Contact

Raise an issue on the project repository.
