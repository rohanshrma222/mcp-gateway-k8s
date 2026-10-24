# System design and tradeoffs

How the system is put together, and — more usefully — what each choice cost.

Everything described here is built and running. Section 11 is the honest list of what is not, and section 12 names the scripts that check the claims rather than restating them.
that delivers them. This is a design document, so it describes the intended design in
full; the honest build state is the table in [../README.md](../README.md).

---

## 1. The problem

A team of people each want their AI client — Claude Code, an MCP Inspector, an in-app chat
agent — to use the company's tools. The naive answer is that every person configures every
server themselves and holds every credential. That fails in four ways at once:

- **Credential sprawl.** Every member holds a WooCommerce key. Offboarding means rotating
  everything, and you cannot tell who used what.
- **No attribution.** The store sees one API key, not five people.
- **No central control.** Disabling a server means asking five people to edit a config file.
- **No least privilege.** A member who can read orders can also delete products, because
  the credential does not distinguish.

So: one gateway. It holds the credentials, decides who may call which tool, records every
call, and exposes everything through a single MCP endpoint. A member gets a URL and a key
and never sees a credential at all.

The design consequence that follows from this, and that most of the rest of the document
is downstream of: **the gateway is the trust boundary.** Credentials stop there,
authorisation is decided there, and attribution happens there.

## 2. Constraints

From the brief, treated as fixed:

- Local Kubernetes on kind, k3d or Minikube; the same Helm charts must deploy to a k3s VPS
  with config changes only.
- **Helm only**, no Kustomize. `values-local.yaml` and `values-prod.yaml`.
- PVCs for the database and `wp-content`. Probes and resource requests/limits on every
  workload. Ingress with stable URLs.
- **No hardcoded secrets** — credentials live in Kubernetes Secrets.
- The WooCommerce MCP server must be unreachable from outside the cluster.
- At least three upstream MCP servers; admin and member roles; per-user API keys stored
  **hashed** and revocable; an audit log visible in the dashboard.

Self-imposed: TypeScript with the official MCP SDK, Groq for the agent, Postgres as the
only state store, and roughly twelve working days.

## 3. The four layers

```
                    ┌──────────────── ns: urumi-platform ─────────────────┐
  browser ──┐       │  dashboard (nginx-unprivileged, static React)       │
            ├─ Traefik ─►  /          dashboard                           │
  Claude    │       │      /api/*     gateway (Fastify)                    │
  Code ─────┘       │      /mcp       gateway (MCP server, stateless)      │
                    │                        │                            │
                    │                   postgres StatefulSet + PVC         │
                    └────────────────────────┼────────────────────────────┘
                          MCP client pool    │ (Streamable HTTP, server-side creds)
            ┌────────────────────────────────┼────────────────────────────┐
            ▼                                ▼                            ▼
  ┌── ns: store-default ───┐      ┌── ns: mcp-upstreams ──────────────────────┐
  │ woo-mcp (no Ingress)   │      │ notes-mcp      (ours, collides on purpose)│
  │    │ WooCommerce REST  │      │ everything-mcp (third-party, pinned)      │
  │    ▼                   │      └───────────────────────────────────────────┘
  │ wordpress + PVC        │
  │    │                   │        Traefik ─► store.urumi.local
  │    ▼                   │
  │ mariadb StatefulSet+PVC│
  └────────────────────────┘
```

| Namespace | Workloads | Reachable from outside |
| --- | --- | --- |
| `urumi-platform` | gateway (×2), dashboard, postgres | dashboard and gateway via `app.urumi.local` |
| `store-default` | wordpress, mariadb, woo-mcp | **storefront only**; woo-mcp has no Ingress |
| `mcp-upstreams` | notes-mcp, everything-mcp | nothing |

One namespace per store rather than one shared store namespace: it makes the multi-store
bonus a second release rather than a rewrite, and it means a NetworkPolicy can be written
per store without enumerating anything.

## 4. Request paths

### 4.1 Storefront checkout

