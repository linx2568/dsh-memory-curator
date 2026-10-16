/**
 * Mount body for dsh-memory-curator — the capture/recall/curate/tools wiring.
 *
 * Extracted from the historical `apply` form so the package can be a Cordis
 * Service whose constructor calls this. The same store is then handed to the
 * management panel through the HTTP routes in lib/panel-api.js.
 *
 * @module dsh-memory-curator/mount
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mountPanelApi } from './panel-api.js'
import { registerMemoryTools } from './tools.js'
import { MemoryStore, scopeForCwd, normalizeText, jaccard } from './store.js'
import { distillTurn, resolveConflict, RECALL_GUIDANCE } from './extract.js'
import { renderCatalog } from './recall.js'
import { readRepoContext } from './repo-docs.js'

const SECTION_NAME = 'memory-curator:guidance'
const CONTEXT_NAME = 'memory-curator:index'
/** High order keeps the index late in runtime context, near other live facts. */
const CONTEXT_ORDER = 9000

/** Resolve $DSH_HOME the same way the shipped plugins do. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** Merge user config over the shipped defaults, rejecting nonsense. */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)
  return {
    captureEnabled: input.captureEnabled !== false,
    recallEnabled: input.recallEnabled !== false,
    curateEnabled: input.curateEnabled !== false,
    catalogMaxBytes: positive(input.catalogMaxBytes, 2400),
    curateEveryTurns: positive(input.curateEveryTurns, 5),
    maxConcurrentDistills: positive(input.maxConcurrentDistills, 2),
    distillTimeoutMs: positive(input.distillTimeoutMs, 60_000),
    minTurnChars: positive(input.minTurnChars, 80),
    dupThreshold: Number.isFinite(input.dupThreshold) && input.dupThreshold > 0 && input.dupThreshold <= 1
      ? input.dupThreshold
      : 0.82,
    storeFile: typeof input.storeFile === 'string' && input.storeFile.trim() !== ''
      ? path.resolve(input.storeFile.trim())
      : path.join(resolveDshHome(), 'memory-curator', 'store.json'),
  }
}

/** Bound one promise with a deadline; resolves `undefined` on timeout. */
function withTimeout(promise, timeoutMs) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Mount the plugin's capture/recall/curate/tools behaviour onto a Cordis
 * context. Called from the Service constructor; the store is attached to
 * `service` so the panel API can read the very same instance.
 *
 * @param {object} ctx - Cordis context of the plugin's own fiber
 * @param {unknown} config - the row's `config` from the bundle patch
 * @param {object} service - the owning service (receives `.store`, `.settings`)
 */
