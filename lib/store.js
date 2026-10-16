/**
 * Durable memory store for dsh-memory-curator.
 *
 * Plain JSON on disk with atomic writes and zero third-party dependencies.
 * Everything here is pure and synchronous except the two file operations, so
 * the curation rules are directly testable without a Harness.
 *
 * @module dsh-memory-curator/store
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { ENTRY_KINDS } from './parse.js'

export { ENTRY_KINDS }

const KIND_SET = new Set(ENTRY_KINDS)

/** Kinds whose entries are mutually exclusive per subject: a newer one wins. */
const DECISIONAL_KINDS = new Set(['decision', 'correction', 'prohibition'])

const DEFAULT_DUP_THRESHOLD = 0.82
const MAX_TEXT_CHARS = 1200
const MAX_SUBJECT_CHARS = 200
const MAX_ENTRIES = 5000

/** Lowercase, strip punctuation, collapse whitespace — the comparison form. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Significant tokens of a string, for overlap scoring. */
export function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1)
}

/** Token-set overlap in [0,1]. Empty inputs score 0 rather than a false match. */
export function jaccard(a, b) {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** One short, stable identifier an agent can quote back. */
export function newId() {
  return crypto.randomBytes(5).toString('hex')
}

/** Derive a workspace scope key from a session working directory. */
export function scopeForCwd(cwd) {
  const value = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : ''
  if (value === '') return 'global'
  const digest = crypto.createHash('sha1').update(value).digest('hex').slice(0, 10)
  return `ws-${digest}`
}

/** Clamp a candidate string to a bounded, single-line form. */
function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * Coerce one untrusted candidate (from a model or a tool call) into an entry.
 * Returns null when the candidate carries no usable content.
 *
 * @param {unknown} candidate
 * @param {{ scope?: string, source?: object, now?: number }} [context]
 * @returns {object|null}
 */
export function normalizeCandidate(candidate, context = {}) {
  if (candidate === null || typeof candidate !== 'object') return null
  const raw = candidate
  const text = clampText(raw.text ?? raw.content ?? raw.value, MAX_TEXT_CHARS)
  if (text === '') return null
  const kind = KIND_SET.has(raw.kind) ? raw.kind : 'fact'
  const subject = clampText(raw.subject ?? raw.topic ?? text, MAX_SUBJECT_CHARS)
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => clampText(tag, 40)).filter((tag) => tag !== '').slice(0, 12)
    : []
  const now = typeof context.now === 'number' ? context.now : Date.now()
  return {
    id: newId(),
    kind,
    subject,
    text,
    tags,
    scope: typeof context.scope === 'string' && context.scope !== '' ? context.scope : 'global',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...(context.source === undefined ? {} : { source: context.source }),
  }
}

/** Read the store document, tolerating absence and corruption. */
export function readStoreFile(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: [], curatedAt: 0, turnsSinceCurate: 0 }
    // A corrupt store must not take the profile down: keep the bad bytes aside.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* best effort */ }
    return { version: 1, entries: [], curatedAt: 0, turnsSinceCurate: 0 }
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => entry !== null && typeof entry === 'object') : []
  return {
    version: 1,
    entries,
    curatedAt: Number.isFinite(parsed?.curatedAt) ? parsed.curatedAt : 0,
    turnsSinceCurate: Number.isFinite(parsed?.turnsSinceCurate) ? parsed.turnsSinceCurate : 0,
  }
}

