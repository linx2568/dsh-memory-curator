#!/usr/bin/env node
/**
 * Recall audit — what the memory actually did, measured from DSH's own session
 * logs rather than from the plugin's intentions.
 *
 * The plugin records no recall events, but DSH logs every tool call, so the real
 * traffic can be reconstructed: which memory tools the agent reached for, which
 * entries it opened in full, how big the injected index was on each turn, and
 * how often that index had to hide entries.
 *
 * Usage:
 *   node scripts/recall-audit.mjs [--workspace <dir>] [--store <file>] [--json]
 *
 * Read-only: it decodes logs and reads the store, and writes nothing.
 *
 * Log format note: a session log is a concatenation of one zstd frame PER JSONL
 * record. `zstdDecompressSync` stops after the first frame, so the file has to
 * be decoded frame by frame — the header frame is also the cheap way to tell
 * which workspace a log belongs to.
 *
 * @module dsh-memory-curator/scripts/recall-audit
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { renderCatalog } from '../lib/recall.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = /^session\.v\d+\.jsonl\.zstd$/

/** Parse `--flag value` and `--flag` arguments. */
function parseArgs(argv) {
  const out = { json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--workspace') out.workspace = argv[++i]
    else if (arg === '--store') out.store = argv[++i]
  }
  return out
}

/** Read the first record of a log (one zstd frame) or undefined. */
function headerOf(file) {
  try {
    const record = JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8').trim())
    return record?.type === 'session' ? record : undefined
  } catch {
    return undefined
  }
}

/** Decode every frame of a concatenated zstd log. */
function decodeLog(buffer) {
  const offsets = []
  let at = buffer.indexOf(ZSTD_MAGIC)
  while (at >= 0) { offsets.push(at); at = buffer.indexOf(ZSTD_MAGIC, at + 4) }
  const parts = []
  let undecodable = 0
  for (let i = 0; i < offsets.length; i += 1) {
    let decoded
    // A frame boundary can also occur inside a payload, so retry with a longer
    // span before declaring the frame unreadable.
    for (let span = 1; span <= 3 && decoded === undefined; span += 1) {
      const end = i + span < offsets.length ? offsets[i + span] : buffer.length
      try { decoded = zlib.zstdDecompressSync(buffer.subarray(offsets[i], end)) } catch { /* longer span */ }
    }
    if (decoded === undefined) undecodable += 1
    else parts.push(decoded)
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, undecodable }
}

/** The index block the plugin injects, as it appears in a context message. */
function indexBlocks(text) {
  const blocks = []
  let at = text.indexOf('Durable memory index:')
  while (at >= 0) {
    const block = text.slice(at)
    const lines = block.split('\n')
    const entries = lines.filter((row) => row.startsWith('- [')).length
    const footer = lines.find((row) => row.includes('not shown') || row.includes('memory_detail with an id')) ?? ''
    const hidden = /^\((\d+) more/.exec(footer.trim())
    blocks.push({ entries, hidden: hidden === null ? 0 : Number(hidden[1]), bytes: Buffer.byteLength(block, 'utf8') })
    at = text.indexOf('Durable memory index:', at + 20)
  }
  return blocks
}

const options = parseArgs(process.argv.slice(2))
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(os.homedir(), '.dsh')
const workspace = path.resolve(options.workspace ?? process.cwd())
const storeFile = options.store ?? path.join(dshHome, 'memory-curator', 'store.json')

// ── the store ───────────────────────────────────────────────────────────────
const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
const known = new Map(store.entries.map((entry) => [entry.id, entry]))

// ── the logs of this workspace ──────────────────────────────────────────────
// Layout varies by DSH version: a workspace directory may hold the log files
// directly, or one subdirectory per session. Search both, bounded to two levels.
const sessionsDir = path.join(dshHome, 'sessions')
const logs = []
let skipped = 0

/** Every `session.v*.jsonl.zstd` directly inside `dir`. */
function logsIn(dir) {
  const found = []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue
    found.push(path.join(dir, entry.name))
  }
  return found
}

for (const workspaceDir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!workspaceDir.isDirectory()) continue
  const dir = path.join(sessionsDir, workspaceDir.name)
  const candidates = [...logsIn(dir)]
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(...logsIn(path.join(dir, entry.name)))
  }
  for (const file of candidates) {
    const header = headerOf(file)
    if (header === undefined || path.resolve(header.cwd ?? '') !== workspace) { skipped += 1; continue }
    logs.push({ file, header })
  }
}