```
browser → 127.0.0.1:80 → kind extraPortMapping → node :80 (hostPort)
        → Traefik → Ingress(store.urumi.local) → wordpress Service → pod
        → MariaDB (order row)
```

### 4.2 A tool call from an external client

```
Claude Code                                 gateway                    woo-mcp
   │  POST /mcp  tools/call                    │                          │
   │  Authorization: Bearer urumi_<id>_<sec>   │                          │
   ├──────────────────────────────────────────►│                          │
   │                                     1. sha256(secret) → api_keys     │
   │                                     2. key revoked? → reject         │
   │                                     3. rate bucket (Postgres)        │
   │                                     4. split "woo__list_orders"      │
   │                                     5. permission check (role×tool)  │
   │                                     6. pool.get("woo") + credential  │
   │                                        ──────────────────────────────►│
   │                                        (AbortController, 20s)        │ WC REST v3
   │                                        ◄──────────────────────────────│
   │                                     7. audit row: user, server,      │
   │                                        tool, duration, outcome       │
   │◄──────────────────────────────────────────│                          │
```

Steps 1–5 all happen before anything leaves the gateway. The client's bearer token is
**never** forwarded upstream — it identifies the caller to us and means nothing to woo-mcp.
Forwarding it would make the gateway a confused deputy.

### 4.3 The chat agent

The agent does not get a privileged internal path. It mints a short-lived, user-scoped API
key and connects to the gateway's **own** `/mcp` over loopback — the identical code path an
external client uses. So the permission filter and the audit row are the same code, and
attribution is not a special case that could silently be wrong.

## 5. Component inventory

| Component | Image | Probes | State | Exposed |
| --- | --- | --- | --- | --- |
| mariadb | `mariadb:11.8.4` | `mariadb-admin ping` ×3 | PVC 8Gi | no |
| wordpress | `wordpress:6.9.1-php8.4-apache` | ready `/wp-login.php`, live `/` | PVC 4Gi (`wp-content`) | `store.urumi.local` |
| woo-mcp | built here | `/readyz`, `/healthz` | none | **no** |
| postgres | `postgres:18.2-alpine` | `pg_isready` ×3 | PVC 8Gi | no |
| gateway | built here | ready `/readyz`, live `/healthz` | none (Postgres) | `/api`, `/mcp` |
| dashboard | nginx-unprivileged + static build | `/` | none | `/` |
| notes-mcp | built here | `/readyz`, `/healthz` | PVC 1Gi | no |
| everything-mcp | pinned Dockerfile around the npm package | `/readyz`, `/healthz` | none | no |

