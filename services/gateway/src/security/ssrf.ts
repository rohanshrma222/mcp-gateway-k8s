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
const ALWAYS_BLOCKED_IPV4 = new Set([
  'unspecified', // 0.0.0.0/8
  'broadcast', // 255.255.255.255
  'multicast', // 224.0.0.0/4
  'linkLocal', // 169.254.0.0/16 - includes cloud metadata
  'loopback', // 127.0.0.0/8
  'reserved', // 192.0.2.0/24, 240.0.0.0/4 and friends
]);

/**
 * Private space, which is blocked for everything EXCEPT hosts on the internal list.
 *
 * Separating these two sets is a correction to the first version of this guard, and the
 * hole it closes is worth recording. That version let any allowlisted host skip every
 * address check, on the reasoning that cluster services legitimately live on private
 * addresses. But "skip every check" also skipped loopback and link-local - and a caller
 * who can create a Service in any namespace they control can make a cluster name resolve
 * wherever they like. An ExternalName Service, or a hand-written Endpoints object, turns
 * `mine.my-ns.svc.cluster.local` into a name that resolves to 169.254.169.254 and is
 * allowlisted by suffix. The guard would have waved it through.
 *
 * So the exemption is now narrow: an internal host may resolve into PRIVATE space, which
 * is the thing cluster DNS legitimately does. Nothing may resolve to loopback, link-local,
 * multicast or the other reserved ranges - not even a name ending in .svc.cluster.local,
 * because there is no legitimate configuration in which it would.
 */
const PRIVATE_IPV4 = new Set([
  'carrierGradeNat', // 100.64.0.0/10
  'private', // 10/8, 172.16/12, 192.168/16
]);

const ALWAYS_BLOCKED_IPV6 = new Set([
  'unspecified', // ::
  'linkLocal', // fe80::/10
  'multicast', // ff00::/8
  'loopback', // ::1
  'rfc6145', // ::ffff:0:0:0/96 translated
  'rfc6052', // 64:ff9b::/96
  '6to4', // 2002::/16
  'teredo', // 2001::/32
  'reserved', // 2001:db8::/32 documentation and others
]);

/** fc00::/7, the IPv6 equivalent of private. See PRIVATE_IPV4. */
const PRIVATE_IPV6 = new Set(['uniqueLocal']);

export type RejectionReason =
  | { kind: 'scheme'; detail: string }
  | { kind: 'credentials'; detail: string }
  | { kind: 'malformed'; detail: string }
  | { kind: 'unresolvable'; detail: string }
  | { kind: 'host-not-allowed'; detail: string }
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
function addressRejection(address: string, allowPrivate: boolean): string | undefined {
  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    // A resolver returning something unparseable is not a situation to interpret
    // optimistically.
    return `${address} is not a valid IP address`;
  }

  if (parsed.kind() === 'ipv4') {
    return classify(address, parsed.range(), ALWAYS_BLOCKED_IPV4, PRIVATE_IPV4, allowPrivate);
  }

  const v6 = parsed as ipaddr.IPv6;
  const range = v6.range();

  if (range === 'ipv4Mapped') {
    const mapped = v6.toIPv4Address();
    const rejection = classify(
      mapped.toString(),
      mapped.range(),
      ALWAYS_BLOCKED_IPV4,
      PRIVATE_IPV4,
      allowPrivate,
    );
    return rejection === undefined ? undefined : `${address} maps to IPv4 ${rejection}`;
  }

  return classify(address, range, ALWAYS_BLOCKED_IPV6, PRIVATE_IPV6, allowPrivate);
}

/**
 * One place where the always-blocked / private-when-internal decision is made, so the
 * IPv4, IPv6 and IPv4-mapped paths cannot drift apart on it.
 */