export function mount(ctx, config, service) {
  const logger = ctx.logger ?? console
  const settings = resolveConfig(config)

  fs.mkdirSync(path.dirname(settings.storeFile), { recursive: true })
  const store = new MemoryStore(settings.storeFile, { dupThreshold: settings.dupThreshold })
  service.store = store
  service.settings = settings

  /**
   * Per-session capture bookkeeping. The cursor counts derived messages already
   * distilled, so a later turn only pays for its own text.
   */
  const sessions = new Map()
  /** Scope lookup from a session, used by both capture and recall. */
  const scopeOf = (session) => scopeForCwd(session?.header?.cwd)
  /** In-flight distillation count, so a burst of turns cannot stampede the model. */
  let activeDistills = 0

  /** The model route auxiliary calls should use. */
  const modelRoute = () => {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection === undefined || selection === null) return { provider: undefined, model: undefined }
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      return { provider: undefined, model: undefined }
    }
    return { provider: selection.provider, model: selection.model }
  }

  /** Call the LLM for one bounded job under the current route. */
  const llmDeps = (signal, sessionId) => {
    const route = modelRoute()
    return { llm: ctx.get('llm'), provider: route.provider, model: route.model, signal, sessionId }
  }

  /** Persist a batch of candidates, reporting what curation did. */
  function commitCandidates(candidates, scope, source) {
    const outcome = { added: 0, folded: 0, conflicts: 0 }
    for (const candidate of candidates) {
      const result = store.insert(candidate, { scope, source })
      if (result.action === 'added') outcome.added += 1
      else if (result.action === 'folding') outcome.folded += 1
      else if (result.action === 'conflict') outcome.conflicts += 1
    }
    if (settings.curateEnabled) {
      const curated = store.curate()
      outcome.folded += curated.folded
      outcome.conflicts += curated.retired
    }
    store.flush()
    return outcome
  }

  /**
   * Requirement D, model-assisted half: for active decisional entries in one
   * scope that share a subject but are not textually similar, ask the model
   * whether the newer one supersedes the older.
   */
  async function adjudicateConflicts(scope, signal) {
    const active = store.active(scope).filter((entry) => entry.status === 'active')
    const pairs = []
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i]
        const b = active[j]
        if (a.kind === 'reference' || b.kind === 'reference') continue
        const sameSubject = normalizeText(a.subject) === normalizeText(b.subject)
        if (!sameSubject) continue
        if (jaccard(a.text, b.text) >= settings.dupThreshold) continue
        const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a]
        pairs.push([older, newer])
      }
    }
    if (pairs.length === 0) return { checked: 0, superseded: 0 }
    let superseded = 0
    for (const [older, newer] of pairs.slice(0, 3)) {
      if (signal?.aborted === true) break
      const result = await withTimeout(
        resolveConflict(llmDeps(signal, undefined), older, newer),
        settings.distillTimeoutMs,
      )
      if (result === undefined || result.ok !== true) continue
      if (result.verdict === 'coexist') continue
      older.status = result.verdict === 'duplicate' ? 'merged' : 'superseded'
      older.supersededBy = newer.id
      older.updatedAt = Date.now()
      if (result.text !== '' && result.verdict === 'supersede') {
        newer.text = result.text
        if (result.subject !== '') newer.subject = result.subject
      }
      superseded += 1
    }
    if (superseded > 0) store.flush()
    return { checked: pairs.length, superseded }
  }

  /** Requirement A: distil one turn's messages and store what survives. */
  async function captureTurn(session, messages, signal) {
    if (activeDistills >= settings.maxConcurrentDistills) return
    activeDistills += 1
    try {
      // The repository's own documents bound what may be recorded: AGENTS.md and
      // CLAUDE.md ride along in full (bounded), every other project document as a
      // name. The read is cached per file, so a quiet repository costs a few stats.
      const repoContext = readRepoContext(session?.header?.cwd)
      const result = await withTimeout(
        distillTurn(llmDeps(signal, session.id), messages, {
          minChars: settings.minTurnChars,
          repoContext,
        }),
        settings.distillTimeoutMs,
      )
      if (result === undefined) return
      if (result.ok !== true) {
        logger.warn?.(`memory-curator: turn distillation skipped (${result.error})`)
        return
      }
      if (result.entries.length === 0) return
      const scope = scopeOf(session)
      const outcome = commitCandidates(result.entries, scope, { kind: 'auto-capture', sessionId: session.id })
      if (settings.curateEnabled) {
        store.countTurn()
        if (store.dueForCuration(settings.curateEveryTurns)) {
          store.markCurated()
          store.flush()
          const adjudicated = await adjudicateConflicts(scope, signal)
          if (adjudicated.superseded > 0) {
            logger.info?.(`memory-curator: retired ${adjudicated.superseded} outdated memory entr${adjudicated.superseded === 1 ? 'y' : 'ies'}`)
          }
        }
      }
      if (outcome.added > 0 || outcome.conflicts > 0) {
        logger.info?.(`memory-curator: captured ${outcome.added} new, folded ${outcome.folded} duplicate, retired ${outcome.conflicts} outdated`)
      }
    } catch (error) {
      logger.warn?.(`memory-curator: capture failed (${String(error?.message ?? error)})`)
    } finally {
      activeDistills -= 1
    }
  }

  // ── capture wiring ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (!settings.captureEnabled) return
    if (event?.type !== 'turn/end') return
    const state = sessions.get(session.id) ?? { processed: 0 }
    sessions.set(session.id, state)
    let messages
    try {
      messages = session.deriveMessages()
    } catch (error) {
      logger.warn?.(`memory-curator: could not read session history (${String(error?.message ?? error)})`)
      return
    }
    if (messages.length <= state.processed) {
      state.processed = messages.length
      return
    }
    const fresh = messages.slice(state.processed)
    state.processed = messages.length
    const controller = new AbortController()
    void captureTurn(session, fresh, controller.signal)
  }), 'memory-curator: capture')

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    sessions.delete(session.id)
  }), 'memory-curator: session cleanup')

  // ── recall wiring ──────────────────────────────────────────────────────────
  ctx.inject(['systemPrompt'], (prompted) => {
    prompted.systemPrompt.section({
      name: SECTION_NAME,
      order: 150,
      text: () => (settings.recallEnabled ? RECALL_GUIDANCE : ''),
    })
    prompted.systemPrompt.context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      text: (context) => {
        if (!settings.recallEnabled) return ''
        const session = context?.agent?.session
        if (session === undefined) return ''
        const scope = scopeOf(session)
        const entries = store.active(scope)
        if (entries.length === 0) return ''
        const catalog = renderCatalog(entries, { maxBytes: settings.catalogMaxBytes })
        return catalog === '' ? '' : `Durable memory index:\n${catalog}`
      },
    })
  })

  // ── tools ──────────────────────────────────────────────────────────────────
  const scopeForExecution = (exec) => scopeOf(exec?.agent?.session)

  ctx.inject(['tools'], (child) => {
    registerMemoryTools(child.tools, { store, settings, scopeForExecution, adjudicateConflicts })
  })

  // ── management panel API ───────────────────────────────────────────────────
  // Same-origin HTTP, NOT a Remote namespace: see lib/panel-api.js for why a
  // hard client dependency on `remote.<namespace>` can stop the whole app from
  // booting. Registered in its own fiber so a composition without a web server
  // loses only the panel, never capture/recall.
  mountPanelApi(ctx, service, logger)

  logger.info?.(`memory-curator: ready (store ${settings.storeFile}, capture ${settings.captureEnabled ? 'on' : 'off'}, recall ${settings.recallEnabled ? 'on' : 'off'}, curation ${settings.curateEnabled ? 'on' : 'off'})`)
}
