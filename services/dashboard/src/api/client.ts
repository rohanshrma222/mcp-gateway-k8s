/**
 * The typed API client.
 *
 * One module, so there is exactly one place that knows how this app talks to the gateway.
 * The value of that is not tidiness: it means the credential policy, the error shape and
 * the 401 handling are decided once instead of per call site, and a page cannot
 * accidentally do it differently.
 *
 * **No base URL and no token handling.** Requests are same-origin relative paths, and the
 * session rides on an httpOnly cookie the browser attaches by itself. There is deliberately
 * nothing here that reads a token, because there is no token for JavaScript to read - 4.3
 * put the session in an httpOnly, SameSite=Strict cookie precisely so that a script
 * injection cannot steal it. A client that held a bearer token in memory or localStorage
 * would undo that, and it would look like perfectly ordinary frontend code while doing it.
 */
import type {
  ApiKey,
  ChatEvent,
  EffectivePermissions,
  PermissionRule,
  AggregatedTool,
  AuditPage,
  AuditSummaryBucket,
  InvitedMember,
  IssuedApiKey,
  Member,
  Role,
  ServerTestResult,
  Session,
  UpstreamServer,
} from './types.js';

/**
 * A failed request, carrying enough to render something useful.
 *
 * `status` is kept because the UI genuinely branches on it: 401 means "your session went
 * away", 403 means "you are not allowed to do that", and those are different screens. The
 * message is the gateway's own sentence - every route in this project returns a readable
 * `error` field, and rewriting it here would throw away the work done to make it readable.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Field-level problems from a zod failure, when the endpoint returns them. */
    readonly issues?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Called when any request comes back 401, so the app can drop to the login screen. */
type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * Set for the login request only.
   *
   * Login is the one endpoint where a 401 is an ANSWER rather than an expired session -
   * it means "wrong password", and the login form shows it inline. Without this flag the
   * global handler would fire and the app would try to log the user out of a session they
   * were in the middle of starting, which looks like the form silently resetting itself.
   */
  expect401?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, expect401 = false, signal } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // Relative path, so same-origin by construction, which is also what makes the
      // SameSite=Strict cookie work and what `connect-src 'self'` in the CSP enforces.
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // A network-level failure, not an HTTP error: the user is offline, or the gateway is
    // unreachable. Given its own message because "Failed to fetch" in a toast tells
    // somebody nothing about which of the two it was.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Could not reach the gateway. It may be restarting, or you may be offline.');
  }

  if (response.status === 401 && !expect401) {
    onUnauthorized?.();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }

  if (response.status === 204) return undefined as T;

  // Parsed before the ok check, because a failure body carries the reason and throwing it
  // away is how an interface ends up showing "Request failed" for everything.
  let payload: unknown;
  const text = await response.text();
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body from an endpoint that should return JSON means something in front
      // of the gateway answered - nginx, Traefik, a proxy error page. Said plainly rather
      // than reported as a parse error, which would point at the wrong component.
      throw new ApiError(
        response.status,
        `The server returned a non-JSON response (HTTP ${response.status}). Something in front of the gateway may have answered instead of the gateway.`,
      );
    }
  }

  if (!response.ok) {
    const shaped = payload as { error?: string; issues?: { field: string; message: string }[] } | undefined;
    throw new ApiError(
      response.status,
      shaped?.error ?? `Request failed with HTTP ${response.status}`,
      shaped?.issues,
    );
  }

  return payload as T;
}

/**
 * The surface, grouped by the page that uses it.
 *
 * Every function is typed by what the endpoint returns rather than by a generic envelope,
 * so a page that misreads a response is a compile error rather than an undefined at
 * runtime. The server wraps most responses in a single key (`{ servers: [...] }`) and the
 * unwrapping happens here, once, so no component has to know about it.
 */
