/**
 * HTTP surface for the dsh-memory-curator management panel.
 *
 * Why HTTP instead of the Typert Remote namespace: a browser half that declares
 * a HARD dependency on a Remote namespace (`inject: ['remote.memoryCurator']`)
 * stays `pending` when that namespace never appears, and the DSH web shell
 * treats a pending client entry as a boot failure —
 *
 *   Error: web boot: 1 entry did not activate
 *   dsh-memory-curator: pending (waiting for service: remote.memoryCurator)
 *
 * — which stops the entire app from starting. Same-origin HTTP routes have no
 * such coupling: the routes register on the `webServer` service through a nested
 * `ctx.inject` fiber, so a composition without a web server simply has no panel
 * backend, and the panel reports that as an ordinary, recoverable error.
 *
 * This mirrors the pattern used by the known-good `dsh-our-free-model` bundle
 * (`ctx.inject(['webServer'], scoped => scoped.effect(() =>
 * scoped.webServer.register({ kind: 'prefix', path: '/api/...', handler })))`).
 *
 * The routes carry their own same-origin fence ({@link isSameOriginRequest}):
 * a plugin prefix is dispatched BEFORE the web server's authentication gate — on
 * one port DSH's own `/api/client-modules` answers 401 without credentials while
 * a route registered here answers 200 (measured on 127.0.0.1:19387) — so without
 * the fence any page the user has open could POST an entry into durable memory.
 *
 * @module dsh-memory-curator/panel-api
 */

/** Longest request body we accept, so a malformed caller cannot balloon memory. */
const MAX_BODY_BYTES = 256 * 1024

/** Read and JSON-parse one request body, bounded by {@link MAX_BODY_BYTES}. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body (${String(error?.message ?? error)})`))
      }
    })
  })
}

/**
 * Whether a request may reach the panel API, judged by the browser's own
 * cross-site label.
 *
 * These routes are dispatched before the web server's authentication gate, so
 * they have to fence themselves. A browser always labels a cross-site request:
 * either `Sec-Fetch-Site: cross-site`, or an `Origin` that differs from the host
 * it is addressing. Either signal alone is enough to refuse, because a POST with
 * `content-type: text/plain` needs no preflight — nothing else stands between
 * the store and any page the user happens to have open, and a forged entry is
 * recalled as durable memory in a later session.
 *
 * A request carrying neither header comes from a local process (a script, curl,
 * the tests) and holds no browser ambient authority, so it stays allowed; that
 * keeps the API usable from a terminal.
 *
 * @param {object} req - the Node request.
 * @returns {boolean} true when the request may be served.
 */
export function isSameOriginRequest(req) {
  const headers = req?.headers ?? {}
  const site = headers['sec-fetch-site']
  // 'none' is a user-initiated navigation (typed URL, bookmark): it carries no
  // ambient authority, and a navigation cannot send a JSON body.
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    // `Origin: null` (a sandboxed frame, a file:// page) names no host: refuse.
    return false
  }
  const addressed = headers.host
  return typeof addressed === 'string' && addressed !== '' && originHost === addressed
}

