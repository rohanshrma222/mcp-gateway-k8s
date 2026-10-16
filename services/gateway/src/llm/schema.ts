/**
 * Turning an upstream's JSON Schema into one a chat-completions model will accept.
 *
 * The plan for this step said "normalise MCP JSON Schemas (strip `$ref`, force
 * `type: object`, drop unsupported keywords)". Before writing any of that I dumped all 21
 * schemas the gateway currently serves and looked at every keyword in them:
 *
 *     $schema a after ambiguous author b before body count data default description
 *     duration enum exclusiveMinimum format id includeImage limit location maxLength
 *     maximum message messageType minLength minimum name outputType page pattern per_page
 *     product properties regular_price required resourceId resourceType search
 *     short_description sku status steps title topic type
 *
 * There is **no `$ref`, `$defs`, `definitions`, `oneOf`, `anyOf`, `allOf` or `not` in any
 * of them**, every schema already has `type: 'object'`, and every one already has
 * `properties`. So two thirds of the work the plan called for is work this tool set does
 * not need - the schemas come from the MCP SDK's zod-to-JSON-Schema conversion, which emits
 * a flat subset by construction.
 *
 * What is actually present and needs doing is small: drop `$schema` (meaningless to the
 * model, and some providers reject unknown top-level keys), and keep `enum`, `format`,
 * `pattern`, `minimum`/`maximum` and `minLength`/`maxLength`, all of which OpenAI-style
 * function calling understands and which genuinely help the model produce valid arguments.
 *
 * The reference-handling capability is still here, because the finding above is about
 * today's three upstreams rather than about the gateway. Registering an upstream is a
 * runtime action - an admin can add one this afternoon whose schemas use `$ref` - and the
 * failure mode if that happens is the bad kind: silent. Which is the real decision in this
 * file.
 */
import type { Logger } from 'pino';

/**
 * A schema that could not be represented is a reason to HIDE the tool, not to patch it.
 *
 * The tempting move is to strip what the model cannot handle and send the rest. That is
 * wrong, and worth being precise about: stripping a `$ref` leaves a property with no type
 * and no constraints, so the model is told a parameter exists and told nothing about what
 * goes in it. It will fill it in confidently and wrongly - and because the gateway
 * deliberately does not validate `tools/call` arguments (decision from 5.4: a proxy
 * forwards the upstream's schema verbatim and lets the upstream judge), that wrong value
 * travels all the way to the upstream, which may well act on it.
 *
 * A tool the model cannot see is a tool it cannot misuse. A tool it can see but not
 * describe correctly is a mutation waiting to happen with the wrong arguments. So an
 * unrepresentable schema removes the tool from the model's list and logs it at `warn` with
 * the offending keyword, because an invisible tool with no explanation is its own
 * debugging problem.
 */
const UNREPRESENTABLE = ['$ref', '$defs', 'definitions', 'allOf', 'not'] as const;

/**
 * `oneOf` and `anyOf` are listed separately because they are not quite the same case.
 *
 * A model CAN often satisfy a union - it will pick one branch - but the schema it is shown
 * does not say which fields are mutually exclusive in a way these APIs represent, so the
 * arguments it produces may satisfy no branch. Treated as unrepresentable for the same
 * reason as the list above, and kept distinct so the log line can say which it was: if an
 * upstream ever trips this, the distinction is the first thing worth knowing.
 */
const UNION_KEYWORDS = ['oneOf', 'anyOf'] as const;

/** Top-level keys that are noise to a model and are dropped rather than refused. */
const DROPPED_AT_ROOT = ['$schema', '$id', 'title'] as const;

/**
 * Walks a schema looking for a keyword that cannot be shown to a model faithfully.
 *
 * **This was a substring search over `JSON.stringify(schema)` first**, with a comment
 * claiming that searching for the quoted form `"not":` avoided matching a property
 * legitimately named `not`. The comment was wrong, and a test caught it: a schema like
 * `{ properties: { not: { type: 'string' } } }` serialises to text containing `"not":`
 * exactly, so a tool with a parameter named `not` - or `allOf`, or `$ref` - was rejected
 * and silently hidden from the model. The failure this function exists to prevent, caused
 * by the function.
 *
 * So it walks, and the distinction that matters is positional: inside a `properties` or
 * `$defs` object the keys are USER-CHOSEN NAMES and must not be read as keywords, while
 * their values are schemas and must be. Nothing but position tells those two apart, which
 * is why a text search cannot be made correct by better quoting.
 *
 * Returns the offending keyword, or `undefined` if the schema is representable.
 */
