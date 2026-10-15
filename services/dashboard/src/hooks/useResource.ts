/**
 * Fetch something, optionally on a timer, and report its state honestly.
 *
 * **Why not TanStack Query.** 7.1 deferred this decision until it had real inputs, and
 * here they are: three pages, each loading one or two collections, one of which refreshes
 * on a timer. No mutation cache to invalidate across routes, no pagination cache, no
 * optimistic updates, no shared query keys between unrelated screens. Those are the
 * problems a query library solves, and this app has none of them yet. The library would be
 * ~13 kB and a second mental model for "where does data live" beside the one below.
 *
 * What it is NOT is a claim that hand-rolling is better in general - it is that this hook
 * is 90 lines, and the day the chat agent needs streaming plus optimistic writes is the
 * day the trade flips. Same judgement as the state library in 7.1.
 *
 * Three behaviours that are easy to get wrong and are the reason this is a hook rather
 * than a `useEffect` in each page:
 *
 * 1. **A refresh must not blank the screen.** `loading` is true only for the FIRST load;
 *    a timer refresh leaves the current data visible. Otherwise a status page flickers
 *    empty every ten seconds, which looks like the gateway falling over.
 *
 * 2. **A failed refresh must not throw away good data.** If the gateway is briefly
 *    unreachable, the last known servers are more useful than an error page - so the error
 *    is reported *alongside* the stale data, and the page decides what to show.
 *
 * 3. **The timer stops when the tab is hidden.** A dashboard left open in a background tab
 *    would otherwise poll all night, and browsers throttle those timers unpredictably
 *    anyway, so the requests arrive in bursts on wake.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  /** True only until the first load settles. A timer refresh does not set this. */
  loading: boolean;
  /** Set when the most recent attempt failed. Does not clear `data`. */
  error: string | undefined;
  /** True while a refresh is in flight behind existing data. */
  refreshing: boolean;
  /** Re-fetch now. Returns when it settles, so a caller can await it after a mutation. */
  reload: () => Promise<void>;
}

export function useResource<T>(
  fetcher: () => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean } = {},
): Resource<T> {
  const { intervalMs, enabled = true } = options;

  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  /**
   * The fetcher in a ref.
   *
   * Callers write `useResource(() => api.servers.list())`, which is a new function on every
   * render. In the effect's dependency array that would re-subscribe - and restart the
   * timer - on every render, so a 10s poll would fire on every keystroke in a filter box.
   * The ref keeps the latest fetcher without making it a dependency.
   */
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Guards a late response from a request whose component has gone, and - more subtly - a
  // slow first load resolving after a fast reload has already set newer data.
  const generation = useRef(0);

  const run = useCallback(async (isFirst: boolean) => {
    const mine = ++generation.current;
    if (isFirst) setLoading(true);
    else setRefreshing(true);

    try {
      const next = await fetcherRef.current();
      if (generation.current !== mine) return;
      setData(next);
      setError(undefined);
    } catch (caught) {
      if (generation.current !== mine) return;
      // The data is deliberately left in place. See the note at the top.
      setError(caught instanceof Error ? caught.message : 'Something went wrong loading this.');
    } finally {
      if (generation.current === mine) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const reload = useCallback(() => run(false), [run]);

  useEffect(() => {
    if (!enabled) return;
    void run(true);
  }, [enabled, run]);

  useEffect(() => {
    if (!enabled || intervalMs === undefined) return;

    let timer: number | undefined;

    const start = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => void run(false), intervalMs);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Fetch immediately on return, then resume the timer. Without the immediate call
        // the user stares at data up to `intervalMs` old on a page whose whole purpose is
        // telling them what is happening right now.
        void run(false);
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, run]);

  return { data, loading, error, refreshing, reload };
}