`woo-mcp` reaches WordPress over the WooCommerce REST API (`wc/v3`) with a mounted
application password; [6.13](#613-woo-mcp-reaches-the-store-over-the-woocommerce-rest-api-not-wp-cli)
says why that rather than WP-CLI, and what it costs.

## 6. Design decisions and what the alternative would have cost

### 6.1 Stateless Streamable HTTP for the gateway's MCP server

A fresh `McpServer` and `StreamableHTTPServerTransport` per request, with no session-id
generator.

**Alternative:** session mode, which the SDK also supports and most examples use.
**Cost:** sessions live in one replica's memory, so two replicas need either sticky
sessions at the ingress or a shared session store. Both are infrastructure bought to solve
a problem created by a choice. Stateless means N replicas work with no coordination — which
is why the gateway runs two replicas *locally*, so any accidental in-memory state fails on
a laptop rather than in production.

**What it costs us:** no server-initiated notifications to a specific session. We do not
need them.

### 6.2 Tool names are namespaced `<serverSlug>__<toolName>`

Slug `[a-z0-9-]`, clamped to 60 characters with a hash suffix on overflow, with the reverse
map in Postgres.

**Alternative:** reject a server whose tool names collide.
**Cost:** that makes a tool name in someone else's server a constraint on ours, which is
not a property we control. `notes-mcp` deliberately exposes `list_products` alongside the
WooCommerce server's, so the collision is demonstrable rather than theoretical.

### 6.3 Postgres is the only state store

Tool cache, audit log, identity, permissions, and per-key rate limits as token buckets
updated with an atomic `UPDATE ... RETURNING`.

**Alternative:** Redis for the cache and the rate limiter.
**Cost:** a second stateful component, a second failure mode, a second thing to back up
and explain — to make something faster that is not slow. One database with one durability
story is easier to defend. If rate limiting became a bottleneck, Redis is the fix, and the
atomic-update interface would not change.

### 6.4 Numbered SQL migrations run by an init container

**Alternative:** an ORM with generated migrations.
**Cost:** schema changes become a framework's opinion that I would then have to explain
under questioning. Plain SQL files are reviewable by anyone and the init container makes
ordering explicit.

### 6.5 Upstream credentials are AES-256-GCM encrypted at rest

Key from a Kubernetes Secret, decrypted in-process per request. The API returns
`hasCredential: true` and never the value — the field is write-only even in the UI.

**Alternative:** store them in plaintext in Postgres; it is already a private database.
**Cost:** a Postgres backup, a logging accident, or read access to one table becomes
immediate access to every upstream. Encryption at rest means the blast radius of a database
read is bounded by a Secret the database does not hold.

### 6.6 API keys are stored as `sha256` of the secret half

Format `urumi_<keyId>_<secret>`; the keyId is indexed for lookup and only the secret half
is hashed. Shown to the user exactly once.

**Alternative:** store the key so it can be shown again.
**Cost:** a database read becomes impersonation of every member. The two-part format is
what makes hashing practical — without the keyId you would hash-scan the table on every
request.

**Why sha256 and not argon2id for this one:** an API key is 32 bytes of CSPRNG output, not
a human-chosen password, so there is no dictionary to slow down and a key-stretching
function would just add latency to every single MCP call. Login passwords *are* argon2id,
because those are human-chosen.

### 6.7 Helm library chart, with the mandatory rules enforced by `fail`

**Alternative:** a copied `_workload.tpl` in each chart — which is what the original plan
said.
**Cost:** Helm cannot share a template file between sibling charts, so "shared" means three
copies, which drift the moment one is fixed, with no mechanism to notice. The library chart
also lets the rules *refuse*: `common.resources`, `common.probes` and `common.image` call
`fail` when values are missing, so three mandatory requirements are structural rather than
remembered.

### 6.8 Calico, with kind's default CNI disabled

**Alternative:** default kind, which is what every tutorial does.
**Cost:** the single most expensive mistake available here. Kubernetes accepts a
NetworkPolicy object on any cluster — the API server validates and stores it — and
delegates enforcement entirely to the CNI. kind's kindnet does not implement enforcement.
Every isolation policy in this repo would be accepted, listed by `kubectl`, and ignored.
The requirement would look satisfied and be fiction. `scripts/verify-netpol.ps1` proves
enforcement, and proves it is *selective*, before any application code depends on it.

### 6.9 Traefik, not ingress-nginx

**Alternative:** ingress-nginx, the default choice in every kind tutorial.
**Cost:** the Kubernetes project announced its retirement in November 2025 and archived the
repository in March 2026 — no releases, no patches for new CVEs — and the intended
successor, InGate, was cancelled. Shipping an unmaintained internet-facing proxy alongside
a security posture would be indefensible. Traefik is also k3s's default, so local and
production run one controller and one `ingressClassName`.

The charts emit plain `Ingress` objects with `ingressClassName: traefik`, so nothing is
Traefik-specific and swapping controllers is a values change.

### 6.10 Groq behind a thin `LlmProvider` interface

**Alternative:** call the provider SDK directly from the chat route.
**Cost:** the agent becomes untestable without a network call and unswappable. MCP tool
schemas also need normalising before any provider will accept them — `$ref` stripped,
`type: object` forced, unsupported keywords dropped — and that belongs in one place.

### 6.11 Liveness probes never check a dependency

**Alternative:** point liveness at `/readyz`, which is simpler and very common.
**Cost:** liveness failure *restarts the container*. A liveness probe that checks the
database converts a database blip into an application restart loop — strictly worse than
serving an error page, and it removes the one process that could have recovered. So
WordPress's liveness is `/` (Apache alone) while readiness is `/wp-login.php` (PHP plus
database), and the gateway's `/healthz` checks only the process while `/readyz` checks
Postgres. **Neither touches the upstream MCP servers**: a dead upstream must degrade one
server's tools, not remove the gateway from its Service and take the dashboard down too.

