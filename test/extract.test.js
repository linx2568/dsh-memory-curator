/**
 * Distillation plumbing: the repository context that bounds what may be
 * recorded, and the bounded model call that consumes it.
 *
 * No Harness, no network: the `llm` service is a stub async generator yielding
 * exactly the chunk shapes `ctx.llm.stream()` yields.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { distillTurn } from '../lib/extract.js'
import { MAX_REPO_CONTEXT_CHARS, renderRepoContext } from '../lib/parse.js'
import { clearRepoDocCache, readRepoContext } from '../lib/repo-docs.js'

/** A throwaway project directory populated with `{ relativeName: text }`. */
function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-repo-'))
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
  }
  return dir
}

/** A stub `llm` service: records every request and answers with `answer`. */
function stubLlm(answer) {
  const seen = []
  return {
    seen,
    llm: {
      async *stream(request) {
        seen.push(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

const deps = (llm) => ({ llm, provider: 'test-provider', model: 'test-model' })
const turn = (text) => [{ role: 'user', content: [{ type: 'text', text }] }]

test('renderRepoContext says nothing when the project owns nothing', () => {
  assert.equal(renderRepoContext(undefined), '')
  assert.equal(renderRepoContext({}), '')
  assert.equal(renderRepoContext({ instructions: [{ name: 'AGENTS.md', text: '   ' }], present: [] }), '')
})

test('renderRepoContext names the documents and carries the instruction text', () => {
  const context = renderRepoContext({
    present: ['AGENTS.md', 'README.md', 'docs/'],
    instructions: [{ name: 'AGENTS.md', text: 'Always run npm test before committing.' }],
  })
  assert.match(context, /Do not duplicate any of it/)
  assert.match(context, /Documents this project already has: AGENTS\.md, README\.md, docs\//)
  assert.match(context, /AGENTS\.md \(verbatim, already owned by the project\)/)
  assert.match(context, /Always run npm test before committing\./)
})

test('readRepoContext returns nothing for an empty or missing directory', () => {
  assert.equal(readRepoContext(undefined), '')
  assert.equal(readRepoContext(''), '')
  assert.equal(readRepoContext(path.join(os.tmpdir(), 'curator-does-not-exist-1234')), '')
})

test('readRepoContext inlines AGENTS.md and lists the documents that exist', () => {
  clearRepoDocCache()
  const dir = project({
    'AGENTS.md': 'Never commit to main.',
    'README.md': '# project\n\nA long human-facing document that must not be inlined.',
    'STATE.md': 'working on the parser',
    'docs/notes.md': 'notes',
    'src/index.js': 'export const x = 1',
  })
  const context = readRepoContext(dir)
  assert.match(context, /Never commit to main\./)
  assert.match(context, /AGENTS\.md/)
  assert.match(context, /README\.md/)
  assert.match(context, /STATE\.md/)
  assert.match(context, /docs\//)
  // Only instruction files are inlined: README is presence-only, and no other
  // document leaks in.
  assert.doesNotMatch(context, /A long human-facing document/)
  assert.doesNotMatch(context, /working on the parser/)
  assert.doesNotMatch(context, /src\/index\.js/)
})

test('readRepoContext bounds the instruction text it carries', () => {
  clearRepoDocCache()
  const dir = project({ 'AGENTS.md': `${'a'.repeat(MAX_REPO_CONTEXT_CHARS)}TAIL-MARKER` })
  const context = readRepoContext(dir)
  assert.doesNotMatch(context, /TAIL-MARKER/)
})

test('an unchanged document is served from cache, an edited one is re-read', () => {
  clearRepoDocCache()
  const dir = project({ 'AGENTS.md': 'rule one' })
  const real = fs.readFileSync
  let reads = 0
  fs.readFileSync = (...args) => { reads += 1; return real.apply(fs, args) }
  try {
    assert.match(readRepoContext(dir), /rule one/)
    const afterFirst = reads
    readRepoContext(dir)
    assert.equal(reads, afterFirst, 'an unchanged file must not be read again')
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rule two', 'utf8')
    assert.match(readRepoContext(dir), /rule two/)
    assert.ok(reads > afterFirst, 'a changed file must be re-read')
  } finally {
    fs.readFileSync = real
  }
})

test('distillTurn skips a turn too short to be worth a model call', async () => {
  const { llm, seen } = stubLlm('{"entries":[]}')
  const result = await distillTurn(deps(llm), turn('ok'), { minChars: 80 })
  assert.deepEqual(result, { ok: true, entries: [] })
  assert.equal(seen.length, 0)
})

test('distillTurn honours a lowered minChars', async () => {
  const { llm, seen } = stubLlm('{"entries":[]}')
  await distillTurn(deps(llm), turn('ok'), { minChars: 1 })
  assert.equal(seen.length, 1)
})

test('distillTurn puts repository context ahead of the fenced transcript', async () => {
  const { llm, seen } = stubLlm(JSON.stringify({
    entries: [{ kind: 'decision', subject: 'sandbox shell', text: 'Git ssh must be the system binary in the sandbox.' }],
  }))
  const result = await distillTurn(deps(llm), turn('x'.repeat(200)), {
    repoContext: 'Repository context. Do not duplicate any of it.\nDocuments this project already has: README.md.',
  })
  assert.equal(result.ok, true)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].kind, 'decision')

  const prompt = seen[0].messages[0].content[0].text
  // Reference first, then the fence, then the conversation: the repository text
  // must never look like part of the turn.
  assert.ok(prompt.indexOf('Repository context') < prompt.indexOf('conversation data to summarise'))
  assert.ok(prompt.indexOf('conversation data to summarise') < prompt.indexOf('x'.repeat(200)))
})

test('distillTurn reports an unparseable answer instead of storing nonsense', async () => {
  const { llm } = stubLlm('I could not decide.')
  const result = await distillTurn(deps(llm), turn('y'.repeat(200)))
  assert.equal(result.ok, false)
  assert.match(result.error, /not parseable JSON/)
})
