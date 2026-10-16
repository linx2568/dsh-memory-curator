/**
 * Minimal Harness glue, written without importing any Harness package.
 *
 * Why this file exists: a plugin installed from an external directory is a
 * symlink into the profile's `node_modules`, and the profile does not hoist the
 * Harness's own packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, …).
 * Importing them therefore fails at activation with "failed to import". The
 * cooperative contracts are small enough to use directly:
 *
 *  - `ctx.tools.register()` accepts a plain `{ name, description, parameters,
 *    output: { schema, render }, execute }` object — `defineTool` is a
 *    convenience wrapper, not a requirement. `register()` compiles NOTHING:
 *    `parameters` must already BE the model-facing JSON Schema, whereas
 *    `defineTool` accepts the authoring shorthand ("parameter spec") and
 *    compiles it. {@link compileParameters} performs that same compilation
 *    here, because a bare property map reaches the provider as a schema whose
 *    root `type` is missing and is rejected outright:
 *
 *      Invalid schema for function 'memory_add': schema must be a JSON Schema
 *      of type: "object", got type: "null". (INVALID_REQUEST)
 *
 *    That rejection fails the WHOLE request, so every tool in the turn — not
 *    just the offending one — is lost. `assertParameters` keeps the compiled
 *    shape honest at registration time, where a mistake is cheap.
 *  - `ctx.llm.stream()` takes a plain request and yields raw chunks; the text
 *    can be assembled by tracking block starts, so `BlockAssembler` is
 *    likewise unnecessary.
 *
 * This keeps the plugin installable from any directory with zero install-time
 * dependencies, which is also why it needs no build step.
 *
 * @module dsh-memory-curator/harness
 */

/** Scalar JSON types the Harness schema subset supports. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
/** Annotation fields copied through to the compiled schema. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/**
 * Compile one authoring node (the Harness "value schema spec") into raw JSON
 * Schema.
 *
 * Supported forms, mirroring the Harness subset:
 *   - `{ type: 'string' | 'number' | 'integer' | 'boolean' | 'null', enum?, const? }`
 *   - `{ type: 'array', items: <node> }`
 *   - `{ type: 'object', additionalProperties: boolean, properties: { … } }`
 *   - `{ type: 'json' }` — any JSON value, compiled to an annotation-only node
 *   - `{ oneOf: [<node>, <node>, …] }` — at least two branches
 *   - `{ description?, title?, default?, examples? }` with no type at all —
 *     the unconstrained-JSON form
 *
 * `required` is the one authoring-only key: a property marked `required: true`
 * is collected into its parent's `required` array.
 *
 * @param {unknown} spec - the authoring node.
 * @param {string} path - dotted path used in error messages.
 * @returns {object} a raw JSON Schema node.
 * @throws {TypeError} on a value outside the supported subset.
 */
