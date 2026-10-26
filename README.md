# Urumi — WooCommerce hosting + team MCP gateway on Kubernetes

A WooCommerce store running on Kubernetes, a WooCommerce MCP server that exposes it as
tools, and a gateway that lets a whole team's AI clients reach every registered MCP server
through **one URL and one API key** — without ever handing those users an upstream
credential.

Everything runs on a local `kind` cluster and deploys to a k3s VPS with the **same Helm
charts** and different values.

---

## Status

Everything described below is built and running on a local kind cluster. The claims are
checked by scripts rather than asserted - `verify-security.ps1` passes 71 checks,
`verify-prod-parity.mjs` 12, and `verify-upgrade-rollback.ps1` 10, all with zero failures.
What is **not** done is listed under [Known gaps, honestly](#known-gaps-honestly); the demo
video is the one deliverable still outstanding.

What works today, end to end on a local kind cluster:

- A WooCommerce storefront at `store.urumi.local` you can check out on, with MariaDB and
  `wp-content` on PVCs that survive pod deletion.
- A WooCommerce MCP server with five tools, reachable **only** by the gateway - it has no
  Ingress object at all, and a NetworkPolicy admits only the gateway's pods.
- A gateway exposing **one** MCP endpoint at `http://app.urumi.local/mcp` that an external
  client reaches with nothing but a URL and an API key. Tools from every enabled upstream
  appear under it, namespaced `<server>__<tool>`. The WooCommerce server is pre-registered
  by the chart, so a fresh install has it without a manual step.
- Dashboard login with argon2id passwords and role guards, per-user API keys stored as
  `sha256` and revocable, and upstream credentials encrypted with AES-256-GCM that the API
  never returns.
- **Three** upstream MCP servers behind one endpoint, 21 tools in total: the WooCommerce
  server, a team notes server (ours, exposing `list_products` on purpose so it *collides*
  with the shop one and the `<server>__<tool>` naming can be shown working), and the
  third-party reference "everything" server, vendored as a pinned dependency rather than
  pulled as an image. None has an Ingress; all three are reachable only from the gateway.
- Two gateway replicas, both serving `/mcp` with the same key, because the endpoint is
  stateless - no session id is issued, which is checked rather than claimed. Stopping an
  upstream leaves `tools/list` working and returns a readable error that names the server.
- A **React dashboard** at `app.urumi.local` with seven working pages: servers (status with
  the failure reason, add/edit/disable, a write-only credential field), tools, members,
  permissions, API keys, the audit log, and chat.
- An **in-dashboard chat agent** that calls tools as the signed-in user. It is an MCP
  *client* to the gateway's own `/mcp`, holding a key minted for that one message and
  revoked when it ends - so it is indistinguishable from an external client and cannot
  exceed the person driving it. Every call is traced in the UI as
  `called woo__list_orders (132ms, ok)` and recorded in the audit log with `actor=chat`.
- **Per-tool permissions**: admins full, members read-only. A tool a user may not call is
  both hidden from `tools/list` and refused on a direct call, decided by one function so
  the two cannot disagree. No matching rule means refused.
- **Per-key rate limiting**: a token bucket in Postgres - not in memory, because two
  replicas would otherwise give each client its allowance twice - returning 429 with
  `Retry-After`.
- **An audit log** of every tool call with the user, server, tool, duration and outcome,
  filterable in the dashboard and queryable with keyset pagination.

### The scripts

Every claim this README makes has a script behind it, which is the point - a README is the
easiest place in a repository to be out of date, and these fail rather than reassure.

| Script | What it proves |
| --- | --- |
| `scripts/bootstrap.ps1` | builds the kind cluster, installs Calico and Traefik, proves the ingress path |
| `scripts/deploy-local.ps1` | builds and loads all five images, deploys all three charts, forces a rollout so a code-only change actually ships |
| `scripts/verify-netpol.ps1` | NetworkPolicy is enforced **and** selective - a deny that blocked everything would pass a one-sided test |
| `scripts/verify-upstream-isolation.ps1` | five phases proving no upstream is reachable except from the gateway, every negative paired with a positive control |
| `scripts/verify-security.ps1` | **71 checks**: non-root, read-only root, dropped capabilities, resource limits, default-deny in all three namespaces, no mounted API tokens, no RBAC, no literal secrets, probes, exactly two Ingress objects |
| `scripts/verify-prod-parity.mjs` | **12 checks**: `values-prod.yaml` changes configuration only, compared field-path by field-path through kubectl's own parser |
| `scripts/verify-upgrade-rollback.ps1` | **10 checks**: `helm upgrade` then `helm rollback` with every row, hash and PVC uid unchanged |
| `scripts/lint-charts.ps1` | lints and renders all three charts against both overlays, then runs the parity proof |

All three verification gates are green as of the last run: security 71/0, parity 12/0,
upgrade/rollback 10/0.

### Bonus and stand-out items: what was attempted, and where

The brief asks for this list explicitly. Five of the nine stand-out areas are implemented;
the bonus and four others are not, and saying so plainly is cheaper than letting someone
look for them.

**Attempted**

| # | Area | Where it lives |
| --- | --- | --- |
| 2 | **Tool permissions** | `services/gateway/src/auth/permissions.ts` (one `decide()` used by *both* listing and calling), schema `charts/platform/migrations/004_tool_permissions.sql`, API `services/gateway/src/routes/permissions.ts`, UI `services/dashboard/src/routes/Permissions.tsx`, design `docs/system-design.md` §9a |
| 6 | **Security hardening** | SSRF guard on admin-supplied URLs `services/gateway/src/security/ssrf.ts`; upstream credentials AES-256-GCM at rest `services/gateway/src/crypto/credentials.ts`; default-deny NetworkPolicies `charts/*/templates/*-networkpolicy.yaml`; non-root, read-only root, dropped capabilities `charts/common/templates/_security.tpl`; gate `scripts/verify-security.ps1` (71 checks) |
| 7 | **Scaling** | two gateway replicas serving one stateless `/mcp` — no session id is issued (`docs/system-design.md` §6.1); per-key token-bucket rate limiting in Postgres rather than memory, `services/gateway/src/auth/rateLimit.ts` + `migrations/005_rate_buckets.sql` |
| 8 | **Observability** | `services/gateway/src/metrics.ts` (`prom-client`: tool calls, error rate, latency and up/down per server); why an upstream is unreachable is recorded as a reason string by `services/gateway/src/mcp/prober.ts` and shown on the servers page |
| 9 | **Upgrades and rollback** | `scripts/verify-upgrade-rollback.ps1` — `helm upgrade` then `helm rollback` with every row, password hash and PVC uid unchanged (10 checks); narrative in [Deploy to a k3s VPS](#deploy-to-a-k3s-vps) and `docs/demo-script.md` §7 |

On **least-privilege RBAC** (part of #6): the strongest form available was to need none.
No workload in this system talks to the Kubernetes API, no pod mounts a service-account
token, and `verify-security.ps1` asserts both rather than trusting it. See
`docs/system-design.md` §6.13 for the transport decision that kept it that way.

**Not attempted**

| # | Area | Why not |
| --- | --- | --- |
| — | **Bonus: multi-store provisioning** | Out of the twelve-day scope. The charts are shaped for it — one namespace and one `store-*` release per store, so it would be a second release rather than a rewrite — but shaping for it is not doing it |
| 1 | Production-like VPS deploy | `values-prod.yaml` exists and `scripts/verify-prod-parity.mjs` proves it changes configuration only, field path by field path. **Never deployed to a real k3s box.** A template diff is not a deploy |
| 3 | OAuth on the gateway | API keys only |
| 4 | Handling many tools | 21 tools across three servers fit in a model's context, so the problem is not yet real here. A search-then-execute tool would be the approach |
| 5 | Hosted MCP servers by image | Admins add upstreams by URL, not by container image |

### Known gaps, honestly

Stated here rather than left to be discovered:

- **Never deployed to a real k3s VPS.** `verify-prod-parity.mjs` proves the manifests differ
  only in configuration and `values-prod.yaml` carries an executable secret runbook, but a
  template diff is not a deploy. Renting a server was out of scope from the plan onward.
  Tracing what *would* happen found three things that have since been fixed: the five
  images were never published anywhere a VPS could pull them, `global.imageRegistry` was
  rewriting the stock wordpress/mariadb/postgres images into a namespace nobody publishes,
  and `environmentType: production` broke woo-mcp's application-password auth because its
  hop to WordPress does not go through the ingress that terminates TLS. All three were
  found by reading the rendered prod manifests rather than by deploying, which is the
  limit of what that method catches — a real deploy would still be the first time
  anything runs.
- **Prometheus and Grafana are not deployed.** The gateway exposes `/metrics` with
  `prom-client` and the series are there; nothing scrapes them, and there are no alert
  rules.
- **Chat sidesteps the rate limit.** The bucket is per key and a key is minted per message,
  so every message starts with a full allowance. Per-key was the specification and this is
  the gap between it and the intention; the fix is a per-user bucket and needs a schema
  change.
- **Prompt-injection defence reduces accidents, it is not a wall.** A note-body injection
  was reported to the user rather than obeyed; a hostile *tool description* succeeded until
  a structural check was added, and that check is a substring match on tool names - an
  oblique reference would not trip it. What bounds a success is the architecture, not the
  prompt.
- **The schema does not roll back.** Migrations are forward-only. Safe for all nine here,
  which are additive; not safe for one that dropped a column.
- **Postgres is a single replica with no replication**, and the dashboard runs one pod. The
  gateway scales horizontally and its state does not.
- **No browser testing.** The dashboard and chat were verified against API payloads, the shipped
  bundle inside the running pod and the CSS. The pages serve and the event contract is
  checked; nothing has been looked at by a human.

---

## Architecture

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

Four layers:

1. **Store** — WordPress + WooCommerce, PVCs for the database and `wp-content`.
2. **WooCommerce MCP server** — written here, Streamable HTTP, five tools. **No Ingress**,
   plus NetworkPolicy: unreachable from outside the cluster.
3. **Gateway + dashboard** — the gateway is an MCP *client* to every upstream and itself an
   MCP *server* on one endpoint. It owns users, roles, hashed revocable API keys, the
   upstream credentials, per-tool permissions and the audit log.
4. **Chat agent** — in-dashboard chat that calls tools through that same endpoint as the
   logged-in user.

Design rationale and the tradeoffs behind each choice: **[docs/system-design.md](docs/system-design.md)**.
Threats and mitigations: **[docs/threat-model.md](docs/threat-model.md)**.

---

## Prerequisites

| Tool | Version used | Notes |
| --- | --- | --- |
| Docker Desktop | current | must be running; the cluster nodes are containers |
| kind | v0.33.0 | `winget install Kubernetes.kind` |
| kubectl | matching 1.36 | ships with Docker Desktop |
| Helm | v4.2.0 | Helm only — no Kustomize |
| Node | >= 24 | `.nvmrc` pins 24 |
| npm | 11.12.1 | workspaces over `services/*` |
| PowerShell | 5.1 or later | the scripts are PowerShell; Windows-hosted |

Roughly 8 GB of free RAM and host ports 80 and 443 unoccupied.

Starting from a machine with none of these installed? [docs/commands.md](docs/commands.md)
Step 1 has the `winget` line for each one.

---

## Local setup

```powershell
git clone https://github.com/rohanshrma222/mcp-gateway-k8s.git
cd mcp-gateway-k8s
npm install
```

### 1. Build the cluster

```powershell
.\scripts\bootstrap.ps1
```

Idempotent — safe to re-run; it reuses an existing cluster and skips installed add-ons.
It creates a 3-node kind cluster with **the default CNI disabled**, installs Calico,
installs Traefik on the node that holds the host port mappings, and then proves the path
works by fetching `http://127.0.0.1/` and requiring a **404 from Traefik** (the router
answered; it has no routes yet).

| Flag | Effect |
| --- | --- |
| `-Recreate` | delete and rebuild the cluster — **destroys all PV data** |
| `-WriteHosts` | also write the hosts entries (needs an elevated shell) |
| `-SkipIngress` | cluster + CNI only |
| `-ClusterName <n>` | default `urumi` |

### 2. Add the hostnames

Two names must resolve to `127.0.0.1`. Either run `bootstrap.ps1 -WriteHosts` from an
**Administrator** shell, or add these to `C:\WINDOWS\System32\drivers\etc\hosts` yourself:

```
127.0.0.1 store.urumi.local
127.0.0.1 app.urumi.local
```

No hosts-file access? Use `nip.io` instead and override the chart values:
`--set store.host=store.127.0.0.1.nip.io`.

### 3. Verify the cluster

```powershell
.\scripts\verify-netpol.ps1     # NetworkPolicy really is enforced   (exit 0 = yes)
.\scripts\lint-charts.ps1       # all charts lint and render, both overlays
kubectl get nodes               # 3 Ready
kubectl get tigerastatus        # Calico: all Available
```

`verify-netpol.ps1` is a gate, not a formality. Every isolation requirement here depends on
NetworkPolicy being enforced, and Kubernetes does not enforce it — the API server stores
the object and delegates enforcement to the CNI. kind's default CNI ignores it. The script
stands up three pods and checks four things in order: traffic flows with no policy
(so the probe is known good), a default-deny blocks it, a selector policy re-opens it for a
labelled pod, and an **unlabelled** pod is *still* blocked by that same policy. The last
phase is the one that matches the requirement — not "traffic is restricted" but "only the
gateway gets through".

### 4. Deploy the application

```powershell
.\scripts\deploy-local.ps1
```

Builds all five images, loads them into the kind cluster, and installs the three charts in
dependency order. Idempotent - safe to re-run after any change. Pass `-SkipImages` when only
chart values changed.

It exists rather than being a list of commands here for a reason worth stating: the
`mcp-upstreams` namespace used to exist only because somebody had created it by hand, so
every chart was correct and a fresh clone still could not deploy. The end-to-end path was
never the thing being run, so it rotted unnoticed. This script *is* that path.

The equivalent by hand, if you would rather see it:

```powershell
# Order matters: the platform chart pre-registers every upstream above it.
foreach ($r in @(
  @{ n='store-default'; c='charts/store';     ns='store-default'  },
  @{ n='upstreams';     c='charts/upstreams'; ns='mcp-upstreams'  },
  @{ n='platform';      c='charts/platform';  ns='urumi-platform' }
)) {
  helm dependency build $r.c
  helm upgrade --install $r.n $r.c --namespace $r.ns --create-namespace `
    --values "$($r.c)/values-local.yaml" --wait --timeout 10m
}
```

Then prove the isolation requirement holds:

```powershell
.\scripts\verify-upstream-isolation.ps1
```

Five phases, exit 0 only if all pass: no Ingress references any MCP server; the gateway can
reach all three; an unlabelled pod in an unrelated namespace can reach none of them; our two
own upstreams can reach nothing but DNS; and the upstreams cannot reach each other. Each
negative has a control check beside it, so "blocked" can never be confused with "broken".

---

## Deploy to a k3s VPS

The same three charts with `values-prod.yaml`. **Proved config-only**, not asserted:
`node scripts/verify-prod-parity.mjs` renders both overlays, parses them through kubectl,
and compares the field paths of every shared object - 12 checks, 0 failures. Differences
that are themselves configuration (the TLS block, the cert-manager annotation, externally
managed Secrets, the disabled reference server) are declared there with reasons, and
anything undeclared fails.

**First publish the images.** `values-prod.yaml` sets `global.imageRegistry` and
`imagePullPolicy: Always`, so a VPS pulls the five images this repo builds rather than
finding them in the node the way kind does. Nothing publishes the `dev` tag, so an install
against unpublished images is an `ImagePullBackOff` on every workload.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

That runs `.github/workflows/publish-images.yml`, which builds woo-mcp, notes-mcp,
everything-mcp, gateway and dashboard and pushes them to
`ghcr.io/<owner>/urumi/<name>:v0.1.0`. The three prod overlays pin that same tag; change it
in all three when you cut a different release, or paste the digests the workflow prints if
you want them immutable. The stock images (wordpress, mariadb, postgres, wp-cli) carry an
explicit `registry: docker.io` so the global registry never rewrites them.

**Then make the five packages public.** GHCR publishes privately by default, and these
charts define no `imagePullSecrets`, so an otherwise correct install fails with `401
Unauthorized` on every pod. On github.com: *Profile → Packages → `urumi/<name>` → Package
settings → Change visibility → Public*, once per image. The alternative is a pull secret
in every namespace, which is three more objects to rotate for a demo deployment.

### Sizing

Summed from the prod render, requests only, long-running pods:

| Workload | Replicas | CPU | Memory |
| --- | --- | --- | --- |
| mariadb | 1 | 250m | 1024Mi |
| wordpress | 1 | 250m | 512Mi |
| woo-mcp | 2 | 200m | 256Mi |
| postgres | 1 | 250m | 512Mi |
| gateway | 2 | 500m | 512Mi |
| dashboard | 2 | 50m | 96Mi |
| notes-mcp | 1 | 25m | 64Mi |
| **Total** | | **1525m** | **2976Mi** |

k3s itself adds roughly 500m and 700Mi for Traefik, CoreDNS, metrics-server and the
local-path provisioner. So **4 vCPU / 8GB** is the comfortable size and a 4GB box does not
fit without dropping replicas - and the replica worth keeping is the gateway's, since two
of them serving one stateless `/mcp` is the point of that design.

### If you want the HTTP→HTTPS redirect

`values-prod.yaml` does not set the Traefik redirect annotation, because the annotation
alone does nothing: it names a `Middleware` object that has to exist first. Create it
before adding the annotation back:

```bash
kubectl apply -f - <<'EOF'
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: redirect-https
  namespace: default
spec:
  redirectScheme:
    scheme: https
    permanent: true
EOF
```

Then set, in `charts/store/values-prod.yaml` under `ingress.annotations`:

```yaml
traefik.ingress.kubernetes.io/router.middlewares: default-redirect-https@kubernetescrd
```

Four Secrets have to exist before the platform chart installs. The commands, with the
consequence of each rotation, are in `charts/platform/values-prod.yaml` next to the names
the chart reads - the short version:

```bash
kubectl create namespace urumi-platform

# Rotating this logs everyone out and does nothing worse.
kubectl -n urumi-platform create secret generic urumi-jwt \
  --from-literal=jwt-secret="$(openssl rand -base64 36 | tr -d =)"

# ROTATING THIS DESTROYS every stored upstream credential - they are encrypted under it
# and the PVC outlives the release. Back it up somewhere that is not the cluster.
kubectl -n urumi-platform create secret generic urumi-encryption \
  --from-literal=encryption-key="$(openssl rand -base64 24 | tr -d =)"

# Omit this entirely to run without the chat agent: POST /api/chat answers 503 and
# everything else works.
kubectl -n urumi-platform create secret generic urumi-groq \
  --from-literal=groq-api-key=gsk_...

# The seed Job is idempotent, so changing a password here does NOT rotate an existing
# account - change it in the dashboard instead.
kubectl -n urumi-platform create secret generic urumi-bootstrap \
  --from-literal=admin-email=admin@example.com \
  --from-literal=admin-password="$(openssl rand -base64 18)" \
  --from-literal=member-email=member@example.com \
  --from-literal=member-password="$(openssl rand -base64 18)"
```

Then the same three charts in the same order, with the prod overlay:

```bash
helm upgrade --install store-default charts/store  -n store-default  --create-namespace -f charts/store/values-prod.yaml
helm upgrade --install upstreams    charts/upstreams -n mcp-upstreams --create-namespace -f charts/upstreams/values-prod.yaml
helm upgrade --install platform     charts/platform -n urumi-platform --create-namespace -f charts/platform/values-prod.yaml
```

One setting differs on a single-node VPS and is worth knowing about:
`gateway.topologySpreadStrictness` stays `ScheduleAnyway` in production. On the three-node
local cluster it is `DoNotSchedule`, which genuinely spreads the two replicas across nodes;
requiring that on one node would leave the second replica `Pending` forever.

The same three charts, with `values-prod.yaml` instead of `values-local.yaml`. Nothing
structural differs; `scripts/lint-charts.ps1` compares the set of objects each overlay
renders so that claim stays checkable rather than asserted.

| | local | production |
| --- | --- | --- |
| storageClass | `standard` (kind) | `local-path` (k3s) |
| imageRegistry | *empty* — images are `kind load`ed | `ghcr.io/rohanshrma222` |
| image pinning | tag | digest |
| TLS | off (hosts-file names; no CA would issue) | cert-manager + `letsencrypt-prod` |
| hostnames | `*.urumi.local` | real DNS |
| secrets | generated and kept via Helm `lookup` | `existingSecret`, created out of band |
| ingress controller | Traefik | Traefik — **k3s ships it by default** |

The ingress controller being the same in both is deliberate: local and production run one
controller and one `ingressClassName`, so the "config changes only" property is real.

---

## How to use it

In the order a reviewer would actually do it. Each step says what you should see, so a
wrong result is recognisable as one.

### 1. Get the two logins

Nothing is hardcoded, so the passwords are generated in the cluster on first install and
read back from the Secret:

```bash
# dashboard - admin, then member
kubectl get secret -n urumi-platform platform-bootstrap -o jsonpath='{.data.admin-password}' | base64 -d
kubectl get secret -n urumi-platform platform-bootstrap -o jsonpath='{.data.member-password}' | base64 -d

# wp-admin, if you want to look at the shop’s own admin (user: admin)
kubectl get secret -n store-default store-default-wordpress -o jsonpath='{.data.wordpress-admin-password}' | base64 -d
```

The accounts are `admin@urumi.local` and `member@urumi.local`. Both matter - the difference
between them is one of the four stand-out areas, and step 5 is where you see it.

### 2. Sign in and look around

Open `http://app.urumi.local` and sign in as **admin**. Seven tabs:

| Tab | What it is | Member sees it? |
| --- | --- | --- |
| **Servers** | the three upstreams, their status and their tools | no |
| **Tools** | all 21 tools as a connected client sees them | yes |
| **Members** | the team, their roles, their keys | no |
| **Permissions** | who may call which tool | no |
| **API keys** | issue and revoke your own keys | yes |
| **Audit** | every tool call, who made it, how long it took | yes |
| **Chat** | the in-dashboard agent | yes |

**On Servers**, all three rows should show a green **Connected** chip: `woo` with 5 tools,
`notes` with 3, `everything` with 13. Expand a row to see each tool.

Worth a look while you are there: **both `woo` and `notes` expose a tool called
`list_products`.** That collision is deliberate. Their full names are `woo__list_products`
and `notes__list_products`, which is how one endpoint carries two servers that disagree
about a tool name.

### 3. Place an order

Open `http://store.urumi.local`, add a product to the cart, check out with **Cash on
Delivery**. Remember what you bought - you will ask the agent about it in step 4.

To confirm it landed, either open `http://store.urumi.local/wp-admin` (user `admin`,
password from step 1) or just ask the chat agent, which is the more interesting check.

### 4. Ask the agent to do something real

**This needs a model key first** - one free key from console.groq.com and one `kubectl`
command, both in [the chat agent section](#the-chat-agent-and-its-model-key) below. Without
it Chat answers 503 and everything else still works.

Then open **Chat** and try these in order. Each tool call appears inline as
`called woo__list_orders (132ms, ok)` with the arguments the model chose.

1. *"How many products are in the store?"* - one upstream, one tool call.
2. *"Check the orders in the store, then save a note recording how many there were."* -
   **two different upstreams in one answer**, which is the brief’s own test.
3. *"Create a product called Test Mug priced 12."* - then reload the storefront. It is
   really there.

Then open **Audit**. Everything above is logged with the tool, the duration, the outcome -
and `actor=chat` **under your own account**, not a service account. The agent acted as you
and the log can prove it.

> Groq’s free tier allows roughly **one complete chat a minute** - see the note at the end
> of this section. If a reply stops with a 429, wait a minute.

### 5. See the permissions working (the part worth doing carefully)

Open a **private window** and sign in as `member@urumi.local`. Then compare:

| | Admin | Member |
| --- | --- | --- |
| Tabs | 7 | **4** - no Servers, Members or Permissions |
| Tools | 21 | **6** |

Now ask the agent, as the member: *"create a product called Sneaky priced 5"*. It answers
that it has no such tool - **not** that permission was denied, because the write tools were
never sent to the model. Check the storefront: nothing was created.

The distinction that matters: hiding a tool is not the control. Calling a hidden tool by
name is also refused, and the refusal is logged with `outcome=denied`, as visibly as a
success. Hiding alone would be cosmetic, because the name is guessable.

### 6. Connect your own MCP client

See [connecting an external MCP client](#connecting-an-external-mcp-client-in-detail)
below - a URL and a key, nothing else. Issue the key on the **API keys** tab; the secret is
shown exactly once because only its `sha256` is stored.


### Connecting an external MCP client, in detail

The WooCommerce server is already registered on a fresh install, so the only thing you need
is a key. Issue one as the seeded admin:

```bash
# the seeded admin password (generated on first install and kept across upgrades)
kubectl get secret -n urumi-platform platform-bootstrap   -o jsonpath='{.data.admin-password}' | base64 -d

# sign in, then issue a key - the secret is shown EXACTLY ONCE and only sha256 is stored
curl -c jar -X POST http://app.urumi.local/api/auth/login   -H 'Content-Type: application/json'   -d '{"email":"admin@urumi.local","password":"<the password above>"}'

curl -b jar -X POST http://app.urumi.local/api/keys   -H 'Content-Type: application/json' -d '{"name":"my laptop"}'
```

From then on a client needs nothing but a URL and that key - no upstream credential ever
leaves the cluster:

```
URL:    http://app.urumi.local/mcp
Header: Authorization: Bearer urumi_<keyId>_<secret>
```

**Claude Code:**

```bash
claude mcp add --transport http urumi http://app.urumi.local/mcp   --header "Authorization: Bearer urumi_<keyId>_<secret>"
```

**MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL:       http://app.urumi.local/mcp
# Header:    Authorization = Bearer urumi_<keyId>_<secret>
```

Both need `app.urumi.local` in your hosts file (see *Add the hostnames* above). To check it
without touching hosts, send the `Host` header yourself:

```bash
curl -s -X POST http://127.0.0.1/mcp -H 'Host: app.urumi.local'   -H 'Content-Type: application/json'   -H 'Accept: application/json, text/event-stream'   -H "Authorization: Bearer urumi_<keyId>_<secret>"   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Every tool from every enabled upstream appears under this one endpoint, namespaced
`<serverSlug>__<toolName>` so two servers exposing `list_products` stay distinguishable.
A revoked key is refused on the next call, and disabling a server removes its tools from
`tools/list` *and* refuses a call that names one.

### The chat agent and its model key

**First, a model key.** The chat agent is the one feature needing an external service. Make
a free key at console.groq.com, then:

```bash
kubectl -n urumi-platform create secret generic urumi-groq \
  --from-literal=groq-api-key=gsk_...
```

`values-local.yaml` already points at that Secret by name, so a redeploy picks it up.
Without it `POST /api/chat` answers **503** with a sentence saying exactly that, and nothing
else is affected — `GROQ_API_KEY` is the only optional secret in the gateway's config
schema, so the platform runs perfectly well without a chat agent.

Then sign in at `http://app.urumi.local`, open **Chat**, and ask for something needing a
tool. Two prompts worth trying:

- *"How many products are in the store?"* — one upstream, one tool call.
- *"Check the orders in the store, then save a note recording how many there were."* — this
  needs **two different upstreams in one answer**, which is the brief's own test.

Every tool call appears inline as `called woo__list_orders (132ms, ok)` with the arguments
the model chose, and lands in the audit log as `actor=chat` under your account — not a
service account. Sign in as the member instead and ask it to create a product: it will say
it has no such tool, because permissions filter what the agent is shown *and*
refuse a direct call either way.

**One practical note.** Groq's free tier allows 8,000 tokens a minute and a single turn
costs about 3,100 — dominated by the 21 tool schemas rather than by the conversation. A
tool-using exchange needs at least two turns, so expect roughly **one complete chat per
minute** before it returns 429. The error is surfaced verbatim, including Groq's own "try
again in 8s". Signing in as a member helps, since a member is sent 6 schemas instead of 21.

---

## Repository layout

```
README.md                  this file
docs/system-design.md      system design and tradeoffs  (deliverable)
docs/threat-model.md       threat model                  (deliverable)
docs/system.md             the six video topics explained, for speaking to
docs/commands.md           every command to run it locally, and what each one does
kind/cluster.yaml          cluster definition, k8s pinned by digest
kind/calico-values.yaml    CNI values — NetworkPolicy enforcement
kind/traefik-values.yaml   ingress controller values
scripts/bootstrap.ps1      cluster + CNI + ingress + smoke test (idempotent)
scripts/deploy-local.ps1   build + load all 5 images, deploy all 3 charts, force the rollout
scripts/verify-netpol.ps1              gate: NetworkPolicy enforced *and* selective
scripts/verify-upstream-isolation.ps1  gate: no upstream reachable except from the gateway
scripts/verify-security.ps1            gate: 71 posture checks against the live cluster
scripts/verify-prod-parity.mjs         gate: values-prod.yaml changes configuration only
scripts/verify-upgrade-rollback.ps1    gate: upgrade + rollback with no data loss
scripts/lint-charts.ps1                gate: lint + render both overlays, then the parity proof
scripts/dev/worst-case-data.sql        injects worst-case data to stress the dashboard
charts/common/             Helm LIBRARY chart — the inherited workload rules
charts/store/              mariadb + wordpress + woo-mcp (one release per store)
charts/platform/           postgres + gateway + dashboard
charts/upstreams/          notes-mcp + everything-mcp
services/                  woo-mcp, notes-mcp, gateway, dashboard (npm workspaces)
package.json               workspaces root, ESM, Node >= 24
tsconfig.base.json         strict shared TypeScript config
```

### Why there is a library chart

Three of the requirements apply to *every* workload: a readiness **and** a liveness probe,
resource requests **and** limits, and a hardened `securityContext`. A rule applied by hand
in nine Deployments is a rule that is missing from the tenth. `charts/common` is a Helm
library chart (`type: library`, installable by nobody) whose partials call Helm's `fail`
when those values are absent:

```
$ helm template demo . --set demo.probes.liveness=null
Error: component "demo" is missing probes.liveness. Every workload must declare a
readiness and a liveness probe (see charts/common/templates/_probes.tpl).
```

The chart does not render, `helm lint` does not pass, and nothing reaches a cluster. The
requirement is enforced by the template rather than by review.

---

## Commands

The short list is below. Every command needed to run this locally, with what each one
actually does and what to do when it fails, is in **[docs/commands.md](docs/commands.md)**.

```powershell
# repo
npm install ; npm run lint ; npm run typecheck ; npm run format

# cluster
.\scripts\bootstrap.ps1
.\scripts\verify-netpol.ps1
.\scripts\lint-charts.ps1
kubectl config use-context kind-urumi
kubectl get tigerastatus
kubectl get --raw=/readyz
kind delete cluster --name urumi

# deploy and prove
.\scripts\deploy-local.ps1                 # build images, install all three charts
.\scripts\deploy-local.ps1 -SkipImages     # charts only
.\scripts\verify-upstream-isolation.ps1    # prove every upstream is gateway-only

# charts
helm dependency build charts/store
helm template store charts/store --values charts/store/values-local.yaml
helm template store charts/store --values charts/store/values-prod.yaml
```

### After a host reboot

The kind containers return with the Docker engine, but the engine does not start with
Windows. Every `kubectl` call failing with `connectex: ... actively refused it` means
Docker Desktop is not running. Start it, wait for **Running**, then confirm with
`kubectl get --raw=/readyz`. Cluster state survives — PVs, Calico and Traefik all come
back without intervention.

---

## Notes

- **No credential is in this repository.** Secrets are Kubernetes Secrets; charts reference
  them by name. Generated passwords use Helm's `lookup` so an upgrade cannot rotate one out
  from under a PVC that still holds data encrypted under the old one.
- **Helm only.** No Kustomize, per the brief.
- The Traefik dashboard is **disabled**: it is unauthenticated by default and would be a
  free read of every route and service in the cluster.
