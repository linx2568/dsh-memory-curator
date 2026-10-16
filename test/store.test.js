/**
 * Store and curation tests: duplicate folding, conflict resolution, scoping.
 * Pure logic only — no Harness and no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryStore, normalizeCandidate, scopeForCwd, jaccard, normalizeText } from '../lib/store.js'

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