function classify(
  address: string,
  range: string,
  alwaysBlocked: Set<string>,
  privateRanges: Set<string>,
  allowPrivate: boolean,
): string | undefined {
  if (alwaysBlocked.has(range)) {
    return `${address} is in the ${range} range, which is never permitted`;
  }
  if (privateRanges.has(range) && !allowPrivate) {
    return `${address} is in the ${range} range, which is only permitted for hosts on the internal allowlist`;
  }
  return undefined;
}

export interface GuardOptions {
  /**
   * Hosts that may be registered at all. **Mandatory and default-deny**: a host that
   * matches nothing here is refused, however public and harmless its addresses are.
   *
   * This is the stricter reading of the requirement, and the first version of this guard
   * got it wrong - it treated the list as an exemption that let cluster names reach
   * private space, while permitting any public host by default. That makes the gateway a
   * general-purpose outbound fetcher the moment someone registers an upstream, and an
   * admin account becomes a way to make the cluster talk to the internet on request.
   *
   * Default-deny means adding a genuinely external upstream is a deliberate, reviewable
   * act: someone edits Helm values and redeploys, rather than typing a URL into a form.
   */
  allowlist: string[];
  /**
   * The subset of hosts additionally permitted to resolve into PRIVATE address space.
   *
   * Separate from `allowlist` because the two questions are different. "May this host be
   * registered" is about trust in the operator's intent. "May this host live on a private
   * address" is about whether private space is where it legitimately lives - true for
   * in-cluster Services, false for a vendor's hosted MCP server, which should resolve
   * publicly and whose resolving privately would be a sign something is wrong.
   */
  privateHosts: string[];
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
    // A literal address is checked directly and is NEVER exempted by either list. This
    // closes the obvious hole in a host-based allowlist: if `10.0.0.1` could be waived by
    // naming it, the allowlist would become the bypass. The lists describe NAMES that DNS
    // answers for, never addresses the caller chose - so `allowPrivate` is false here
    // unconditionally, and a literal public address is still refused below for not being
    // an allowlisted host.
    const rejection = addressRejection(host, false);
    if (rejection !== undefined) {
      return { ok: false, reason: { kind: 'blocked-address', detail: rejection } };
    }
    if (!matchesAllowlist(host, options.allowlist)) {
      return {
        ok: false,
        reason: {
          kind: 'host-not-allowed',
          detail: `${host} is not on the upstream allowlist; add it to gateway.upstreamAllowlist in Helm values if it is genuinely intended`,
        },
      };
    }
    return { ok: true, host, addresses: [host] };
  }

  /**
   * The host allowlist, checked BEFORE resolving.
   *
   * Before, because it is cheaper and because a refused host should not cost a DNS query -
   * and more importantly because it means an attacker cannot use this endpoint to make the
   * gateway resolve arbitrary names for them, which is a small exfiltration channel in its
   * own right (DNS to a name they control confirms the request reached us).
   */
  if (!matchesAllowlist(host, options.allowlist)) {
    return {
      ok: false,
      reason: {
        kind: 'host-not-allowed',
        detail: `${host} is not on the upstream allowlist; add it to gateway.upstreamAllowlist in Helm values if it is genuinely intended`,
      },
    };
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
   * Address checks ALWAYS run, for every host, including allowlisted ones.
   *
   * The only thing membership of `privateHosts` changes is whether private space is
   * acceptable. Loopback, link-local, multicast and the reserved ranges are refused for
   * everybody - see PRIVATE_IPV4 for the attack that made this distinction necessary.
   */
  const allowPrivate = matchesAllowlist(host, options.privateHosts);

  // EVERY address must pass. See the note at the top of this file: a hostname with one
  // public and one loopback A record passes a first-address check intermittently, which
  // is the worst possible behaviour for a security control.
  for (const address of addresses) {
    const rejection = addressRejection(address, allowPrivate);
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

  return { ok: true, host, addresses };
}

/** Flattens a rejection into one sentence for an API response or a log line. */
export function describeRejection(reason: RejectionReason): string {
  return reason.detail;
}
