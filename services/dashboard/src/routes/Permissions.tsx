/**
 * The Permissions page: the policy, and what it actually means for a given person.
 *
 * Two halves, and the second is why this page is usable. The rule list is the policy as
 * stored. The effective view answers the question an admin actually has - "so can Alice
 * create products?" - which a list of rules does not answer, because the precedence is
 * specificity-first and stops being obvious at about four rules.
 *
 * The effective view is computed by the **gateway**, using the same `decide()` the call path
 * enforces with. Not re-implemented here: a preview that disagreed with enforcement would be
 * worse than no preview at all, because it would be believed. That is the whole reason there
 * is an `/api/permissions/effective` endpoint rather than a loop in this file.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api/client.js';
import type { EffectivePermissions, Member, PermissionRule, UpstreamServer } from '../api/types.js';
import { Button } from '../components/Button.js';
import { Dialog } from '../components/Dialog.js';
import { EmptyState, ErrorState, LoadingRows } from '../components/states.js';
import { useResource } from '../hooks/useResource.js';

export function Permissions() {
  const rules = useResource<PermissionRule[]>(() => api.permissions.list());
  const servers = useResource<UpstreamServer[]>(() => api.servers.list());
  const members = useResource<Member[]>(() => api.users.list());

  const [adding, setAdding] = useState(false);
  const [previewFor, setPreviewFor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const remove = async (rule: PermissionRule) => {
    setBusy(rule.id);
    try {
      await api.permissions.remove(rule.id);
      toast.success('Rule deleted');
      await rules.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not delete that rule');
    } finally {
      setBusy(undefined);
    }
  };

  if (rules.loading) return <LoadingRows rows={4} />;

  if (rules.data === undefined) {
    return (
      <ErrorState
        error={rules.failure ?? rules.error}
        title="Could not load permissions"
        subject="the permission policy"
        onRetry={() => void rules.reload()}
      />
    );
  }

  const denyCount = rules.data.filter((rule) => rule.effect === 'deny').length;

  return (
    <section>
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink-50">Permissions</h1>
            <p className="mt-1 max-w-prose text-sm text-ink-400">
              {rules.data.length} rule{rules.data.length === 1 ? '' : 's'} ({denyCount} deny).
              A tool call with no matching rule is <strong className="text-ink-200">refused</strong>,
              so this list is what makes the gateway usable rather than what restricts it.
            </p>
          </div>
          <Button intent="primary" onClick={() => setAdding(true)}>
            Add rule
          </Button>
        </div>

        {/* The precedence, stated on the page rather than in documentation nobody opens.
            It is the one thing a reader needs in order to predict what the list below does,
            and they are about to need it. */}
        <div className="mt-4 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
          <p className="text-xs font-medium text-ink-300">How a decision is made</p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-500">
            The most specific matching rule wins, and between two equally specific rules the
            one naming a person beats the one naming their role:
          </p>
          <ol className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-500">
            {[
              'user + tool',
              'role + tool',
              'user + server',
              'role + server',
              'user',
              'role',
              'refused',
            ].map((step, index, all) => (
              <li key={step} className="flex items-center gap-1.5">
                <code
                  className={
                    step === 'refused'
                      ? 'rounded bg-bad-600/20 px-1.5 py-0.5 text-bad-500'
                      : 'rounded bg-ink-800 px-1.5 py-0.5'
                  }
                >
                  {step}
                </code>
                {index < all.length - 1 ? <span className="text-ink-700">&rsaquo;</span> : undefined}
              </li>
            ))}
          </ol>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-600">
            So a <code className="text-ink-500">deny</code> on one tool is not undone by a
            broad <code className="text-ink-500">allow</code> — which is the point of ordering
            it this way.
          </p>
        </div>
      </header>

      {rules.data.length === 0 ? (
        <EmptyState
          title="No rules, so every tool call is refused."
          action={
            <Button intent="primary" onClick={() => setAdding(true)}>
              Add the first rule
            </Button>
          }
        >
          The platform chart seeds a starting policy — admins allowed everything, members
          read-only — so an empty list usually means the seed Job has not run.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {rules.data.map((rule) => (
            <li key={rule.id}>
              <RuleRow rule={rule} busy={busy === rule.id} onDelete={() => void remove(rule)} />
            </li>
          ))}
        </ul>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-medium text-ink-200">What a person can actually call</h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-500">
          Computed by the gateway with the same function it enforces with, so this is the
          decision rather than a guess about it.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={previewFor ?? ''}
            onChange={(event) => setPreviewFor(event.target.value === '' ? undefined : event.target.value)}
            className="rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 focus:border-brand-600 focus:outline-none"
            aria-label="Account to preview"
          >
            <option value="">Choose an account…</option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.email} ({member.role})
              </option>
            ))}
          </select>
          {members.data === undefined && !members.loading ? (
            <span className="text-xs text-ink-600">Could not load accounts.</span>
          ) : undefined}
        </div>

        {previewFor === undefined ? undefined : <Effective key={previewFor} userId={previewFor} />}
      </section>

      <AddRuleDialog
        open={adding}
        onClose={() => setAdding(false)}
        servers={servers.data ?? []}
        members={members.data ?? []}
        onCreated={() => {
          setAdding(false);
          void rules.reload();
        }}
      />
    </section>
  );
}