export const api = {
  auth: {
    async login(email: string, password: string): Promise<Session> {
      const result = await request<{ user: Session }>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
        expect401: true,
      });
      return result.user;
    },

    /**
     * Who am I? Returns undefined rather than throwing on 401.
     *
     * This runs once on startup to decide between the app and the login screen, and at
     * that moment a 401 is the expected answer for anyone not signed in - not an error.
     * Throwing here would mean every page load of a logged-out browser logged an
     * exception, which trains whoever reads the console to ignore it.
     */
    async me(): Promise<Session | undefined> {
      try {
        const result = await request<{ user: Session }>('/api/auth/me', { expect401: true });
        return result.user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return undefined;
        throw error;
      }
    },

    async logout(): Promise<void> {
      await request<void>('/api/auth/logout', { method: 'POST' });
    },
  },

  users: {
    async list(): Promise<Member[]> {
      const result = await request<{ users: Member[] }>('/api/users');
      return result.users;
    },

    /**
     * Invite a member.
     *
     * The password comes back in this response and nowhere else, ever - there is no
     * endpoint that could return it again, which is what makes "shown once" a property
     * rather than an intention. The caller is responsible for showing it to the admin
     * before the state holding it is discarded; see `SecretOnce`.
     */
    async invite(email: string, role: Role): Promise<InvitedMember> {
      return request('/api/users', { method: 'POST', body: { email, role } });
    },

    /**
     * Change a role, or disable an account.
     *
     * Partial, and the gateway refuses two things with a 409 rather than a 403: an admin
     * removing their own admin access, and demoting or disabling the last enabled admin.
     * Both are authorised requests that conflict with the state of the system, which is
     * what 409 means - so the UI surfaces the message rather than treating it as a
     * permission problem.
     */
    async update(id: string, patch: { role?: Role; disabled?: boolean }): Promise<Member> {
      const result = await request<{ user: Member }>(`/api/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      return result.user;
    },
  },

  servers: {
    async list(): Promise<UpstreamServer[]> {
      const result = await request<{ servers: UpstreamServer[] }>('/api/servers');
      return result.servers;
    },

    /**
     * Register an upstream.
     *
     * `credential` goes up and never comes back. There is no field for it on
     * `UpstreamServer` and no endpoint that returns one, so this is the only direction it
     * can travel - which is what makes "write-only" a property of the system rather than a
     * convention the UI agrees to follow.
     */
    async create(input: {
      name: string;
      slug: string;
      url: string;
      authType: 'none' | 'bearer' | 'header';
      authHeader?: string;
      credential?: string;
      timeoutMs?: number;
    }): Promise<UpstreamServer> {
      const result = await request<{ server: UpstreamServer }>('/api/servers', {
        method: 'POST',
        body: input,
      });
      return result.server;
    },

    /**
     * Change an upstream.
     *
     * Partial by design: the gateway validates the RESULTING state rather than the patch,
     * so sending `{ authType: 'header' }` without a header name is a 400 that names a
     * field the request never contained. That is correct behaviour and the dialog sends
     * the whole auth triple together to stay clear of it.
     *
     * `slug` is absent on purpose - the gateway refuses to change it, because the slug is
     * the prefix on every tool name and every audit row already written against it.
     */
    async update(
      id: string,
      patch: {
        name?: string;
        url?: string;
        authType?: 'none' | 'bearer' | 'header';
        authHeader?: string | null;
        credential?: string;
        enabled?: boolean;
        timeoutMs?: number;
      },
    ): Promise<UpstreamServer> {
      const result = await request<{ server: UpstreamServer }>(
        `/api/servers/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: patch },
      );
      return result.server;
    },

    async remove(id: string): Promise<void> {
      await request<{ ok: boolean }>(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /**
     * Ask the gateway to connect right now.
     *
     * Note this returns 200 even when the upstream is unreachable, with the reason in the
     * body - a deliberate choice from 5.1, because "I tried and it refused the connection"
     * is a successful test, not a server error. So there is no catch branch here for the
     * common failure.
     */
    async test(id: string): Promise<ServerTestResult> {
      return request(`/api/servers/${encodeURIComponent(id)}/test`, { method: 'POST' });
    },
  },

  tools: {
    async list(): Promise<AggregatedTool[]> {
      const result = await request<{ tools: AggregatedTool[] }>('/api/tools');
      return result.tools;
    },
  },

  chat: {
    /**
     * Send a message and consume the streamed reply.
     *
     * **Not `EventSource`, and that is forced rather than chosen.** `EventSource` is the
     * browser's built-in SSE client and it would handle the framing and reconnection for
     * free - but it can only issue a GET, cannot send a request body, and cannot set
     * headers. The message and the conversation history have to go up in a body, so the
     * whole built-in path is unavailable and the framing has to be parsed by hand.
     *
     * The consolation is that `EventSource`'s automatic reconnection would be actively
     * wrong here. It retries by re-issuing the request, which for a chat turn means sending
     * the message again - a second model call, a second set of tool calls, a second set of
     * audit rows and, for anything that writes, a duplicated side effect. A chat turn is not
     * idempotent, so silent retry is the last thing it should do.
     *
     * Returns an `AbortController` so the caller can stop the turn. That matters more than
     * usual: `routes/chat.ts` listens for the client disconnecting and aborts the model
     * request, so abandoning a reply actually stops the work and the billing rather than
     * just hiding it.
     */
    send(
      message: string,
      history: { role: 'user' | 'assistant'; content: string }[],
      onEvent: (event: ChatEvent) => void,
    ): { done: Promise<void>; abort: () => void } {
      const controller = new AbortController();

      const done = (async (): Promise<void> => {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ message, history }),
          signal: controller.signal,
        });

        /**
         * A non-2xx here is a real HTTP error, and the route is careful to resolve every
         * failure it CAN report that way - a bad body, or no model key configured - before
         * it writes the SSE headers. After those headers the status is pinned at 200 and
         * failures arrive as `error` events instead, which is why both paths exist.
         */
        if (!response.ok) {
          let message = `the chat request failed with HTTP ${response.status}`;
          try {
            const body = (await response.json()) as { error?: string };
            if (typeof body.error === 'string' && body.error !== '') message = body.error;
          } catch {
            // Not JSON; the generic sentence stands.
          }
          if (response.status === 401) onUnauthorized?.();
          throw new ApiError(response.status, message);
        }

        if (response.body === null) {
          throw new ApiError(response.status, 'the chat stream was empty');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done: finished, value } = await reader.read();
            if (finished) break;

            // `stream: true` so a multi-byte character split across two network chunks is
            // held until complete rather than emitted as a replacement character. Tool
            // output in this system is arbitrary user text and does contain non-ASCII.
            buffer += decoder.decode(value, { stream: true });

            // Events are separated by a blank line. A chunk boundary can fall anywhere,
            // including mid-field, so whatever has not yet been terminated stays in the
            // buffer - parsing each chunk independently would silently drop it.
            let split = buffer.indexOf('\n\n');
            while (split !== -1) {
              const frame = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);

              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice('data:'.length).trim();
                if (payload === '') continue;
                try {
                  onEvent(JSON.parse(payload) as ChatEvent);
                } catch {
                  // One unparseable frame is skipped rather than failing the turn. The
                  // stream is a sequence of independent events, so the cost is one event;
                  // aborting would cost the whole answer.
                }
              }

              split = buffer.indexOf('\n\n');
            }
          }
        } finally {
          /**
           * Releasing the lock matters on an abort: without it the response body stays
           * locked and the underlying connection is held until the browser gives up.
           */
          reader.releaseLock();
        }
      })();

      return { done, abort: () => controller.abort() };
    },
  },

  permissions: {
    async list(): Promise<PermissionRule[]> {
      const body = await request<{ rules: PermissionRule[] }>("/api/permissions");
      return body.rules;
    },

    async create(rule: {
      role?: "admin" | "member";
      userId?: string;
      serverId?: string;
      toolName?: string;
      effect: "allow" | "deny";
    }): Promise<{ id: string }> {
      return request<{ id: string }>("/api/permissions", { method: "POST", body: rule });
    },

    async remove(id: string): Promise<void> {
      await request<void>(`/api/permissions/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    /** Asks the gateway what a user may call, rather than computing it in the browser. */
    async effective(userId: string): Promise<EffectivePermissions> {
      return request<EffectivePermissions>(
        `/api/permissions/effective?userId=${encodeURIComponent(userId)}`,
      );
    },
  },

  keys: {
    async list(): Promise<ApiKey[]> {
      const result = await request<{ keys: ApiKey[] }>('/api/keys');
      return result.keys;
    },
    async issue(name: string): Promise<IssuedApiKey> {
      return request('/api/keys', { method: 'POST', body: { name } });
    },
    async revoke(id: string): Promise<void> {
      await request<void>(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  },

  audit: {
    /**
     * A page of audit rows.
     *
     * The cursor is passed straight back as the server gave it. Nothing here parses or
     * constructs one, which is what keeps decision 2.80's promise honest: the cursor is
     * opaque, so the server stays free to change the ordering without breaking this
     * client.
     */
    async list(params: Record<string, string | number | undefined> = {}): Promise<AuditPage> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') query.set(key, String(value));
      }
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      return request(`/api/audit${suffix}`);
    },
    async summary(params: Record<string, string | undefined> = {}): Promise<AuditSummaryBucket[]> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') query.set(key, value);
      }
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      const result = await request<{ buckets: AuditSummaryBucket[] }>(`/api/audit/summary${suffix}`);
      return result.buckets;
    },
  },
};
