/**
 * Session state: who is signed in, and what they may see.
 *
 * **React context rather than a state library**, and the reason is consistency with how
 * the rest of this project treats dependencies. woo-mcp uses plain `node:http` because
 * three routes do not earn a framework; notes-mcp uses the built-in SQLite because a
 * native module did not earn its install step. This is the same judgement: the shared
 * state here is one object - email, role, loading - read by the nav and the route guards
 * and written by exactly two actions. A store library earns its place when many slices are
 * mutated from many places, and if the chat agent in stage 8 turns out to need that, it is
 * a contained change. Reaching for it now would be buying a solution to a problem this app
 * does not have yet.
 *
 * The role lives here only to decide what to RENDER. It is not a permission check. Every
 * admin route on the gateway re-checks the role server-side against the database row on
 * every request (4.3), so hiding a nav link is a courtesy to the user rather than a
 * control - a member who types /servers gets an empty page because the API returns 403,
 * not because this file hid a link.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, setUnauthorizedHandler } from '../api/client.js';
import type { Session } from '../api/types.js';

interface SessionState {
  session: Session | undefined;
  /** True until the first `me()` call settles, so the app can avoid flashing the login form. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // A ref, not state: this is read inside a callback registered once, and making it state
  // would mean re-registering the handler on every change for no benefit.
  const signedIn = useRef(false);

  useEffect(() => {
    /**
     * Any request coming back 401 drops the session.
     *
     * The gateway's session is an 8-hour JWT, so a dashboard left open overnight will
     * start getting 401s. Without this the UI would keep rendering a logged-in shell whose
     * every request fails - the user sees a working app that does nothing, which is a
     * worse experience than being asked to sign in again.
     */
    setUnauthorizedHandler(() => {
      if (signedIn.current) {
        signedIn.current = false;
        setSession(undefined);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.auth
      .me()
      .then((found) => {
        if (cancelled) return;
        setSession(found);
        signedIn.current = found !== undefined;
      })
      .catch(() => {
        // A failure here is not a logged-out user - `me()` already returns undefined for
        // that. It means the gateway is unreachable, and the login screen is still the
        // right destination: it is where the error can be shown and retried.
        if (!cancelled) setSession(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const user = await api.auth.login(email, password);
    signedIn.current = true;
    setSession(user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch (error) {
      // The cookie is cleared locally regardless. A logout that fails because the gateway
      // is unreachable must still log the user out of this tab - refusing to would leave
      // them looking at a session they have explicitly asked to end, which is the one
      // outcome nobody expects. The cookie is httpOnly so this cannot clear it directly,
      // but dropping the session state means the next request 401s and the server-side
      // token expires on its own 8-hour schedule.
      if (!(error instanceof ApiError)) throw error;
    } finally {
      signedIn.current = false;
      setSession(undefined);
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({ session, loading, signIn, signOut }),
    [session, loading, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  // Thrown rather than returning a default, because a component rendering outside the
  // provider is a wiring mistake and a silent `undefined` session would present as a
  // mysterious redirect to login rather than as the bug it is.
  if (context === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}