function RuleRow({
  rule,
  busy,
  onDelete,
}: {
  rule: PermissionRule;
  busy: boolean;
  onDelete: () => void;
}) {
  const subject = rule.role !== undefined ? `role: ${rule.role}` : (rule.userEmail ?? rule.userId ?? '?');
  const scope =
    rule.toolName !== undefined
      ? `${rule.serverSlug ?? '?'} / ${rule.toolName}`
      : rule.serverSlug !== undefined
        ? `every tool on ${rule.serverSlug}`
        : 'every tool on every server';

  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-2.5">
      {/* The effect first and colour-coded, because it is what a reader scans for, and
          flex-shrink-0 so a long email never squeezes it into two lines. */}
      <span
        className={
          rule.effect === 'allow'
            ? 'shrink-0 rounded bg-ok-600/20 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-ok-500'
            : 'shrink-0 rounded bg-bad-600/20 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-bad-500'
        }
      >
        {rule.effect}
      </span>

      <div className="min-w-0 flex-1">
        {/* break-all on the subject: an email has no wrap opportunity and the column caps
            at 320 characters. The same bug 7.5 found on the Keys page. */}
        <p className="break-all text-sm text-ink-100">{subject}</p>
        <p className="mt-0.5 truncate text-xs text-ink-500">{scope}</p>
      </div>

      <Button
        intent="ghost"
        size="sm"
        busy={busy}
        onClick={onDelete}
        className="shrink-0"
      >
        Delete
      </Button>
    </div>
  );
}

