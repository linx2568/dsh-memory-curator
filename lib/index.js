/**
 * dsh-memory-curator — curated durable memory for DeepSeek Harness.
 *
 * Four behaviours, all owned here:
 *   A. Automatic capture — every finished turn is distilled into durable entries.
 *   B. Progressive-disclosure recall — a bounded index is injected each turn;
 *      full text is fetched only through `memory_detail`.
 *   C. Automatic duplicate consolidation — duplicate statements fold into one.
 *   D. Automatic conflict resolution — a newer decision retires the outdated one,
 *      with model adjudication for the pairs the deterministic pass cannot settle.
 *
 * Plus an HTTP surface for the management panel in the DSH sidebar: the panel
 * calls `/api/memory-curator/*` (see `mountPanelApi` in lib/panel-api.js).
 *
 * The panel deliberately does NOT use `ctx.remote.memoryCurator`. A client half
 * that hard-injects `remote.<namespace>` stays `pending` when the namespace is
 * absent, and the DSH web shell reports a pending client entry as a boot failure
 * ("web boot: 1 entry did not activate"), which stops the whole app from
 * starting. Same-origin HTTP routes carry no such risk: the panel renders and
 * reports an ordinary error if the route is missing.
 *
 * Everything is local: one JSON store under $DSH_HOME, no network of its own,
 * no account, no API key. Model calls reuse the Harness `llm` service.
 *
 * Tool `parameters` are authoring shorthand in lib/tools.js, compiled to
 * object-rooted JSON Schema by lib/harness.js before registration — the
 * registry forwards them to the provider verbatim, and a schema without a root
 * `type: "object"` fails the whole request with INVALID_REQUEST.
 *
 * The package is a plain Cordis Service. It deliberately does NOT carry a
 * Typert `@Remote` surface: the panel talks over HTTP instead (see above), so
 * the only runtime imports are `cordis` and `schemastery` — both declared peer
 * dependencies, which keeps the install-time surface as small as possible.
 *
 * @module dsh-memory-curator
 */

import { Service } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"

import { mount, resolveConfig } from './mount.js'
import { MemoryStore, scopeForCwd } from './store.js'
import { renderCatalog, renderDetail } from './recall.js'
import { memoryTools, toolParameters } from './tools.js'
import { compileParameters, assertParameters } from './harness.js'

/** The plugin's own name, used for prompt sections and tool provenance. */
export const name = 'memory-curator'

/** Cordis service key: what this Service registers as on the context. */
const SERVICE_KEY = 'memoryCurator'

/**
 * Cordis Service that owns the memory store and mounts the
 * capture/recall/curate/tools wiring plus the management-panel HTTP API.
 */
class MemoryCuratorService extends Service {
  static Config = z.object({
    captureEnabled: z.boolean().default(true),
    recallEnabled: z.boolean().default(true),
    curateEnabled: z.boolean().default(true),
    catalogMaxBytes: z.number().default(2400),
    curateEveryTurns: z.number().default(5),
    maxConcurrentDistills: z.number().default(2),
    distillTimeoutMs: z.number().default(60000),
    minTurnChars: z.number().default(80),
    dupThreshold: z.number().default(0.82),
    storeFile: z.string().default(''),
  })

  constructor(ctx, config) {
    super(ctx, SERVICE_KEY)
    this.ctx = ctx
    this.config = resolveConfig(config)
    mount(ctx, config, this)
  }
}

export { MemoryCuratorService as default, MemoryCuratorService }
/** Exported for tests and for reuse by other plugins. */
export { MemoryStore, renderCatalog, renderDetail, scopeForCwd, mount }
export { memoryTools, toolParameters, compileParameters, assertParameters }
