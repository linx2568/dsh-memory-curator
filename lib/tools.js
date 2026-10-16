/**
 * The agent-facing memory tools: definitions, schemas and handlers.
 *
 * Split out of `mount.js` so the parameter specs have exactly one home. They
 * are written in the Harness authoring shorthand and compiled to object-rooted
 * JSON Schema by `toolDefinition` (see lib/harness.js) — `ctx.tools.register()`
 * forwards `parameters` to the model provider VERBATIM, and a bare property map
 * there is rejected with INVALID_REQUEST, which fails the whole request rather
 * than just the one tool. `test/tools.test.js` pins that contract.
 *
 * @module dsh-memory-curator/tools
 */

import { toolDefinition } from './harness.js'
import { renderDetail } from './recall.js'

/**
 * Authoring parameter specs, keyed by tool name — the single source of truth.
 *
 * Written in the Harness shorthand, compiled to object-rooted JSON Schema by
 * `toolDefinition`. `test/tools.test.js` feeds these very objects to the
 * Harness's own compiler, so the spec here and the schema the provider receives
 * cannot drift apart.
 *
 * @type {Record<string, object>}
 */
export const toolParameters = {
  memory_search: {
    query: { type: 'string', required: true, description: 'What to look for, in natural language.' },
    limit: { type: 'number', description: 'Maximum entries, 1 through 20; defaults to 8.' },
  },
  memory_detail: {
    id: { type: 'string', required: true, description: 'Entry id (or an unambiguous prefix) from memory_search or the memory index.' },
  },
  memory_add: {
    text: { type: 'string', required: true, description: 'One self-contained statement, readable with no surrounding context.' },
    kind: { type: 'string', description: 'One of: decision, correction, prohibition, reference, open, fact. Defaults to fact.' },
    subject: { type: 'string', description: 'Short stable key naming what this is about; reuse the same wording for the same topic so contradictions are detected.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
  },
  memory_curate: {},
  memory_forget: {
    id: { type: 'string', required: true, description: 'Entry id (or an unambiguous prefix).' },
  },
  memory_stats: {},
}

/**
 * The tool definitions, as specs.
 *
 * Each entry carries the authoring parameter map plus an `execute` that
 * receives the shared context, so the same specs drive both registration and
 * the schema tests. Handlers never capture state at module scope: `ctx` is
 * passed per call.
 *
 * @param {object} deps - live collaborators.
 * @param {object} deps.store - the memory store.
 * @param {object} deps.settings - resolved plugin settings.
 * @param {(exec: object) => string} deps.scopeForExecution - scope of a tool call.
 * @param {(scope: string, signal: AbortSignal) => Promise<object>} deps.adjudicateConflicts - model-assisted conflict pass.
 * @returns {object[]} registry-ready definitions.
 */
export function memoryTools({ store, settings, scopeForExecution, adjudicateConflicts }) {
  return [
    toolDefinition({
      name: 'memory_search',
      description: 'Tier-2 recall: search durable memory for entries relevant to a query. Returns short digests only (each under 240 characters) with an id. Call memory_detail with an id to read the full text. Use this when the injected memory index did not surface what you need.',
      parameters: toolParameters.memory_search,
      async execute(args, exec) {
        const scope = scopeForExecution(exec)
        const limit = Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 20 ? args.limit : 8
        const hits = store.search(args.query, scope, limit)
        if (hits.length === 0) return JSON.stringify({ query: args.query, results: [], note: 'No matching active memory. Absence of a result is not evidence that the fact was never recorded.' })
        return JSON.stringify({
          query: args.query,
          results: hits.map(({ entry, score }) => ({
            id: entry.id, kind: entry.kind, subject: entry.subject, score: Number(score.toFixed(3)), digest: entry.text.slice(0, 240),
          })),
          note: 'These are bounded digests. Call memory_detail for the full text of any id.',
        })
      },
      presentCall: (args) => ({ card: 'generic', title: `Search memory: ${String(args.query ?? '')}`, kind: 'search', rawInput: args }),
    }),

    toolDefinition({
      name: 'memory_detail',
      description: 'Tier-3 recall: read ONE durable memory entry in full by its id, including status, scope, timestamps and any successor. Use after memory_search or the injected index has given you an id.',
      parameters: toolParameters.memory_detail,
      async execute(args) {
        const entry = store.get(args.id)
        if (entry === undefined) {
          return JSON.stringify({ error: 'no unique memory entry matches that id', id: args.id })
        }
        // Opening an entry in full is the one hard signal that it earned its
        // prompt bytes; it feeds the index ordering and the decay pass.
        store.markRecalled(entry.id)
        store.flush()
        const successor = entry.supersededBy === undefined ? undefined : store.get(entry.supersededBy)
        return renderDetail(entry, { supersededBy: successor })
      },
      presentCall: (args) => ({ card: 'generic', title: `Read memory ${String(args.id ?? '')}`, kind: 'read', rawInput: args }),
    }),

    toolDefinition({
      name: 'memory_add',
      description: 'Record one durable memory entry. Use for facts, decisions, corrections, prohibitions, references, or open work that should survive this session. Duplicates fold automatically and a newer entry on an existing subject automatically retires the outdated one, so record freely without checking first.',
      parameters: toolParameters.memory_add,
      async execute(args, exec) {
        const scope = scopeForExecution(exec)
        const result = store.insert({ ...args, tags: args.tags ?? [] }, { scope, source: { kind: 'agent-tool' } })
        if (result.action === 'invalid') return JSON.stringify({ error: 'the entry needs non-empty text' })
        if (settings.curateEnabled) store.curate()
        store.flush()
        if (result.action === 'folding') {
          return JSON.stringify({ action: 'folded-into-existing', id: result.entry.id, subject: result.entry.subject, note: 'An equivalent memory already existed; it was updated instead of duplicated.' })
        }
        if (result.action === 'conflict') {
          return JSON.stringify({
            action: 'recorded-and-superseded',
            id: result.entry.id,
            superseded: result.superseded.map((entry) => ({ id: entry.id, text: entry.text })),
            note: 'The newer statement replaced the outdated one; the older is kept as history and no longer recalled.',
          })
        }
        return JSON.stringify({ action: 'added', id: result.entry.id, kind: result.entry.kind, subject: result.entry.subject })
      },
      presentCall: () => ({ card: 'generic', title: 'Record memory', kind: 'edit' }),
    }),

    toolDefinition({
      name: 'memory_curate',
      description: 'Run the curation pass now: fold duplicate entries and retire entries superseded by newer ones. Normally automatic; use this to consolidate after a burst of recording.',
      parameters: toolParameters.memory_curate,
      async execute(_args, exec) {
        const scope = scopeForExecution(exec)
        const folded = store.curate()
        const controller = new AbortController()
        const adjudicated = await adjudicateConflicts(scope, controller.signal)
        store.flush()
        return JSON.stringify({
          foldedDuplicates: folded.folded,
          retiredSuperseded: folded.retired + adjudicated.superseded,
          conflictPairsChecked: adjudicated.checked,
          stats: store.stats(scope),
        })
      },
      presentCall: () => ({ card: 'generic', title: 'Curate memory', kind: 'other' }),
    }),

    toolDefinition({
      name: 'memory_forget',
      description: 'Retire one durable memory entry so it is no longer recalled. Use only when the user asks, or when an entry is verified wrong or obsolete.',
      parameters: toolParameters.memory_forget,
      async execute(args) {
        const entry = store.forget(args.id)
        if (entry === undefined) return JSON.stringify({ error: 'no unique memory entry matches that id', id: args.id })
        store.flush()
        return JSON.stringify({ action: 'forgotten', id: entry.id, text: entry.text })
      },
      presentCall: () => ({ card: 'generic', title: 'Forget memory', kind: 'delete' }),
    }),

    toolDefinition({
      name: 'memory_stats',
      description: 'Report durable-memory counters for this workspace: active, superseded, merged and forgotten entries, and per-kind totals.',
      parameters: toolParameters.memory_stats,
      async execute(_args, exec) {
        const scope = scopeForExecution(exec)
        return JSON.stringify({ scope, store: settings.storeFile, ...store.stats(scope) }, null, 2)
      },
      presentCall: () => ({ card: 'generic', title: 'Memory statistics', kind: 'read' }),
    }),
  ]
}

/**
 * Register every memory tool on a `tools` service.
 *
 * @param {object} tools - the Harness `tools` service.
 * @param {object} deps - see {@link memoryTools}.
 * @returns {Function[]} one disposer per registration.
 */
export function registerMemoryTools(tools, deps) {
  return memoryTools(deps).map((definition) => tools.register(definition))
}