function Effective({ userId }: { userId: string }) {
  // Keyed on userId through the dependency array so switching accounts refetches rather
  // than showing the previous person's answer under the new name.
  /**
   * `useResource` takes options, not a dependency array - so this component is REMOUNTED
   * when the account changes, via a `key` on it in the parent, rather than refetching in
   * place. I checked the signature after assuming it wrong: a dep array passed where options
   * are expected would have been silently ignored, and this panel would have kept showing
   * the first account picked, under the new name.
   */
  const preview = useResource<EffectivePermissions>(() => api.permissions.effective(userId));

  if (preview.loading) return <LoadingRows rows={2} height="h-10" />;
  if (preview.data === undefined) {
    return (
      <ErrorState
        error={preview.failure ?? preview.error}
        title="Could not compute effective permissions"
        onRetry={() => void preview.reload()}
      />
    );
  }

  const allowed = preview.data.tools.filter((tool) => tool.allowed);
  const refused = preview.data.tools.filter((tool) => !tool.allowed);

  return (
    <div className="mt-4">
      <p className="text-xs text-ink-400">
        <strong className="text-ink-200">{preview.data.user.email}</strong> can call{' '}
        <strong className="text-ink-200">{allowed.length}</strong> of {preview.data.tools.length}{' '}
        tool{preview.data.tools.length === 1 ? '' : 's'}.
      </p>

      <ul className="mt-2 space-y-1">
        {[...allowed, ...refused].map((tool) => (
          <li
            key={tool.name}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border border-ink-800/60 px-2.5 py-1.5"
          >
            <span className={tool.allowed ? 'text-xs text-ok-500' : 'text-xs text-bad-500'}>
              {tool.allowed ? '✓' : '✗'}
            </span>
            <code className="break-all text-xs text-ink-200">{tool.name}</code>
            {/* The reason, always shown rather than on hover. A tick nobody can account for
                is not reviewable, and the reason is the only thing that makes the precedence
                visible in practice. */}
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-600">{tool.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddRuleDialog({
  open,
  onClose,
  servers,
  members,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  servers: UpstreamServer[];
  members: Member[];
  onCreated: () => void;
}) {
  const [subject, setSubject] = useState('role:member');
  const [serverId, setServerId] = useState('');
  const [toolName, setToolName] = useState('');
  const [effect, setEffect] = useState<'allow' | 'deny'>('deny');
  const [saving, setSaving] = useState(false);

  /**
   * The tool list is narrowed to the chosen server, because a tool name without its server
   * does not identify a tool in this system - there are two called `list_products`. Offering
   * every name would invite exactly that mistake.
   */
  const tools = useResource(() => api.tools.list());
  const serverTools = useMemo(() => {
    if (serverId === '') return [];
    const slug = servers.find((server) => server.id === serverId)?.slug;
    if (slug === undefined) return [];
    return (tools.data ?? [])
      .filter((tool) => tool.server === slug)
      .map((tool) => tool.upstreamName)
      .sort();
  }, [serverId, servers, tools.data]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.permissions.create({
        ...(subject.startsWith('role:')
          ? { role: subject.slice('role:'.length) as 'admin' | 'member' }
          : { userId: subject.slice('user:'.length) }),
        ...(serverId === '' ? {} : { serverId }),
        ...(toolName === '' ? {} : { toolName }),
        effect,
      });
      toast.success('Rule added');
      onCreated();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not add that rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a permission rule"
      description="The most specific matching rule wins; a rule with no server covers everything."
    >
      <div className="space-y-3">
        <Field label="Applies to">
          <select
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className="w-full rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 focus:border-brand-600 focus:outline-none"
          >
            <option value="role:admin">Every admin</option>
            <option value="role:member">Every member</option>
            {members.map((member) => (
              <option key={member.id} value={`user:${member.id}`}>
                {member.email} only
              </option>
            ))}
          </select>
        </Field>

        <Field label="Server" hint="Leave as every server for a blanket rule.">
          <select
            value={serverId}
            onChange={(event) => {
              setServerId(event.target.value);
              // Clearing the tool is required, not tidiness: a tool name left over from the
              // previous server would be submitted against the new one, and the API would
              // accept it as a rule that can never match anything.
              setToolName('');
            }}
            className="w-full rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 focus:border-brand-600 focus:outline-none"
          >
            <option value="">Every server</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.slug}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Tool"
          hint={serverId === '' ? 'Choose a server first to narrow to one tool.' : undefined}
        >
          <select
            value={toolName}
            disabled={serverId === ''}
            onChange={(event) => setToolName(event.target.value)}
            className="w-full rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 focus:border-brand-600 focus:outline-none disabled:opacity-50"
          >
            <option value="">Every tool on that server</option>
            {serverTools.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Effect">
          <div className="flex gap-2">
            {(['allow', 'deny'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setEffect(option)}
                className={
                  effect === option
                    ? 'flex-1 rounded-md border border-brand-600 bg-brand-600/20 px-3 py-1.5 text-sm text-ink-50'
                    : 'flex-1 rounded-md border border-ink-800 px-3 py-1.5 text-sm text-ink-400 hover:text-ink-200'
                }
              >
                {option}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* The actions live in children, because Dialog takes no footer prop - checked after
          assuming it did. Same class of mistake as the dep array above, found the same way. */}
      <div className="mt-5 flex justify-end gap-2">
        <Button intent="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button intent="primary" busy={saving} onClick={() => void submit()}>
          Add rule
        </Button>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-300">{label}</span>
      {children}
      {hint === undefined ? undefined : (
        <span className="mt-1 block text-[11px] text-ink-600">{hint}</span>
      )}
    </label>
  );
}
