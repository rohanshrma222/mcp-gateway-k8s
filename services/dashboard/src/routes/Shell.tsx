/**
 * The signed-in shell: nav, who-you-are, sign out.
 *
 * **Nothing here animates on navigation, and that is the decision rather than an
 * omission.** Nav links in an operations dashboard get clicked tens of times a day by
 * whoever lives in it. At that frequency an animation stops being delight and becomes
 * latency the user pays every time - the interface feels slower while doing exactly the
 * same work. A fade on route change would be the single most-seen animation in the app and
 * the least useful.
 *
 * The same reasoning removes a page-transition animation entirely: the content swap is
 * instant, so a click feels like the page was already there.
 *
 * What DOES move is the active-link indicator, because it is explaining something - which
 * section you are in - and it moves rather than jumping so the eye can follow it.
 */
import { NavLink, Outlet } from 'react-router-dom';
import clsx from 'clsx';
import { Button } from '../components/Button.js';
import { useSession } from '../auth/session.js';
import type { Role } from '../api/types.js';

interface NavItem {
  to: string;
  label: string;
  /**
   * Who sees this link.
   *
   * A courtesy, not a control. Every admin route on the gateway re-checks the role
   * server-side against the database row on every request, and 4.3 proved that by
   * promoting a user mid-session and watching an admin route start answering without a
   * new login. A member who types the URL gets a 403 from the API, not a page.
   *
   * It is still worth doing: showing somebody four links that all fail is a worse
   * interface than showing them the two that work.
   */
  roles: Role[];
}

const NAV: NavItem[] = [
  { to: '/servers', label: 'Servers', roles: ['admin'] },
  { to: '/tools', label: 'Tools', roles: ['admin', 'member'] },
  { to: '/members', label: 'Members', roles: ['admin'] },
  { to: '/keys', label: 'API keys', roles: ['admin', 'member'] },
  { to: '/audit', label: 'Audit', roles: ['admin', 'member'] },
  { to: '/chat', label: 'Chat', roles: ['admin', 'member'] },
];

export function Shell() {
  const { session, signOut } = useSession();
  /**
   * Cannot happen, and handled anyway.
   *
   * `Tree` only renders this component when a session exists, so this is defensive. It
   * returned `undefined` before 7.5 - a genuinely blank page if the invariant ever broke,
   * which is the hardest kind of bug to diagnose because there is nothing on screen to
   * suggest where to look. A sentence naming the component costs nothing and turns a blank
   * page into a bug report.
   */
  if (session === undefined) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <p className="max-w-sm text-center text-sm text-ink-400">
          The application shell rendered without a session, which should not be possible.
          Reloading the page will re-check it.
        </p>
      </main>
    );
  }

  const visible = NAV.filter((item) => item.roles.includes(session.role));

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-800 bg-ink-900/60">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <span className="text-sm font-semibold tracking-tight text-ink-50">Urumi</span>

          <nav className="flex items-center gap-1" aria-label="Sections">
            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  clsx(
                    'relative rounded-md px-3 py-1.5 text-sm',
                    // Only colour transitions, and only on devices that really hover.
                    'transition-colors duration-(--duration-press) ease-(--ease-out)',
                    isActive ? 'text-ink-50' : 'text-ink-400 hover:text-ink-200',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {item.label}
                    {/**
                     * The active underline.
                     *
                     * A separate absolutely-positioned element rather than a border, so it
                     * can transition opacity and scaleX without affecting layout. A border
                     * appearing would shift the text by a pixel; this cannot.
                     */}
                    <span
                      aria-hidden="true"
                      className={clsx(
                        'absolute inset-x-2 -bottom-px h-0.5 origin-left rounded-full bg-brand-500',
                        'transition-[opacity,transform] duration-(--duration-press) ease-(--ease-out)',
                        isActive ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0',
                      )}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-ink-400 sm:inline">
              {session.email}
              {/* The role is shown because what a member can do differs from an admin, and
                  seeing "member" explains an absent link better than its absence does. */}
              <span className="ml-2 rounded border border-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                {session.role}
              </span>
            </span>
            <Button intent="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      {/* No transition wrapper. See the note at the top of this file. */}
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
