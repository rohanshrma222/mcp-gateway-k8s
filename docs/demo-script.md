# Demo script

Shot-by-shot runbook for the demo video. Target length **12–15 minutes**.

The brief names six topics that must be covered. Each section below maps to one, and the
mapping is deliberate so nothing gets lost in editing:

| § | Required topic |
| --- | --- |
| 2 | System design, plus the live definition of done with two users |
| 3 | Kubernetes: what runs where, probes, limits, public vs internal and how it is enforced |
| 4 | MCP internals: connection, call path, collisions, timeouts, dead upstream |
| 5 | Security posture: key and credential storage, member limits, malicious upstream |
| 6 | Chat agent: the tool loop and identity |
| 7 | Local → VPS: Helm values, upgrade and rollback |

**Rule for the recording:** every claim is shown, not asserted. If a sentence cannot be
accompanied by something on screen, it belongs in the written docs instead.

---

## 0. Before recording

Run through this list once; it is what turns the demo into a replay rather than a gamble.

```powershell
.\scripts\bootstrap.ps1          # cluster converged, smoke test green
.\scripts\verify-netpol.ps1      # exit 0
.\scripts\lint-charts.ps1        # exit 0
.\scripts\verify-dod.ps1         # stage 9 — the whole definition of done
```

- [ ] Docker Desktop running; `kubectl get --raw=/readyz` returns `ok`
- [ ] Hosts entries present for `store.urumi.local` and `app.urumi.local`
- [ ] Two browser profiles open: **user A** (member) and **admin**
- [ ] A terminal with a large font, Claude Code configured against `app.urumi.local/mcp`
- [ ] MCP Inspector ready in a separate tab
- [ ] One product already in the store, one order already placed (so "before" state exists)
- [ ] Screen recorder set to capture the terminal *and* the browser legibly
- [ ] Rehearse §4.3 and §5.3 — the dead-upstream and permission-denied shots are the two
      where a fumble costs the most credibility

---

## 1. Opening — 45 seconds

One sentence on the problem, then one diagram.

> "If five people on a team want their AI clients to use five internal tools, every person
> configures every server and holds every credential. There is no attribution, no central
> control, and no least privilege. This is one gateway that fixes all four: an admin
> registers each server once, every member gets one URL and one key, and nobody ever sees
> a credential."

Show the architecture diagram from the README. Name the four layers. Do not linger.

---

## 2. System design and the definition of done — 3 minutes

### 2.1 The store works

- Open `store.urumi.local`, add a product to the cart, check out with Cash on Delivery.
- Show the order in `wp-admin`.

### 2.2 Data survives

```powershell
kubectl -n store-default delete pod -l app.kubernetes.io/component=wordpress
kubectl -n store-default delete pod -l app.kubernetes.io/component=mariadb
kubectl -n store-default get pods -w
```

Reload the storefront. The order is still there.

> "Both PVCs. The database and `wp-content`. Deleting the pods is not deleting the data."

### 2.3 User B — an external MCP client

In Claude Code, with **only** a URL and an API key:

- `tools/list` → every tool from every enabled server.
- "What orders came in today?" → the real order from §2.1.
- **One prompt that needs two upstreams:** *"Summarise today's orders and save a note about
  it."* → `woo__list_orders` then `notes__add_note`.

> "Two different servers, one endpoint, one key. The client has no idea there is more than
> one server behind this."

### 2.4 User A — the chat agent

In the dashboard, as a logged-in member: *"Create a product called Demo Mug priced 499."*

Switch to the storefront tab and reload. It is there.

---

## 3. Kubernetes — 2.5 minutes

### 3.1 What runs where

```powershell
kubectl get pods -A -o wide --field-selector metadata.namespace!=kube-system
```

Three namespaces: `urumi-platform`, `store-default`, `mcp-upstreams`. Note the gateway's
two replicas on **different nodes** — that is why the kind cluster has two workers.

### 3.2 Probes and limits on everything

```powershell
kubectl get pods -A -o jsonpath-as-json="{range .items[*]}{.metadata.name}{'\t'}{.spec.containers[*].resources}{'\n'}{end}"
```

Then the point worth making — this is enforced, not remembered:

```powershell
helm template store charts/store --values charts/store/values-local.yaml `
  --set wordpress.probes.liveness=null
