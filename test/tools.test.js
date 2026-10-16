/**
 * Tool-schema contract tests.
 *
 * The regression these exist for: `ctx.tools.register()` forwards a tool's
 * `parameters` to the model provider VERBATIM. The plugin used to hand it the
 * authoring shorthand (`{ query: { type: 'string', required: true } }`), which
 * has no root `type`, and the provider rejected the whole request:
 *
 *   Invalid schema for function 'memory_add': schema must be a JSON Schema of
 *   type: "object", got type: "null". (INVALID_REQUEST)
 *
 * So the shape is asserted twice: structurally here (always), and against the
 * Harness's own compiler when `@deepseek-ai/dsh-tools` is installed
 * (build-time only — the plugin never imports it at runtime).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mount } from '../lib/mount.js'
import { memoryTools, toolParameters } from '../lib/tools.js'
import { compileParameters, assertParameters, compileValueSchema } from '../lib/harness.js'

const TOOL_NAMES = ['memory_add', 'memory_curate', 'memory_detail', 'memory_forget', 'memory_search', 'memory_stats']

/** A throwaway store path so no test touches the real memory file. */
function tempStoreFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tools-')), 'store.json')
}

/** Capture the definitions the plugin hands to `ctx.tools.register()`. */
function registeredDefinitions() {
  const recorded = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    inject(deps, callback) {
      if (deps.includes('tools')) callback({ tools: { register: (def) => { recorded.push(def); return () => {} } } })
    },
    get: () => undefined,
  }
  mount(ctx, { storeFile: tempStoreFile() }, {})
  return recorded
}

/** The authoring specs, as the plugin declares them. */
function toolSpecs() {
  return memoryTools({
    store: {},
    settings: {},
    scopeForExecution: () => 'global',
    adjudicateConflicts: async () => ({ checked: 0, superseded: 0 }),
  })
}

/** The Harness's own compiler, or undefined when it is not installed. */
async function harnessCompiler() {
  try {
    return await import('@deepseek-ai/dsh-tools')
  } catch {
    return undefined
  }
}

/** One registered definition by name. */
function definitionOf(name) {
  const found = registeredDefinitions().find((d) => d.name === name)
  assert.ok(found, `${name} must be registered`)
  return found
}

test('every registered tool declares an object-rooted JSON Schema', () => {
  const definitions = registeredDefinitions()
  assert.deepEqual(definitions.map((d) => d.name).sort(), TOOL_NAMES)

  for (const definition of definitions) {
    const { parameters } = definition
    assert.equal(typeof parameters, 'object', `${definition.name}: parameters must be an object`)
    // The exact defect: no root type means the provider rejects the request.
    assert.equal(parameters.type, 'object', `${definition.name}: root type must be "object"`)
    assert.equal(typeof parameters.properties, 'object', `${definition.name}: properties must be an object`)
    assert.equal(Array.isArray(parameters.properties), false)
    if (parameters.required !== undefined) {
      assert.equal(Array.isArray(parameters.required), true, `${definition.name}: required must be an array`)
      for (const name of parameters.required) {
        assert.ok(Object.hasOwn(parameters.properties, name), `${definition.name}: required names undeclared ${name}`)
      }
    }
    // No authoring-only keys survive into the wire schema.
    for (const [name, node] of Object.entries(parameters.properties)) {
      assert.equal(Object.hasOwn(node, 'required'), false, `${definition.name}.${name} still carries the authoring-only "required" key`)
      assert.equal(typeof node.type, 'string', `${definition.name}.${name} needs a concrete type`)
      assert.equal(typeof node.description, 'string', `${definition.name}.${name} needs a description for the model`)
    }
  }
})

test('memory_add declares the schema the provider rejected', () => {
  assert.deepEqual(definitionOf('memory_add').parameters, {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'One self-contained statement, readable with no surrounding context.' },
      kind: { type: 'string', description: 'One of: decision, correction, prohibition, reference, open, fact. Defaults to fact.' },
      subject: { type: 'string', description: 'Short stable key naming what this is about; reuse the same wording for the same topic so contradictions are detected.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
    },
    required: ['text'],
  })
  // A parameterless tool still needs the object root.
  for (const name of ['memory_curate', 'memory_stats']) {
    assert.deepEqual(definitionOf(name).parameters, { type: 'object', properties: {} })
  }
})

test('compileParameters collects required names and keeps annotations', () => {
  const schema = compileParameters({
    id: { type: 'string', required: true, description: 'An id.', title: 'Id' },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string', enum: ['fast', 'slow'] },
    nested: {
      type: 'object',
      additionalProperties: false,
      properties: { inner: { type: 'integer', required: true } },
    },
    loose: { type: 'json' },
    choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  })

  assert.deepEqual(schema.required, ['id'])
  assert.deepEqual(schema.properties.id, { type: 'string', description: 'An id.', title: 'Id' })
  assert.deepEqual(schema.properties.tags, { type: 'array', items: { type: 'string' } })
  assert.deepEqual(schema.properties.mode.enum, ['fast', 'slow'])
  assert.deepEqual(schema.properties.nested, {
    type: 'object',
    additionalProperties: false,
    properties: { inner: { type: 'integer' } },
    required: ['inner'],
  })
  // `json` is annotation-only: the unconstrained-JSON form.
  assert.deepEqual(schema.properties.loose, {})
  assert.deepEqual(schema.properties.choice, { oneOf: [{ type: 'string' }, { type: 'number' }] })
})

test('compileParameters omits required when nothing is required', () => {
  const schema = compileParameters({ note: { type: 'string' } })
  assert.deepEqual(schema, { type: 'object', properties: { note: { type: 'string' } } })
  assert.equal(Object.hasOwn(schema, 'required'), false)
})

