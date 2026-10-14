/**
 * The SSRF guard. Stand-out area #6.
 *
 * The attack this exists to stop: an admin registers an upstream whose URL points *inward*
 * rather than outward. The gateway then makes the request on their behalf, from inside the
 * cluster, with the cluster's own network position - and returns the response. That turns
 * "register an MCP server" into "read any internal HTTP endpoint", including the Kubernetes
 * API, Postgres's HTTP-adjacent neighbours, another tenant's service, or on a cloud VM the
 * instance metadata endpoint at 169.254.169.254, which hands out credentials.
 *
 * Two properties make this guard worth writing carefully rather than approximately.
 *
 * 1. **Every address a hostname resolves to must be checked, not just the first one.**
 *    `dns.lookup` returns one address. A hostname with two A records - one public, one
 *    127.0.0.1 - passes a first-address check roughly half the time, which is worse than
 *    failing, because it is intermittent. So this resolves A *and* AAAA and requires every
 *    answer to pass.
 *
 * 2. **It has to run again at call time.** Validation at write time is a snapshot of what
 *    a name resolved to then. DNS rebinding is the attack where the name resolves to a
 *    harmless public address while being registered, and to 127.0.0.1 when the gateway
 *    actually connects. Checking once is checking the wrong moment.
 *
 * `ipaddr.js` rather than hand-rolled parsing, and that is a deliberate dependency. IPv6
 * parsing is where SSRF guards get bypassed: `::` expansion, IPv4-mapped forms like
 * `::ffff:127.0.0.1`, zone identifiers, and the several legal spellings of the same
 * address. A bug in that parser is a security bug, and a mature zero-dependency library
 * that classifies ranges is the safer choice than code I wrote this afternoon.
 */
import { promises as dns } from 'node:dns';
import ipaddr from 'ipaddr.js';

/**
 * Only http and https. Everything else is either useless to an MCP client or actively
 * dangerous: `file:` reads the container filesystem, `gopher:` and `dict:` were the classic
 * SSRF-to-arbitrary-TCP pivots, and `data:` lets a URL smuggle a payload with no request at
 * all.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * IPv4 range names from `ipaddr.js` that must never be reachable.
 *
 * `linkLocal` covers 169.254.0.0/16 and therefore the cloud metadata address
 * 169.254.169.254 - it is not special-cased because it is not special: the whole range is
 * unreachable-by-policy, and naming only the one address would leave 169.254.169.253.
 */
const BLOCKED_IPV4_RANGES = new Set([
  'unspecified', // 0.0.0.0/8
  'broadcast', // 255.255.255.255
  'multicast', // 224.0.0.0/4
  'linkLocal', // 169.254.0.0/16 - includes cloud metadata
  'loopback', // 127.0.0.0/8
  'carrierGradeNat', // 100.64.0.0/10
  'private', // 10/8, 172.16/12, 192.168/16
  'reserved', // 192.0.2.0/24, 240.0.0.0/4 and friends
]);

const BLOCKED_IPV6_RANGES = new Set([
  'unspecified', // ::
  'linkLocal', // fe80::/10
  'multicast', // ff00::/8
  'loopback', // ::1
  'uniqueLocal', // fc00::/7 - the IPv6 equivalent of private
  'rfc6145', // ::ffff:0:0:0/96 translated
  'rfc6052', // 64:ff9b::/96
  '6to4', // 2002::/16
  'teredo', // 2001::/32
  'reserved', // 2001:db8::/32 documentation and others
]);

export type RejectionReason =
  | { kind: 'scheme'; detail: string }
  | { kind: 'credentials'; detail: string }
  | { kind: 'malformed'; detail: string }
  | { kind: 'unresolvable'; detail: string }
  | { kind: 'blocked-address'; detail: string };

export type GuardResult =
  | { ok: true; host: string; addresses: string[] }
  | { ok: false; reason: RejectionReason };

/** Injectable so the guard is testable, including the rebinding case. See resolveAll. */
export type Resolver = (hostname: string) => Promise<string[]>;

/**
 * Resolves both A and AAAA records, returning every answer.
 *
 * A failure of one family is not a failure overall - plenty of hosts are IPv4-only, and
 * `resolve6` on them raises ENODATA. But a failure of *both* means the name does not
 * resolve, which is itself a rejection: a hostname that cannot be resolved now cannot be
 * validated now, and registering it would mean the first real validation happens at call
 * time against whatever it resolves to then.
 */
export async function resolveAll(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);

  const addresses: string[] = [];
  if (v4.status === 'fulfilled') addresses.push(...v4.value);
  if (v6.status === 'fulfilled') addresses.push(...v6.value);

  return addresses;
}

/**
 * Does this hostname match one of the configured allowlist patterns?
 *
 * The allowlist exists because of an unavoidable tension: in-cluster services live on
 * private addresses, which the rules above reject. `*.svc.cluster.local` is how
 * `store-default-woo-mcp.store-default.svc.cluster.local` is re-admitted without opening
 * private space generally.
 *
 * The boundary matters. A pattern `*.svc.cluster.local` must match
 * `foo.svc.cluster.local` and must NOT match `evil-svc.cluster.local` or
 * `attacker.com.svc.cluster.local.evil.com`. So the comparison is a suffix match on a
 * **dot boundary**, never a substring test - `hostname.endsWith('svc.cluster.local')`
 * would accept `notsvc.cluster.local`.
 *
 * Why this is safe despite permitting private addresses: these names are served by cluster
 * DNS, which an external attacker does not control. Registering
 * `anything.svc.cluster.local` requires the ability to create a Service in the cluster,
 * which is a much larger grant than "can use the dashboard".
 */
