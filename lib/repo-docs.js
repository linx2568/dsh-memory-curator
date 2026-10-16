/**
 * Read the repository documents that bound what memory may record.
 *
 * The plugin deliberately does not overlap with the artifacts a project already
 * keeps: AGENTS.md / CLAUDE.md hold the rules, README.md explains the project,
 * STATE.md-style files hold the current work, and the code holds the
 * architecture. The distiller therefore receives, along with the turn
 * transcript, the bounded text of the instruction files and the names of the
 * documents that exist, so it can decline to record what the repository already
 * owns (see `DISTILL_SYSTEM_PROMPT`).
 *
 * Reading happens once per captured turn but is effectively free: every file is
 * cached by mtime+size, so an unchanged repository costs one stat per file.
 * Every failure is silent — a missing or unreadable document means less context,
 * never a failed capture.
 *
 * @module dsh-memory-curator/repo-docs
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  INSTRUCTION_FILES,
  MAX_REPO_CONTEXT_CHARS,
  REPO_DOC_FILES,
  renderRepoContext,
} from './parse.js'

/** mtime+size keyed cache, so a quiet repository costs only stats. */
const cache = new Map()

/** Read one file bounded to `budget` characters, or undefined when unreadable. */
function readBounded(file, budget) {
  try {
    const stats = fs.statSync(file)
    if (!stats.isFile()) return undefined
    const cached = cache.get(file)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.text
    }
    const text = fs.readFileSync(file, 'utf8').slice(0, Math.max(0, budget))
    cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, text })
    return text
  } catch {
    // Absent, unreadable, a directory: the repository simply owns nothing here.
    return undefined
  }
}

/** Whether a path exists as a directory. */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Build the repository context for one capture.
 *
 * @param {string} cwd - the session working directory.
 * @param {{ maxChars?: number }} [options] - byte budget for instruction text.
 * @returns {string} the bounded context block, or '' when there is nothing to say.
 */
export function readRepoContext(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const root = path.resolve(cwd.trim())
  const budget = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : MAX_REPO_CONTEXT_CHARS

  const present = []
  for (const name of [...INSTRUCTION_FILES, ...REPO_DOC_FILES]) {
    if (fs.existsSync(path.join(root, name))) present.push(name)
  }
  if (isDirectory(path.join(root, 'docs'))) present.push('docs/')

  const instructions = []
  let remaining = budget
  for (const name of INSTRUCTION_FILES) {
    if (remaining <= 0) break
    const text = readBounded(path.join(root, name), remaining)
    if (text === undefined || text.trim() === '') continue
    instructions.push({ name, text })
    remaining -= text.length
  }

  return renderRepoContext({ instructions, present })
}

/** Drop the read cache; used by tests, and by a caller that knows the tree moved. */
export function clearRepoDocCache() {
  cache.clear()
}
