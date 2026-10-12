# Urumi — WooCommerce hosting + team MCP gateway on Kubernetes

A WooCommerce store running on Kubernetes, a WooCommerce MCP server that exposes it as
tools, and a gateway that lets a whole team's AI clients reach every registered MCP server
through **one URL and one API key** — without ever handing those users an upstream
credential.

Everything runs on a local `kind` cluster and deploys to a k3s VPS with the **same Helm
charts** and different values.

---

## Status

This is built in stages. The table is the honest state of the repository, not the plan.

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Cluster, repo skeleton, NetworkPolicy proof, chart scaffolding | **done** |
| 2 | Store: WordPress + WooCommerce + MariaDB, persistent | not started |
| 3 | WooCommerce MCP server (5 tools, Streamable HTTP) | not started |
| 4 | Gateway: identity, API keys, upstream registry | not started |
| 5 | Aggregation and the single `/mcp` endpoint | not started |
| 6 | Audit log + two more upstreams | not started |
| 7 | Dashboard | not started |
| 8 | Chat agent | not started |
| 9 | Hardening, scale, production story | not started |
| 10 | Docs, demo, submission | not started |

What works today: `scripts/bootstrap.ps1` builds the cluster and proves the ingress path
end to end; `scripts/verify-netpol.ps1` proves NetworkPolicy is enforced *and* selective;
`scripts/lint-charts.ps1` lints and renders all three charts against both value overlays.

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

*Stage 2 onward. This section fills in as the charts gain templates.*

```powershell
# planned
helm dependency build charts/store
helm upgrade --install store-default charts/store `
  --namespace store-default --create-namespace `
  --values charts/store/values-local.yaml
```

---

## Deploy to a k3s VPS

*Planned — Stage 9. The charts are already structured for it.*

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

*These sections fill in as the stages land; each names the stage that delivers it.*

### Place an order — *stage 2*

Open `http://store.urumi.local`, add a product to the cart, check out with Cash on
Delivery, then confirm the order in `wp-admin`.

### Connect an external MCP client — *stage 5*

An admin registers upstream servers in the dashboard. A member is issued an API key, shown
exactly once. The client then needs nothing but a URL and that key:

```
URL:    http://app.urumi.local/mcp
Header: Authorization: Bearer urumi_<keyId>_<secret>
```

Every tool from every enabled upstream appears under one endpoint, namespaced
`<serverSlug>__<toolName>` so two servers exposing `list_products` stay distinguishable.

### Use the chat agent — *stage 8*

Sign in to `http://app.urumi.local`, open Chat, and ask for something that needs a tool
("create a product called X priced Y", "what orders came in today"). The agent connects to
the gateway's own `/mcp` endpoint as the logged-in user, so every call is attributed to
that person in the audit log — not to a service account.

---

## Repository layout

```
README.md                  this file
docs/system-design.md      system design and tradeoffs  (deliverable)
docs/threat-model.md       threat model                  (deliverable)
docs/demo-script.md        runbook for the demo video
kind/cluster.yaml          cluster definition, k8s pinned by digest
kind/calico-values.yaml    CNI values — NetworkPolicy enforcement
kind/traefik-values.yaml   ingress controller values
scripts/bootstrap.ps1      cluster + CNI + ingress + smoke test (idempotent)
scripts/verify-netpol.ps1  gate: NetworkPolicy enforced *and* selective
scripts/lint-charts.ps1    gate: deps + lint + render, both overlays
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
