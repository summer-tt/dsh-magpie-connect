import { AsyncLocalStorage } from 'node:async_hooks'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import test, { type TestContext } from 'node:test'

import { decodeMagpieModels, ModelCatalog } from '../src/adapter/catalog.ts'
import type { HarnessChunk } from '../src/adapter/events.ts'
import { MagpieAdapter, type MagpieAdapterOptions } from '../src/adapter/magpie-adapter.ts'
import type { HarnessGenerateOptions } from '../src/adapter/messages.ts'

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

async function mockGateway(t: TestContext, { inputTokens = 10, failFirstRequest }: {
  inputTokens?: number
  failFirstRequest?: () => void
} = {}) {
  const calls: RequestSeen[] = []
  const server = createServer(async (request, response) => {
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

function makeAdapter(baseUrl: string, transport: Transport, options: MagpieAdapterOptions) {
  const catalog = new ModelCatalog({ baseUrl })
  catalog.adoptDirectory(decodeMagpieModels({ data: [{
    id: model,
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
