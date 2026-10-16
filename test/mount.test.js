/**
 * Mount integration test: drive `mount()` with a stand-in Cordis context.
 *
 * This is the contract that must hold at boot. The plugin's real failure mode
 * was a browser half parked on a service that never appeared, so these tests
 * assert the shape that keeps boot safe:
 *   - `mount` completes with NO web server present, and
 *   - the panel route registers once one appears, and
 *   - nothing in the host half is left waiting on a service.
 *
 * The stand-in models only what `mount` touches: `effect`, `on`, `inject`,
 * `get`, `logger`. No Harness, no network, no browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mount } from '../lib/mount.js'
import { scopeForCwd } from '../lib/store.js'

/** A Cordis-context stand-in recording every effect and injection. */
function fakeContext() {
  const effects = []
  const injections = []
  const listeners = []
  const services = new Map()
  const logs = []

  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    effect(fn, label) {
      // Run the effect body now, exactly as cordis does on apply, and keep the
      // disposer so a test can assert cleanup exists.
      const dispose = fn()
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on(name, listener) {
      listeners.push({ name, listener })
      return () => {}
    },
    inject(deps, callback) {
      injections.push({ deps, callback })
      // Mimic cordis: fire the callback only for services already present.
      const available = deps.every((d) => services.has(d))
      if (!available) return () => {}
      const scoped = {
        ...ctx,
        get: (name) => (deps.includes(name) ? services.get(name) : undefined),
        effect: ctx.effect,
      }
      for (const dep of deps) scoped[dep] = services.get(dep)
      callback(scoped)
      return () => {}
    },
    get(name) { return services.get(name) },
    /** Test hook: publish a service and replay pending injections. */
    provide(name, value) {
      services.set(name, value)
      for (const { deps, callback } of injections) {
        if (!deps.includes(name) || !deps.every((d) => services.has(d))) continue
        const scoped = { ...ctx, get: (n) => (deps.includes(n) ? services.get(n) : undefined) }
        for (const dep of deps) scoped[dep] = services.get(dep)
        callback(scoped)
      }
    },
  }
  return { ctx, effects, injections, listeners, logs, services }
}

/** A throwaway store path so no test touches the real memory file. */
function tempStoreFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-mount-')), 'store.json')
}

/** A fake web server recording registered routes. */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) { routes.push(route); return () => {} },
  }
}

test('mount completes with no web server present and leaves nothing parked', () => {
  const { ctx, injections, logs } = fakeContext()
  const service = {}
  // The whole point: a composition without a web server must still mount
  // capture/recall. A hard `inject` on the host half would park the fiber here.
  assert.doesNotThrow(() => mount(ctx, { storeFile: tempStoreFile() }, service))

  assert.equal(typeof service.store, 'object')
  assert.equal(typeof service.settings, 'object')

  // The panel API is the one nested injection, and it is still waiting — which
  // is the safe state: waiting on the HOST side only delays the panel.
  const panelInjection = injections.find((i) => i.deps.includes('webServer'))
  assert.ok(panelInjection, 'the panel API must be registered through a nested inject')
  assert.equal(panelInjection.deps.length, 1)

  // A readiness line is logged either way, so an operator can see the plugin mount.
  assert.ok(logs.some(([, m]) => /memory-curator: ready/.test(m)))
})

test('mount registers the panel route once a web server appears', () => {
  // Record the nested injection instead of auto-firing it, so the test can
  // hand it a web server exactly as cordis would when the service arrives.
  const recorded = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    inject: (deps, callback) => { recorded.push({ deps, callback }) },
    get: () => undefined,
  }
  mount(ctx, { storeFile: tempStoreFile() }, {})

  const pending = recorded.find((r) => r.deps.includes('webServer'))
  assert.ok(pending, 'the panel API must be registered through a nested inject')

  const server = fakeWebServer()
  const scopedEffects = []
  pending.callback({
    webServer: server,
    get: (name) => (name === 'webServer' ? server : undefined),
    effect(fn, label) { const d = fn(); scopedEffects.push(label); return () => { if (typeof d === 'function') d() } },
  })

  assert.equal(server.routes.length, 1)
  assert.equal(server.routes[0].kind, 'prefix')
  assert.equal(server.routes[0].path, '/api/memory-curator')
  assert.equal(typeof server.routes[0].handler, 'function')
  assert.ok(scopedEffects.some((l) => /panel api/.test(l)))
})

test('mount wires capture, recall and the memory tools', () => {
  const { ctx, listeners, injections } = fakeContext()
  const service = {}
  mount(ctx, { storeFile: tempStoreFile() }, service)

  // Capture listens for finished turns.
  assert.ok(listeners.some((l) => l.name === 'session/event'), 'capture must listen for session/event')
  assert.ok(listeners.some((l) => l.name === 'session/disposed'), 'sessions must be cleaned up')

  // Recall injects a system-prompt section and a context block.
  assert.ok(injections.some((i) => i.deps.includes('systemPrompt')), 'recall must inject systemPrompt')

  // Tools register against the tools service; fire that injection and count them.
  const toolsInjection = injections.find((i) => i.deps.includes('tools'))
  assert.ok(toolsInjection, 'the memory tools must be registered')
  const registered = []
  toolsInjection.callback({ tools: { register: (def) => { registered.push(def); return () => {} } } })
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['memory_add', 'memory_curate', 'memory_detail', 'memory_forget', 'memory_search', 'memory_stats'])
})

test('mount respects a disabled capture flag', () => {
  const { ctx, listeners } = fakeContext()
  const service = {}
  mount(ctx, { storeFile: tempStoreFile(), captureEnabled: false }, service)
  // The listener still attaches (cheap) but the resolved setting is what gates it.
  assert.equal(service.settings.captureEnabled, false)
  assert.equal(service.settings.recallEnabled, true)
})

test('the host half declares no hard dependency that could park boot', async () => {
  // A regression guard for the failure that stopped DSH from starting: the
  // module must not export a hard `inject` naming anything beyond what a
  // headless composition can provide. The browser half is where a hard remote
  // dependency proved fatal, but the host half is held to the same rule.
  const hostModule = await import('../lib/index.js')
  assert.equal(hostModule.inject, undefined, 'the host half must not declare a hard inject list')
})

test('a delegated subagent gets the tools but not the resident index', () => {
  const { ctx, injections } = fakeContext()
  const service = {}
  mount(ctx, { storeFile: tempStoreFile() }, service)
  const root = 'D:\\work'
  service.store.insert(
    { kind: 'fact', subject: 'sandbox shell', text: 'Git ssh must be the system binary inside the sandbox.' },
    { scope: scopeForCwd(root) },
  )

  const captured = {}
  const injection = injections.find((i) => i.deps.includes('systemPrompt'))
  assert.ok(injection, 'recall must register against systemPrompt')
  injection.callback({
    systemPrompt: {
      section: (spec) => { captured.section = spec },
      context: (spec) => { captured.context = spec },
    },
  })
  assert.ok(captured.context, 'the index must be registered as a runtime-context block')

  const render = (header) => captured.context.text({ agent: { session: { header } } })
  assert.match(render({ cwd: root, delegationDepth: 0 }), /sandbox shell/)
  // Measured: three subagent sessions received a full catalog and used memory
  // once between them. Both markers are honoured, and an unmarked session keeps
  // its memory — the gate fails open.
  assert.equal(render({ cwd: root, origin: 'subagent' }), '')
  assert.equal(render({ cwd: root, delegationDepth: 1 }), '')
  assert.match(render({ cwd: root }), /sandbox shell/)
})
