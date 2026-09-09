/**
 * Response schemas, handed to whichever adapter can enforce them.
 *
 * `LlmRequest.jsonSchema` has existed since the provider layer was written and
 * had **no callers**, which made it worse than absent: the field read as though
 * structured output was in force, Gemini's `responseSchema` branch was dead
 * code, and every response from every provider was in practice a free-text
 * blob that `analyze/parse.ts` had to repair.
 *
 * That repair is good and stays — a schema is not available on every backend,
 * and Chrome's built-in AI has no schema facility at all. But repairing a
 * malformed response is strictly worse than not receiving one, and it fails in
 * the way that costs most: a truncated or fenced triage response loses the
 * verdicts for a whole pass, and with sampled triage that pass now runs three
 * times.
 *
 * Two schemas, held to different standards on purpose:
 *
 *   TRIAGE_SCHEMA   small, closed, exhaustively specified. Enforceable in
 *                   strict mode, where the provider guarantees the shape rather
 *                   than being asked for it.
 *   AUTHOR_SCHEMA   an envelope only. A finding is a large nested object whose
 *                   optional parts are genuinely optional, and strict mode
 *                   requires every property to be required and every object
 *                   closed. Pinning the whole finding would force the model to
 *                   emit empty strings for fields it has nothing to say about,
 *                   which the grounding pass would then have to strip. So the
 *                   envelope is enforced — `findings` and `declined` both
 *                   present, `siteId` on every entry — and the finding body is
 *                   left open and validated downstream where it already was.
 *
 * The split matters because the envelope is where the accounting contract
 * lives. A site that is silently dropped is the failure two-stage analysis
 * exists to prevent, and that is exactly the property a schema can hold.
 */

/** A schema plus how hard the provider should be asked to hold it. */
export interface ResponseSchema {
  /** Identifier sent to providers that name their schemas. */
  name: string
  schema: Record<string, unknown>
  /**
   * True when every object is closed and every property required, so the
   * provider can guarantee the shape rather than merely aim at it. False for
   * schemas with genuinely optional structure.
   */
  strict: boolean
}

const CATEGORIES = [
  'missing-index', 'redundant-index', 'full-scan', 'n-plus-one',
  'over-fetch', 'unbounded-result', 'plan-cache-miss', 'round-trip',
  'inefficient-join', 'implicit-cast', 'sort-in-memory', 'batching',
  'transaction-scope', 'connection-handling', 'other',
] as const

/**
 * Triage: one verdict per id, nothing else.
 *
 * Closed and fully required, so this is enforceable in strict mode. The
 * accounting contract — every id back, exactly once — is not expressible in
 * JSON Schema and stays where it already is, in `parseTriage`, which reconciles
 * the response against the ids that were sent. The schema removes the *shape*
 * failures so the reconciler only ever has to deal with the semantic ones.
 */
export const TRIAGE_SCHEMA: ResponseSchema = {
  name: 'triage_verdicts',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'verdict', 'category', 'why'],
          properties: {
            id: { type: 'string', description: 'Exactly the id given for this site.' },
            verdict: { type: 'string', enum: ['problem', 'clean', 'unsure'] },
            category: { type: 'string', enum: [...CATEGORIES] },
            why: { type: 'string', description: 'One short clause.' },
          },
        },
      },
    },
  },
}

/**
 * Authoring: the envelope, not the finding.
 *
 * `findings` and `declined` are both required even when empty, because "no
 * findings" and "the model forgot the key" are different answers and the parser
 * cannot tell them apart from an absent key. `siteId` is required on both sides
 * for the same reason: it is what makes a site accountable.
 */
export const AUTHOR_SCHEMA: ResponseSchema = {
  name: 'authored_findings',
  strict: false,
  schema: {
    type: 'object',
    required: ['findings', 'declined'],
    properties: {
      findings: {
        type: 'array',
        description: 'One entry per site that holds up. May be empty.',
        items: {
          type: 'object',
          required: ['siteId'],
          properties: {
            siteId: { type: 'string' },
            category: { type: 'string', enum: [...CATEGORIES] },
          },
        },
      },
      declined: {
        type: 'array',
        description: 'Every site not written up, with a reason. May be empty.',
        items: {
          type: 'object',
          required: ['siteId', 'why'],
          properties: {
            siteId: { type: 'string' },
            why: { type: 'string' },
          },
        },
      },
    },
  },
}

/** The single-shot path returns findings with no declined list. */
export const SINGLE_SHOT_SCHEMA: ResponseSchema = {
  name: 'findings',
  strict: false,
  schema: {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: { type: 'array', items: { type: 'object' } },
    },
  },
}