### 6.11a A readiness probe may *report* a dependency, but only on its own budget

**Alternative:** have the readiness handler check the dependency with the same client the
application uses, and simply not let the result affect the status code.
**Cost:** this looks sufficient and is not, and it cost us a real outage of woo-mcp.
Ignoring a dependency in the *status code* only closes one of the two ways a probe can
fail; the other is failing to answer at all. woo-mcp's `/readyz` reports store reachability
as an informational field, but the first version called the store through the ordinary
WooCommerce client — which retries with backoff, because a loaded store deserves patience.
Against an unreachable store it took ~40s to return, and the kubelet's default
`timeoutSeconds` is **1**. The probe timed out, liveness followed, and the pod left its
Service during exactly the outage the design existed to survive.

The rule we now apply to every health endpoint: **a diagnostic must be cheaper than the
deadline of the thing reporting it.** Concretely — a separate single-attempt budget
(`WC_PROBE_TIMEOUT_MS`, 1000ms, capped in the schema so configuration cannot raise it past
the probe timeout), an in-handler ceiling independent of that client, and `timeoutSeconds`
set **explicitly** in values rather than inherited from a 1-second default that appears
nowhere in the manifest. Verified by scaling WordPress to zero: `/readyz` returns 200 in
~1.0s naming the reason, the pod stays Ready, and tool calls return a readable error.

### 6.12 Generated secrets use `lookup` before `randAlphaNum`

**Alternative:** `randAlphaNum` alone, which is the common snippet.
**Cost:** it re-randomises on every `helm upgrade`. For a stateless service that is
surprising; for MariaDB it is slow data loss — the PVC still holds a database whose user has
the old password, the new Secret disagrees, and the pod never becomes ready again.

Volunteered caveat: `lookup` returns empty during `helm template` and `--dry-run`, so
rendered output shows a fresh value each time and a template diff reports those keys as
changed when nothing has. Production therefore supplies secrets out of band via
`existingSecret` and does not rely on generation at all.

### 6.13 woo-mcp reaches the store over the WooCommerce REST API, not WP-CLI

`woo-mcp` calls `/wp-json/wc/v3/products` and `/wp-json/wc/v3/orders` over HTTP Basic,
authenticating with a WordPress **Application Password** mounted as a file at
`/etc/woo-mcp/credentials/app-password` and re-read when its mtime changes, so rotating the
Secret needs no restart.

WP-CLI is not absent from the system — the post-install/post-upgrade bootstrap hook is a
WP-CLI script (`charts/store/templates/bootstrap-configmap.yaml`) that installs core,
activates WooCommerce, sets permalinks, enables Cash on Delivery and issues the application
password. The split is deliberate: **WP-CLI provisions the store once, REST operates it
continuously.** They are different jobs with different trust requirements.

**Alternative:** have the MCP server drive WP-CLI for the tool calls too.

**Cost:** WP-CLI is a *local* tool. It needs the WordPress filesystem and the database
credentials in its own process, and woo-mcp is a separate Deployment. That leaves two ways
to do it and both are worse:

- *Put WP-CLI in woo-mcp.* The container grows PHP, WordPress core and a direct MariaDB
  credential. The MCP server stops being a client of the store and becomes a second writer
  to its database, with a credential far broader than the five tools need.
