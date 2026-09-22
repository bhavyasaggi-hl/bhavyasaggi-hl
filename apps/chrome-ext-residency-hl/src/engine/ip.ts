/** IPv4 / IPv6 parsing and CIDR containment, used by the `inCidr` operators. */

export interface CidrRange {
  readonly source: string;
  readonly base: bigint;
  readonly mask: bigint;
  readonly bits: 32 | 128;
}

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV6_GROUPS = 8;

function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  const [head = '', tail, ...rest] = value.split('::');
  if (rest.length > 0) {
    return null;
  }
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const explicit = headGroups.length + tailGroups.length;
  if (tail === undefined ? explicit !== IPV6_GROUPS : explicit > IPV6_GROUPS) {
    return null;
  }
  const filler = new Array<string>(IPV6_GROUPS - explicit).fill('0');
  const groups = tail === undefined ? headGroups : [...headGroups, ...filler, ...tailGroups];
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/iu.test(group)) {
      return null;
    }
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

/** Parses an IPv4 or IPv6 literal, tolerating the `[::1]` bracket form. */
function parseIp(value: string): { readonly value: bigint; readonly bits: 32 | 128 } | null {
  const trimmed = value.trim().replace(/^\[|\]$/gu, '');
  if (trimmed.includes(':')) {
    const parsed = parseIpv6(trimmed);
    return parsed === null ? null : { value: parsed, bits: IPV6_BITS };
  }
  const parsed = parseIpv4(trimmed);
  return parsed === null ? null : { value: parsed, bits: IPV4_BITS };
}

/** Parses `1.2.3.0/24`, `2001:db8::/32` or a bare address (treated as a /32 or /128). */
export function parseCidr(value: string): CidrRange | null {
  const source = value.trim();
  const [address = '', prefix] = source.split('/');
  const ip = parseIp(address);
  if (ip === null) {
    return null;
  }
  const prefixLength = prefix === undefined ? ip.bits : Number(prefix);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > ip.bits) {
    return null;
  }
  const hostBits = BigInt(ip.bits - prefixLength);
  const mask =
    hostBits === 0n
      ? (1n << BigInt(ip.bits)) - 1n
      : ((1n << BigInt(prefixLength)) - 1n) << hostBits;
  return { source, base: ip.value & mask, mask, bits: ip.bits };
}

/** True when `address` sits inside `range`. Mixed address families never match. */
export function ipInCidr(address: string, range: CidrRange): boolean {
  const ip = parseIp(address);
  if (ip === null || ip.bits !== range.bits) {
    return false;
  }
  return (ip.value & range.mask) === range.base;
}
