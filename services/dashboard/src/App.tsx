/**
 * The route tree.
 *
 * The signed-in and signed-out trees are swapped on the session rather than guarded by
 * redirects. The difference matters: with a redirect there is a moment where a protected
 * route is mounted and fetching before the guard fires, so a logged-out visitor can see a
 * flash of the shell. Rendering a different tree means the protected routes do not exist
 * for them at all.
 *
 * Stage 7.2 onward fills in the pages. They are listed here now, each rendering a small
 * "not built yet" panel, because a nav link to a route that does not exist is a 404 in the
 * middle of the app - and the role filtering in Shell.tsx is only verifiable if the links
 * go somewhere.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { SessionProvider, useSession } from './auth/session.js';
import { Login } from './routes/Login.js';
import { Shell } from './routes/Shell.js';
import { Servers } from './routes/Servers.js';
import { Audit } from './routes/Audit.js';

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Tree />
        {/*
          Sonner, from the curated list, rather than a hand-rolled toast.
          
          This is the component that most rewards a library: stacking, timers that pause
          when the tab is hidden, swipe-to-dismiss, and gap-filling pseudo-elements so a
          stack keeps its hover state. Those are the invisible edge cases nobody notices
          working, and hand-rolling them is the named mistake.
          
          Its defaults are left alone apart from the theme. "Good defaults matter more than
          options" is the library author own principle, and its easing and timing are
          deliberately a little slower and more elegant than the rest of this interface -
          which is right for something that appears in the corner and asks to be read,
          rather than something the user is pointing at.
        */}
        <Toaster theme="dark" position="bottom-right" closeButton />
      </BrowserRouter>
    </SessionProvider>
  );
}

function Tree() {
  const { session, loading } = useSession();

  /**
   * Nothing is rendered until the first `me()` settles.
   *
   * Without this the app shows the login form for the few hundred milliseconds that call
   * takes, then replaces it with the dashboard - so every page load of a signed-in user
   * flashes a login screen at them. A blank hold is less jarring than a wrong answer, and
   * there is deliberately no spinner: at this duration a spinner appears and vanishes,
   * which is more distracting than nothing.
   */
  if (loading) return <div className="min-h-dvh" />;

  if (session === undefined) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />} path="/">
        {/* Admins land on Servers, members on Tools - the first page each can actually
            use, rather than a shared landing page that would be empty for one of them. */}
        <Route index element={<Navigate to={session.role === 'admin' ? '/servers' : '/tools'} replace />} />
        <Route path="servers" element={<Servers />} />
        <Route path="tools" element={<Pending title="Tools" step="7.2" />} />
        <Route path="members" element={<Pending title="Members" step="7.3" />} />
        <Route path="keys" element={<Pending title="API keys" step="7.3" />} />
        <Route path="audit" element={<Audit />} />
        <Route path="chat" element={<Pending title="Chat" step="8.3" />} />
        {/* An unknown path inside the app goes home rather than showing a 404. The nav is
            the only way to reach these routes, so a bad path here is a stale bookmark. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/**
 * A placeholder that says which step delivers the page.
 *
 * Honest rather than decorative: "coming soon" tells a reviewer nothing, while naming the
 * step means the roadmap in docs/implementation.md and the running app agree.
 */
function Pending({ title, step }: { title: string; step: string }) {
  return (
    <section>
      <h1 className="text-lg font-semibold tracking-tight text-ink-50">{title}</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-400">
        This page is delivered by step {step}. The shell, session handling, role-aware
        navigation and the typed API client it will use are in place.
      </p>
    </section>
  );
}
