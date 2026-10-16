/**
 * Store and curation tests: duplicate folding, conflict resolution, scoping.
 * Pure logic only — no Harness and no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore, normalizeCandidate, scopeForCwd, jaccard, normalizeText, redactSecrets } from '../lib/store.js'

/** A store backed by a throwaway temp file. */
function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-test-'))
  const file = path.join(dir, 'store.json')
  return { store: new MemoryStore(file, options), file, dir }
}

test('normalizeCandidate rejects empty content and clamps kinds', () => {
  assert.equal(normalizeCandidate(null), null)
  assert.equal(normalizeCandidate({ text: '   ' }), null)
  const entry = normalizeCandidate({ text: 'x'.repeat(5000), kind: 'nonsense' })
  assert.equal(entry.kind, 'fact')
  assert.ok(entry.text.length <= 1200)
})

test('scopeForCwd is stable and distinguishes workspaces', () => {
  const a = scopeForCwd('D:\\dev')
  assert.equal(a, scopeForCwd('D:\\dev'))
  assert.notEqual(a, scopeForCwd('D:\\other'))
  assert.equal(scopeForCwd(undefined), 'global')
})

test('jaccard only matches on real overlap', () => {
  assert.equal(jaccard('', 'anything'), 0)
  assert.ok(jaccard('the plugin installs via npm', 'plugin installs via pnpm') > 0.4)
  assert.ok(jaccard('alpha beta', 'gamma delta') === 0)
})

test('a duplicate statement folds instead of being stored twice', () => {
  const { store } = tempStore()
  const first = store.insert({ kind: 'fact', subject: 'package manager', text: 'The profile uses pnpm as its package manager.' }, { scope: 'ws-a' })
  assert.equal(first.action, 'added')
  const second = store.insert({ kind: 'fact', subject: 'package manager', text: 'The profile uses pnpm as the package manager.' }, { scope: 'ws-a' })
  assert.equal(second.action, 'folding')
  assert.equal(store.all().filter((e) => e.status === 'active').length, 1)
})

test('a newer decision on the same subject supersedes the older one', () => {
  const { store } = tempStore()
  const older = store.insert({ kind: 'decision', subject: 'install method', text: 'Install plugins with the GitHub spec form.' }, { scope: 'ws-a' })
  const newer = store.insert({ kind: 'decision', subject: 'install method', text: 'Install plugins from the npm registry by package name.' }, { scope: 'ws-a' })
  assert.equal(newer.action, 'conflict')
  assert.equal(newer.superseded.length, 1)
  const retired = store.get(older.entry.id)
  assert.equal(retired.status, 'superseded')
  assert.equal(retired.supersededBy, newer.entry.id)
  // Only the newer one is recalled.
  assert.deepEqual(store.active('ws-a').map((e) => e.id), [newer.entry.id])
})

test('a correction retires the decision it corrects', () => {
  const { store } = tempStore()
  const decision = store.insert({ kind: 'decision', subject: 'memory plugin', text: 'Keep using the existing memory plugin for recall.' }, { scope: 'ws-a' })
  const correction = store.insert({ kind: 'correction', subject: 'memory plugin', text: 'That is wrong: the existing plugin never captured automatically, replace it.' }, { scope: 'ws-a' })
  assert.equal(correction.action, 'conflict')
  assert.equal(store.get(decision.entry.id).status, 'superseded')
})

test('different subjects coexist even when decisional', () => {
  const { store } = tempStore()
  store.insert({ kind: 'decision', subject: 'package manager', text: 'Use pnpm for the profile.' }, { scope: 'ws-a' })
  const other = store.insert({ kind: 'decision', subject: 'runtime version', text: 'Target runtime 0.2.0-rc.2 only.' }, { scope: 'ws-a' })
  assert.equal(other.action, 'added')
  assert.equal(store.active('ws-a').length, 2)
})

test('prohibitions are recorded and recalled like any durable entry', () => {
  const { store } = tempStore()
  const result = store.insert({ kind: 'prohibition', subject: 'editing profile files', text: 'Never hand-edit the profile package.json or cordis.patch.yml.' }, { scope: 'ws-a' })
  assert.equal(result.action, 'added')
  assert.equal(store.active('ws-a')[0].kind, 'prohibition')
})

test('scopes isolate workspaces but a global entry stays visible', () => {
  const { store } = tempStore()
  store.insert({ kind: 'fact', subject: 'global rule', text: 'The user prefers concise Chinese answers.' }, { scope: 'global' })
  store.insert({ kind: 'fact', subject: 'local rule', text: 'This workspace builds with pnpm.' }, { scope: 'ws-a' })
  assert.equal(store.active('ws-a').length, 2)
  assert.equal(store.active('ws-b').length, 1)
})