- *`kubectl exec` into the WordPress pod.* This needs a ServiceAccount with `pods/exec`,
  which is one of the broadest verbs in Kubernetes — it is arbitrary code execution inside
  the target pod. Today **no workload in this system talks to the Kubernetes API at all**,
  no pod mounts a service-account token, and `scripts/verify-security.ps1` asserts both.
  That property would be traded away for a transport choice.

Three more things REST buys that a database-level tool does not:

- **WooCommerce's own logic runs.** `update_order_status` is required to have real effects:
  WooCommerce sends the customer the email for the new status and adjusts stock on
  cancelled/refunded. A direct write sets a column and silently skips both, which looks
  like it worked.
- **A bounded, revocable credential.** An application password is scoped to one WordPress
  user, visible in wp-admin, and revocable there without touching the database. The WP-CLI
  equivalent is the database credential, which cannot be scoped or revoked per consumer.
- **It scales and it is typed.** `wooMcp.replicas: 2` in production is only coherent for a
  stateless HTTP client; a CLI shelling into one WordPress pod is not. And `wc/v3` is a
  versioned JSON contract rather than stdout to be parsed.

**What it costs us,** stated rather than discovered:

- WordPress serves Application Passwords over plain HTTP **only** when
  `wp_get_environment_type()` returns `local`. That is why `wordpress.environmentType` is
  the single most load-bearing value in the local overlay, and why production sets
  `production` and runs TLS end to end. WP-CLI would have sidestepped the whole question.
  (WooCommerce's own Basic auth requires SSL; over plain HTTP it falls back to OAuth 1.0a,
  the documented alternative had Application Passwords been unavailable.)
- A tool call pays an HTTP hop plus a full WordPress bootstrap, where WP-CLI would have
  paid one query. Irrelevant at this scale and worth knowing.
- The REST surface is smaller than WP-CLI's. All five required tools map onto `wc/v3`
  cleanly; a future tool needing something WooCommerce does not expose there would need a
  different answer rather than an extra flag.

## 7. Data model

| Table | Purpose | Notes |
| --- | --- | --- |
| `users` | identity, role | argon2id password hash; role `admin` \| `member` |
| `api_keys` | per-user keys | `sha256` of the secret half, `revoked_at`, `last_used_at` |
| `mcp_servers` | upstream registry | URL, auth type, **encrypted** credential, enabled, timeout |
| `mcp_tools` | tool cache per server | so `tools/list` never blocks on a dead upstream |
| `tool_permissions` | role/user × server × tool | allow/deny, applied to listing *and* calling |
| `audit_log` | one row per `tools/call` | append-only, indexed for the dashboard query |
| `rate_buckets` | per-key token bucket | atomic `UPDATE ... RETURNING`, works across replicas |

## 8. Scaling and statelessness

The gateway runs **two replicas by default in every environment**, including locally. That
is not a flourish — it is a test. The `/mcp` endpoint holds no session state, so any
accidental in-memory state fails immediately on a laptop instead of in production. Each
replica keeps its own MCP client pool; nothing is shared except Postgres.

Rate limits are per-key token buckets in Postgres rather than in memory, specifically so
two replicas cannot each grant a full quota. A PodDisruptionBudget keeps one replica
serving through a node drain.

**What measuring that actually produced**, because three of the four claims above were
not true when first checked:

- Both replicas were scheduled on the **same node**. The spread constraint was
  `whenUnsatisfiable: ScheduleAnyway`, which is a preference the scheduler weighs against
  everything else and loses. Two replicas on one node survive a pod failure and not a node
  failure, which is most of the reason for two. The strictness is now a value:
  `DoNotSchedule` locally where three nodes can satisfy it, `ScheduleAnyway` in production
  where one node cannot.
- Requiring the spread then **deadlocked the rollout**. A spread constraint counts every
  pod matching its selector, including the outgoing ReplicaSet’s, so with two schedulable
  nodes and `maxSurge: 1` the surge pod could never be placed. Fixed with
  `matchLabelKeys: [pod-template-hash]`, which scopes the skew per revision. Worth
  remembering that this cannot happen on a first install - there is no old ReplicaSet to
  collide with - so a constraint that is correct on `helm install` hangs the upgrade after
  it.
