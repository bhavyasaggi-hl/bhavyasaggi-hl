/**
 * URL helpers.
 *
 * Registrable-domain detection uses a bundled shortlist of common multi-label
 * public suffixes rather than the full Public Suffix List. The result is used
 * for grouping in the report only, never for a security decision.
 */

const MULTI_LABEL_SUFFIXES = new Set([
  'ac.uk',
  'co.uk',
  'gov.uk',
  'ltd.uk',
  'me.uk',
  'net.uk',
  'org.uk',
  'plc.uk',
  'sch.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'id.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'co.in',
  'net.in',
  'org.in',
  'gen.in',
  'firm.in',
  'ind.in',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'go.jp',
  'co.kr',
  'or.kr',
  'ne.kr',
  'go.kr',
  'com.mx',
  'com.ar',
  'com.co',
  'com.tr',
  'com.sg',
  'com.hk',
  'com.tw',
  'com.my',
  'co.za',
  'org.za',
  'net.za',
  'com.sa',
  'com.eg',
  'com.ng',
  'com.pk',
  'com.ua',
  'com.pl',
  'com.ru',
  'co.il',
  'org.il',
  'net.il',
  'eu.com',
  'us.com',
  'uk.com',
  'gb.com',
  'de.com',
  'jp.com',
  'cn.com',
  's3.amazonaws.com',
  'cloudfront.net',
  'azureedge.net',
  'blob.core.windows.net',
  'appspot.com',
  'web.app',
  'firebaseapp.com',
  'workers.dev',
  'pages.dev',
  'github.io',
  'gitlab.io',
  'netlify.app',
  'vercel.app',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** Returns the approximate eTLD+1 of `host`, or `host` itself when it cannot be reduced. */
function registrableDomain(host: string): string {
  if (host.length === 0 || IPV4.test(host) || host.includes(':')) {
    return host;
  }
  const labels = host.split('.');
  if (labels.length <= 2) {
    return host;
  }
  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastThree)) {
    return labels.slice(-4).join('.');
  }
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return lastThree;
  }
  return lastTwo;
}

export interface ParsedUrl {
  readonly host: string;
  readonly registrableDomain: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly protocol: string;
}

/** Parses `rawUrl` defensively; opaque or malformed URLs still yield a usable shape. */
export function parseUrl(rawUrl: string): ParsedUrl {
  try {
    const parsed = new URL(rawUrl);
    const query: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    const host = parsed.hostname;
    return {
      host,
      registrableDomain: registrableDomain(host),
      path: parsed.pathname,
      query,
      protocol: parsed.protocol.replace(':', ''),
    };
  } catch {
    return { host: '', registrableDomain: '', path: rawUrl, query: {}, protocol: '' };
  }
}