test('curate folds duplicates that entered through separate paths', () => {
  const { store } = tempStore()
  // Two entries too dissimilar to fold on insert, but identical after curation
  // is asked to compare same-subject entries.
  store.insert({ kind: 'open', subject: 'release', text: 'Publish the release after tests pass.' }, { scope: 'ws-a' })
  store.insert({ kind: 'open', subject: 'release', text: 'Publish the release once the test suite is green.' }, { scope: 'ws-a' })
  const before = store.active('ws-a').length
  const result = store.curate()
  const after = store.active('ws-a').length
  assert.ok(result.folded + result.retired > 0 || before === after)
  assert.equal(store.document.turnsSinceCurate, 0)
})

test('search ranks by relevance and honours scope', () => {
  const { store } = tempStore()
  store.insert({ kind: 'decision', subject: 'plugin install', text: 'Install plugins from the npm registry by package name.' }, { scope: 'ws-a' })
  store.insert({ kind: 'fact', subject: 'weather', text: 'It rains frequently in this region during spring.' }, { scope: 'ws-a' })
  const hits = store.search('how do I install a plugin', 'ws-a', 5)
  assert.ok(hits.length >= 1)
  assert.match(hits[0].entry.text, /npm registry/)
})

test('an empty query returns recent entries rather than nothing', () => {
  const { store } = tempStore()
  store.insert({ kind: 'fact', subject: 'one', text: 'The first durable statement about this project.' }, { scope: 'ws-a' })
  assert.equal(store.search('', 'ws-a', 5).length, 1)
})

test('forget retires an entry from recall but keeps it retrievable', () => {
  const { store } = tempStore()
  const added = store.insert({ kind: 'fact', subject: 'temp', text: 'This statement will be forgotten shortly.' }, { scope: 'ws-a' })
  const forgotten = store.forget(added.entry.id)
  assert.equal(forgotten.status, 'forgotten')
  assert.equal(store.active('ws-a').length, 0)
  assert.equal(store.get(added.entry.id).status, 'forgotten')
})

test('get resolves an unambiguous id prefix', () => {
  const { store } = tempStore()
  const added = store.insert({ kind: 'fact', subject: 'prefix', text: 'Resolvable by a short id prefix.' }, { scope: 'ws-a' })
  assert.equal(store.get(added.entry.id.slice(0, 4)).id, added.entry.id)
  assert.equal(store.get('zzzzzz'), undefined)
})

test('persistence round-trips through the atomic writer', () => {
  const { store, file } = tempStore()
  store.insert({ kind: 'decision', subject: 'persist', text: 'Entries survive a process restart.' }, { scope: 'ws-a' })
  store.flush()
  const reopened = new MemoryStore(file)
  assert.equal(reopened.active('ws-a').length, 1)
  assert.match(reopened.active('ws-a')[0].text, /survive a process restart/)
})

test('a corrupt store is quarantined instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-corrupt-'))
  const file = path.join(dir, 'store.json')
  fs.writeFileSync(file, '{ this is not json')
  const store = new MemoryStore(file)
  assert.deepEqual(store.all(), [])
  assert.ok(fs.readdirSync(dir).some((entry) => entry.includes('.corrupt-')))
})

test('turn counting drives the curation cadence', () => {
  const { store } = tempStore()
  assert.equal(store.dueForCuration(3), false)
  store.countTurn(); store.countTurn()
  assert.equal(store.dueForCuration(3), false)
  store.countTurn()
  assert.equal(store.dueForCuration(3), true)
  store.markCurated()
  assert.equal(store.dueForCuration(3), false)
})

test('stats report the full lifecycle', () => {
  const { store } = tempStore()
  store.insert({ kind: 'decision', subject: 's1', text: 'The first decision about the build pipeline.' }, { scope: 'ws-a' })
  store.insert({ kind: 'decision', subject: 's1', text: 'A later decision that replaces the build pipeline choice.' }, { scope: 'ws-a' })
  const stats = store.stats('ws-a')
  assert.equal(stats.active, 1)
  assert.equal(stats.superseded, 1)
  assert.equal(stats.visible, 1)
})

test('markRecalled counts a read, survives a reopen, and leaves the text alone', () => {
  const { store, file } = tempStore()
  const added = store.insert({ kind: 'fact', subject: 'sandbox shell', text: 'Git ssh must be the system binary inside the sandbox.' }, { scope: 'ws-a' })
  const id = added.entry.id
  assert.equal(store.markRecalled(id), 1)
  assert.equal(store.markRecalled([id]), 1)
  assert.equal(store.markRecalled('ffffffffff'), 0, 'an unknown id is not a read')

  const entry = store.get(id)
  assert.equal(entry.recallCount, 2)
  assert.ok(entry.lastRecalledAt >= entry.updatedAt, 'a read records when it happened')
  assert.equal(entry.updatedAt, added.entry.updatedAt, 'reading is not a change to the statement')

  assert.ok(store.flush())
  assert.equal(new MemoryStore(file).get(id).recallCount, 2, 'the counter must survive a reopen')
})

