# Worst-case data for the dashboard

`worst-case-data.sql` inserts the realistic worst case for every free-text field the
dashboard renders, so the UI can be checked against hostile data instead of the kind
data a seed script produces. It was written for step 7.5 and found three bugs.

It is a **development tool**, not part of any chart or deploy path. It writes directly to
Postgres rather than going through the API, which is the point: the API's zod limits are
not a guarantee about what the dashboard receives, because every text column in the
schema is unbounded `text`. Running it proved that - a server name came back from
`/api/servers` at **234 characters** against a zod maximum of 200.

## Run it

```powershell
kubectl exec -i -n urumi-platform platform-postgres-0 -- `
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U urumi -d urumi -qX -f -' `
  < scripts/dev/worst-case-data.sql
```

## Clean up

It creates one upstream with the slug `wc` and four tools under it, plus three audit
rows. Remove them with:

```sql
DELETE FROM audit_log WHERE server_slug = 'wc';
DELETE FROM mcp_tools WHERE server_id = (SELECT id FROM mcp_servers WHERE slug = 'wc');
DELETE FROM mcp_servers WHERE slug = 'wc';
```

Leave it cleaned up. A fake upstream named
`UnternehmensdienstleistungsgesellschaftUnternehmens…` showing as Unreachable on the
Servers page is exactly the kind of thing that ends up in a demo video.

## What it covers, and what it found

| Field | Worst case | Limit, and where | Result |
| --- | --- | --- | --- |
| `server.name` | 234 chars, one unbroken token | zod 200; column `text` | held (`truncate`) - and proved the DB accepts more than the API |
| `server.url` | 160 chars, no spaces, query string | zod 2048 | held (`break-all`) |
| `server.lastError` | the longest real failure sentence | ~200 in `pool.ts` | held (`break-words`) |
| `tool.name` | 59 chars prefixed | 60 in `naming.ts` | held (`break-all`) |
| `tool.title` | 59 chars; also 1 char; also absent | **unbounded** | held, no orphaned line when absent |
| `tool.description` | 3,984 chars | **unbounded** | clamped at 3 lines; see the gap below |
| `tool.title` | `ツール設定 — Configuración 🔧` | — | held |
| `audit.errorMessage` | 2,037 chars, unbreakable 105-char tail | 2000 in `audit.ts` | held (`line-clamp-3` + `break-words`) |
| `audit.durationMs` | 1ms / 9,999ms / 120,000ms | — | **broke**: 9,999ms rendered "10.00s" beside 10,000ms as "10.0s" |
| `key.ownerEmail` | 88 chars, no spaces | zod 320 | **broke**: no break opportunity, overflowed the card |
| `audit` total count | exactly 1 | — | **broke**: "1 calls" |

## The gap it named and did not fix

`tool.title`, `tool.description` and `tool.upstreamName` have **no length limit** in zod,
in the database, or in the prober. They are the only rendered fields that come from a
third party rather than from an admin, and step 5.2 stores them verbatim on purpose, so
a verbose or hostile upstream controls their size. The dashboard clamps them visually,
but `/api/tools` still transfers them in full on every page load: 25 tools came to
21.3 kB with one 4,000-character description among them.

Capping what is stored is a change to the gateway rather than the dashboard, and it
belongs in the security sweep of step 9.4 alongside the other input-size limits - noted
there rather than fixed here, so that 7.5 stays a states pass.