export function matchesAllowlist(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  return patterns.some((raw) => {
    const pattern = raw.toLowerCase().trim().replace(/\.$/, '');

    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      // The dot is included in the comparison, which is what enforces the label
      // boundary - and the exact-match case is deliberately NOT accepted here, because
      // `*.svc.cluster.local` describes names under that suffix, not the suffix itself.
      return host.endsWith(`.${suffix}`);
    }

    return host === pattern;
  });
}

/**
 * Classifies one resolved address.
 *
 * IPv4-mapped IPv6 is handled explicitly, and it is the bypass most worth knowing about:
 * `::ffff:127.0.0.1` is a perfectly legal IPv6 address whose `range()` is `ipv4Mapped`,
 * not `loopback`. A guard that only consulted the IPv6 range list would wave it through
 * and then connect to localhost. So a mapped address is converted and re-classified under
 * the IPv4 rules.
 */
function addressRejection(address: string): string | undefined {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    // A resolver returning something unparseable is not a situation to interpret
    // optimistically.
    return `${address} is not a valid IP address`;
  }

  if (parsed.kind() === 'ipv4') {
    const range = parsed.range();
    return BLOCKED_IPV4_RANGES.has(range) ? `${address} is in the ${range} range` : undefined;
  }

  const v6 = parsed as ipaddr.IPv6;
  const range = v6.range();

  if (range === 'ipv4Mapped') {
    const mapped = v6.toIPv4Address();
    const mappedRange = mapped.range();
    return BLOCKED_IPV4_RANGES.has(mappedRange)
      ? `${address} maps to IPv4 ${mapped.toString()}, which is in the ${mappedRange} range`
      : undefined;
  }

  return BLOCKED_IPV6_RANGES.has(range) ? `${address} is in the ${range} range` : undefined;
}

export interface GuardOptions {
  allowlist: string[];
  /** Defaults to real DNS. Overridden in tests, including to simulate rebinding. */
  resolver?: Resolver;
}

/**
 * The guard itself. Called at write time by the registry, and again at call time by the
 * MCP client pool.
 *
 * Order is deliberate: the cheap structural checks come first, so a `file:` URL is
 * rejected without a DNS query, and only a structurally plausible URL costs a resolution.
 */
export async function checkUrl(rawUrl: string, options: GuardOptions): Promise<GuardResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: { kind: 'malformed', detail: 'not a valid absolute URL' } };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      reason: {
        kind: 'scheme',
        detail: `scheme "${url.protocol.replace(':', '')}" is not allowed; use http or https`,
      },
    };
  }

  /**
   * Credentials in the URL are refused outright.
   *
   * Two reasons, and the second is the one people miss. They would be stored in a
   * plain-text column while the registry has a proper encrypted credential field, so
   * this is a way to put a secret somewhere it is not protected. And `http://a@b/` is a
   * classic parser-confusion trick - some readers see host `a`, correct ones see host
   * `b` - so refusing the whole shape avoids ever depending on which reading a
   * downstream library takes.
   */
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason: {
        kind: 'credentials',
        detail:
          'credentials in the URL are not allowed; use authType bearer or header so the secret is encrypted at rest',
      },
    };
  }

  // `URL` strips the brackets from an IPv6 literal host, which is what `ipaddr` wants.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') {
    return { ok: false, reason: { kind: 'malformed', detail: 'the URL has no host' } };
  }

  /**
   * A literal IP address is checked directly and is NEVER exempted by the allowlist.
   *
   * This closes the obvious hole in a hostname-based allowlist: if `10.0.0.1` could be
   * waved through by naming it, the allowlist would become the bypass. The allowlist
   * exempts *names* served by cluster DNS, not addresses chosen by the caller.
   *
   * It also means no DNS query for a literal, which incidentally makes
   * `http://2130706433/` (decimal 127.0.0.1) and `http://0177.0.0.1/` cheap to reject -
   * though note the URL parser normalises most of those spellings before we see them.
   */
  if (ipaddr.isValid(host)) {
    const rejection = addressRejection(host);
    if (rejection !== undefined) {
      return { ok: false, reason: { kind: 'blocked-address', detail: rejection } };
    }
    return { ok: true, host, addresses: [host] };
  }

  const resolver = options.resolver ?? resolveAll;
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (error) {
    return {
      ok: false,
      reason: {
        kind: 'unresolvable',
        detail: `could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (addresses.length === 0) {
    return {
      ok: false,
      reason: { kind: 'unresolvable', detail: `${host} has no A or AAAA records` },
    };
  }

  /**
   * The allowlist is applied AFTER resolution, not instead of it.
   *
   * An allowed name still has to resolve - a name that resolves to nothing is rejected
   * above regardless - but once it does, a private address is permitted for it. The order
   * matters because it means the allowlist cannot be used to skip the "does this exist"
   * question, only the "is this address public" one.
   */
  const allowlisted = matchesAllowlist(host, options.allowlist);

  if (!allowlisted) {
    // EVERY address must pass. See the note at the top of this file: a hostname with one
    // public and one loopback A record passes a first-address check intermittently, which
    // is the worst possible behaviour for a security control.
    for (const address of addresses) {
      const rejection = addressRejection(address);
      if (rejection !== undefined) {
        return {
          ok: false,
          reason: {
            kind: 'blocked-address',
            detail: `${host} resolves to ${addresses.length} address(es) and ${rejection}`,
          },
        };
      }
    }
  }

  return { ok: true, host, addresses };
}

/** Flattens a rejection into one sentence for an API response or a log line. */
export function describeRejection(reason: RejectionReason): string {
  return reason.detail;
}
