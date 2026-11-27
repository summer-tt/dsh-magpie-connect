import { AsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { createRequire } from 'node:module'
import { setTimeout } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'

import { decodeMagpieModels, ModelCatalog } from '../src/adapter/catalog.ts'
import type { HarnessChunk } from '../src/adapter/events.ts'
import { MagpieAdapter, type MagpieAdapterOptions } from '../src/adapter/magpie-adapter.ts'
import type { HarnessGenerateOptions } from '../src/adapter/messages.ts'
import { resolveConfig, type DshMagpieConnectConfig } from '../src/config.ts'
import { apply, inject, MAGPIE_DRAFT_MODEL_CONTROLS, SESSION_CONTROLS_API } from '../src/index.ts'
import { SessionControls, SessionControlsStore, type MagpieDraftModelControls, type SessionControlsAgent } from '../src/session-controls.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const provider = 'magpie'
const model = 'codex/gpt-6.2-sol'
const catalogWindow = 500_000
const catalogDefault = 184_464
const gatewayOutputLimit = 393_216
const narrowWindow = 272_000
const narrowDefault = 70_464
const wideWindow = 872_000
const wideDefault = 370_464
const transports = [
  { endpoint: '/v1/responses', maxTokensField: 'max_output_tokens' },
  { endpoint: '/v1/chat/completions', maxTokensField: 'max_completion_tokens' },
] as const

type Transport = (typeof transports)[number]
type Controls = ReturnType<NonNullable<MagpieAdapterOptions['resolveSessionControls']>>

function eventStream(endpoint: string, inputTokens: number): string {
  const event = (payload: object | string) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
  if (endpoint === '/v1/responses') {
    const item = { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }
    return [
      event({ type: 'response.output_item.added', output_index: 0, item }),
      event({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' }),
      event({ type: 'response.output_item.done', output_index: 0, item }),
      event({ type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: {
        input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1,
      } } }),
    ].join('')
  }
  return [
    event({ id: 'chat_test', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: {
      prompt_tokens: inputTokens, completion_tokens: 1, total_tokens: inputTokens + 1,
    } }),
    event('[DONE]'),
  ].join('')
}

interface RequestSeen {
  endpoint: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

async function mockGateway(t: TestContext, { inputTokens = 10, failFirstRequest, directory }: {
  inputTokens?: number
  failFirstRequest?: () => void
  directory?: unknown[]
} = {}) {
  const calls: RequestSeen[] = []
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models' && directory) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: directory }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const endpoint = request.url ?? ''
    calls.push({ endpoint, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    if (calls.length === 1 && failFirstRequest) {
      failFirstRequest()
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after-ms': '1' })
      response.end(JSON.stringify({ error: { message: 'Retry this request' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(eventStream(endpoint, inputTokens))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls }
}

function makeAdapter(baseUrl: string, transport: Transport, options: MagpieAdapterOptions, modelId = model) {
  const catalog = new ModelCatalog({ baseUrl })
  catalog.adoptDirectory(decodeMagpieModels({ data: [{
    id: modelId,
    native_endpoints: [transport.endpoint],
    context_window: catalogWindow,
    max_output_tokens: gatewayOutputLimit,
    reasoning: true,
    supported_reasoning_levels: ['medium', 'high', 'ultra'],
  }] }))
  return new MagpieAdapter(catalog, { baseUrl, providerId: provider, maxRetries: 0, ...options })
}

function request(overrides: Partial<HarnessGenerateOptions> = {}): HarnessGenerateOptions {
  return {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: 'ultra',
    temperature: 0.3,
    ...overrides,
  }
}

async function finish(stream: AsyncIterable<HarnessChunk>) {
  let last: HarnessChunk | undefined
  for await (const chunk of stream) last = chunk
  assert.ok(last?.type === 'finish')
  return last.reason
}

test('Cordis draft service seeds the first prepared request and bound Session view across reload', async (t) => {
  type Fiber = { dispose(): Promise<void> }
  type Host = {
    provide(name: string, value: unknown): void
    plugin(plugin: { inject: readonly string[]; apply: typeof apply }, config: DshMagpieConnectConfig): PromiseLike<Fiber>
    root: { reflect: { get(name: string): MagpieDraftModelControls | undefined } }
    emit(name: string, payload: unknown): void
  }
  let cordisPath: string
  try {
    const dshAnchor = process.env.DSH_INSTALL_DIR
      ? join(process.env.DSH_INSTALL_DIR, 'package.json')
      : createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    cordisPath = createRequire(dshAnchor).resolve('@deepseek-ai/cordis')
  } catch {
    t.skip('A DSH installation with Cordis is needed for the Host integration test')
    return
  }
  const { Context } = await import(pathToFileURL(cordisPath).href) as { Context: new () => Host }
  const host = new Context()
  const dataDir = mkdtempSync(join(tmpdir(), 'magpie-draft-host-'))
  const statePath = join(dataDir, 'session-controls.json')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const { baseUrl, calls } = await mockGateway(t, { directory: [
    { id: model, native_endpoints: ['/v1/responses'], context_window: catalogWindow, max_output_tokens: gatewayOutputLimit,
      reasoning: true, supported_reasoning_levels: ['low', 'high', 'ultra'] },
    { id: 'codex/gpt-6.2-astra' },
  ] })
  const route = { provider, model }
  const config: DshMagpieConnectConfig = { providerId: provider, baseUrl, apiKey: 'test-key', dataDir, maxRetries: 0,
    sessionControlRoutes: [{ ...route, efforts: ['high', 'medium'], speed: { options: ['standard', 'ultrafast'], default: 'standard' },
      contextWindow: { options: [narrowWindow, wideWindow], default: narrowWindow } },
    { provider, model: 'codex/gpt-6.2-astra' },
    { provider, model: 'absent', speed: { options: ['standard'], default: 'standard' } }],
  }
  let adapter: MagpieAdapter | undefined
  let initiator: SessionControlsAgent | undefined
  let sessionLookups = 0
  const boundRoutes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
  host.provide('llm', { registerAdapter: (_providers: string[], value: MagpieAdapter) => { adapter = value } })
  host.provide('agents', {
    get: (id: string) => { sessionLookups++; return initiator?.id === id ? initiator : undefined },
    currentInitiator: () => initiator,
  })
  host.provide('connection', { fetch: { register: (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => {
    boundRoutes.set(entry.path, entry)
    return () => { boundRoutes.delete(entry.path) }
  } } })
  const plugin = { inject, apply }
  let fiber = await host.plugin(plugin, config)
  t.after(async () => { await fiber.dispose() })
  const getService = () => host.root.reflect.get(MAGPIE_DRAFT_MODEL_CONTROLS)
  const service = getService()
  assert.ok(service)
  assert.ok(adapter)
  await waitForCatalog(adapter)
  assert.deepEqual(service.describe(route), {
    speed: { options: ['standard', 'ultrafast'], value: 'standard' },
    contextWindow: { options: [narrowWindow, wideWindow], value: narrowWindow },
    efforts: ['high'],
  })
  for (const unsupported of [{ ...route, provider: 'different' }, { ...route, model: 'unknown' },
    { ...route, model: 'codex/gpt-6.2-astra' }, { ...route, model: 'absent' }]) {
    assert.deepEqual(service.describe(unsupported), {})
    assert.throws(() => service.validate({ ...unsupported, controls: { speed: 'standard' } }), { code: 'draft-model-controls-invalid' })
  }
  assert.throws(() => service.validate({ ...route, controls: { speed: 'fast' } }), { code: 'draft-model-controls-invalid' })
  assert.equal(sessionLookups, 0)
  assert.equal(existsSync(statePath), false)

  const sessionId = 'draft-session'
  const draft = { ...route, sessionId, controls: { speed: 'ultrafast' as const, contextWindow: wideWindow } }
  service.validate(draft)
  const agent: SessionControlsAgent = { id: sessionId, status: 'idle', session: { id: sessionId, header: {} },
    model: { current: () => ({ ...route, reasoningEffort: 'high' }) },
    runMaintenance: (task) => task(new AbortController().signal),
  }
  // Draft setup seeds the unpublished Session before Cordis dispatches startup.
  service.initialize(draft)
  await host.emit('agent/created', { agent, source: 'startup' })
  initiator = agent
  const prepared = await adapter.prepareCall(provider, model)
  assert.deepEqual(prepared.model.context, { contextWindow: wideWindow })
  assert.deepEqual(await finish(prepared.stream(request({ sessionId, reasoningEffort: 'high' }))), { kind: 'stop' })
  assert.equal(calls[0]?.body.service_tier, 'ultrafast')
  assert.deepEqual(calls[0]?.body.reasoning, { effort: 'high', summary: 'auto' })
  assert.equal(calls[0]?.body.max_output_tokens, wideDefault)

  const bound = boundRoutes.get(SESSION_CONTROLS_API)
  assert.ok(bound)
  const url = `http://localhost${SESSION_CONTROLS_API}`
  const getView = async () => (await (await bound.fetch(new Request(`${url}?${new URLSearchParams({ ...route, sessionId })}`))).json()).value
  assert.equal((await getView()).speed.value, 'ultrafast')
  assert.equal((await getView()).contextWindow.value, wideWindow)
  assert.equal(service.describe(route).contextWindow?.value, narrowWindow)
  const response = await bound.fetch(new Request(url, { method: 'POST', body: JSON.stringify({ ...route, sessionId, field: 'speed', value: 'standard' }) }))
  assert.equal(response.status, 200)
  const saved = readFileSync(statePath, 'utf8')
  service.initialize(draft)
  assert.equal(readFileSync(statePath, 'utf8'), saved)
  assert.throws(() => service.initialize({ ...draft, controls: { speed: 'standard' } }), { code: 'draft-model-controls-invalid' })

  await fiber.dispose()
  assert.equal(getService(), undefined)
  fiber = await host.plugin(plugin, { ...config, sessionSpeedEnabled: false })
  const reloaded = getService()
  assert.ok(reloaded)
  // The persisted receipt wins even if the next generation has not warmed up
  // or configuration no longer supports the originally submitted controls.
  reloaded.initialize(draft)
  assert.equal(readFileSync(statePath, 'utf8'), saved)
})

async function waitForCatalog(adapter: MagpieAdapter): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (adapter.listModels(provider).some(({ id }) => id === model)) return
    await setTimeout(10)
  }
  assert.fail('The test gateway catalog did not become visible')
}

for (const transport of transports) {
  test(`${transport.endpoint} serializes both controls independently`, async (t) => {
    const { baseUrl, calls } = await mockGateway(t)
    const cases: Array<{ label: string; controls: Controls; expectedTier?: string }> = [
      { label: 'both enabled', controls: { speed: 'fast', contextWindow: narrowWindow }, expectedTier: 'priority' },
      { label: 'only speed', controls: { speed: 'ultrafast' }, expectedTier: 'ultrafast' },
      { label: 'only context', controls: { contextWindow: narrowWindow } },
      { label: 'both disabled', controls: {} },
      { label: 'standard speed', controls: { speed: 'standard', contextWindow: wideWindow } },
    ]
    for (const { label, controls, expectedTier } of cases) {
      await t.test(label, async () => {
        const adapter = makeAdapter(baseUrl, transport, {
          resolveInitiatorSessionId: () => 'viewing-session',
          resolveSessionControls: (p, m, id) => p === provider && m === model && id === 'viewing-session' ? controls : {},
        })
        const expectedWindow = controls.contextWindow ?? catalogWindow
        const expectedDefault = controls.contextWindow === narrowWindow ? narrowDefault
          : controls.contextWindow === wideWindow ? wideDefault : catalogDefault
        const resolved = adapter.resolveModel(provider, model)
        assert.deepEqual(resolved.context, { contextWindow: expectedWindow })
        assert.equal(resolved.defaultMaxTokens, expectedDefault)
        const prepared = await adapter.prepareCall(provider, model)
        assert.deepEqual(prepared.model, resolved)
        assert.deepEqual(await finish(prepared.stream(request({ sessionId: 'viewing-session' }))), { kind: 'stop' })
        const call = calls.at(-1)!
        assert.equal(call.endpoint, transport.endpoint)
        assert.equal(call.headers['x-session-id'], 'viewing-session')
        assert.equal(call.body.model, model)
        assert.equal(call.body[transport.maxTokensField], expectedDefault)
        assert.equal(call.body.temperature, 0.3)
        assert.equal(Object.hasOwn(call.body, 'service_tier'), expectedTier !== undefined)
        assert.equal(call.body.service_tier, expectedTier)
        const effort = transport.endpoint === '/v1/responses'
          ? (call.body.reasoning as { effort: string }).effort : call.body.reasoning_effort
        assert.equal(effort, 'ultra')
      })
    }
    assert.equal(calls.length, cases.length)
  })
}

test('Group session controls reach Chat Completions with the selected model ID', async (t) => {
  const groupModel = 'group/gpt-6.2-sol-272k-ultrafast'
  const sessionId = 'group-session'
  const directory = mkdtempSync(join(tmpdir(), 'magpie-group-adapter-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const controls = new SessionControls({
    config: resolveConfig({ providerId: provider }),
    store: new SessionControlsStore(join(directory, 'controls.json')),
    agents: () => undefined,
    catalogEfforts: () => [],
    warn: (error) => { throw error },
  })
  const { baseUrl, calls } = await mockGateway(t)
  const adapter = makeAdapter(baseUrl, transports[1], {
    resolveInitiatorSessionId: () => sessionId,
    resolveSessionControls: controls.resolve.bind(controls),
  }, groupModel)
  const prepared = await adapter.prepareCall(provider, groupModel)
  assert.equal(prepared.model.context.contextWindow, narrowWindow)
  assert.deepEqual(await finish(prepared.stream(request({ model: groupModel, sessionId }))), { kind: 'stop' })
  assert.equal(calls[0]?.body.model, groupModel)
  assert.equal(calls[0]?.body.service_tier, 'ultrafast')
  assert.equal(calls[0]?.body.max_completion_tokens, narrowDefault)
})

test('reasoning choices intersect the directory in directory order for the exact route', async (t) => {
  const transport = transports[0]
  const { baseUrl, calls } = await mockGateway(t)
  let configured = ['high']
  const adapter = makeAdapter(baseUrl, transport, {
    resolveAllowedEfforts: (p, m) => p === provider && m === model ? configured : undefined,
  })
  const ladder = () => adapter.resolveModel(provider, model).reasoning
  assert.deepEqual(ladder()?.efforts.map(({ id }) => id), ['high'])
  assert.equal(ladder()?.defaultEffort, 'high')
  assert.equal(adapter.resolveModel('other-provider', model).reasoning?.defaultEffort, 'medium')

  const prepared = await adapter.prepareCall(provider, model)
  assert.deepEqual(prepared.model.reasoning, ladder())
  assert.deepEqual(await finish(prepared.stream(request({ reasoningEffort: prepared.model.reasoning?.defaultEffort }))), { kind: 'stop' })
  assert.equal((calls[0]?.body.reasoning as { effort: string }).effort, 'high')

  configured = ['ultra', 'medium', 'none']
  assert.deepEqual(ladder()?.efforts.map(({ id }) => id), ['medium', 'ultra'])
  assert.equal(ladder()?.defaultEffort, 'medium')
})

test('only prepared calls can retain an existing exact reasoning effort outside the choice list', async (t) => {
  const transport = transports[0]
  const { baseUrl, calls } = await mockGateway(t)
  let configured = ['high']
  let existing: string | undefined = 'medium'
  const adapter = makeAdapter(baseUrl, transport, {
    resolveAllowedEfforts: () => configured,
    resolveInitiatorReasoningEffort: (p, m) => p === provider && m === model ? existing : undefined,
  })
  assert.deepEqual(adapter.resolveModel(provider, model).reasoning?.efforts.map(({ id }) => id), ['high'])
  const prepared = await adapter.prepareCall(provider, model)
  assert.deepEqual(prepared.model.reasoning?.efforts.map(({ id }) => id), ['medium', 'high'])
  assert.equal(prepared.model.reasoning?.defaultEffort, 'high')

  configured = ['none']
  assert.equal(adapter.resolveModel(provider, model).reasoning, undefined)
  const disjoint = await adapter.prepareCall(provider, model)
  assert.deepEqual(disjoint.model.reasoning?.efforts.map(({ id }) => id), ['medium'])
  assert.equal(disjoint.model.reasoning?.defaultEffort, undefined)
  assert.deepEqual(await finish(disjoint.stream(request({ reasoningEffort: 'medium' }))), { kind: 'stop' })
  assert.equal((calls[0]?.body.reasoning as { effort: string }).effort, 'medium')

  existing = undefined
  assert.equal((await adapter.prepareCall(provider, model)).model.reasoning, undefined)
  existing = 'unsupported'
  assert.equal((await adapter.prepareCall(provider, model)).model.reasoning, undefined)
})

test('parallel prepared requests use their own initiator snapshot and local context window', async (t) => {
  const transport = transports[0]
  const { baseUrl, calls } = await mockGateway(t, { inputTokens: 300_000 })
  const initiator = new AsyncLocalStorage<string>()
  const left: Controls = { speed: 'fast', contextWindow: narrowWindow }
  const right: Controls = { speed: 'ultrafast', contextWindow: wideWindow }
  const resolutions: Array<string | undefined> = []
  const adapter = makeAdapter(baseUrl, transport, {
    resolveInitiatorSessionId: () => initiator.getStore(),
    resolveSessionControls: (_provider, _model, id) => {
      resolutions.push(id)
      return id === 'left' ? left : id === 'right' ? right : {}
    },
  })
  const prepare = (id: string) => initiator.run(id, async () => {
    await Promise.resolve()
    return adapter.prepareCall(provider, model)
  })
  const [leftCall, rightCall] = await Promise.all([prepare('left'), prepare('right')])
  assert.deepEqual(leftCall.model.context, { contextWindow: narrowWindow })
  assert.deepEqual(rightCall.model.context, { contextWindow: wideWindow })
  Object.assign(left, { speed: 'standard', contextWindow: wideWindow })
  Object.assign(right, { speed: 'standard', contextWindow: narrowWindow })

  const [leftFinish, rightFinish] = await initiator.run('outside', () => Promise.all([
    finish(leftCall.stream(request({ sessionId: 'left', maxTokens: leftCall.model.defaultMaxTokens }))),
    finish(rightCall.stream(request({ sessionId: 'right' }))),
  ]))
  assert.equal(leftFinish.kind, 'error')
  assert.equal(leftFinish.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.deepEqual(rightFinish, { kind: 'stop' })
  assert.deepEqual(resolutions, ['left', 'right'])
  assert.deepEqual(calls.map(({ headers, body }) => [
    headers['x-session-id'], body.service_tier, body[transport.maxTokensField],
  ]).sort(), [
    ['left', 'priority', narrowDefault],
    ['right', 'ultrafast', wideDefault],
  ])
})

test('a connection retry serializes the same request snapshot', async (t) => {
  const controls: Controls = { speed: 'fast', contextWindow: narrowWindow }
  const { baseUrl, calls } = await mockGateway(t, {
    failFirstRequest: () => Object.assign(controls, { speed: 'ultrafast', contextWindow: wideWindow }),
  })
  const transport = transports[0]
  const adapter = makeAdapter(baseUrl, transport, {
    maxRetries: 1,
    resolveInitiatorSessionId: () => 'session',
    resolveSessionControls: () => controls,
  })
  const prepared = await adapter.prepareCall(provider, model)
  assert.deepEqual(await finish(prepared.stream(request({ sessionId: 'session' }))), { kind: 'stop' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.body.service_tier, 'priority')
  assert.equal(calls[0]?.body[transport.maxTokensField], narrowDefault)
  assert.deepEqual(calls[0]?.body, calls[1]?.body)
})

test('compaction uses the explicit session window and preserves the gateway speed and helper maxTokens', async (t) => {
  const transport = transports[0]
  const { baseUrl, calls } = await mockGateway(t, { inputTokens: 300_000 })
  const initiator = new AsyncLocalStorage<string>()
  const resolutions: Array<string | undefined> = []
  const adapter = makeAdapter(baseUrl, transport, {
    resolveInitiatorSessionId: () => initiator.getStore(),
    resolveSessionControls: (_provider, _model, id) => {
      resolutions.push(id)
      if (id === 'child') return { speed: 'ultrafast', contextWindow: narrowWindow }
      if (id === 'parent') return { speed: 'standard', contextWindow: catalogWindow }
      return {}
    },
  })
  const helper = request({ sessionId: 'child', purpose: 'compaction', maxTokens: catalogDefault, reasoningEffort: undefined })
  const checkWindow = async (stream: AsyncIterable<HarnessChunk>) => {
    // The fixture reports 300K input, which only exceeds the child's window.
    const last = await finish(stream)
    assert.equal(last.kind, 'error')
    assert.equal(last.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  }
  for (const initiatorId of [undefined, 'parent', 'child']) {
    const prepared = await (initiatorId === undefined
      ? adapter.prepareCall(provider, model)
      : initiator.run(initiatorId, () => adapter.prepareCall(provider, model)))
    await checkWindow(prepared.stream(helper))
  }
  await initiator.run('parent', () => checkWindow(adapter.stream(helper)))
  assert.deepEqual(resolutions, [undefined, 'child', 'parent', 'child', 'child', 'child'])
  assert.equal(calls.length, 4)
  for (const { headers, body } of calls) {
    assert.equal(headers['x-session-id'], 'child')
    assert.equal(headers['x-deepseek-harness-compact'], '1')
    assert.equal(Object.hasOwn(body, 'service_tier'), false)
    assert.equal(body[transport.maxTokensField], catalogDefault)
    assert.equal(Object.hasOwn(body, 'reasoning'), false)
  }
})
