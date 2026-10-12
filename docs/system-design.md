# System design and tradeoffs

How the system is put together, and — more usefully — what each choice cost.

Sections describing components not yet built are marked **(planned)** and name the stage
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

### 4.1 Storefront checkout **(planned — stage 2)**

```
browser → 127.0.0.1:80 → kind extraPortMapping → node :80 (hostPort)
        → Traefik → Ingress(store.urumi.local) → wordpress Service → pod
        → MariaDB (order row)
```

### 4.2 A tool call from an external client **(planned — stage 5)**

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

### 4.3 The chat agent **(planned — stage 8)**

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

### 6.12 Generated secrets use `lookup` before `randAlphaNum`

**Alternative:** `randAlphaNum` alone, which is the common snippet.
**Cost:** it re-randomises on every `helm upgrade`. For a stateless service that is
surprising; for MariaDB it is slow data loss — the PVC still holds a database whose user has
the old password, the new Secret disagrees, and the pod never becomes ready again.

Volunteered caveat: `lookup` returns empty during `helm template` and `--dry-run`, so
rendered output shows a fresh value each time and a template diff reports those keys as
changed when nothing has. Production therefore supplies secrets out of band via
`existingSecret` and does not rely on generation at all.

## 7. Data model **(planned — stage 4)**

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

Stateful components do not scale horizontally and are not pretended to: MariaDB and
Postgres are single-replica StatefulSets with PVCs. WordPress stays at one replica in
production because `local-path` on a single-node VPS is node-local, not RWX — stated rather
than quietly assumed.

## 9. Failure modes **(planned — stages 5, 6, 9)**

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

## 11. Known gaps and what I would build next

- **Multi-store provisioning** (the bonus) is out of the twelve-day scope.
  Namespace-per-store is already the layout, so a provisioner is additive.
- **OAuth on the gateway** and **hosted-server-by-container-image** are documented, not
  built.
- **No paid VPS deployment.** `values-prod.yaml` plus the k3s runbook make the path real
  and reviewable; actually renting a VPS is about a one-day add-on.
- **Single-replica datastores.** Correct for this scope; a real deployment wants replication
  and a tested restore, not just a PVC.
- **`lint-charts.ps1` compares object sets, not full rendered output.** A tripwire for
  structural drift, not a diff. Stage 9 replaces it with a real one.