function findUnrepresentable(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;

  if (Array.isArray(node)) {
    // Array positions hold schemas (`items`, `prefixItems`), so each is checked.
    for (const item of node) {
      const found = findUnrepresentable(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const record = node as Record<string, unknown>;

  for (const keyword of [...UNREPRESENTABLE, ...UNION_KEYWORDS]) {
    if (Object.hasOwn(record, keyword)) return keyword;
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' || key === 'patternProperties') {
      /**
       * The keys here are property names chosen by whoever wrote the upstream, so they are
       * skipped as keywords and only their values are descended into. This is the whole
       * bug the text search had.
       */
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const sub of Object.values(value as Record<string, unknown>)) {
        const found = findUnrepresentable(sub);
        if (found !== undefined) return found;
      }
      continue;
    }

    const found = findUnrepresentable(value);
    if (found !== undefined) return found;
  }

  return undefined;
}

export interface NormalisedSchema {
  ok: true;
  schema: Record<string, unknown>;
}

export interface RejectedSchema {
  ok: false;
  /** The keyword that made it unrepresentable, for the log line and the metric label. */
  reason: string;
}

/**
 * Normalise one tool's input schema, or reject it.
 *
 * Deliberately NOT a deep rewrite. Everything except the dropped root keys is passed
 * through as-is, because the upstream's schema is the authority on what the upstream
 * accepts and 5.4 already settled that the gateway does not get to reinterpret it. The
 * function's job is to answer "can a model be shown this?" and to remove the two or three
 * keys that are about JSON Schema rather than about the arguments.
 */
export function normaliseToolSchema(input: unknown): NormalisedSchema | RejectedSchema {
  /**
   * An absent or non-object schema becomes the empty object schema rather than a rejection.
   *
   * MCP permits a tool with no inputs, and several of everything-mcp's are exactly that.
   * `{ type: 'object', properties: {} }` is how a no-argument function is spelled in a
   * chat-completions request - omitting `parameters` entirely makes some providers treat
   * the tool as malformed, and omitting `properties` makes others reject it.
   */
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: true, schema: { type: 'object', properties: {} } };
  }

  const found = findUnrepresentable(input);
  if (found !== undefined) return { ok: false, reason: found };

  const schema: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of DROPPED_AT_ROOT) delete schema[key];

  /**
   * `type: 'object'` is forced, and `properties` defaulted.
   *
   * Every current schema already has both, so this changes nothing today. It is here
   * because a chat-completions tool's parameters MUST be an object schema - that is the
   * protocol, not a provider quirk, since the arguments arrive as a JSON object - and an
   * upstream publishing a top-level array or string schema would otherwise produce a
   * request the provider rejects with a message about our request rather than about the
   * upstream, which is a confusing place to start debugging.
   */
  schema.type = 'object';
  if (schema.properties === undefined || typeof schema.properties !== 'object') {
    schema.properties = {};
  }

  return { ok: true, schema };
}

export interface ToolForModel {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NormaliseResult {
  tools: ToolForModel[];
  /** Tools excluded from the model's view, with why. Surfaced so it is never silent. */
  excluded: { name: string; reason: string }[];
}

/**
 * Normalise a whole tool list, excluding what cannot be represented.
 */
export function normaliseToolsForModel(
  tools: { name: string; description?: string | undefined }[],
  schemaOf: (name: string) => unknown,
  logger: Logger,
): NormaliseResult {
  const out: ToolForModel[] = [];
  const excluded: { name: string; reason: string }[] = [];

  for (const tool of tools) {
    const result = normaliseToolSchema(schemaOf(tool.name));
    if (!result.ok) {
      excluded.push({ name: tool.name, reason: result.reason });
      logger.warn(
        { tool: tool.name, keyword: result.reason },
        'tool hidden from the chat agent: its input schema uses a keyword the model cannot be shown faithfully',
      );
      continue;
    }

    out.push({
      name: tool.name,
      /**
       * A tool with no description still gets a sentence, because the description is how
       * the model decides whether to call it at all. An empty string makes the tool
       * effectively invisible to the model while appearing in the list, which looks like a
       * model failure and is actually missing metadata.
       */
      description:
        tool.description !== undefined && tool.description.trim() !== ''
          ? tool.description
          : `The ${tool.name} tool. The upstream published no description for it.`,
      parameters: result.schema,
    });
  }

  return { tools: out, excluded };
}