test('compileParameters passes an already-compiled schema through unchanged', () => {
  const compiled = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  assert.equal(compileParameters(compiled), compiled)
})

test('a __proto__ parameter name becomes an own property, not a prototype', () => {
  const schema = compileParameters(JSON.parse('{"__proto__": {"type": "string"}}'))
  assert.ok(Object.hasOwn(schema.properties, '__proto__'))
  assert.equal(Object.getPrototypeOf(schema.properties), Object.prototype)
})

test('compileValueSchema rejects values outside the supported subset', () => {
  assert.throws(() => compileValueSchema({ type: 'blob' }), /type must be string\/number\/integer\/boolean\/null\/array\/object\/json/)
  assert.throws(() => compileValueSchema({ type: 'object' }), /additionalProperties must be explicitly true or false/)
  assert.throws(() => compileValueSchema({ type: 'object', additionalProperties: true, nope: 1 }), /not supported by the parameter spec DSL/)
  assert.throws(() => compileValueSchema({ oneOf: [{ type: 'string' }] }), /at least two schemas/)
  assert.throws(() => compileValueSchema({ type: 'string', oneOf: [{ type: 'string' }, { type: 'string' }] }), /cannot declare both type and oneOf/)
  assert.throws(() => compileValueSchema({ type: 'string', enum: [] }), /enum must be a non-empty array/)
  assert.throws(() => compileValueSchema('nope'), /must be a schema object/)
})

test('compileParameters rejects a property whose required flag is not true', () => {
  assert.throws(() => compileParameters({ id: { type: 'string', required: false } }), /required must be true when present/)
  assert.throws(() => compileParameters({ id: 'string' }), /must be a value schema object/)
  assert.throws(() => compileParameters([]), /must be an object of value schemas/)
})

test('assertParameters catches the exact regression the provider reported', () => {
  // The bare property map that produced 'got type: "null"'.
  assert.throws(() => assertParameters({ text: { type: 'string' } }, 'memory_add'), /root type of "object" \(got undefined\)/)
  assert.throws(() => assertParameters({ type: 'object' }, 'memory_add'), /properties must be an object/)
  assert.throws(() => assertParameters({ type: 'object', properties: {}, required: [1] }, 'memory_add'), /required must be an array of strings/)
  assert.throws(() => assertParameters({ type: 'object', properties: {}, required: ['ghost'] }, 'memory_add'), /names undeclared property "ghost"/)
  assert.throws(() => assertParameters({ type: 'object', properties: { a: { type: 'string', required: true } } }, 'memory_add'), /authoring-only "required" key/)
  assert.doesNotThrow(() => assertParameters({ type: 'object', properties: { a: { type: 'string' } } }, 'memory_add'))
})

test('the compiled schemas match the Harness compiler exactly', async (t) => {
  const harness = await harnessCompiler()
  if (harness === undefined) {
    t.skip('@deepseek-ai/dsh-tools is not installed (optional devDependency)')
    return
  }

  // The plugin's own authoring specs, compiled by the Harness itself. If our
  // compiler ever drifts from the Harness DSL, this fails — and if the specs
  // regress to a bare property map, so does the schema the provider receives.
  for (const [name, spec] of Object.entries(toolParameters)) {
    const harnessSchema = harness.parameterSchemaSpecToJsonSchema(spec)
    assert.deepEqual(
      definitionOf(name).parameters,
      harnessSchema,
      `${name}: the registered schema must equal the Harness compilation of toolParameters.${name}`,
    )
    assert.doesNotThrow(() => harness.assertSupportedJsonSchema(harnessSchema), `${name}: not a supported JSON Schema`)
  }

  // The richer shapes the plugin does not use yet, so the compiler stays honest.
  const shapes = {
    nested: {
      limit: { type: 'number', required: true },
      filter: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true }, deep: { type: 'json' } },
      },
    },
    scalars: {
      flag: { type: 'boolean' },
      count: { type: 'integer', enum: [1, 2, 3] },
      nothing: { type: 'null' },
      loose: { type: 'json' },
      choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      annotated: { type: 'string', title: 'T', default: 'd', examples: ['a'] },
    },
  }
  for (const [label, spec] of Object.entries(shapes)) {
    assert.deepEqual(compileParameters(spec), harness.parameterSchemaSpecToJsonSchema(spec), `${label}: compilers must agree`)
  }
})

test('the compiled schemas validate Harness-style arguments', async (t) => {
  const harness = await harnessCompiler()
  if (harness === undefined) {
    t.skip('@deepseek-ai/dsh-tools is not installed (optional devDependency)')
    return
  }
  const add = definitionOf('memory_add').parameters
  assert.deepEqual(harness.validateJsonSchemaValue(add, { text: 'a fact', tags: ['x'] }), [])
  assert.ok(harness.validateJsonSchemaValue(add, { tags: ['x'] }).length > 0, 'missing required text must be reported')
  assert.ok(harness.validateJsonSchemaValue(add, { text: 'a fact', tags: 'x' }).length > 0, 'wrong tag type must be reported')

  // Every tool the plugin registers must be accepted by the Harness subset check.
  for (const definition of registeredDefinitions()) {
    assert.doesNotThrow(
      () => harness.assertSupportedJsonSchema(definition.parameters),
      `${definition.name}: not a supported JSON Schema`,
    )
  }
})

test('the tool specs module does not import any Harness package', () => {
  // The zero-install-time-dependency rule: only relative imports and node builtins.
  for (const file of ['tools.js', 'harness.js', 'mount.js']) {
    const source = fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8')
    const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('node:'),
        `${file} imports ${specifier}; runtime imports must stay relative or node builtins`,
      )
    }
  }
})