```

> ```
> Error: component "wordpress" is missing probes.liveness. Every workload must declare a
> readiness and a liveness probe.
> ```
>
> "Three of the requirements apply to every workload, and I will have nine. So the library
> chart refuses to render one that is missing them. It is not that I remembered — it is
> that it cannot be built wrong."

Also mention: liveness never checks a dependency. WordPress liveness is `/`, readiness is
`/wp-login.php`. A database blip must not become a restart loop.

### 3.3 Public vs internal, and how it is enforced

```powershell
kubectl get ingress -A        # store and app only. No woo-mcp. No upstreams.
```

> "woo-mcp has no Ingress object at all. There is no external route to disable."

Then the enforcement, which is the part most demos skip:

```powershell
# from an unrelated pod
kubectl -n default run probe --rm -it --image=curlimages/curl --restart=Never -- `
  curl -s -m 5 http://woo-mcp.store-default.svc.cluster.local:3000/mcp
# → times out

# from the gateway pod
kubectl -n urumi-platform exec deploy/platform-gateway -- `
  curl -s -o /dev/null -w "%{http_code}" http://woo-mcp.store-default.svc.cluster.local:3000/healthz
# → 200
```

> "And this is only real because of one line in the cluster config. Kubernetes accepts a
> NetworkPolicy on any cluster and delegates enforcement to the CNI — kind's default CNI
> ignores it entirely. I disabled it, installed Calico, and proved enforcement before
> writing any application code."

```powershell
.\scripts\verify-netpol.ps1
```

Show the four-phase table. Point at phase 4.

> "Phases two and three alone would also be true of a firewall that just switches all
> traffic on and off. Phase four is the one that matches the requirement: the unlabelled pod
> is still blocked by the same policy that lets the labelled one through."

---

## 4. MCP internals — 2.5 minutes

### 4.1 How a client connects

Show the gateway `/mcp` endpoint handling `initialize` → `tools/list` → `tools/call`.
Stateless Streamable HTTP: a fresh server and transport per request, no session id.

> "That is what lets two replicas serve the same client with no sticky sessions and no
> shared session store. The scaling property is a consequence of the transport choice."

### 4.2 Collisions

```
woo__list_products
notes__list_products
```

> "Both servers expose `list_products`. notes-mcp does it on purpose, so the collision is
> demonstrable instead of theoretical."

Call each. Show the different results.

### 4.3 Timeout and dead upstream

**Timeout** — call `everything__longRunningOperation`:

> "Per-server `AbortController`, twenty seconds, and the error names the server rather than
> leaking a stack trace."

**Dead upstream** — and this is the shot to rehearse:

```powershell
kubectl -n mcp-upstreams scale deploy/upstreams-notes-mcp --replicas=0
```

Then, in order:

1. Dashboard → the server shows **Unreachable with the reason**, not just red.
2. `tools/list` in Claude Code → **still works**, served from the Postgres cache.
3. The other servers' tools → still callable.
4. Scale back up → recovers on the next prober pass.

> "`tools/list` is served from cache specifically so one dead server cannot hang every
> client on the team."

---

## 5. Security posture — 2.5 minutes

### 5.1 Key storage

```sql
SELECT id, key_id, user_id, substring(secret_hash,1,16) AS hash, revoked_at FROM api_keys;
```

> "Only a sha256 of the secret half. A database read gives an attacker nothing usable. The
> key was shown exactly once, at issue."

Revoke it in the UI → next call from that client is rejected.

### 5.2 Credentials have no read path

```
GET /api/servers/woo  →  { "name": "woo", "hasCredential": true, ... }
```

> "There is no endpoint that returns it. Not for a member, not for an admin. It is
> AES-256-GCM encrypted at rest with a key from a Kubernetes Secret, decrypted in-process
> per request. An admin can replace it and cannot retrieve it."

### 5.3 Member limits — both halves

As a member:

1. `tools/list` → `woo__create_product` is **absent**.
2. Call it by name anyway → **rejected**, distinct error.

> "Hiding it from the list is usability. The rejection is the control — an attacker just
> types the name."

### 5.4 Malicious upstream

Call `everything__printEnv`.

> "This server is in the stack on purpose. A stack where every server is mine would not
> demonstrate this at all. The gateway sends an upstream its own credential and nothing
> else — no client token, no gateway environment, no other server's credential."

Then SSRF:

- Try to register `http://169.254.169.254/` → **rejected**, with a clear reason.

> "Registering an upstream hands the server a URL it will fetch from inside the cluster.
> That is an SSRF primitive by design, so all addresses are resolved and loopback, private,
> link-local and CGNAT ranges are refused — and re-validated at call time, because
> validating once lets DNS rebinding through."

