/**
 * The sign-in screen.
 *
 * The one animated thing here is the error message, and that is the whole motion budget
 * for this page. Sign-in is occasional - once a session - so it is in the band where an
 * animation is worth having. Everything else on the page is static because a form that
 * animates its own fields on load is slower to use and nobody asked it to.
 *
 * The error animates because the alternative is worse: a message that appears instantly
 * in the layout shifts the button down under the user's cursor as they are still pressing
 * it. A 200ms fade with a small rise gives the eye time to follow, and - importantly - the
 * space is reserved whether or not there is an error, so nothing moves at all.
 */
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.js';
import { Button } from '../components/Button.js';
import { useSession } from '../auth/session.js';

export function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
      // No navigation call. The session going from undefined to present is what swaps the
      // route tree, so there is one source of truth for "am I signed in" rather than a
      // redirect that could disagree with it.
    } catch (caught) {
      /**
       * The gateway's own sentence, shown verbatim.
       *
       * 4.3 made login answer "invalid email or password" for both a wrong password and
       * an unknown account - deliberately, so the form cannot be used to enumerate who
       * has an account. Rewriting the message here, or adding a friendlier "we could not
       * find that user", would undo that work from the one place a user can see it.
       */
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong signing in. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight text-ink-50">Urumi</h1>
          <p className="mt-1 text-sm text-ink-400">MCP gateway control plane</p>
        </header>

        <form onSubmit={onSubmit} noValidate>
          <div className="space-y-4">
            <Field
              id="email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="username"
              autoFocus
            />
            <Field
              id="password"
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
          </div>

          {/**
           * The slot is always in the layout, so the button never moves.
           *
           * `min-h` reserves the space for one line of error text. The common alternative -
           * conditionally rendering the message - shifts every element below it the moment
           * the request fails, which on a form means the button jumps out from under the
           * pointer exactly when the user is most likely to click again.
           */}
          <div className="mt-4 min-h-10" aria-live="polite">
            {error === undefined ? undefined : (
              <p
                // Enters from 0.98 and 2px, never from scale(0) or a large offset: nothing
                // in the real world appears from nothing, and a big entrance for an error
                // message reads as drama rather than information.
                className="animate-[error-in_200ms_var(--ease-out)_both] rounded-md border border-bad-600/40 bg-bad-600/10 px-3 py-2 text-sm text-bad-500"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          <Button
            type="submit"
            intent="primary"
            busy={busy}
            className="mt-2 w-full"
            // Disabled until both fields have something, so the common failure - pressing
            // sign in on an empty form - is prevented rather than reported.
            disabled={email.trim() === '' || password === ''}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-ink-500">
          Member and admin accounts are seeded on install. The password is in the
          <code className="mx-1 rounded bg-ink-900 px-1 py-0.5 text-ink-300">platform-bootstrap</code>
          Kubernetes Secret.
        </p>
      </div>
    </main>
  );
}

/**
 * A labelled input.
 *
 * Local to this file on purpose: it is used twice, here, and promoting it to a shared
 * component before a second page needs it would be inventing an API for a guess. Stage 7.2
 * onward will tell us what a real shared field needs.
 */
function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  autoFocus = false,
}: {
  id: string;
  label: string;
  type: 'email' | 'password';
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-300">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        // 16px on mobile, because anything smaller makes iOS Safari zoom the page on
        // focus - which is jarring and then leaves the layout zoomed.
        className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) placeholder:text-ink-600 focus:border-brand-500 sm:text-sm"
      />
    </div>
  );
}