/** Write the store document atomically (temp file then rename). */
export function writeStoreFile(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/**
 * The curation engine: insertion, duplicate folding, and conflict resolution.
 *
 * Duplicate rule — a new entry whose normalized text (or, within the same kind,
 * whose subject) overlaps an active entry above the threshold is folded into
 * that entry instead of being stored twice.
 *
 * Conflict rule — within one scope, two ACTIVE decisional entries (decision,
 * correction, prohibition) that share a subject but differ materially are a
 * conflict: the newer one wins and the older is marked `superseded`, keeping a
 * `supersededBy` pointer so the history stays explainable.
 */
export class MemoryStore {
  /**
   * @param {string} file - absolute path of the JSON store
   * @param {{ dupThreshold?: number, now?: () => number }} [options]
   */
  constructor(file, options = {}) {
    this.file = file
    this.dupThreshold = Number.isFinite(options.dupThreshold) ? options.dupThreshold : DEFAULT_DUP_THRESHOLD
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.document = readStoreFile(file)
    this.dirty = false
    /** Serializes read-modify-write sequences inside one process. */
    this.queue = Promise.resolve()
  }

  /** All entries, including superseded and merged history. */
  all() {
    return this.document.entries
  }

  /** Entries visible to recall for a scope: that scope plus the global scope. */
  active(scope) {
    return this.document.entries.filter((entry) => entry.status === 'active'
      && (entry.scope === scope || entry.scope === 'global'))
  }

  /** Look up one entry by id or unambiguous id prefix. */
  get(id) {
    const key = String(id ?? '').trim().toLowerCase()
    if (key === '') return undefined
    const exact = this.document.entries.find((entry) => entry.id === key)
    if (exact !== undefined) return exact
    const prefixed = this.document.entries.filter((entry) => entry.id.startsWith(key))
    return prefixed.length === 1 ? prefixed[0] : undefined
  }

  /**
   * Insert one candidate, folding duplicates and resolving conflicts.
   *
   * @param {unknown} candidate
   * @param {{ scope?: string, source?: object }} [context]
   * @returns {{ action: 'added'|'folding'|'conflict'|'invalid', entry?: object, foldedInto?: object, superseded?: object[] }}
   */
  insert(candidate, context = {}) {
    const entry = normalizeCandidate(candidate, { ...context, now: this.now() })
    if (entry === null) return { action: 'invalid' }

    const scope = entry.scope
    const peers = this.document.entries.filter((existing) => existing.status === 'active' && existing.scope === scope)
    const sameSubjectAs = (existing) => normalizeText(existing.subject) === normalizeText(entry.subject)
    const similarTextTo = (existing) => normalizeText(existing.text) === normalizeText(entry.text)
      || jaccard(existing.text, entry.text) >= this.dupThreshold

    // 1. Duplicate: materially the SAME statement. Folding is safe because
    //    nothing about what is known changes — only the wording is refreshed.
    //    Order matters here: this runs before the conflict rule so that a
    //    merely-similar subject can never swallow a genuinely new decision.
    const duplicate = peers.find((existing) => existing.kind === entry.kind && similarTextTo(existing))
    if (duplicate !== undefined) {
      // Keep the older id (stable across recall) and refresh its wording.
      duplicate.updatedAt = entry.updatedAt
      if (entry.text.length > duplicate.text.length) {
        duplicate.text = entry.text
        duplicate.subject = entry.subject
      }
      duplicate.tags = [...new Set([...(duplicate.tags ?? []), ...entry.tags])].slice(0, 12)
      this.dirty = true
      return { action: 'folding', entry: duplicate, foldedInto: duplicate }
    }

    // 2. Conflict: same subject, DIFFERENT substance, and at least one side is
    //    decisional. The newer statement wins and the older is retained only as
    //    history, so recall stops surfacing a decision that was replaced.
    const superseded = []
    if (DECISIONAL_KINDS.has(entry.kind)) {
      for (const existing of peers) {
        if (!sameSubjectAs(existing)) continue
        if (!DECISIONAL_KINDS.has(existing.kind) && !similarTextTo(existing)) {
          // A superseded non-decisional note: retire it only when the new entry
          // is the same kind of statement, else leave the fact alone.
          continue
        }
        existing.status = 'superseded'
        existing.supersededBy = entry.id
        existing.updatedAt = entry.updatedAt
        superseded.push(existing)
      }
    } else {
      // 3. Consolidation for non-decisional kinds: the same subject with a
      //    restated body is the same knowledge, so keep one copy.
      const restated = peers.find((existing) => existing.kind === entry.kind && sameSubjectAs(existing))
      if (restated !== undefined) {
        restated.updatedAt = entry.updatedAt
        if (entry.text.length > restated.text.length) {
          restated.text = entry.text
          restated.subject = entry.subject
        }
        restated.tags = [...new Set([...(restated.tags ?? []), ...entry.tags])].slice(0, 12)
        this.dirty = true
        return { action: 'folding', entry: restated, foldedInto: restated }
      }
    }

    this.document.entries.push(entry)
    if (this.document.entries.length > MAX_ENTRIES) {
      // Drop the oldest retired history first; never drop an active entry.
      const retired = this.document.entries
        .filter((existing) => existing.status !== 'active')
        .sort((a, b) => a.updatedAt - b.updatedAt)
      const excess = this.document.entries.length - MAX_ENTRIES
      for (const stale of retired.slice(0, excess)) {
        const index = this.document.entries.indexOf(stale)
        if (index >= 0) this.document.entries.splice(index, 1)
      }
    }
    this.dirty = true
    return superseded.length > 0
      ? { action: 'conflict', entry, superseded }
      : { action: 'added', entry }
  }

  /**
   * Deterministic curation pass: retire exact duplicates that entered through
   * separate paths, and report what changed. Safe to run repeatedly.
   *
   * @returns {{ folded: number, retired: number }}
   */
  curate() {
    let folded = 0
    let retired = 0
    const byScope = new Map()
    for (const entry of this.document.entries) {
      if (entry.status !== 'active') continue
      const bucket = byScope.get(entry.scope) ?? []
      bucket.push(entry)
      byScope.set(entry.scope, bucket)
    }
    for (const bucket of byScope.values()) {
      bucket.sort((a, b) => b.updatedAt - a.updatedAt)
      for (let i = 0; i < bucket.length; i += 1) {
        const keeper = bucket[i]
        if (keeper.status !== 'active') continue
        for (let j = i + 1; j < bucket.length; j += 1) {
          const other = bucket[j]
          if (other.status !== 'active') continue
          if (other.kind !== keeper.kind) continue
          const sameSubject = normalizeText(other.subject) === normalizeText(keeper.subject)
          const similar = normalizeText(other.text) === normalizeText(keeper.text)
            || jaccard(other.text, keeper.text) >= this.dupThreshold
          if (!similar && !(sameSubject && DECISIONAL_KINDS.has(keeper.kind) === false)) continue
          other.status = similar ? 'merged' : 'superseded'
          other.supersededBy = keeper.id
          other.updatedAt = this.now()
          if (similar) folded += 1
          else retired += 1
          this.dirty = true
        }
      }
    }
    this.document.curatedAt = this.now()
    this.document.turnsSinceCurate = 0
    this.dirty = true
    return { folded, retired }
  }

  /** Rank active entries against a free-text query. */
  search(query, scope, limit = 8) {
    const needle = String(query ?? '').trim()
    const candidates = this.active(scope)
    if (needle === '') {
      return candidates
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((entry) => ({ entry, score: 0 }))
    }
    const normalized = normalizeText(needle)
    const scored = []
    for (const entry of candidates) {
      let score = jaccard(entry.text, needle) * 0.6 + jaccard(entry.subject, needle) * 0.4
      if (normalizeText(entry.text).includes(normalized)) score += 0.5
      if (normalizeText(entry.subject).includes(normalized)) score += 0.3
      for (const tag of entry.tags ?? []) {
        if (normalizeText(tag).includes(normalized)) score += 0.2
      }
      // Recency tiebreak: a week of age costs about 0.05.
      const ageDays = Math.max(0, (this.now() - entry.updatedAt) / 86_400_000)
      score += Math.max(0, 0.05 - ageDays * 0.007)
      if (score > 0.01) scored.push({ entry, score })
    }
    scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    return scored.slice(0, limit)
  }

  /** Forget one entry (soft: marked so recall stops showing it). */
  forget(id) {
    const entry = this.get(id)
    if (entry === undefined) return undefined
    entry.status = 'forgotten'
    entry.updatedAt = this.now()
    this.dirty = true
    return entry
  }

  /** Count one finished turn toward the next model-assisted curation cycle. */
  countTurn() {
    this.document.turnsSinceCurate = (this.document.turnsSinceCurate ?? 0) + 1
    this.dirty = true
    return this.document.turnsSinceCurate
  }

  /** Whether enough turns have passed to run a curation cycle. */
  dueForCuration(every) {
    return (this.document.turnsSinceCurate ?? 0) >= every
  }

  /** Clear the turn counter after a curation cycle. */
  markCurated() {
    this.document.turnsSinceCurate = 0
    this.document.curatedAt = this.now()
    this.dirty = true
  }

  /** Bounded counters for the memory_stats tool. */
  stats(scope) {
    const entries = this.document.entries
    const byKind = {}
    for (const entry of entries) {
      if (entry.status !== 'active') continue
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    }
    return {
      total: entries.length,
      active: entries.filter((entry) => entry.status === 'active').length,
      visible: this.active(scope).length,
      superseded: entries.filter((entry) => entry.status === 'superseded').length,
      merged: entries.filter((entry) => entry.status === 'merged').length,
      forgotten: entries.filter((entry) => entry.status === 'forgotten').length,
      byKind,
      curatedAt: this.document.curatedAt,
      turnsSinceCurate: this.document.turnsSinceCurate,
    }
  }

  /** Persist when something changed. Returns true when a write happened. */
  flush() {
    if (!this.dirty) return false
    writeStoreFile(this.file, this.document)
    this.dirty = false
    return true
  }

  /** Run one read-modify-write sequence without interleaving. */
  serialize(operation) {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}
