/**
 * `POST /api/chat` - the chat agent, streamed as Server-Sent Events.
 *
 * **SSE rather than a WebSocket**, because the traffic is one-directional once the request
 * is made: the user sends a message and then only receives. A WebSocket would add a second
 * protocol, a second set of ingress rules, its own reconnection logic and its own auth
 * handshake, to carry a stream that HTTP already carries. SSE rides the existing cookie
 * auth, the existing Ingress, and reconnects by being a normal request.
 *
 * **Why not just return the whole answer?** A tool-calling turn is several seconds -
 * `woo__list_orders` alone is a round trip through the gateway to WooCommerce to MariaDB -
 * and a request that returns nothing for eight seconds is indistinguishable from one that
 * has failed. Streaming also lets the trace appear as it happens, which is the thing that
 * makes the agent's behaviour legible rather than magical: the user watches it decide to
 * call a tool, sees what it got back, and sees the answer built from that.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { Config } from '../config.js';
import type { LlmMessage, LlmProvider } from '../llm/provider.js';
import { LlmError } from '../llm/provider.js';
import { runAgent, type AgentEvent } from '../chat/agent.js';
import { mintChatKey, revokeChatKey } from '../chat/ephemeralKey.js';
import { chatKeyTtlMs } from '../chat/keySweeper.js';

export interface ChatRouteDeps {
  db: Db;
  config: Config;
  logger: Logger;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /**
   * Absent when no model is configured.
   *
   * The gateway deliberately starts without a `GROQ_API_KEY` rather than failing its config
   * check: the store, the three upstreams, `/mcp`, the dashboard and the audit log are all
   * independent of the chat agent, and refusing to boot would take the whole platform down
   * over an optional feature. The route then answers 503 with a sentence saying exactly
   * that, which is more useful than a missing endpoint.
   */
  provider: LlmProvider | undefined;
  /**
   * Builds the system prompt for a given user.
   *
   * A builder rather than a fixed string, which is a correction to how 8.1 wired this: the
   * prompt there was built once at registration with the literal placeholders "the
   * signed-in user" and "as recorded", so the agent was told nothing about who it was
   * acting as. The prompt now names the real account.
   *
   * The values come from `request.principal`, which the session middleware derived from a
   * verified cookie against the live database row - NOT from the request body. So the
   * original concern behind passing a plain string (that a request must not be able to
   * influence what the agent is told it is) still holds: the body cannot reach this.
   */
  buildSystemPrompt: (options: { userEmail: string; role: string }) => string;
}

const historyMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const body = z.object({
  message: z.string().min(1).max(8000),
  /**
   * The conversation so far, sent by the client.
   *
   * Server-side session state was the alternative and was rejected: it would need a store,
   * an expiry policy and a cleanup path, and it would break the statelessness that lets the
   * gateway run two replicas - a second chat message could land on the replica without the
   * history. Client-held history keeps `/api/chat` as stateless as `/mcp`.
   *
   * The cost is that the client can edit the history, including putting words in the
   * assistant's mouth. That is bounded by what the history can do: it cannot grant
   * permissions, because every tool call is still authorised by the ephemeral key against
   * the user's live role. The worst case is a user talking their own agent into a confused
   * state inside their own session, using their own permissions - which they could do by
   * typing it anyway. 8.2's prompt hardening covers the untrusted-content side of this,
   * which is the part that is not self-inflicted.
   */
  history: z.array(historyMessage).max(40).default([]),
});

export function chatRoutes(deps: ChatRouteDeps): FastifyPluginAsync {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post('/api/chat', { preHandler: deps.requireAuth }, async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        // `requireAuth` guarantees this; the check is for the type and for the case where
        // the preHandler is ever reordered.
        return reply.code(401).send({ error: 'authentication required' });
      }

      const parsed = body.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid request',
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
      }

      if (deps.provider === undefined) {
        return reply.code(503).send({
          error:
            'the chat agent is not configured: this deployment has no model API key, so GROQ_API_KEY is unset. Everything else on the gateway works without it.',
        });
      }

      /**
       * The headers go out before any work starts.
       *
       * Once they are sent the status code is fixed at 200, so every later failure has to be
       * reported as an SSE event rather than an HTTP code. That is a real constraint and the
       * reason the two checks above come first: a bad body or a missing model are the
       * failures that CAN still be an honest 400 or 503, so they are resolved while that is
       * still possible.
       */
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        // No caching of a stream, by anything, ever. nginx in front of this would otherwise
        // happily buffer it and deliver the whole conversation at the end.
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // The header nginx reads to stop proxy buffering. Without it, the stream arrives in
        // chunks when a buffer fills, which looks exactly like a slow model.
        'x-accel-buffering': 'no',
      });

      const send = (event: AgentEvent | { type: 'error'; text: string }): void => {
        // One `data:` line with JSON, which keeps parsing on the client trivial. A payload
        // containing a newline would otherwise break the framing, and JSON has no raw
        // newlines, so this is safe by construction rather than by sanitising.
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      /**
       * The client going away aborts the model request.
       *
       * Without this, closing the tab leaves the model generating and the tool calls
       * running, billed and writing audit rows, for a conversation nobody will read.
       */
      const controller = new AbortController();
      request.raw.on('close', () => {
        if (!reply.raw.writableEnded) controller.abort();
      });

      const key = await mintChatKey(
        deps.db,
        principal.userId,
        deps.logger,
        chatKeyTtlMs(deps.config),
      );
      const startedAt = Date.now();

      try {
        const history: LlmMessage[] = parsed.data.history.map((message) =>
          message.role === 'user'
            ? { role: 'user', content: message.content }
            : { role: 'assistant', content: message.content },
        );

        for await (const event of runAgent(parsed.data.message, history, {
          mcpUrl: deps.config.CHAT_SELF_MCP_URL,
          apiKey: key.presented,
          provider: deps.provider,
          systemPrompt: deps.buildSystemPrompt({
            userEmail: principal.email,
            role: principal.role,
          }),
          maxIterations: deps.config.CHAT_MAX_ITERATIONS,
          logger: deps.logger.child({ requestId: request.id, userId: principal.userId }),
          signal: controller.signal,
        })) {
          send(event);
        }

        deps.logger.info(
          { userId: principal.userId, durationMs: Date.now() - startedAt, keyId: key.keyId },
          'chat turn completed',
        );
      } catch (caught) {
        if (controller.signal.aborted) {
          // The user left. Nothing to report to them, and not an error worth logging loudly.
          deps.logger.debug({ userId: principal.userId }, 'chat cancelled by the client');
        } else {
          const message =
            caught instanceof LlmError
              ? caught.message
              : caught instanceof Error
                ? caught.message
                : 'the chat agent failed';
          deps.logger.error({ err: caught, userId: principal.userId }, 'chat turn failed');
          send({ type: 'error', text: message });
        }
      } finally {
        /**
         * Revoked before the response ends, and before the handler returns, so the key's
         * lifetime is strictly inside one request. Never throws - see `revokeChatKey`.
         */
        await revokeChatKey(deps.db, key, deps.logger);
        if (!reply.raw.writableEnded) reply.raw.end();
      }

      /**
       * Fastify is told the reply was handled manually.
       *
       * Writing to `reply.raw` bypasses Fastify's lifecycle, so without this it waits for a
       * `send()` that never comes and eventually logs a warning about a reply that was
       * never sent.
       */
      return reply;
    });
  };
}
