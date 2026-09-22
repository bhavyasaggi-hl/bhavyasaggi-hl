/**
 * Starter policy shipped with the extension.
 *
 * It is deliberately conservative: the only globally-scoped assertions are ones
 * that hold for a well-behaved site (TLS, no server errors), so a fresh install
 * does not paint every domain red. The scoped group is a worked example that
 * users retarget at their own hosts.
 */

export const DEFAULT_CONFIG_YAML = `# Residency Auditor policy.
#
# This document is a strict subset of the OpenCollection schema: every field is
# one the schema defines, and none is added. A policy is a collection whose
# items describe requests to match rather than requests to send.
# Schema: https://schema.opencollection.com/opencollection/v1.0.0.json
opencollection: '1.0.0'

info:
  name: Starter residency policy
  version: '1'

items:
  # An item's scope is the request it describes: \`http.url\` says which requests
  # it covers, \`http.method\` narrows by verb, and \`info.tags\` names the
  # resource types. A url of '*' means every request.
  - info:
      name: Every request
      type: http
      description: Baseline rules that hold for any well-behaved site.
    http:
      url: '*'
    runtime:
      assertions:
        - description: Transport is encrypted
          expression: req.url
          operator: startsWith
          value: 'https://'

        - description: No server-side failure
          expression: res.status
          operator: lt
          value: '500'

  - info:
      name: First-party API (example)
      type: http
      description: Replace the url with your own API, and the tags with the traffic you care about.
      tags:
        - fetch
        - xhr
    http:
      url: '*.api.example.com'
    runtime:
      assertions:
        - description: Region header present
          expression: res.headers['x-data-region']
          operator: isNotEmpty

        # \`value\` is a string, so a list of accepted values is comma separated.
        - description: Served from an approved EU region
          expression: res.headers['x-data-region']
          operator: in
          value: 'eu-west-1, eu-central-1'

        - description: Edge POP is in the EU
          expression: res.headers['x-served-by']
          operator: matches
          value: '^(?:ams|fra|dub|lhr|cdg)'

        - description: Response IP is inside an approved range
          expression: res.ip
          operator: inCidr
          value: '52.28.0.0/16, 2a05:d000::/29'
          disabled: true

      # Scripts run in a sandbox with no access to the browser or the extension.
      # Only \`tests\` is supported: this audits traffic a page already sent, so
      # there is nothing to run before a request. A script takes \`type\` and
      # \`code\`, and nothing else.
      scripts:
        - type: tests
          code: |-
            test("every approved region is in the EU", function () {
              const region = res.headers['x-data-region'];
              expect(region).to.be.a('string');
              expect(region.startsWith('eu-')).to.equal(true);
            });

# The schema's own escape hatch, and the only place a field it does not define
# may live.
extensions:
  residency:
    # 'host' groups by exact hostname, 'domain' groups by approximate eTLD+1.
    grouping: host
    # Discard a tab's captures when its top-level document navigates.
    clearOnNavigate: true
    # Keep requests that no item scopes; they show up as "not applicable".
    recordUnscoped: true
    # Record every tab on sight. Off by default: a tab is audited once you ask.
    recordByDefault: false
`;
