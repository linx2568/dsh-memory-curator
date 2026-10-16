/**
 * Requirement B: recall with progressive disclosure.
 *
 * Three tiers, in the order the model pays for them:
 *
 *   1. CATALOG — one line per entry (kind, age, subject). Always injected,
 *      bounded by `catalogMaxBytes`. This is what the model sees by default.
 *   2. DIGEST  — a longer excerpt returned by `memory_search`, still short,
 *      each row carrying the id needed to descend.
 *   3. FULL    — the complete entry text, returned only by `memory_detail`.
 *
 * Nothing below a tier is rendered until the model asks for it, so the
 * standing prompt cost stays flat as the store grows.
 *
 * @module dsh-memory-curator/recall
 */

const KIND_LABEL = Object.freeze({
  decision: 'decision',
  correction: 'correction',
  prohibition: 'must-not',
  reference: 'reference',
  open: 'open',
  fact: 'fact',
})

/** Kinds that change behaviour, so freshly captured facts must not evict them. */
const DECISIONAL_KINDS = new Set(['decision', 'correction', 'prohibition', 'open'])

/**
 * Share of the byte budget the decisional kinds may claim before the ordinary
 * facts take the rest. Measured on a real store, all fifteen decisional entries
 * came to 983 bytes of a 2400-byte budget, so this is headroom, not a squeeze.
 */
export const DECISIONAL_SHARE = 0.6

/** Sort key: an entry that was just read is as fresh as one just written. */
function recencyOf(entry) {
  const written = Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0
  const read = Number.isFinite(entry?.lastRecalledAt) ? entry.lastRecalledAt : 0
  return read > written ? read : written
}

/** Newest first, with an id tie-break so the block never shuffles on ties. */
function byRecency(a, b) {
  return recencyOf(b) - recencyOf(a) || String(a.id).localeCompare(String(b.id))
}