/** Reduce a store entry to a JSON-safe, panel-friendly view. */
export function stripEntry(e) {
  return {
    id: e.id,
    kind: e.kind,
    subject: e.subject,
    text: e.text,
    status: e.status,
    scope: e.scope,
    tags: e.tags ?? [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    supersededBy: e.supersededBy,
    recallCount: e.recallCount ?? 0,
  }
}

/**
 * Build the `/api/memory-curator/*` request handler over one mounted service.
 *
 * Routes (all JSON, all same-origin):
 *   GET  /entries         → every entry, newest first
 *   GET  /search?q=&limit → server-side keyword search over active entries
 *   GET  /detail?id=      → one entry in full, plus its successor
 *   GET  /stats           → counters for the panel header
 *   POST /add             → record one entry
 *   POST /forget          → retire one entry
 *   POST /curate          → run the deterministic curation pass now
 *
 * @param {object} service - the mounted MemoryCuratorService (carries `.store`)
 * @returns {(req: object, res: object) => Promise<void>} the route handler
 */
export function createPanelApi(service) {
  /** Send one JSON response with caching disabled (the panel always wants fresh data). */
  const send = (res, status, payload) => {
    const body = JSON.stringify(payload ?? null)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  return async function handler(req, res) {
    // Fence first, before any routing or body read: /add and /forget change what
    // future sessions recall, and this handler is reachable without credentials.
    if (!isSameOriginRequest(req)) {
      return send(res, 403, { error: 'cross-site requests are not accepted by the memory panel API' })
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/memory-curator/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const store = service.store
    if (store === undefined) return send(res, 503, { error: 'memory store is not mounted' })

    try {
      if (method === 'GET' && (routePath === '/' || routePath === '/entries')) {
        // Newest first, and deterministic when timestamps tie: the store returns
        // insertion order, and one turn's capture routinely inserts a whole
        // batch within the same millisecond, so `updatedAt` alone would leave
        // such a batch in reverse. Later insertion wins the tie.
        const entries = store.all()
          .map((entry, index) => ({ entry, index }))
          .sort((a, b) => {
            const delta = (b.entry.updatedAt ?? b.entry.createdAt ?? 0) - (a.entry.updatedAt ?? a.entry.createdAt ?? 0)
            return delta !== 0 ? delta : b.index - a.index
          })
          .map(({ entry }) => stripEntry(entry))
        return send(res, 200, { entries })
      }

      if (method === 'GET' && routePath === '/search') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        if (q === '') return send(res, 200, { results: [] })
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
        const terms = q.split(/\s+/).filter(Boolean)
        const results = store.all()
          .filter((e) => e.status === 'active')
          .map((e) => {
            const hay = `${e.subject} ${e.text} ${(e.tags ?? []).join(' ')}`.toLowerCase()
            return { e, score: terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0) }
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ e }) => stripEntry(e))
        return send(res, 200, { results })
      }

      if (method === 'GET' && routePath === '/detail') {
        const id = url.searchParams.get('id') ?? ''
        const entry = store.get(id)
        if (entry === undefined) return send(res, 404, { error: 'no unique memory entry matches that id', id })
        const successor = entry.supersededBy === undefined ? undefined : store.get(entry.supersededBy)
        return send(res, 200, {
          entry: stripEntry(entry),
          supersededBy: successor === undefined ? undefined : stripEntry(successor),
        })
      }

      if (method === 'GET' && routePath === '/stats') {
        const all = store.all()
        const byStatus = {}
        const byKind = {}
        for (const e of all) {
          byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
          byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
        }
        // `reads`/`neverRead` are the panel's window into whether the store is
        // earning its prompt bytes.
        const reads = all.reduce((sum, e) => sum + (e.recallCount ?? 0), 0)
        const neverRead = all.filter((e) => e.status === 'active' && (e.recallCount ?? 0) === 0).length
        return send(res, 200, { total: all.length, byStatus, byKind, reads, neverRead, store: service.settings?.storeFile })
      }

      if (method === 'POST' && routePath === '/add') {
        const body = await readJsonBody(req)
        const result = store.insert(
          {
            text: body.text,
            kind: body.kind,
            subject: body.subject,
            tags: Array.isArray(body.tags) ? body.tags : [],
          },
          { scope: typeof body.scope === 'string' && body.scope !== '' ? body.scope : 'global', source: { kind: 'panel' } },
        )
        if (result.action === 'invalid') return send(res, 400, { error: 'the entry needs non-empty text' })
        if (service.settings?.curateEnabled !== false) store.curate()
        store.flush()
        return send(res, 200, { action: result.action, id: result.entry?.id, kind: result.entry?.kind, subject: result.entry?.subject })
      }

      if (method === 'POST' && routePath === '/forget') {
        const body = await readJsonBody(req)
        const entry = store.forget(body.id)
        if (entry === undefined) return send(res, 404, { error: 'no unique memory entry matches that id', id: body.id })
        store.flush()
        return send(res, 200, { action: 'forgotten', id: entry.id, text: entry.text })
      }

      if (method === 'POST' && routePath === '/curate') {
        const folded = store.curate()
        store.flush()
        return send(res, 200, { foldedDuplicates: folded.folded, retiredSuperseded: folded.retired })
      }

      return send(res, 404, { error: `no such memory-curator route: ${method} ${routePath}` })
    } catch (error) {
      return send(res, 500, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * Register the panel API on the composition's web server.
 *
 * Uses a nested `ctx.inject` fiber on purpose: the callback pends while
 * `webServer` is absent or merely not provided yet, and is re-run if the service
 * is replaced. Reading `ctx.get('webServer')` once at apply time would answer
 * `undefined` in compositions where the web server publishes after the plugin
 * loads, silently leaving the panel without a backend.
 *
 * @param {object} ctx - the plugin's Cordis context
 * @param {object} service - the mounted MemoryCuratorService
 * @param {object} [logger] - optional logger for one mount line
 */
export function mountPanelApi(ctx, service, logger) {
  ctx.inject(['webServer'], (scoped) => {
    const handler = createPanelApi(service)
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/memory-curator', handler }),
      'memory-curator: panel api',
    )
    logger?.info?.('memory-curator: management panel API mounted at /api/memory-curator')
  })
}
