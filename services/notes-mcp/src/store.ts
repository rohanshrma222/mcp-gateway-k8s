/**
 * The notes store: SQLite, via Node's built-in `node:sqlite`.
 *
 * **Why SQLite on its own volume rather than a schema in the platform Postgres.** The
 * gateway is supposed to treat an upstream as a black box it reaches only over MCP. Giving
 * one of them a table inside the control plane's own database would make that isolation a
 * story rather than a fact - and it would mean this server could not be handed to another
 * team, or run outside this cluster, without taking the gateway's database with it. An
 * upstream that owns its storage completely is the honest shape.
 *
 * **Why the built-in rather than `better-sqlite3`.** The built-in has no install step to
 * get wrong. `better-sqlite3` is a native module needing musl prebuilds, and this repo has
 * already paid for that class of problem twice: argon2 in 4.3, and 4.6 where npm nested a
 * dependency under the workspace and the Dockerfile shipped the wrong tree. Verified in
 * the exact image this service is built from (node:24.15.0-alpine, Node v24.22.0):
 * `DatabaseSync` imports, creates a table, inserts and reads back with no flag.
 *
 * **The costs, stated rather than discovered later.** `node:sqlite` is still marked
 * experimental in Node 24, so it emits a warning at startup and its API could change
 * across a major - pinned base image, so that is a decision point rather than a surprise.
 * And SQLite on a ReadWriteOnce volume means `replicas: 1` for this upstream: one writer,
 * one node. That second constraint is independently useful for the demo, because it puts
 * an upstream that genuinely cannot scale horizontally next to a gateway that can - which
 * is the more interesting half of the scaling story.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './logger.js';

export interface Note {
  id: number;
  title: string;
  body: string;
  author: string;
  product: string | null;
  createdAt: string;
}

export interface ProductMention {
  product: string;
  mentions: number;
  lastMentionedAt: string;
  lastNoteId: number;
  lastNoteTitle: string;
}

export class NotesStore {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly logger: Logger) {
    // The PVC is mounted at /data, but the directory for a nested path may not exist on a
    // freshly provisioned volume. Created here rather than assumed, because the
    // alternative is a startup crash whose message is about SQLite rather than about a
    // missing directory.
    mkdirSync(dirname(path), { recursive: true });

    this.db = new DatabaseSync(path);

    /**
     * WAL, and the reason is specific to running under Kubernetes probes.
     *
     * In the default rollback-journal mode a writer blocks readers. This process answers
     * `/readyz` by touching the database, so a single slow write could make the readiness
     * probe time out and take the pod out of its Service - the exact failure woo-mcp hit
     * in stage 3 for a different reason. WAL lets the probe read while a write is in
     * flight.
     *
     * `synchronous = NORMAL` rather than FULL: with WAL this still survives a process
     * crash, and loses only the last transactions on a sudden machine power loss. For
     * team notes on a kind cluster that is the right trade; FULL would fsync on every
     * commit for durability this data does not need.
     */
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Off by default in SQLite, which is a surprise worth defending against explicitly:
    // without it the `product` column's shape is enforced by nothing.
    this.db.exec('PRAGMA foreign_keys = ON');

    this.migrate();
  }

  /**
   * Schema, applied on every start.
   *
   * `IF NOT EXISTS` rather than the numbered-migration ledger the platform database uses.
   * The difference is deliberate and worth being able to defend: the platform's schema is
   * edited by people over time and a checksum ledger catches a file changing under a
   * deployment that already applied it. This one table belongs to this one service and
   * ships with it, so the image and the schema version are the same artefact. Adding a
   * ledger here would be ceremony around a problem that cannot occur.
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        author     TEXT    NOT NULL,
        -- Nullable: a note may or may not be about a product. This column is what makes
        -- list_products answerable, and it is a plain string rather than a reference,
        -- because this server deliberately knows nothing about the WooCommerce catalogue.
        -- See mcp/server.ts on why that is the point of the collision rather than a gap.
        product    TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `);
    // Newest-first is the only order anything reads these in.
    this.db.exec('CREATE INDEX IF NOT EXISTS notes_created_idx ON notes (created_at DESC, id DESC)');
    this.db.exec('CREATE INDEX IF NOT EXISTS notes_product_idx ON notes (product) WHERE product IS NOT NULL');
  }

  addNote(input: { title: string; body: string; author: string; product?: string }): Note {
    const result = this.db
      .prepare('INSERT INTO notes (title, body, author, product) VALUES (?, ?, ?, ?) RETURNING id, created_at')
      .get(input.title, input.body, input.author, input.product ?? null) as
      | { id: number; created_at: string }
      | undefined;

    if (result === undefined) {
      // RETURNING cannot legitimately come back empty for a successful single-row insert,
      // so this is a "cannot happen" that still gets a real error rather than a
      // non-null assertion - the assertion is what turns this into a confusing
      // TypeError three frames away if it ever does.
      throw new Error('insert returned no row');
    }

    this.logger.info({ noteId: result.id, product: input.product ?? null }, 'note added');

    return {
      id: result.id,
      title: input.title,
      body: input.body,
      author: input.author,
      product: input.product ?? null,
      createdAt: result.created_at,
    };
  }

  listNotes(options: { limit: number; author?: string; product?: string }): Note[] {
    const conditions: string[] = [];
    // Typed concretely rather than as unknown[]: node:sqlite constrains bound values to
    // SQLInputValue, and an unknown[] spread into .all() does not satisfy it. The compiler
    // catching that is the flag earning its keep - a cast would have compiled and then
    // thrown at runtime on the first unexpected value.
    const params: (string | number)[] = [];

    if (options.author !== undefined) {
      conditions.push('author = ?');
      params.push(options.author);
    }
    if (options.product !== undefined) {
      conditions.push('product = ?');
      params.push(options.product);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT id, title, body, author, product, created_at
           FROM notes ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, options.limit) as {
      id: number;
      title: string;
      body: string;
      author: string;
      product: string | null;
      created_at: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      author: row.author,
      product: row.product,
      createdAt: row.created_at,
    }));
  }

  /**
   * Products *mentioned in notes* - which is what makes the deliberate name collision
   * meaningful rather than contrived. See `mcp/server.ts`.
   */
  listProducts(options: { limit: number }): ProductMention[] {
    const rows = this.db
      .prepare(
        `SELECT product,
                count(*)                       AS mentions,
                max(created_at)                AS last_mentioned_at,
                -- The note that carried the most recent mention. max(id) rather than a
                -- correlated subquery because id is monotonic, so within one product
                -- group the largest id IS the newest note - and one aggregate beats a
                -- subquery per row.
                max(id)                        AS last_note_id
           FROM notes
          WHERE product IS NOT NULL
          GROUP BY product
          ORDER BY count(*) DESC, max(created_at) DESC
          LIMIT ?`,
      )
      .all(options.limit) as {
      product: string;
      mentions: number;
      last_mentioned_at: string;
      last_note_id: number;
    }[];

    // Titles fetched in one pass rather than a query per row. Small either way at this
    // scale; written this way because a loop of queries is the shape that stops being
    // small without anyone noticing.
    const titles = new Map<number, string>();
    if (rows.length > 0) {
      const placeholders = rows.map(() => '?').join(', ');
      const titleRows = this.db
        .prepare(`SELECT id, title FROM notes WHERE id IN (${placeholders})`)
        .all(...rows.map((row) => row.last_note_id)) as { id: number; title: string }[];
      for (const row of titleRows) titles.set(row.id, row.title);
    }

    return rows.map((row) => ({
      product: row.product,
      mentions: row.mentions,
      lastMentionedAt: row.last_mentioned_at,
      lastNoteId: row.last_note_id,
      lastNoteTitle: titles.get(row.last_note_id) ?? '(unknown)',
    }));
  }

  /**
   * Can this process serve a tool call?
   *
   * One trivial query against the real file, which is what distinguishes "the database is
   * open and answering" from "the handle exists". It touches only state this server owns,
   * so unlike woo-mcp's store probe this one IS a readiness verdict - the rule from 4.2
   * applies: a dependency belongs in readiness when it is the component's own state.
   */
  check(): { ok: true; notes: number } {
    const row = this.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number };
    return { ok: true, notes: row.n };
  }

  close(): void {
    this.db.close();
  }
}