### 5.5 Audit

The Audit page, filtered. Every action from §2 through §5 is there: user, server, tool,
duration, outcome — including the **denied** and **timeout** rows.

> "A rejection is as visible as a success. An audit log that only records successes tells
> you nothing about an attack."

---

## 6. The chat agent — 1.5 minutes

Ask something needing two tools. Show the inline trace:

```
called woo__list_orders (320ms, ok)
called notes__add_note  (41ms, ok)
```

Then the identity point, which is the one that matters:

> "The agent does not get a privileged internal path. It mints a short-lived user-scoped
> key and connects to the gateway's own `/mcp` over loopback — the identical code path
> Claude Code uses. So the permission filter and the audit row are the same code, and the
> attribution is not a special case that could quietly be wrong."

Show the audit row: the **real user**, with `actor=chat`.

Then the honest note on injection:

> "Tool descriptions and results come from servers I may not control, and they are fed to a
> model that can call tools. I label them as untrusted and cap the loop, but the defence
> that actually holds is that the tool set is permission-filtered server-side before the
> model ever sees it. The model is not the security boundary. The gateway is."

---

## 7. Local → VPS — 1.5 minutes

### 7.1 Only config differs

```powershell
helm template store charts/store --values charts/store/values-local.yaml > local.yaml
helm template store charts/store --values charts/store/values-prod.yaml  > prod.yaml
code --diff local.yaml prod.yaml
```

> "Same templates, same object set. StorageClass, registry, digest pinning, TLS, hostnames,
> secret strategy. No resource appears in one and not the other — and the lint script checks
> that, so it is not a promise."

Mention Traefik: k3s ships it by default, so local and production run the same controller
and the same `ingressClassName`.

### 7.2 Upgrade and rollback

```powershell
helm upgrade store-default charts/store --values charts/store/values-local.yaml `
  --set wordpress.image.tag=<new>
kubectl -n store-default rollout status deploy/store-default-wordpress
# storefront still serving, order still present

helm rollback store-default
kubectl -n store-default rollout status deploy/store-default-wordpress
# order still present
```

> "No data loss in either direction. The PVCs are not touched by either operation, and the
> generated secrets are looked up rather than regenerated — which is the reason an upgrade
> does not lock the database out of its own volume."

---

## 8. Closing — 45 seconds

Three sentences, no new material:

1. What is built, briefly.
2. **One honest gap**, named without being asked — prompt injection is bounded, not solved;
   there is no CI image scanning; the datastores are single-replica.
3. What I would build next: the multi-store provisioner, since namespace-per-store is
   already the layout.

> "The thing I would most want to be asked about is the one line that disables kind's
> default CNI. Everything described as isolation in this project is downstream of it being
> real, and that is why it was the first thing I proved."

---

## Shot list

| # | Shot | Topic | Est. |
| --- | --- | --- | --- |
| 1 | Problem + diagram | 1 | 0:45 |
| 2 | Checkout, delete pods, data survives | 2 | 1:15 |
| 3 | Claude Code: two-upstream prompt | 2 | 1:00 |
| 4 | Chat: create product → storefront | 2 | 0:45 |
| 5 | `pods -A -o wide`, replicas on two nodes | 3 | 0:30 |
| 6 | `helm template` guardrail failure | 3 | 0:45 |
| 7 | No Ingress; curl refused then 200; `verify-netpol.ps1` | 3 | 1:15 |
| 8 | Stateless transport; collisions | 4 | 1:00 |
| 9 | Timeout; kill notes-mcp; `tools/list` still works | 4 | 1:30 |
| 10 | `api_keys` table; revoke → rejected | 5 | 0:45 |
| 11 | `hasCredential: true`; member denied twice over | 5 | 0:45 |
| 12 | `printEnv`; SSRF rejection | 5 | 1:00 |
| 13 | Audit page with denied and timeout rows | 5 | 0:30 |
| 14 | Chat tool trace + audit attribution | 6 | 1:30 |
| 15 | local vs prod template diff | 7 | 0:45 |
| 16 | upgrade then rollback, data intact | 7 | 0:45 |
| 17 | Closing, including a named gap | — | 0:45 |
| | | | **~15:00** |

Over by a minute or two: cut shot 8 to a sentence over the architecture diagram, and
compress shot 2's pod deletion to a single pod.
