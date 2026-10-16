/**
 * A secret the system will never show again.
 *
 * Used for both one-time values: an invited member's initial password and a freshly issued
 * API key. Both are returned by exactly one response and stored only as a hash, so once
 * this component unmounts the value is gone from the universe - not hidden, gone.
 *
 * **The copy button needed real work, and the reason is worth knowing.** `navigator.clipboard`
 * is only defined in a *secure context*: HTTPS, or localhost. This dashboard is served over
 * plain HTTP on `app.urumi.local`, which is neither - so on the local cluster the modern
 * clipboard API **does not exist**, and a button calling it would throw or silently do
 * nothing. In production behind TLS it works. A copy button that works for the author and
 * fails in the demo is worse than no copy button, so there are three layers:
 *
 *   1. `navigator.clipboard.writeText` when it exists (production, or localhost).
 *   2. `document.execCommand('copy')` over a selected input - deprecated, and the only
 *      thing that works in a non-secure context.
 *   3. The value sits in a read-only input that selects itself on focus, so Ctrl+C always
 *      works even if both of the above fail. The UI says so rather than pretending.
 *
 * Checked rather than assumed: the page returns `HTTP/1.1 200` over `http://app.urumi.local`,
 * so layer 1 is unavailable on the cluster as deployed today.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.js';

export function SecretOnce({
  label,
  value,
  caption,
  onDone,
}: {
  label: string;
  value: string;
  /** What this secret is for, and what happens when the panel closes. */
  caption: string;
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    // Selected on mount, so Ctrl+C works immediately without the user having to aim at a
    // 43-character string. This is the fallback that cannot fail.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopyFailed(false);

    // Layer 1: the modern API, guarded by existence rather than by a try/catch alone -
    // reading `navigator.clipboard.writeText` when clipboard is undefined is itself a
    // TypeError, so the check has to come first.
    if (typeof navigator.clipboard?.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        return;
      } catch {
        // Permission denied, or a browser that exposes the API and refuses it. Falls
        // through rather than reporting failure, because layer 2 may still work.
      }
    }

    // Layer 2: the deprecated path, which is the only one available over plain HTTP.
    const input = inputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
      try {
        // `execCommand` is deprecated and is here on purpose: it is the ONLY copy path
        // that works outside a secure context, which is where this app runs locally.
        const ok = document.execCommand('copy');
        if (ok) {
          setCopied(true);
          return;
        }
      } catch {
        // Falls through to layer 3.
      }
    }

    // Layer 3: tell the truth. The value is selected and the user can copy it manually.
    setCopyFailed(true);
  }

  return (
    <div className="rounded-md border border-warn-600/40 bg-warn-600/10 p-3">
      <p className="text-sm font-medium text-ink-100">{label}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-400">{caption}</p>

      <div className="mt-3 flex gap-2">
        {/*
          A read-only input rather than a <code> block, specifically so it is selectable and
          so execCommand has something to copy from. `readOnly` not `disabled`: a disabled
          input cannot be focused or selected, which would break both the fallback and
          manual copying.
        */}
        <input
          ref={inputRef}
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          // Not type="password". Masking a value whose entire purpose is to be read and
          // copied once would be theatre - and the admin needs to see it to send it.
          className="tabular min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-xs text-ink-100 select-all"
          aria-label={label}
        />
        <Button size="sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {copyFailed ? (
        <p className="mt-2 text-xs text-warn-500" role="status">
          This browser would not copy it automatically — the value above is selected, so
          press Ctrl+C (or Cmd+C). The clipboard API needs HTTPS, which this local cluster
          does not use.
        </p>
      ) : undefined}

      <label className="mt-3 flex items-start gap-2 text-xs text-ink-300">
        {/*
          An explicit acknowledgement before the panel can be dismissed.

          The alternative - a plain Close button - makes it one stray click to lose a value
          that cannot be recovered. This is the one place in the app where a confirmation is
          worth the friction, because the cost of the mistake is reissuing a key or
          re-inviting a person, and the user will not realise until later.
        */}
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5"
        />
        <span>I have copied it. I understand it cannot be shown again.</span>
      </label>

      <div className="mt-3 flex justify-end">
        <Button intent="primary" size="sm" disabled={!acknowledged} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
