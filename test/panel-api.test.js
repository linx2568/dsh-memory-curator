/**
 * Panel API tests: the `/api/memory-curator/*` routes the browser half calls.
 *
 * These drive `createPanelApi` with fake Node `req`/`res` objects, so the whole
 * request path — routing, JSON encoding, status codes, store mutation — is
 * exercised without a web server. Pure logic plus an EventEmitter: no Harness,
 * no network, no browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { createPanelApi, isSameOriginRequest, stripEntry } from '../lib/panel-api.js'
import { MemoryStore } from '../lib/store.js'

/** A mounted-service stand-in: the route handler only needs `.store`/`.settings`. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-api-'))
  const store = new MemoryStore(path.join(dir, 'store.json'))
  return { service: { store, settings: { storeFile: path.join(dir, 'store.json'), curateEnabled: true } } }
}

/**
 * A fake request: an EventEmitter carrying method/url, fed an optional body.
 *
 * `headers` defaults to an empty map, which is what a local caller (a script,
 * curl) sends — the same-origin fence must let those through.
 */
function fakeRequest(method, url, body, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {}
  // Emitting on the next tick keeps the handler's listener wiring race-free.
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

/** A fake response capturing status, headers and body. */
function fakeResponse() {
  const res = {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(chunk) { res.body = chunk ?? '' },
  }
  return res
}

/** Drive one request through a handler and return the decoded reply. */
async function callApi(handler, method, url, body, headers) {
  const res = fakeResponse()
  await handler(fakeRequest(method, url, body, headers), res)
  return { status: res.status, headers: res.headers, json: JSON.parse(res.body) }
}

test('GET /entries returns entries newest first', async () => {
  const { service } = fixture()
  service.store.insert({ text: 'older fact about the build', kind: 'fact' }, { scope: 'global' })
  service.store.insert({ text: 'newer fact about the release', kind: 'decision' }, { scope: 'global' })
  const handler = createPanelApi(service)

  const reply = await callApi(handler, 'GET', '/api/memory-curator/entries')
  assert.equal(reply.status, 200)
  assert.equal(reply.json.entries.length, 2)
  // Newest first: the second insert must lead.
  assert.match(reply.json.entries[0].text, /newer/)
  assert.equal(reply.headers['cache-control'], 'no-store')
})

test('the bare prefix path is treated as the entries listing', async () => {
  const { service } = fixture()
  service.store.insert({ text: 'a durable fact worth keeping', kind: 'fact' }, { scope: 'global' })
  const reply = await callApi(createPanelApi(service), 'GET', '/api/memory-curator')
  assert.equal(reply.status, 200)
  assert.equal(reply.json.entries.length, 1)
})

test('POST /add records an entry and it becomes visible', async () => {
  const { service } = fixture()
  const handler = createPanelApi(service)

  const added = await callApi(handler, 'POST', '/api/memory-curator/add', {
    text: 'the panel writes through the same store', kind: 'decision', subject: 'panel store',
  })
  assert.equal(added.status, 200)
  assert.equal(added.json.action, 'added')
  assert.ok(added.json.id)

  const listed = await callApi(handler, 'GET', '/api/memory-curator/entries')
  assert.equal(listed.json.entries.length, 1)
  assert.equal(listed.json.entries[0].subject, 'panel store')
})

test('POST /add rejects empty text with 400', async () => {
  const { service } = fixture()
  const reply = await callApi(createPanelApi(service), 'POST', '/api/memory-curator/add', { text: '   ' })
  assert.equal(reply.status, 400)
  assert.match(reply.json.error, /non-empty text/)
})

test('POST /forget retires an entry and reports it', async () => {
  const { service } = fixture()
  const inserted = service.store.insert({ text: 'a fact that will be forgotten', kind: 'fact' }, { scope: 'global' })
  const handler = createPanelApi(service)

  const forgotten = await callApi(handler, 'POST', '/api/memory-curator/forget', { id: inserted.entry.id })
  assert.equal(forgotten.status, 200)
  assert.equal(forgotten.json.action, 'forgotten')

  // A retired entry must no longer count as active in the stats the header shows.
  const stats = await callApi(handler, 'GET', '/api/memory-curator/stats')
  assert.equal(stats.json.byStatus.active ?? 0, 0)
  assert.equal(stats.json.byStatus.forgotten, 1)
})

test('POST /forget rejects an unknown id with 404', async () => {
  const { service } = fixture()
  const reply = await callApi(createPanelApi(service), 'POST', '/api/memory-curator/forget', { id: 'nope' })
  assert.equal(reply.status, 404)
})

test('GET /search matches keywords and skips retired entries', async () => {
  const { service } = fixture()
  service.store.insert({ text: 'the plugin mounts a webserver route', kind: 'fact' }, { scope: 'global' })
  const doomed = service.store.insert({ text: 'a webserver note that gets retired', kind: 'fact' }, { scope: 'global' })
  service.store.forget(doomed.entry.id)
  const handler = createPanelApi(service)

  const hit = await callApi(handler, 'GET', '/api/memory-curator/search?q=webserver')
  assert.equal(hit.status, 200)
  assert.equal(hit.json.results.length, 1)
  assert.match(hit.json.results[0].text, /mounts a webserver route/)

  const miss = await callApi(handler, 'GET', '/api/memory-curator/search?q=zzzznomatch')
  assert.equal(miss.json.results.length, 0)

  const blank = await callApi(handler, 'GET', '/api/memory-curator/search')
  assert.equal(blank.json.results.length, 0)
})

test('GET /detail returns one entry, and 404s an unknown id', async () => {
  const { service } = fixture()
  const inserted = service.store.insert({ text: 'a detail-addressable fact', kind: 'reference' }, { scope: 'global' })
  const handler = createPanelApi(service)

  const found = await callApi(handler, 'GET', `/api/memory-curator/detail?id=${encodeURIComponent(inserted.entry.id)}`)
  assert.equal(found.status, 200)
  assert.equal(found.json.entry.id, inserted.entry.id)
  assert.equal(found.json.entry.kind, 'reference')

  const missing = await callApi(handler, 'GET', '/api/memory-curator/detail?id=deadbeef')
  assert.equal(missing.status, 404)
})

test('GET /stats reports totals and per-kind counters', async () => {
  const { service } = fixture()
  service.store.insert({ text: 'one decision among the entries', kind: 'decision' }, { scope: 'global' })
  service.store.insert({ text: 'one fact among the entries', kind: 'fact' }, { scope: 'global' })
  const reply = await callApi(createPanelApi(service), 'GET', '/api/memory-curator/stats')
  assert.equal(reply.status, 200)
  assert.equal(reply.json.total, 2)
  assert.equal(reply.json.byKind.decision, 1)
  assert.equal(reply.json.byKind.fact, 1)
  assert.equal(reply.json.byStatus.active, 2)
})

test('POST /curate folds duplicates', async () => {
  const { service } = fixture()
  service.store.insert({ text: 'the store folds near-identical statements automatically', kind: 'fact' }, { scope: 'global' })
  service.store.insert({ text: 'the store folds near-identical statements automatically', kind: 'fact' }, { scope: 'global' })
  const reply = await callApi(createPanelApi(service), 'POST', '/api/memory-curator/curate', {})
  assert.equal(reply.status, 200)
  assert.equal(typeof reply.json.foldedDuplicates, 'number')
})

test('an unknown route answers 404 with the route named', async () => {
  const { service } = fixture()
  const reply = await callApi(createPanelApi(service), 'GET', '/api/memory-curator/nonsense')
  assert.equal(reply.status, 404)
  assert.match(reply.json.error, /nonsense/)
})

test('a service without a store answers 503 rather than throwing', async () => {
  const reply = await callApi(createPanelApi({}), 'GET', '/api/memory-curator/entries')
  assert.equal(reply.status, 503)
})

test('a malformed JSON body answers 500 with a readable message', async () => {
  const { service } = fixture()
  const handler = createPanelApi(service)
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/memory-curator/add'
  req.destroy = () => {}
  process.nextTick(() => {
    req.emit('data', Buffer.from('{not json', 'utf8'))
    req.emit('end')
  })
  const res = fakeResponse()
  await handler(req, res)
  assert.equal(res.status, 500)
  assert.match(JSON.parse(res.body).error, /invalid JSON/)
})

test('a cross-site request is refused before it can touch the store', async () => {
  const { service } = fixture()
  const reply = await callApi(
    createPanelApi(service),
    'POST',
    '/api/memory-curator/add',
    { text: 'a forged entry that must never be stored', kind: 'decision' },
    // The shape a hostile page sends: a simple request (text/plain, no
    // preflight) from another site to the loopback API.
    { origin: 'https://evil.example', host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
  )
  assert.equal(reply.status, 403)
  assert.equal(service.store.all().length, 0)
})

test('an Origin that disagrees with the addressed host is refused on its own', async () => {
  const { service } = fixture()
  service.store.insert({ text: 'an entry the attacker wants gone', kind: 'fact' }, { scope: 'global' })
  const id = service.store.all()[0].id
  const reply = await callApi(
    createPanelApi(service),
    'POST',
    '/api/memory-curator/forget',
    { id },
    { origin: 'https://evil.example', host: '127.0.0.1:19387' },
  )
  assert.equal(reply.status, 403)
  assert.equal(service.store.get(id).status, 'active')
})

test('a same-site Origin (a sibling subdomain) is still refused', async () => {
  const { service } = fixture()
  const reply = await callApi(
    createPanelApi(service),
    'GET',
    '/api/memory-curator/entries',
    undefined,
    // Same registrable domain, different origin: the Sec-Fetch-Site label is the
    // only signal that gives it away.
    { origin: 'http://other.dsh.example', host: 'dsh.example', 'sec-fetch-site': 'same-site' },
  )
  assert.equal(reply.status, 403)
})

test('Origin: null names no host and is refused', async () => {
  const { service } = fixture()
  const reply = await callApi(
    createPanelApi(service),
    'GET',
    '/api/memory-curator/entries',
    undefined,
    { origin: 'null', host: '127.0.0.1:19387' },
  )
  assert.equal(reply.status, 403)
})

test('the panel\'s own same-origin request is served', async () => {
  const { service } = fixture()
  const reply = await callApi(
    createPanelApi(service),
    'POST',
    '/api/memory-curator/add',
    { text: 'a legitimate entry from the panel', kind: 'fact' },
    { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
  )
  assert.equal(reply.status, 200)
  assert.equal(reply.json.action, 'added')
  assert.equal(service.store.all().length, 1)
})

test('isSameOriginRequest judges the label, not the caller', () => {
  const answered = { origin: 'http://localhost:19387', host: 'localhost:19387' }
  assert.equal(isSameOriginRequest({ headers: { ...answered, 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(isSameOriginRequest({ headers: { ...answered, 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isSameOriginRequest({ headers: { ...answered, 'sec-fetch-site': 'same-site' } }), false)
  // A user-initiated navigation carries no ambient authority and cannot send a body.
  assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'none' } }), true)
  // No browser headers at all: a local script, curl, or this test suite.
  assert.equal(isSameOriginRequest({ headers: {} }), true)
  assert.equal(isSameOriginRequest({}), true)
  // Headers arriving with unexpected casing are read as Node delivers them.
  assert.equal(isSameOriginRequest({ headers: { origin: 'http://localhost:19387', host: 'localhost:19387' } }), true)
})

test('stripEntry drops internal fields and always yields a tags array', () => {
  const view = stripEntry({ id: 'a', kind: 'fact', subject: 's', text: 't', status: 'active', scope: 'global', createdAt: 1, updatedAt: 2 })
  assert.deepEqual(view.tags, [])
  assert.equal(view.supersededBy, undefined)
  // The internal bookkeeping must not leak into the panel payload.
  assert.equal(Object.hasOwn(view, 'embedding'), false)
  assert.deepEqual(Object.keys(view).sort(), [
    'createdAt', 'id', 'kind', 'scope', 'status', 'subject', 'supersededBy', 'tags', 'text', 'updatedAt',
  ].sort())
})
