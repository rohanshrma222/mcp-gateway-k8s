/**
 * The Members page: who is on the team, what role they have, and how to add one.
 *
 * Admin-only, and that is enforced server-side on every request against the live database
 * row - the nav hiding the link is a courtesy. A member who types `/members` gets an empty
 * page because `GET /api/users` answers 403, not because this file hid a link.
 *
 * The two refusals the gateway makes here are both **409, not 403**, and the page surfaces
 * them as messages rather than as permission errors: an admin cannot remove their own admin
 * access, and nobody can demote or disable the last enabled admin. Both are authorised
 * requests that conflict with the state of the system. The second one took two attempts to
 * implement correctly - see decision 2.94 - and this page is where its message is read.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api, ApiError } from '../api/client.js';
import type { Member, Role } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../components/Button.js';
import { Dialog } from '../components/Dialog.js';
import { SecretOnce } from '../components/SecretOnce.js';
import { relativeTime } from '../components/StatusChip.js';
import { EmptyState, ErrorState, LoadingRows } from '../components/states.js';
import { useSession } from '../auth/session.js';

export function Members() {
  const { session } = useSession();
  const members = useResource<Member[]>(() => api.users.list());

  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  /**
   * The invited account's password, held in state only until the admin dismisses it.
   *
   * Deliberately not written anywhere else - no localStorage, no URL, no toast. A toast
   * would be the worst of the options: it disappears on a timer, so a secret that cannot be
   * recovered would vanish while somebody was reaching for their password manager.
   */
  const [issued, setIssued] = useState<{ email: string; password: string } | undefined>(undefined);

  const act = useCallback(
    async (id: string, label: string, operation: () => Promise<unknown>) => {
      setBusyId(id);
      try {
        await operation();
        await members.reload();
        toast.success(label);
      } catch (caught) {
        // The gateway's own sentence. The last-admin and self-demotion refusals are written
        // to be read by a person - "promote somebody else first, or nobody will be able to
        // administer this deployment" - and replacing them with "Update failed" would throw
        // away the only part of that work a user ever sees.
        toast.error(caught instanceof ApiError ? caught.message : `${label} failed`);
      } finally {
        setBusyId(undefined);
      }
    },
    [members],
  );

  if (members.loading) return <LoadingRows rows={2} />;

  if (members.data === undefined) {
    /**
     * This is the page where the 403 branch matters most, because it is the one a member is
     * most likely to reach by typing the URL - the nav hides the link, so curiosity is the
     * only route here. Before 7.5 they got a panel headed "Could not load members", which
     * is true of nothing: the request succeeded and the answer was no.
     */
    return (
      <ErrorState
        error={members.failure ?? members.error}
        title="Could not load members"
        subject="the member list"
        onRetry={() => void members.reload()}
      />
    );
  }

  /**
   * An empty member list cannot happen through the API - the seed Job creates two accounts
   * and there is no endpoint that deletes one. It is handled anyway, because "cannot happen"
   * is a statement about today's endpoints rather than about this component, and the cost of
   * being wrong is a blank page on the one screen that explains who can administer the
   * system.
   */
  if (members.data.length === 0) {
    return (
      <EmptyState title="No accounts exist." action={<Button intent="primary" onClick={() => setInviting(true)}>Invite the first member</Button>}>
        The seed Job creates an admin and a member on install, so an empty list means it has
        not run — check the platform release and the bootstrap Secret.
      </EmptyState>
    );
  }

  const admins = members.data.filter((member) => member.role === 'admin' && !member.disabled);

  return (
    <section>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-50">Members</h1>
          <p className="mt-1 text-sm text-ink-400">
            {members.data.length} account{members.data.length === 1 ? '' : 's'} · {admins.length} enabled
            admin{admins.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button intent="primary" className="ml-auto" onClick={() => setInviting(true)}>
          Invite member
        </Button>
      </header>

      {/*
        A standing warning when there is exactly one admin.

        Not an error - one admin is a perfectly normal state for a small deployment. It is
        shown because the consequence is invisible until somebody tries: with one admin, the
        gateway will refuse to demote or disable them, and an admin who does not know that
        reads the refusal as a bug. Saying it up front turns a confusing 409 into an expected
        one.
      */}
      {admins.length === 1 ? (
        <p className="mb-4 rounded-md border border-warn-600/40 bg-warn-600/10 px-3 py-2 text-sm text-warn-500">
          There is only one enabled admin. The gateway will refuse to demote or disable them,
          because nobody could administer this deployment afterwards — promote a second admin
          first.
        </p>
      ) : undefined}

      <ul className="space-y-2">
        {members.data.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            isSelf={member.id === session?.id}
            busy={busyId === member.id}
            onRole={(role) => void act(member.id, `${member.email} is now ${role}`, () => api.users.update(member.id, { role }))}
            onToggle={() =>
              void act(
                member.id,
                member.disabled ? `${member.email} re-enabled` : `${member.email} disabled`,
                () => api.users.update(member.id, { disabled: !member.disabled }),
              )
            }
          />
        ))}
      </ul>

      <Dialog
        open={inviting}
        onClose={() => {
          // The dialog cannot be closed while a one-time secret is on screen. Escape and a
          // backdrop click both route here, and either would discard a password that cannot
          // be recovered.
          if (issued === undefined) setInviting(false);
        }}
        title={issued === undefined ? 'Invite a member' : `Invited ${issued.email}`}
        description={
          issued === undefined
            ? 'The gateway generates their first password and shows it once. There is no email in this deployment, so you will need to send it to them yourself.'
            : undefined
        }
      >
        {issued === undefined ? (
          <InviteForm
            onCancel={() => setInviting(false)}
            onSubmit={async (email, role) => {
              const result = await api.users.invite(email, role);
              setIssued({ email: result.user.email, password: result.initialPassword });
              await members.reload();
            }}
          />
        ) : (
          <SecretOnce
            label="Initial password"
            value={issued.password}
            caption={`Send this to ${issued.email} however you normally share a credential. It is stored only as an argon2id hash, so no endpoint can return it again — if it is lost, the account has to be invited again under a different address.`}
            onDone={() => {
              setIssued(undefined);
              setInviting(false);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function MemberRow({
  member,
  isSelf,
  busy,
  onRole,
  onToggle,
}: {
  member: Member;
  isSelf: boolean;
  busy: boolean;
  onRole: (role: Role) => void;
  onToggle: () => void;
}) {
  return (
    <li
      className={clsx(
        'flex flex-wrap items-center gap-3 rounded-lg border border-ink-800 p-3',
        member.disabled ? 'bg-ink-900/20' : 'bg-ink-900/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          {/* truncate + min-w-0: an email address is up to 320 characters and need not
              contain a space. */}
          <span className={clsx('truncate font-medium', member.disabled ? 'text-ink-500' : 'text-ink-100')}>
            {member.email}
          </span>
          {isSelf ? (
            <span className="rounded border border-brand-600/40 bg-brand-600/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-brand-400">
              you
            </span>
          ) : undefined}
          {member.disabled ? (
            <span className="rounded border border-ink-700 bg-ink-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
              disabled
            </span>
          ) : undefined}
        </span>
        <span className="mt-0.5 block text-xs text-ink-600">joined {relativeTime(member.createdAt)}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/*
          A select rather than a promote/demote button pair.

          Two buttons would need one of them disabled at all times, which reads as broken.
          A select shows the current state and the alternative in one control - and because
          the gateway validates the resulting state, the refusals arrive as readable
          messages rather than as a disabled option the user cannot explain.
        */}
        <label className="sr-only" htmlFor={`role-${member.id}`}>
          Role for {member.email}
        </label>
        <select
          id={`role-${member.id}`}
          value={member.role}
          disabled={busy}
          onChange={(event) => onRole(event.target.value as Role)}
          className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) focus:border-brand-500 disabled:opacity-50"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>

        <Button size="sm" busy={busy} onClick={onToggle}>
          {member.disabled ? 'Enable' : 'Disable'}
        </Button>
      </div>
    </li>
  );
}

function InviteForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (email: string, role: Role) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
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
        void onSubmit(email.trim(), role)
          .catch((caught: unknown) => {
            // Shown in the dialog, next to the field. A duplicate address returns 409
            // naming the address - deliberately, unlike the login route's ambiguity,
            // because an admin needs to know why no password appeared.
            setError(caught instanceof ApiError ? caught.message : 'Could not invite this person.');
          })
          .finally(() => setBusy(false));
      }}
      className="space-y-4"
    >
      <div>
        <label htmlFor="invite-email" className="mb-1.5 block text-sm font-medium text-ink-300">
          Email
        </label>
        <input
          id="invite-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          autoFocus
          placeholder="someone@urumi.local"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) placeholder:text-ink-600 focus:border-brand-500 sm:text-sm"
        />
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          Trimmed and lowercased before it is stored, so two casings of one address cannot
          become two accounts.
        </p>
      </div>

      <div>
        <label htmlFor="invite-role" className="mb-1.5 block text-sm font-medium text-ink-300">
          Role
        </label>
        <select
          id="invite-role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 focus:border-brand-500 sm:text-sm"
        >
          <option value="member">member — can use tools and see their own activity</option>
          <option value="admin">admin — can also manage servers and members</option>
        </select>
      </div>

      {/* Always in the layout, so the buttons never move under the pointer. */}
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
        <Button type="submit" intent="primary" busy={busy} disabled={email.trim() === ''}>
          Invite
        </Button>
      </div>
    </form>
  );
}