/** Compact age rendering: 3d, 5h, 12m. */
export function formatAge(timestamp, now = Date.now()) {
  const delta = Math.max(0, now - Number(timestamp ?? 0))
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y`
}

/** One catalog line: the cheapest representation of an entry. */
export function catalogLine(entry, now = Date.now()) {
  const label = KIND_LABEL[entry.kind] ?? entry.kind
  // Tabs/newlines would break the aligned block, so collapse to one line.
  const subject = String(entry.subject ?? '').replace(/\s+/g, ' ').trim()
  return `- [${entry.id}] ${label} (${formatAge(entry.updatedAt, now)}) ${subject}`
}

/**
 * Render the resident catalog within a byte budget, in two layers:
 *
 *   1. the entries that change behaviour — decisions, corrections, prohibitions
 *      and open work — which may claim at most {@link DECISIONAL_SHARE} of the
 *      budget;
 *   2. everything else, most recent first, taking whatever is left.
 *
 * The layering is not cosmetic. Measured on a real store, a pure newest-first
 * index let freshly captured task narration evict the platform knowledge that
 * had actually been read — including a live prohibition — while every
 * decisional entry together needed under half the budget. Within a layer, an
 * entry that was read counts as fresh ({@link recencyOf}), so being used is not
 * punished by age.
 *
 * Always ends with a count of what was withheld, so an omitted entry is never
 * mistaken for a deleted one.
 *
 * @param {ReadonlyArray<object>} entries
 * @param {{ maxBytes?: number, now?: number, decisionalShare?: number }} [options]
 * @returns {string}
 */
export function renderCatalog(entries, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 2400
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const share = Number.isFinite(options.decisionalShare) && options.decisionalShare > 0 && options.decisionalShare <= 1
    ? options.decisionalShare
    : DECISIONAL_SHARE
  if (entries.length === 0) return ''
  const ordered = [...entries].sort(byRecency)
  const decisional = ordered.filter((entry) => DECISIONAL_KINDS.has(entry.kind))
  const ordinary = ordered.filter((entry) => !DECISIONAL_KINDS.has(entry.kind))
  const header = 'Durable memory index (rules and decisions first, then most recent):'
  const footer = (hidden) => hidden > 0
    ? `(${hidden} more not shown — call memory_search before assuming something was never recorded.)`
    : `(${ordered.length} entr${ordered.length === 1 ? 'y' : 'ies'}; use memory_detail with an id for the full text.)`
  const lines = []
  let bytes = Buffer.byteLength(header, 'utf8')
  // Reserve room for the footer; its exact size depends on `hidden`, so the body
  // is re-trimmed below if this guess overflows.
  const ceiling = maxBytes - 160
  const decisionalCeiling = Math.floor(maxBytes * share)
  let decisionalBytes = 0
  for (const entry of decisional) {
    const line = catalogLine(entry, now)
    const size = Buffer.byteLength(`${line}\n`, 'utf8')
    if (bytes + size > ceiling || decisionalBytes + size > decisionalCeiling) break
    lines.push(line)
    bytes += size
    decisionalBytes += size
  }
  for (const entry of ordinary) {
    const line = catalogLine(entry, now)
    const size = Buffer.byteLength(`${line}\n`, 'utf8')
    if (bytes + size > ceiling) break
    lines.push(line)
    bytes += size
  }
  if (lines.length === 0) {
    // Budget too small for even one line: still report the count truthfully.
    return `${header}\n${footer(ordered.length)}`
  }
  // Re-trim from the tail, which is the ordinary facts: a rule is never dropped
  // to make room for a fact.
  let hidden = ordered.length - lines.length
  let body = `${header}\n${lines.join('\n')}\n${footer(hidden)}`
  while (Buffer.byteLength(body, 'utf8') > maxBytes && lines.length > 1) {
    lines.pop()
    hidden += 1
    body = `${header}\n${lines.join('\n')}\n${footer(hidden)}`
  }
  return body
}

/**
 * Tier 1 row: a bounded excerpt the model reads before deciding to descend.
 *
 * @param {object} entry
 * @param {number} [score]
 * @param {number} [maxChars]
 */
export function renderDigest(entry, score, maxChars = 240) {
  const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  const excerpt = text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}\u2026`
  const label = KIND_LABEL[entry.kind] ?? entry.kind
  const relevance = Number.isFinite(score) && score > 0 ? ` relevance=${score.toFixed(2)}` : ''
  const status = entry.status === 'active' ? '' : ` status=${entry.status}`
  return `- [${entry.id}] ${label}${relevance}${status}\n  ${entry.subject}\n  ${excerpt}`
}

/**
 * Tier 2: the complete entry, with its provenance and history, rendered only
 * when the model explicitly asks for that id.
 *
 * @param {object} entry
 * @param {{ supersededBy?: object }} [context]
 * @param {number} [now]
 */
export function renderDetail(entry, context = {}, now = Date.now()) {
  const label = KIND_LABEL[entry.kind] ?? entry.kind
  const lines = [
    `id: ${entry.id}`,
    `kind: ${label}`,
    `status: ${entry.status}`,
    `scope: ${entry.scope}`,
    `subject: ${entry.subject}`,
    `updated: ${new Date(entry.updatedAt).toISOString()} (${formatAge(entry.updatedAt, now)} ago)`,
    `created: ${new Date(entry.createdAt).toISOString()}`,
  ]
  if (Array.isArray(entry.tags) && entry.tags.length > 0) lines.push(`tags: ${entry.tags.join(', ')}`)
  if (entry.source !== undefined) lines.push(`source: ${JSON.stringify(entry.source)}`)
  if (entry.supersededBy !== undefined) {
    const successor = context.supersededBy
    lines.push(`superseded by: ${entry.supersededBy}${successor === undefined ? '' : ` — ${successor.text}`}`)
  }
  lines.push('', entry.text)
  return lines.join('\n')
}
