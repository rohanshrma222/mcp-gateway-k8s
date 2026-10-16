/**
 * API keys: issue, list, revoke.
 *
 * A separate page from Members, although step 7.3 names them in one breath, because the two
 * have different audiences. The member list is admin-only; keys are not - a member needing
 * an API key is the brief's own member story, and the constraint on a member is what their
 * key may *do* (stage 9's per-tool permissions), not whether they may have one. So the nav
 * shows this to everyone and Members only to admins, and the API scopes each accordingly:
 * a member sees their own keys, an admin sees everyone's with the owner's address.
 *
 * The plaintext appears in exactly one response and is stored only as a sha256 hash. There
 * is no endpoint that could return it again - which is what makes "shown once" a property of
 * the system rather than a promise this page keeps.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api, ApiError } from '../api/client.js';
import type { ApiKey } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../components/Button.js';
import { Dialog } from '../components/Dialog.js';
import { SecretOnce } from '../components/SecretOnce.js';
import { relativeTime } from '../components/StatusChip.js';
import { EmptyState, ErrorState, LoadingRows } from '../components/states.js';
import { useSession } from '../auth/session.js';

export function Keys() {
  const { session } = useSession();
  const keys = useResource<ApiKey[]>(() => api.keys.list());

  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | undefined>(undefined);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKey | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const revoke = useCallback(
    async (key: ApiKey) => {
      setBusyId(key.id);
      try {
        await api.keys.revoke(key.id);
        await keys.reload();
        toast.success(`Revoked "${key.name}"`);
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : 'Could not revoke that key');
      } finally {
        setBusyId(undefined);
      }
    },
    [keys],
  );

  if (keys.loading) return <LoadingRows rows={2} />;

  if (keys.data === undefined) {
    // No `subject`: this page is open to every role, so a 403 here would mean something
    // genuinely unexpected rather than a member reaching an admin page.
    return (
      <ErrorState
        error={keys.failure ?? keys.error}
        title="Could not load keys"
        onRetry={() => void keys.reload()}
      />
    );
  }

  const active = keys.data.filter((key) => key.revokedAt === null);
  const revoked = keys.data.filter((key) => key.revokedAt !== null);

  return (
    <section>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-50">API keys</h1>
          <p className="mt-1 max-w-prose text-sm text-ink-400">
            {active.length} active{revoked.length > 0 ? `, ${revoked.length} revoked` : ''} ·{' '}
            {session?.role === 'admin' ? "everyone's keys" : 'your keys'}. A key is all an MCP
            client needs — point it at{' '}
            <code className="rounded bg-ink-900 px-1 py-0.5 text-xs text-ink-300">
              /mcp
            </code>{' '}
            with the key as a Bearer token.
          </p>
        </div>
        <Button intent="primary" className="ml-auto" onClick={() => setIssuing(true)}>
          Issue a key
        </Button>
      </header>

      {keys.data.length === 0 ? (
        <Empty onIssue={() => setIssuing(true)} />
      ) : (
        <ul className="space-y-2">
          {/* Active first, then revoked. Revoked keys are kept visible rather than hidden
              because "was this key ever used after I revoked it" is a question somebody
              will ask, and the audit log answers it by key - but only if you can still see
              which key it was. */}
          {[...active, ...revoked].map((key) => (
            <KeyRow
              key={key.id}
              apiKey={key}
              showOwner={session?.role === 'admin'}
              busy={busyId === key.id}
              onRevoke={() => setConfirmRevoke(key)}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={issuing}
        onClose={() => {
          // Cannot be dismissed while the plaintext is on screen - Escape and a backdrop
          // click both arrive here, and either would discard a key that cannot be recovered.
          if (issued === undefined) setIssuing(false);
        }}
        title={issued === undefined ? 'Issue an API key' : `Key "${issued.name}"`}
        description={
          issued === undefined
            ? 'Name it after the thing that will hold it, so you know what you are revoking later.'
            : undefined
        }
      >
        {issued === undefined ? (
          <IssueForm
            onCancel={() => setIssuing(false)}
            onSubmit={async (name) => {
              const result = await api.keys.issue(name);
              setIssued({ name, key: result.key });
              await keys.reload();
            }}
          />
        ) : (
          <>
            <SecretOnce
              label="API key"
              value={issued.key}
              caption="Stored only as a sha256 hash, so no endpoint can return it again. If it is lost, revoke this key and issue another."
              onDone={() => {
                setIssued(undefined);
                setIssuing(false);
              }}
            />
            {/*
              The ready-to-paste command, below the secret.

              The brief's second user story is somebody connecting an external client with
              nothing but a URL and a key, and this is the one moment the dashboard knows
              both. Making them assemble it from the README is friction for no reason.
            */}
            <details className="mt-3 rounded-md border border-ink-800 bg-ink-900/40 p-3">
              <summary className="cursor-pointer text-xs font-medium text-ink-300">
                Connect Claude Code with this key
              </summary>
              <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-ink-400">
                <code>{`claude mcp add --transport http urumi \\\n  ${window.location.origin}/mcp \\\n  --header "Authorization: Bearer ${issued.key}"`}</code>
              </pre>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                Or in MCP Inspector: Streamable HTTP, URL{' '}
                <code className="text-ink-400">{window.location.origin}/mcp</code>, header{' '}
                <code className="text-ink-400">Authorization</code>.
              </p>
            </details>
          </>
        )}
      </Dialog>

      <Dialog
        open={confirmRevoke !== undefined}
        onClose={() => setConfirmRevoke(undefined)}
        title={confirmRevoke === undefined ? 'Revoke key' : `Revoke "${confirmRevoke.name}"?`}
        description="The next request using it is refused immediately — the check reads the database on every call, so there is no cache to wait for. Calls it already made stay in the audit log."
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmRevoke(undefined)}>Cancel</Button>
          <Button
            intent="danger"
            onClick={() => {
              const target = confirmRevoke;
              if (target === undefined) return;
              setConfirmRevoke(undefined);
              void revoke(target);
            }}
          >
            Revoke
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function KeyRow({
  apiKey,
  showOwner,
  busy,
  onRevoke,
}: {
  apiKey: ApiKey;
  showOwner: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const isRevoked = apiKey.revokedAt !== null;

  return (
    <li
      className={clsx(
        'flex flex-wrap items-center gap-3 rounded-lg border border-ink-800 p-3',
        isRevoked ? 'bg-ink-900/20' : 'bg-ink-900/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={clsx('truncate font-medium', isRevoked ? 'text-ink-500' : 'text-ink-100')}>
            {apiKey.name}
          </span>
          {/*
            The key id, which is the public half of `urumi_<keyId>_<secret>`.

            Shown because it is what appears in a log line and in an audit row - 4.4 chose to
            look keys up by id precisely so the system could say "key 3f2a… was revoked"
            without ever having held the secret. Without it on screen, correlating a log line
            to a row in this list would be guesswork.
          */}
          <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-400">
            {apiKey.keyId}
          </code>
          {isRevoked ? (
            <span className="rounded border border-ink-700 bg-ink-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
              revoked
            </span>
          ) : undefined}
        </span>

        <span className="mt-0.5 block text-xs text-ink-600">
          {/* break-all, because an email has no spaces to wrap at and the column caps at
              320 characters. Without it a long address overflows the card rather than
              wrapping - the metadata line is a block, so it wraps at whitespace and an
              email offers none. Found by feeding the API an 88-character address. */}
          {showOwner ? <span className="break-all text-ink-500">{apiKey.ownerEmail} · </span> : undefined}
          created {relativeTime(apiKey.createdAt)} ·{' '}
          {apiKey.lastUsedAt === null ? (
            // Never used is worth saying explicitly: it distinguishes a key somebody was
            // issued and never configured from one in active use, which is the difference
            // between a forgotten key and a live one when deciding what to revoke.
            <span className="text-ink-600">never used</span>
          ) : (
            <>last used {relativeTime(apiKey.lastUsedAt)}</>
          )}
          {isRevoked && apiKey.revokedAt !== null ? <> · revoked {relativeTime(apiKey.revokedAt)}</> : undefined}
        </span>
      </div>

      {isRevoked ? (
        // No action. A revocation is a timestamp rather than a delete (4.4), so the row
        // stays - but there is nothing to do to it, and offering a disabled button would
        // suggest otherwise.
        <span className="shrink-0 text-xs text-ink-600">no longer accepted</span>
      ) : (
        <Button size="sm" intent="ghost" busy={busy} onClick={onRevoke}>
          Revoke
        </Button>
      )}
    </li>
  );
}

function IssueForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(undefined);
        void onSubmit(name.trim())
          .catch((caught: unknown) => {
            setError(caught instanceof ApiError ? caught.message : 'Could not issue a key.');
          })
          .finally(() => setBusy(false));
      }}
      className="space-y-4"
    >
      <div>
        <label htmlFor="key-name" className="mb-1.5 block text-sm font-medium text-ink-300">
          Name
        </label>
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          placeholder="claude code on my laptop"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) placeholder:text-ink-600 focus:border-brand-500 sm:text-sm"
        />
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          Required, because an unnamed key in a list of five is a key nobody dares revoke.
        </p>
      </div>

      <div className="min-h-10" aria-live="polite">
        {error === undefined ? undefined : (
          <p
            className="animate-[error-in_200ms_var(--ease-out)_both] rounded-md border border-bad-600/40 bg-bad-600/10 px-3 py-2 text-sm text-bad-500"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" intent="primary" busy={busy} disabled={name.trim() === ''}>
          Issue
        </Button>
      </div>
    </form>
  );
}

function Empty({ onIssue }: { onIssue: () => void }) {
  return (
    <EmptyState
      title="No API keys yet."
      action={
        <Button intent="primary" onClick={onIssue}>
          Issue your first key
        </Button>
      }
    >
      A key is all an external MCP client needs. It sees every tool from every enabled
      upstream through one endpoint, and never holds an upstream&rsquo;s own credential.
    </EmptyState>
  );
}