- A rolling restart **dropped 3 requests of 276**. Not a bad shutdown: Kubernetes sends
  SIGTERM and removes the pod from the Service endpoints concurrently, so the ingress
  still routes to a pod that has begun draining. A `preStop` sleep of 5s inverts the
  order. Re-measured: **412 of 412 succeeded**.
- Statelessness held without change: `initialize` returns **no** `Mcp-Session-Id`, and 30
  calls from one client split **75 / 136** across the two pods with 31 audit rows all
  `ok`.

Stateful components do not scale horizontally and are not pretended to: MariaDB and
Postgres are single-replica StatefulSets with PVCs. WordPress stays at one replica in
production because `local-path` on a single-node VPS is node-local, not RWX — stated rather
than quietly assumed.

## 9. Failure modes

| Failure | Behaviour |
| --- | --- |
| Upstream unreachable | prober marks it `Unreachable` **with the error reason**; `tools/list` still served from the Postgres cache; a call returns a structured MCP error naming the server |
| Upstream slow | per-server `AbortController` timeout (default 20s), then a circuit breaker after N consecutive failures |
| API key revoked | the next call is rejected; no cache to expire, because the check is a database read |
| Server disabled | its tools vanish from `tools/list` and from the chat agent's tool set in the same request |
| Gateway pod killed | the other replica serves; stateless, so no session is lost |
| Postgres unavailable | gateway fails `/readyz` and leaves its Service; the storefront is unaffected — different namespace, different database |
| Malformed LLM tool call | the tool error is returned to the model, which may retry; the loop is capped |
| Rate limit exhausted | `429` with `Retry-After` |

## 9a. The permission model

A rule in `tool_permissions` names a **subject** - a role or a single user, never both,
enforced by a CHECK constraint - and a **scope**: everything, one server, or one tool on
one server. A bare tool name is rejected by the schema, because this system deliberately
ships two tools called `list_products` and a name alone does not identify one.

Precedence is **specificity first, then subject**:

```
user+tool  >  role+tool  >  user+server  >  role+server  >  user  >  role  >  DENY
```

The alternative - subject first, so any user-level rule beats any role-level one - was
rejected on a single example. With `user=alice -> allow everything` and
`role=member + create_product -> deny`, subject-first lets Alice create products: a broad
convenience grant undoing a narrow deliberate deny. Specificity-first reads as "the
narrowest rule about the thing you are doing wins, and between two equally narrow rules the
one naming you personally wins".

The precedence lives in the `ORDER BY` of a LATERAL subquery, so it exists once and
`tools/list` stays a single query regardless of how many rules there are.

**No matching rule means refused.** The cost is real: register a new upstream and nobody
can call it until a rule exists. The seeded policy grants admins everything, so whoever
registered it can use it and extending access to members is a deliberate act. The reason is
situational rather than a general preference for deny - upstreams here are registered **at
runtime, through an API, by an admin typing a URL**, so under default-allow the instant
anyone adds a server every member can call everything it exposes, including writes nobody
has reviewed.

**One function decides, and both paths use it.** `tools/list` filters with it and
`tools/call` asks it about one tool. Two implementations would drift, and the two failure
modes are not equally visible: visible-but-uncallable is loud, while hidden-but-callable is
silent *and undetectable by testing through the UI*, because the UI never asks for the tool
it was not shown. The call-path check also runs **before** the upstream credential is
decrypted, so a refusal opens no connection and reveals nothing about reachability.

## 10. Local → production

Same charts, different values. The full table is in [../README.md](../README.md); the
mechanism is that `values.yaml` carries everything true in every environment and the two
overlays carry *only* genuine differences. `scripts/lint-charts.ps1` compares the
`(kind, name)` set each overlay renders, so "config only" is checkable rather than
asserted.

One difference is deliberate and the script reports rather than fails on it:
`upstreams/values-prod.yaml` disables everything-mcp, whose `printEnv` and
`longRunningOperation` tools are test fixtures and exactly what you would not leave
registered on a real deployment.

