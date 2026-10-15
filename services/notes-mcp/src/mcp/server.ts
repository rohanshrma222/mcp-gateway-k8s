/**
 * The three tools.
 *
 * `add_note` and `list_notes` are the service's actual job. `list_products` exists
 * because the plan asks for a collision that can be demonstrated rather than described -
 * and the shape of that collision is the interesting part.
 *
 * A contrived duplicate would be a tool called `list_products` that returns notes. This
 * one answers the question honestly from its own data: **which products are people
 * writing notes about.** So the gateway ends up advertising two tools with the same
 * underlying name, `woo__list_products` and `notes__list_products`, which return
 * genuinely different and genuinely useful answers - the catalogue versus what the team
 * has been discussing. That is the case the prefixing scheme exists for: not two copies
 * of one tool, but two servers that legitimately own the same noun.
 *
 * Note what this server does NOT do: it has no idea whether a product it names exists in
 * WooCommerce. The `product` column is a free string. That is deliberate - an upstream
 * that reached into another upstream's data would defeat the whole architecture, and the
 * gateway is the only component that is supposed to know both exist. The consequence is
 * that these two tools can disagree, and an agent asking both is how a human finds out.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { NotesStore } from '../store.js';

export interface McpServerDeps {
  store: NotesStore;
  logger: Logger;
  instanceSlug: string;
}

/**
 * `McpServer.registerTool` here, where the gateway uses the low-level `Server`.
 *
 * Not an inconsistency - the opposite. This service OWNS its tools, so letting the SDK
 * derive JSON Schema from these zod schemas means the published schema and the validation
 * can never drift. The gateway is a proxy, so it must forward an upstream's schema
 * verbatim and has nothing of its own to derive from; converting there would mean
 * advertising a schema the upstream never published (decision 2.73). Same library, two
 * roles, two correct answers.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'urumi-notes-mcp', version: '0.1.0' },
    {
      instructions:
        'Team notes for the Urumi platform. Use add_note to record a decision or an ' +
        'observation, list_notes to read recent ones, and list_products to see which ' +
        'products the team has been writing about. This server knows nothing about the ' +
        'actual store catalogue - it only knows what people have written down.',
    },
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add a note',
      description:
        'Record a note for the team. Optionally tag it with a product name, which makes ' +
        'it show up in list_products. This writes data.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('A short headline for the note.'),
        body: z.string().min(1).max(5_000).describe('The note itself.'),
        author: z
          .string()
          .min(1)
          .max(200)
          .describe('Who is recording this note, as a name or email address.'),
        product: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Optional product name this note is about. Free text: this server does not ' +
              'check it against the store catalogue, so spelling it the same way as in ' +
              'the store is what makes the two comparable.',
          ),
      },
      // Honest annotations, because the gateway forwards them to an LLM and this is the
      // one tool here with a side effect.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (args) => {
      const note = deps.store.addNote({
        title: args.title,
        body: args.body,
        author: args.author,
        ...(args.product === undefined ? {} : { product: args.product }),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ added: note }, null, 2) }] };
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'Recent team notes, newest first. Optionally filter by author or by product.',
      inputSchema: {
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('How many notes to return, newest first.'),
        author: z.string().min(1).max(200).optional().describe('Only notes by this author.'),
        product: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Only notes tagged with this product name.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const notes = deps.store.listNotes({
        limit: args.limit,
        ...(args.author === undefined ? {} : { author: args.author }),
        ...(args.product === undefined ? {} : { product: args.product }),
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: notes.length, notes }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'list_products',
    {
      title: 'List products mentioned in notes',
      /**
       * The description says plainly what this is and what it is not.
       *
       * That matters more here than for any other tool in the system: an agent is about
       * to be shown two tools whose names differ only by prefix, and the description is
       * the only thing that tells it which one answers the question it actually has.
       * "Products the team has written notes about - NOT the store catalogue" is the
       * sentence that makes the collision navigable instead of a coin flip.
       */
      description:
        'Products the team has written notes about, with how many notes mention each. ' +
        'This is NOT the store catalogue - it only reflects what people recorded here, ' +
        'and a product named in a note may not exist in the shop at all. For the real ' +
        'catalogue, use the WooCommerce server\'s list_products instead.',
      inputSchema: {
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('How many products to return, most-mentioned first.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => {
      const products = deps.store.listProducts({ limit: args.limit });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                source: `notes (${deps.instanceSlug})`,
                note: 'mentions in team notes, not the store catalogue',
                count: products.length,
                products,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