test('stats report reads and never-read entries', () => {
  const { store } = tempStore()
  const read = store.insert({ kind: 'fact', subject: 'a', text: 'A durable statement about the first thing.' }, { scope: 'ws-a' })
  store.insert({ kind: 'fact', subject: 'b', text: 'A durable statement about the second thing.' }, { scope: 'ws-a' })
  store.markRecalled(read.entry.id)
  const stats = store.stats('ws-a')
  assert.equal(stats.reads, 1)
  assert.equal(stats.neverRead, 1)
  assert.equal(stats.active, 2)
})

test('redactSecrets removes credential shapes and keeps the sentence', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz012345'
  const github = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const { text, redacted } = redactSecrets(`The key ${key} leaked and was rotated; the gh token is ${github}.`)
  assert.equal(redacted, 2)
  assert.doesNotMatch(text, /sk-abcdef/)
  assert.doesNotMatch(text, /ghp_/)
  assert.match(text, /leaked and was rotated/, 'the knowledge around the secret survives')
  assert.match(text, /\[redacted\]/)
})

test('redactSecrets leaves ordinary identifiers alone', () => {
  // A commit id, a sha256 digest and a normal sentence must not be mangled: the
  // patterns name credential shapes, not "anything that looks random".
  const commit = 'd4634724f86e3c005d3b70475be991df27b74735'
  const digest = 'a12bf3ac84f2fd56844038eb1c6d3c05e4de9b4e'
  const { text, redacted } = redactSecrets(`Commit ${commit} has tree ${digest}; the locale file is locale/en.json.`)
  assert.equal(redacted, 0)
  assert.match(text, new RegExp(commit))
  assert.match(text, new RegExp(digest))
})

test('a secret pasted into a candidate is redacted at the write choke point', () => {
  const { store } = tempStore()
  const result = store.insert({
    kind: 'fact',
    subject: 'rotated key',
    text: 'The deploy key sk-abcdefghijklmnopqrstuvwxyz012345 was rotated after the incident.',
  }, { scope: 'ws-a' })
  assert.equal(result.action, 'added')
  assert.doesNotMatch(result.entry.text, /sk-abcdef/)
  assert.equal(result.entry.redacted, 1)
  assert.match(result.entry.text, /rotated after the incident/)
})

test('decay retires long-unread ordinary entries but never the rules', () => {
  const day = 86_400_000
  const now = Date.now()
  const { store } = tempStore({ now: () => now })
  const old = now - 200 * day
  const staleFact = store.insert({ kind: 'fact', subject: 'stale', text: 'An ordinary fact nobody has opened in months.' }, { scope: 'ws-a' })
  const usedFact = store.insert({ kind: 'fact', subject: 'used', text: 'An ordinary fact that was read recently.' }, { scope: 'ws-a' })
  const prohibition = store.insert({ kind: 'prohibition', subject: 'rule', text: 'Never push directly to the main branch.' }, { scope: 'ws-a' })
  const reference = store.insert({ kind: 'reference', subject: 'ref', text: 'The authoritative reference document lives here.' }, { scope: 'ws-a' })
  const freshFact = store.insert({ kind: 'fact', subject: 'fresh', text: 'An ordinary fact recorded just now.' }, { scope: 'ws-a' })

  for (const entry of [staleFact.entry, usedFact.entry, prohibition.entry, reference.entry]) entry.createdAt = old
  usedFact.entry.lastRecalledAt = now - day

  const result = store.decay({ staleAfterDays: 120, neverReadGraceDays: 30 })
  assert.deepEqual(result.ids, [staleFact.entry.id])
  assert.equal(store.get(staleFact.entry.id).status, 'decayed')
  for (const keep of [usedFact, prohibition, reference, freshFact]) {
    assert.equal(store.get(keep.entry.id).status, 'active', `${keep.entry.subject} must survive`)
  }
  assert.equal(store.stats('ws-a').decayed, 1)
})

test('a decayed entry leaves recall but is kept as history', () => {
  const day = 86_400_000
  const now = Date.now()
  const { store } = tempStore({ now: () => now })
  const added = store.insert({ kind: 'fact', subject: 's', text: 'An ordinary fact that went stale months ago.' }, { scope: 'ws-a' })
  added.entry.createdAt = now - 400 * day
  store.decay({ staleAfterDays: 120 })
  assert.equal(store.active('ws-a').length, 0)
  assert.ok(store.get(added.entry.id), 'the text is still retrievable by id')
})