The single most load-bearing value is `wordpress.environmentType: local`. WordPress offers
Application Passwords over plain HTTP only when `wp_get_environment_type()` returns `local`,
and woo-mcp authenticates to the WooCommerce REST API with one. In production it becomes
`production` and the path is TLS end to end. (WooCommerce's own Basic auth requires SSL;
over plain HTTP it falls back to OAuth 1.0a, which is the documented alternative if
Application Passwords were unavailable.)

## 12. How the claims in this document are checked

Every structural claim above has a script behind it, because a design document is the
easiest place in a repository to be confidently out of date. These fail rather than
reassure, and all three were green at the last run.

| Script | Claim it checks | Result |
| --- | --- | --- |
| `verify-netpol.ps1` | NetworkPolicy is enforced **and** selective | pass |
| `verify-upstream-isolation.ps1` | no upstream is reachable except from the gateway, every negative paired with a positive control | pass |
| `verify-security.ps1` | non-root, read-only root, dropped capabilities, resource limits, default-deny in all three namespaces, no mounted API tokens, no RBAC, no literal secrets, probes, exactly two Ingress objects | **71 checks, 0 failures** |
| `verify-prod-parity.mjs` | `values-prod.yaml` changes configuration only, field path by field path | **12 checks, 0 failures** |
| `verify-upgrade-rollback.ps1` | upgrade then rollback with every row, hash and PVC uid unchanged | **10 checks, 0 failures** |

The parity check deserves a note on what it means, because the obvious reading is wrong.
"Only config changed" does not mean the two renders are identical - they must differ, or
the overlay does nothing. It means **no object has a different shape**: the same objects,
each with the same containers, volumes, mounts, probes and fields, with only the leaf
values differing. So it compares field *paths* rather than values, and differences that are
themselves configuration - the TLS block, the cert-manager annotation, externally managed
Secrets, the disabled reference server - are declared with reasons. Anything undeclared
fails.

## 11. Known gaps and what I would build next

- **Multi-store provisioning** (the bonus) is out of the twelve-day scope.
  Namespace-per-store is already the layout, so a provisioner is additive.
- **OAuth on the gateway** and **hosted-server-by-container-image** are documented, not
  built.
- **No paid VPS deployment.** `values-prod.yaml` plus the k3s runbook make the path real
  and reviewable; actually renting a VPS is about a one-day add-on.
- **Single-replica datastores.** Correct for this scope; a real deployment wants replication
  and a tested restore, not just a PVC.
- **Prometheus and Grafana are not deployed.** The gateway exposes `/metrics` with
  `prom-client` and the series exist - tool calls by outcome, a duration histogram, upstream
  up/down, tool counts per server, probe freshness, audit-write failures, swept chat keys -
  but nothing scrapes them and there are no alert rules. The series were chosen so that a
  stalled prober is visible (a freshness timestamp, not a counter), which is the part that
  needed thinking about; wiring a scraper is configuration.
- **Chat sidesteps the rate limit.** The bucket is keyed on the API key and a key is minted
  per chat message, so every message starts with a full allowance. Per-key was the
  specification and this is the gap between it and the intention. The fix is a per-user
  bucket, which needs a schema change and carries a real question with it: should a person’s
  chat and their external client share one allowance or have separate ones?
- **Prompt-injection defence reduces accidents; it is not a boundary.** A note-body injection
  was reported to the user rather than obeyed, twice. A hostile tool *description* succeeded
  until a structural check was added - and that check is a substring match on tool names, so
  an oblique reference would not trip it. What bounds a success is the architecture: the agent
  holds an ordinary key through the ordinary path, so it cannot exceed the user driving it.
- **No browser testing.** The dashboard and chat were verified against API payloads, the shipped
  bundle inside the running pod, and the CSS. The pages serve and the SSE event contract is
  checked against the code that consumes it; nothing has been looked at by a human.