const calls = []
const indexInjections = []
let frames = 0
let undecodable = 0
let records = 0
for (const { file, header } of logs) {
  const decoded = decodeLog(fs.readFileSync(file))
  frames += decoded.frames
  undecodable += decoded.undecodable
  for (const line of decoded.text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    records += 1
    if (record.type === 'tool/call') {
      const name = record.data?.name
      if (typeof name === 'string' && name.startsWith('memory_')) {
        let args = {}
        try { args = JSON.parse(record.data?.arguments ?? '{}') } catch { /* keep {} */ }
        calls.push({ session: header.id, depth: header.delegationDepth ?? 0, name, args })
      }
    }
    const content = record.data?.content
    if (record.type === 'user/message' && Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text !== 'string') continue
        for (const injected of indexBlocks(block.text)) indexInjections.push({ session: header.id, ...injected })
      }
    }
  }
}

// ── traffic ─────────────────────────────────────────────────────────────────
const byTool = new Map()
const readIds = new Map()
const queries = []
const byDepth = new Map()
for (const call of calls) {
  byTool.set(call.name, (byTool.get(call.name) ?? 0) + 1)
  byDepth.set(call.depth, (byDepth.get(call.depth) ?? 0) + 1)
  if (call.name === 'memory_detail' && typeof call.args.id === 'string') {
    readIds.set(call.args.id, (readIds.get(call.args.id) ?? 0) + 1)
  }
  if (call.name === 'memory_search') queries.push(call.args.query ?? '')
}

const active = store.entries.filter((entry) => entry.status === 'active')
const readEntries = active.filter((entry) => readIds.has(entry.id))

// ── index pressure ──────────────────────────────────────────────────────────
const scope = `ws-${(await import('node:crypto')).createHash('sha1').update(workspace).digest('hex').slice(0, 10)}`
const visible = active.filter((entry) => entry.scope === scope || entry.scope === 'global')
const nowCatalog = renderCatalog(visible, { maxBytes: 2400 })
const shownIds = new Set([...nowCatalog.matchAll(/\[([0-9a-f]{10})\]/g)].map((match) => match[1]))
const evicted = visible.filter((entry) => !shownIds.has(entry.id))
const truncations = indexInjections.filter((row) => row.hidden > 0).length

const report = {
  workspace,
  store: storeFile,
  logs: logs.length,
  frames,
  undecodableFrames: undecodable,
  records,
  skippedLogs: skipped,
  calls: Object.fromEntries([...byTool].sort((a, b) => b[1] - a[1])),
  callsByDepth: Object.fromEntries(byDepth),
  detailReads: { distinct: readIds.size, resolved: [...readIds.keys()].filter((id) => known.has(id)).length },
  activeEntries: active.length,
  entriesEverRead: readEntries.length,
  searches: queries,
  index: {
    injections: indexInjections.length,
    truncated: truncations,
    maxEntries: indexInjections.length === 0 ? 0 : Math.max(...indexInjections.map((row) => row.entries)),
    maxBytes: indexInjections.length === 0 ? 0 : Math.max(...indexInjections.map((row) => row.bytes)),
    nowVisible: visible.length,
    nowShown: shownIds.size,
    nowEvicted: evicted.length,
    evictedDecisional: evicted.filter((entry) => ['decision', 'correction', 'prohibition', 'open'].includes(entry.kind)).length,
    evictedEverRead: evicted.filter((entry) => readIds.has(entry.id)).length,
  },
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const { index: idx } = report
  console.log(`workspace      ${report.workspace}`)
  console.log(`logs           ${report.logs} (${report.skippedLogs} other workspaces skipped), ${report.frames} frames, ${report.undecodableFrames} undecodable, ${report.records} records`)
  console.log(`tool calls     ${Object.entries(report.calls).map(([tool, count]) => `${tool}=${count}`).join('  ') || '(none)'}`)
  console.log(`by depth       ${Object.entries(report.callsByDepth).map(([depth, count]) => `depth${depth}=${count}`).join('  ') || '(none)'}`)
  console.log(`detail reads   ${report.detailReads.distinct} distinct ids, ${report.detailReads.resolved} resolved`)
  console.log(`readership     ${report.entriesEverRead} of ${report.activeEntries} active entries ever opened in full`)
  console.log(`searches       ${report.searches.length}${report.searches.length > 0 ? `: ${report.searches.slice(0, 5).map((q) => `"${q}"`).join(' ')}` : ''}`)
  console.log(`index          ${idx.injections} injections, ${idx.truncated} truncated (${idx.injections === 0 ? 0 : Math.round(idx.truncated / idx.injections * 100)}%), largest ${idx.maxEntries} lines / ${idx.maxBytes} bytes`)
  console.log(`eviction now   ${idx.nowShown} shown of ${idx.nowVisible} visible; ${idx.nowEvicted} hidden (${idx.evictedDecisional} decisional, ${idx.evictedEverRead} ever read)`)
  if (idx.nowEvicted > 0) {
    console.log('hidden now:')
    for (const entry of evicted.sort((a, b) => a.updatedAt - b.updatedAt)) {
      console.log(`  ${entry.id} ${entry.kind.padEnd(11)} ${readIds.has(entry.id) ? 'read' : '    '} ${String(entry.subject).slice(0, 56)}`)
    }
  }
}