export function compileValueSchema(spec, path = 'schema') {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`memory-curator: ${path} must be a schema object`)
  }

  const node = {}
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(spec, key)) node[key] = spec[key]
  }

  if (Object.hasOwn(spec, 'oneOf')) {
    if (Object.hasOwn(spec, 'type')) {
      throw new TypeError(`memory-curator: ${path} cannot declare both type and oneOf`)
    }
    const branches = spec.oneOf
    if (!Array.isArray(branches) || branches.length < 2) {
      throw new TypeError(`memory-curator: ${path}.oneOf must be an array of at least two schemas`)
    }
    node.oneOf = branches.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`))
    rejectUnknownKeys(spec, path, ['oneOf', ...ANNOTATION_KEYS])
    return node
  }

  const type = Object.hasOwn(spec, 'type') ? spec.type : undefined
  if (type === undefined) {
    // Annotation-only node: the unconstrained-JSON form. `required: true` is
    // still meaningful for the parent, so only the sibling DSL keys are wrong.
    rejectUnknownKeys(spec, path, ANNOTATION_KEYS)
    return node
  }

  if (type === 'json') {
    rejectUnknownKeys(spec, path, ['type', ...ANNOTATION_KEYS])
    return node
  }
  if (type === 'array') {
    if (Object.hasOwn(spec, 'items')) {
      node.type = 'array'
      node.items = compileValueSchema(spec.items, `${path}.items`)
    } else {
      node.type = 'array'
    }
    rejectUnknownKeys(spec, path, ['type', 'items', ...ANNOTATION_KEYS])
    return node
  }
  if (type === 'object') {
    if (typeof spec.additionalProperties !== 'boolean') {
      throw new TypeError(`memory-curator: ${path}.additionalProperties must be explicitly true or false`)
    }
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties
    if (Object.hasOwn(spec, 'properties')) {
      const compiled = compilePropertyMap(spec.properties, `${path}.properties`)
      node.properties = compiled.properties
      if (compiled.required.length > 0) node.required = compiled.required
    }
    rejectUnknownKeys(spec, path, ['type', 'properties', 'additionalProperties', ...ANNOTATION_KEYS])
    return node
  }
  if (SCALAR_TYPES.has(type)) {
    node.type = type
    if (Object.hasOwn(spec, 'enum')) {
      if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
        throw new TypeError(`memory-curator: ${path}.enum must be a non-empty array of scalar values`)
      }
      node.enum = [...spec.enum]
    }
    if (Object.hasOwn(spec, 'const')) node.const = spec.const
    rejectUnknownKeys(spec, path, ['type', 'enum', 'const', ...ANNOTATION_KEYS])
    return node
  }

  throw new TypeError(`memory-curator: ${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
}

/**
 * Compile a map of property name to authoring node, collecting the names whose
 * spec says `required: true`.
 *
 * @param {unknown} spec - `{ <name>: <node>, … }`.
 * @param {string} path - dotted path used in error messages.
 * @returns {{properties: object, required: string[]}} the compiled map.
 */
function compilePropertyMap(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`memory-curator: ${path} must be an object of value schemas`)
  }
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`memory-curator: ${path}.${key} must be a value schema object`)
    }
    if (Object.hasOwn(value, 'required')) {
      if (value.required !== true) {
        throw new TypeError(`memory-curator: ${path}.${key}.required must be true when present`)
      }
      required.push(key)
    }
    // Define rather than assign so a property literally named __proto__ becomes
    // an own key instead of mutating this map's prototype.
    Object.defineProperty(properties, key, {
      value: compileValueSchema(value, `${path}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return { properties, required }
}

/**
 * Compile an authoring parameter map into the object-rooted JSON Schema the
 * model-facing tool declaration must carry.
 *
 * @param {unknown} spec - `{ <name>: <node>, … }`, or an already-compiled
 *   `{ type: 'object', properties, required? }` schema, which passes through
 *   unchanged so a caller can never silently regress to the bare-property-map
 *   form that the provider rejects.
 * @returns {{type: 'object', properties: object, required?: string[]}}
 */
export function compileParameters(spec) {
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)
    && spec.type === 'object' && spec.properties !== null && typeof spec.properties === 'object') {
    return spec
  }
  const compiled = compilePropertyMap(spec ?? {}, 'parameters')
  return {
    type: 'object',
    properties: compiled.properties,
    ...compiled.required.length === 0 ? {} : { required: compiled.required },
  }
}

/**
 * Reject authoring keys the compiler would otherwise ignore, so a typo fails at
 * registration instead of silently dropping a constraint the model needs.
 *
 * @param {object} spec - the authoring node.
 * @param {string} path - dotted path used in error messages.
 * @param {string[]} allowed - keys this node form may carry (plus `required`).
 */
function rejectUnknownKeys(spec, path, allowed) {
  for (const key of Object.keys(spec)) {
    if (key === 'required' || allowed.includes(key)) continue
    throw new TypeError(`memory-curator: ${path}.${key} is not supported by the parameter spec DSL`)
  }
}

/**
 * Assert that a compiled tool schema is the object-rooted JSON Schema the
 * Harness forwards verbatim to the model provider.
 *
 * This is the guard for the failure this module exists to prevent: a schema
 * without a root `type: "object"` makes the provider reject the ENTIRE request
 * with INVALID_REQUEST, so the check runs once at registration, not per call.
 *
 * @param {unknown} schema - the compiled parameter schema.
 * @param {string} toolName - the tool name, for the error message.
 * @throws {TypeError} when the schema is not object-rooted or still carries
 *   authoring-only keys.
 */
export function assertParameters(schema, toolName) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`memory-curator: tool "${toolName}" parameters must be a schema object`)
  }
  if (schema.type !== 'object') {
    throw new TypeError(`memory-curator: tool "${toolName}" parameters must have a root type of "object" (got ${JSON.stringify(schema.type)}) — the model provider rejects the whole request otherwise`)
  }
  const properties = schema.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new TypeError(`memory-curator: tool "${toolName}" parameters.properties must be an object`)
  }
  if (Object.hasOwn(schema, 'required')
    && (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string'))) {
    throw new TypeError(`memory-curator: tool "${toolName}" parameters.required must be an array of strings`)
  }
  const declared = new Set(Object.keys(properties))
  for (const name of schema.required ?? []) {
    if (!declared.has(name)) {
      throw new TypeError(`memory-curator: tool "${toolName}" parameters.required names undeclared property ${JSON.stringify(name)}`)
    }
  }
  for (const [name, node] of Object.entries(properties)) {
    if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, 'required')) {
      throw new TypeError(`memory-curator: tool "${toolName}" parameters.properties.${name} still carries the authoring-only "required" key`)
    }
  }
  return schema
}

/**
 * Build one tool definition shaped for `ctx.tools.register()`.
 *
 * `spec.parameters` is written in the authoring shorthand and compiled to the
 * object-rooted JSON Schema the registry forwards verbatim; see
 * {@link compileParameters}.
 *
 * @param {object} spec - tool definition `{ name, description, parameters, execute, presentCall? }`.
 * @returns {object} a registry-ready definition.
 */
export function toolDefinition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: assertParameters(compileParameters(spec.parameters), spec.name),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const value = await spec.execute(args ?? {}, exec)
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    },
    ...spec.presentCall === undefined ? {} : { presentCall: spec.presentCall },
  }
}

/** Build a user-role message for one auxiliary model call. */
export function userMessage(text, sourceKind = 'dsh-memory-curator') {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: sourceKind },
  }
}

/**
 * Stream one model call through the Harness `llm` service and return its text.
 *
 * Chunks arrive as block deltas; only text blocks are collected, and tool or
 * reasoning blocks are ignored. Terminal error/abort finishes are surfaced so
 * the caller can skip the work instead of storing a truncated answer.
 *
 * @param {object} llm - the Harness `llm` service
 * @param {object} request - `{ provider, model, system, text, maxTokens, signal, sessionId }`
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function streamText(llm, request) {
  const buffers = new Map()
  let finish
  try {
    const options = {
      provider: request.provider,
      model: request.model,
      system: request.system,
      messages: [userMessage(request.text)],
      ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
      ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
      ...request.signal === undefined ? {} : { signal: request.signal },
    }
    for await (const chunk of llm.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'block-start') {
        buffers.set(chunk.index, { type: chunk.blockType, text: '' })
      } else if (chunk.type === 'text-delta') {
        const buffer = buffers.get(chunk.index)
        if (buffer !== undefined) buffer.text += chunk.text
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
    return { ok: false, error: finish.failure?.message ?? 'model call failed' }
  }
  const text = [...buffers.values()]
    .filter((buffer) => buffer.type === 'text')
    .map((buffer) => buffer.text)
    .join('\n')
  return { ok: true, text }
}

/**
 * Register a prompt section, tolerating a composition without `systemPrompt`.
 *
 * @param {object} ctx
 * @param {object} section - `{ name, order, text }`
 */
export function registerSection(ctx, section) {
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.systemPrompt.section(section)
  })
}

/**
 * Register a runtime-context contribution.
 *
 * @param {object} ctx
 * @param {object} contribution - `{ name, order, text }`
 */
export function registerContext(ctx, contribution) {
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.systemPrompt.context(contribution)
  })
}
