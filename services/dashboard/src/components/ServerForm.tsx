/**
 * Add and edit an upstream.
 *
 * The step asks for the credential field to be "write-only in the UI too", and the phrasing
 * matters: the API already cannot return a credential - 4.5 omitted those three columns from
 * every SELECT, so there is nothing to leak. This file is about the second half, which is
 * that the interface must not *imply* otherwise.
 *
 * So the field is empty when editing a server that has one. Not masked, not pre-filled with
 * dots - empty, with a line of text saying a credential is stored and that leaving the box
 * alone keeps it. A masked field full of bullets is the common pattern and it tells two
 * lies: that the value is loaded into the page, and that clearing the box would clear the
 * secret. Neither is true, and an admin who believes the first will eventually ask why they
 * cannot copy it.
 */
import { useState, type FormEvent } from 'react';
import { Button } from './Button.js';
import type { UpstreamServer } from '../api/types.js';

export interface ServerFormValues {
  name: string;
  slug: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  authHeader: string;
  credential: string;
  timeoutMs: number;
}

export function ServerForm({
  mode,
  server,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  server?: UpstreamServer;
  onSubmit: (values: ServerFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<ServerFormValues>({
    name: server?.name ?? '',
    slug: server?.slug ?? '',
    url: server?.url ?? '',
    authType: server?.authType ?? 'none',
    authHeader: server?.authHeader ?? '',
    // Always empty, in both modes. See the note at the top of this file.
    credential: '',
    timeoutMs: server?.timeoutMs ?? 20_000,
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof ServerFormValues>(key: K, value: ServerFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(values);
    } catch (caught) {
      // Shown inside the dialog rather than as a toast. A validation failure belongs beside
      // the field that caused it - a toast would appear in the corner while the form sits
      // there looking accepted, and it would vanish on its own before the user had fixed
      // anything.
      setError(caught instanceof Error ? caught.message : 'Could not save this server.');
    } finally {
      setBusy(false);
    }
  }

  const needsHeaderName = values.authType === 'header';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <Text
        id="name"
        label="Name"
        value={values.name}
        onChange={(v) => set('name', v)}
        placeholder="WooCommerce (default store)"
        hint="Shown in this list and in the audit log."
      />

      {mode === 'create' ? (
        <Text
          id="slug"
          label="Slug"
          value={values.slug}
          onChange={(v) => set('slug', v)}
          placeholder="woo"
          hint="Lowercase letters, digits and hyphens. Becomes the prefix on every tool name, as in woo__list_products — so it cannot be changed later."
        />
      ) : (
        <Readonly label="Slug" value={server?.slug ?? ''} hint="Immutable. It is the prefix on every tool name and on every audit row already written against this server." />
      )}

      <Text
        id="url"
        label="URL"
        value={values.url}
        onChange={(v) => set('url', v)}
        placeholder="http://my-mcp.my-namespace.svc.cluster.local:3000/mcp"
        hint="Must match the gateway's allowlist — by default, in-cluster Service names only. A public address is refused, and so is anything resolving to loopback or link-local space."
      />

      <div>
        <label htmlFor="authType" className="mb-1.5 block text-sm font-medium text-ink-300">
          Authentication
        </label>
        <select
          id="authType"
          value={values.authType}
          onChange={(event) => set('authType', event.target.value as ServerFormValues['authType'])}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) focus:border-brand-500 sm:text-sm"
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
      </div>

      {needsHeaderName ? (
        <Text
          id="authHeader"
          label="Header name"
          value={values.authHeader}
          onChange={(v) => set('authHeader', v)}
          placeholder="X-Api-Key"
          hint="The header the credential is sent in."
        />
      ) : undefined}

      {values.authType === 'none' ? undefined : (
        <div>
          <label htmlFor="credential" className="mb-1.5 block text-sm font-medium text-ink-300">
            Credential
          </label>
          <input
            id="credential"
            type="password"
            value={values.credential}
            onChange={(event) => set('credential', event.target.value)}
            // No autocomplete prompt for a credential that belongs to a server rather than
            // to the person typing it - a browser offering to save it in a password manager
            // under this site is wrong.
            autoComplete="off"
            placeholder={server?.hasCredential === true ? 'Stored — leave blank to keep it' : ''}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) sm:text-sm"
          />
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {server?.hasCredential === true
              ? 'A credential is stored for this server. It is encrypted with AES-256-GCM and cannot be read back — not by this page, and not by any endpoint. Leave this blank to keep it, or type a new one to replace it.'
              : 'Encrypted with AES-256-GCM before it is stored, and never returned by any endpoint afterwards.'}
          </p>
        </div>
      )}

      <div>
        <label htmlFor="timeoutMs" className="mb-1.5 block text-sm font-medium text-ink-300">
          Timeout
        </label>
        <div className="flex items-center gap-2">
          <input
            id="timeoutMs"
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={values.timeoutMs}
            onChange={(event) => set('timeoutMs', Number(event.target.value))}
            className="tabular w-32 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 sm:text-sm"
          />
          <span className="text-sm text-ink-500">ms</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          How long one tool call may take. Between 1,000 and 120,000.
        </p>
      </div>

      {/* Always in the layout, so the buttons never move under the pointer when a
          validation error arrives. Same reasoning as the login form. */}
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
        <Button type="submit" intent="primary" busy={busy}>
          {mode === 'create' ? 'Register server' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function Text({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-300">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        // 16px base so iOS Safari does not zoom the page on focus, shrinking to 14px only
        // from the small breakpoint up where that behaviour does not apply.
        className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) placeholder:text-ink-600 focus:border-brand-500 sm:text-sm"
      />
      {hint === undefined ? undefined : (
        <p className="mt-1 text-xs leading-relaxed text-ink-500">{hint}</p>
      )}
    </div>
  );
}

function Readonly({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink-300">{label}</span>
      {/* Rendered as text rather than a disabled input. A disabled input looks like a field
          that might become editable; this reads as a fact about the server. */}
      <code className="block truncate rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm text-ink-400">
        {value}
      </code>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">{hint}</p>
    </div>
  );
}
