import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  apiOfPath,
  decodeMagpieModels,
  ModelCatalog,
  modelApiForEntry,
  staticMagpieModels,
  type EndpointApi,
} from '../src/adapter/catalog.ts'
import { MagpieAdapter } from '../src/adapter/magpie-adapter.ts'
import type { PiEvent } from '../src/adapter/events.ts'
import type { HarnessChunk } from '../src/adapter/events.ts'
import type { HarnessGenerateOptions, HarnessMessage } from '../src/adapter/messages.ts'

/**
 * Protocol choice from the gateway's ordinary `GET /models`.
 *
 * The plugin speaks two protocols only — Chat Completions and Responses —
 * and the request model id never changes: the choice is which wire a turn
 * rides, decided per model from `native_endpoints` (what the gateway relays
 * as-is) and `magpie_prefers` (where the gateway says it is best asked).
 */

const CHAT = '/v1/chat/completions'
const RESPONSES = '/v1/responses'
const MESSAGES = '/v1/messages'

function entry(id: string, nativeEndpoints: string[], prefers?: unknown) {
  return { id, display_name: id, native_endpoints: nativeEndpoints, ...(prefers === undefined ? {} : { magpie_prefers: prefers }) }
}

// --- pure choice -------------------------------------------------------------

test('one supported native endpoint is used directly, preference notwithstanding', () => {
  assert.equal(modelApiForEntry([RESPONSES]), 'openai-responses')
  assert.equal(modelApiForEntry([CHAT]), 'openai-completions')
  // The single endpoint wins: a preference naming the other wire is not adopted.
  assert.equal(modelApiForEntry([RESPONSES], RESPONSES), 'openai-responses')
  assert.equal(modelApiForEntry([RESPONSES], CHAT), 'openai-responses')
  assert.equal(modelApiForEntry([CHAT], RESPONSES), 'openai-completions')
  // A wire the plugin does not speak next to a supported one changes nothing.
  assert.equal(modelApiForEntry([RESPONSES, MESSAGES], MESSAGES), 'openai-responses')
})

test('several supported native endpoints: the preference must be supported and listed', () => {
  const both = [CHAT, RESPONSES]
  assert.equal(modelApiForEntry(both, RESPONSES), 'openai-responses', 'a listed preference is adopted')
  assert.equal(modelApiForEntry(both, CHAT), 'openai-completions')
  // Not in the native list: the existing Chat-first rule stays.
  assert.equal(modelApiForEntry(both, MESSAGES), 'openai-completions', 'messages is listed but not supported')
  assert.equal(modelApiForEntry(both, undefined), 'openai-completions', 'missing preference keeps Chat first')
})

test('unsupported preference values fall back to Chat, never to an error', () => {
  const both = [CHAT, RESPONSES]
  for (const bogus of ['bogus', '', 42, null, 'responses', '/V1/RESPONSES']) {
    assert.equal(modelApiForEntry(both, bogus as string), 'openai-completions', String(bogus))
  }
})

test('with several wires the preference must be the gateway\'s own listed path', () => {
  const both = [CHAT, RESPONSES]
  // `/v2/responses` names a wire that is listed, but it is not a path the
  // gateway listed: what it said it prefers is a path, and this is not it.
  assert.equal(modelApiForEntry(both, '/v2/responses'), 'openai-completions')
  assert.equal(modelApiForEntry(both, '/api/v1/responses'), 'openai-completions')
  assert.equal(modelApiForEntry([...both, '/v2/responses'], '/v2/responses'), 'openai-responses', 'listed, so it is adopted')
})

test('an empty or missing native list may adopt either supported preference', () => {
  assert.equal(modelApiForEntry([], RESPONSES), 'openai-responses')
  assert.equal(modelApiForEntry([], CHAT), 'openai-completions')
  assert.equal(modelApiForEntry([], MESSAGES), 'openai-completions', 'unsupported → Chat')
  assert.equal(modelApiForEntry([], 'bogus'), 'openai-completions')
  assert.equal(modelApiForEntry([], undefined), 'openai-completions')
})

test('a list naming nothing the plugin supports stays on Chat, whatever the preference', () => {
  // Only the Anthropic wire is native. The gateway translates whatever the
  // plugin sends, and before the preference existed such a model went to Chat
  // whatever its id said — a preference naming an unlisted wire changes none
  // of that.
  assert.equal(modelApiForEntry([MESSAGES], RESPONSES), 'openai-completions')
  assert.equal(modelApiForEntry([MESSAGES], undefined), 'openai-completions')
  assert.equal(modelApiForEntry([MESSAGES], MESSAGES), 'openai-completions')
})

test('a path is matched by whole segment, never by substring', () => {
  assert.equal(apiOfPath('/v1/chat/completions'), 'openai-completions')
  assert.equal(apiOfPath('/v1/responses'), 'openai-responses')
  assert.equal(apiOfPath('/api/v2/v1/responses'), 'openai-responses', 'a prefixed gateway path still names the wire')
  for (const lookalike of ['/v1/responses/compact', '/v1/responses/input_tokens', '/v1/chat/completionsx', '/v1/xresponses', '/v1/messages']) {
    assert.equal(apiOfPath(lookalike), undefined, lookalike)
  }
  // A lookalike is "nothing supported": alone it leaves the turn on Chat,
  // and beside a real wire it does not turn one endpoint into several.
  assert.equal(modelApiForEntry(['/v1/responses/compact'], RESPONSES), 'openai-completions')
  assert.equal(modelApiForEntry(['/v1/responses', '/v1/responses/compact']), 'openai-responses')
  assert.equal(modelApiForEntry([CHAT, '/v1/responses/compact'], RESPONSES), 'openai-completions')
})

test('the plugin never sends the drawers header when it reads the directory', async () => {
  const seen: Array<Record<string, string>> = []
  const spy = (async (_url: string | URL, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>)
    return new Response(JSON.stringify({ data: [entry('m', [CHAT])] }), { status: 200 })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl: spy, baseUrl: 'http://gw.lan/v1', apiKey: 'k' })
  try {
    await catalog.refreshOnce()
    assert.equal(seen.length, 1)
    assert.equal(Object.keys(seen[0]!).some((name) => /x-magpie/i.test(name)), false)
  } finally {
    catalog.stop()
  }
})

// --- decoding + catalog -------------------------------------------------------

test('decodeModel keeps a readable magpie_prefers path and drops anything else', () => {
  const models = decodeMagpieModels({ data: [
    entry('path', [CHAT, RESPONSES], RESPONSES),
    entry('bare-name', [CHAT, RESPONSES], 'responses'),
    entry('number', [CHAT, RESPONSES], 7),
    entry('blank', [CHAT, RESPONSES], '  '),
    entry('lookalike', [CHAT, RESPONSES], '/v1/responses/compact'),
    entry('absent', [CHAT]),
  ] })
  assert.equal(models.get('path')?.prefers, RESPONSES)
  for (const id of ['bare-name', 'number', 'blank', 'lookalike', 'absent']) {
    assert.equal(models.get(id)?.prefers, undefined, id)
  }
  // A dropped value must not turn the wire: two supported endpoints, no
  // readable preference → Chat first.
  assert.equal(modelApiForEntry(models.get('bare-name')!.nativeEndpoints, models.get('bare-name')?.prefers), 'openai-completions')
})

test('ModelCatalog resolves the wire per model from native endpoints and the preference', async () => {
  const catalog = new ModelCatalog({
    fetchImpl: (async () => new Response(JSON.stringify({ data: [
      entry('only-responses', [RESPONSES]),
      entry('only-chat', [CHAT]),
      entry('both-prefers-responses', [CHAT, RESPONSES], RESPONSES),
      entry('both-prefers-chat', [CHAT, RESPONSES], CHAT),
      entry('both-no-prefers', [CHAT, RESPONSES]),
      entry('none-prefers-responses', [], RESPONSES),
      entry('messages-only', [MESSAGES]),
      entry('messages-only-codex-like', [MESSAGES]),
    ] }))) as typeof fetch,
    baseUrl: 'http://gw.lan/v1',
    apiKey: 'k',
  })
  try {
    await catalog.refreshOnce()
    const api = (id: string): EndpointApi => catalog.apiFor(id)
    assert.equal(api('only-responses'), 'openai-responses')
    assert.equal(api('only-chat'), 'openai-completions')
    assert.equal(api('both-prefers-responses'), 'openai-responses')
    assert.equal(api('both-prefers-chat'), 'openai-completions')
    assert.equal(api('both-no-prefers'), 'openai-completions')
    assert.equal(api('none-prefers-responses'), 'openai-responses')
    assert.equal(api('messages-only'), 'openai-completions')
    // A listed model is never guessed at from its id: the compat heuristic is
    // for unknown ids only.
    assert.equal(api('messages-only-codex-like'), 'openai-completions')
    // requiresResponsesApi reads the same decision.
    assert.equal(catalog.requiresResponsesApi('both-prefers-responses'), true)
    assert.equal(catalog.requiresResponsesApi('messages-only-codex-like'), false)
    // The id itself is untouched by any of this.
    assert.deepEqual(catalog.list(), [
      'both-no-prefers',
      'both-prefers-chat',
      'both-prefers-responses',
      'messages-only',
      'messages-only-codex-like',
      'none-prefers-responses',
      'only-chat',
      'only-responses',
    ])
  } finally {
    catalog.stop()
  }
})

test('the static snapshot and an unknown model keep today\'s behaviour', () => {
  const catalog = new ModelCatalog({ baseUrl: 'http://gw.lan/v1', apiKey: 'k' })
  // Dispatch reads the live/cached directory only: with none loaded, every
  // id — snapshot or unknown — is sent on Chat, as before.
  for (const seed of staticMagpieModels) {
    assert.equal(catalog.apiFor(seed.id), 'openai-completions', `${seed.id}: no directory row`)
    assert.equal(seed.prefers, undefined, `${seed.id}: the snapshot predates the preference`)
  }
  assert.equal(catalog.apiFor('codex/some-unlisted-model'), 'openai-completions')
  // The capability hint reads the directory and the snapshot, and keeps its
  // own heuristic for unknown ids; it is not a dispatch rule.
  assert.equal(catalog.requiresResponsesApi('codex/gpt-5.6-terra'), true)
  assert.equal(catalog.requiresResponsesApi('vercel/openai/gpt-4.1'), false)
  assert.equal(catalog.requiresResponsesApi('codex/some-unlisted-model'), true)
  assert.equal(catalog.requiresResponsesApi('unknown/thing'), false)
})

test('a change of only the preference is announced to the picker', async () => {
  let prefers: string | undefined
  const announced: string[] = []
  const catalog = new ModelCatalog({
    fetchImpl: (async () => new Response(JSON.stringify({ data: [entry('m', [CHAT, RESPONSES], prefers)] }))) as typeof fetch,
    baseUrl: 'http://gw.lan/v1',
    apiKey: 'k',
    refreshSeconds: 3600,
    onInvalidate: () => announced.push('invalidate'),
  })
  try {
    await catalog.refreshOnce()
    assert.equal(announced.length, 1, 'first fill announces')
    prefers = RESPONSES
    await catalog.refreshOnce()
    assert.equal(announced.length, 2, 'a moved wire is a changed exposed set')
    assert.equal(catalog.apiFor('m'), 'openai-responses')
  } finally {
    catalog.stop()
  }
})

// --- cache -------------------------------------------------------------------

test('a cache written before the preference existed is restored and serves Chat until a refresh', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'magpie-prefers-cache-'))
  const cachePath = join(dir, 'magpie-models.json')
  try {
    // v3 shape: `prefers` did not exist. The entry is otherwise complete, so
    // ids, labels and capabilities must survive untouched.
    writeFileSync(cachePath, JSON.stringify({
      version: 3,
      updatedAt: Date.now(),
      entries: [{ id: 'm', displayName: 'M/m', image: false, nativeEndpoints: [CHAT, RESPONSES], reasoning: false }],
    }))
    const fail = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const catalog = new ModelCatalog({ fetchImpl: fail, baseUrl: 'http://gw.lan/v1', apiKey: 'k', cachePath })
    await catalog.refreshOnce()
    assert.equal(catalog.getEntry('m')?.displayName, 'M/m', 'a v3 label is recomputable, so it is kept')
    assert.equal(catalog.apiFor('m'), 'openai-completions', 'no preference known → Chat first')
    catalog.stop()

    const live = new ModelCatalog({
      fetchImpl: (async () => new Response(JSON.stringify({ data: [entry('m', [CHAT, RESPONSES], RESPONSES)] }))) as typeof fetch,
      baseUrl: 'http://gw.lan/v1',
      apiKey: 'k',
      cachePath,
    })
    await live.refreshOnce()
    assert.equal(live.apiFor('m'), 'openai-responses')
    const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as { version: number; entries: Array<{ prefers?: string }> }
    assert.ok(saved.version > 3, 'the cache schema is versioned past the pre-preference shape')
    assert.equal(saved.entries[0]?.prefers, RESPONSES, 'the preference persists')
    live.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- adapter: the real stream path against a real HTTP server ----------------

interface Wire {
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A gateway stand-in recording every inference request, answering both wires. */
async function listenGateway(): Promise<{ origin: string; wires: Wire[]; close(): Promise<void> }> {
  const wires: Wire[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) headers[name] = String(value)
      wires.push({ path: request.url ?? '', headers, body: raw === '' ? {} : JSON.parse(raw) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if ((request.url ?? '').endsWith('/chat/completions')) {
        response.end([
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
        return
      }
      // A faithful Responses stream: the item slot has to exist before its
      // deltas, and the terminal event has to carry the response.
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] }
      const completed = {
        type: 'response.completed',
        response: {
          id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: 'm',
          output: [{ ...item, status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        },
      }
      response.end([
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', object: 'response', created_at: 1, status: 'in_progress', model: 'm', output: [] } })}`,
        '',
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}`,
        '',
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi', item_id: 'msg_1', output_index: 0, content_index: 0, sequence_number: 1 })}`,
        '',
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: completed.response.output[0] })}`,
        '',
        `event: response.completed\ndata: ${JSON.stringify(completed)}`,
        '',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}/v1`,
    wires,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function wireMessages(turns: Array<'user' | 'assistant'>, toolCall = false): HarnessMessage[] {
  return turns.map((role) => (role === 'user'
    ? { role: 'user', content: [{ type: 'text', text: 'ping' }] }
    : {
        role: 'assistant',
        source: { kind: 'model', provider: 'dsh-magpie-connect', model: 'm' },
        content: [
          { type: 'reasoning', text: 'let me think' },
          { type: 'text', text: 'pong' },
          ...(toolCall ? [{ type: 'tool-call', id: 'call_1', name: 'tool', arguments: '{"a":1}' }] : []),
        ],
      })) as HarnessMessage[]
}

async function streamOnce(adapter: MagpieAdapter, options: Partial<HarnessGenerateOptions>): Promise<HarnessChunk[]> {
  const full: HarnessGenerateOptions = { provider: 'dsh-magpie-connect', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], ...options }
  const call = await adapter.prepareCall('dsh-magpie-connect', full.model)
  const chunks: HarnessChunk[] = []
  for await (const chunk of call.stream(full)) chunks.push(chunk)
  return chunks
}

function adapterOver(catalog: ModelCatalog, origin: string): MagpieAdapter {
  return new MagpieAdapter(catalog, { magpieBaseUrl: origin, apiKey: 'not-needed', firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000 })
}

function catalogWith(data: unknown): ModelCatalog {
  const catalog = new ModelCatalog({ baseUrl: 'http://gw.lan/v1', apiKey: 'k' })
  catalog.adoptDirectory(decodeMagpieModels(data))
  return catalog
}

test('the adapter streams on the wire the directory chose, with the id and the gateway untouched', async (t) => {
  const gateway = await listenGateway()
  try {
    const cases: Array<{ name: string; row: Record<string, unknown>; wire: string }> = [
      { name: 'responses only', row: entry('m', [RESPONSES]), wire: '/v1/responses' },
      { name: 'chat only', row: entry('m', [CHAT]), wire: '/v1/chat/completions' },
      { name: 'both, prefers responses', row: entry('m', [CHAT, RESPONSES], RESPONSES), wire: '/v1/responses' },
      { name: 'both, prefers chat', row: entry('m', [CHAT, RESPONSES], CHAT), wire: '/v1/chat/completions' },
      { name: 'both, no preference', row: entry('m', [CHAT, RESPONSES]), wire: '/v1/chat/completions' },
      { name: 'both, prefers an unlisted wire', row: entry('m', [CHAT, RESPONSES], '/v2/responses'), wire: '/v1/chat/completions' },
      { name: 'none listed, prefers responses', row: entry('m', [], RESPONSES), wire: '/v1/responses' },
    ]
    for (const { name, row, wire } of cases) {
      await t.test(name, async () => {
        gateway.wires.length = 0
        const adapter = adapterOver(catalogWith({ data: [row] }), gateway.origin)
        const resolved = adapter.resolveModel('dsh-magpie-connect', 'm')
        assert.equal(resolved.id, 'm', 'the request id is never rewritten')
        const chunks = await streamOnce(adapter, {})
        const finish = chunks.find((chunk) => chunk.type === 'finish')
        assert.deepEqual(finish && (finish as { reason: unknown }).reason, { kind: 'stop' })
        assert.equal(gateway.wires.length, 1)
        assert.equal(gateway.wires[0]?.path, wire)
        assert.equal((gateway.wires[0]?.body as { model: string }).model, 'm')
        // The plugin names itself the way it always did; nothing else is asked
        // of the gateway and no drawer view is requested.
        assert.match(gateway.wires[0]?.headers['user-agent'] ?? '', /^deepseek-harness\//)
        assert.equal(Object.keys(gateway.wires[0]?.headers ?? {}).some((header) => /x-magpie/i.test(header)), false)
      })
    }
  } finally {
    await gateway.close()
  }
})

test('an id the directory does not list is still sent on Chat, whatever its name', async () => {
  // Before the preference existed, an unlisted `codex/…` id was sent to chat
  // completions (the id heuristic only informed the picker's image default).
  // The preference must not turn that heuristic into a dispatch rule.
  const gateway = await listenGateway()
  try {
    const catalog = new ModelCatalog({ baseUrl: gateway.origin, apiKey: 'k' })
    for (const id of ['codex/some-unlisted-model', 'copilot/grok-9-unlisted', 'auto/gpt-6-luna']) {
      gateway.wires.length = 0
      const adapter = new MagpieAdapter(catalog, { magpieBaseUrl: gateway.origin, apiKey: 'not-needed', firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000 })
      const chunks = await streamOnce(adapter, { model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] })
      const finish = chunks.find((chunk) => chunk.type === 'finish')
      assert.deepEqual(finish && (finish as { reason: unknown }).reason, { kind: 'stop' }, id)
      assert.equal(gateway.wires[0]?.path, '/v1/chat/completions', id)
      assert.equal((gateway.wires[0]?.body as { model: string }).model, id, 'the id is sent verbatim')
    }
  } finally {
    await gateway.close()
  }
})

test('a model only the static snapshot knows is sent on Chat, as before', async () => {
  // Requests have always been decided from the live/cached directory alone
  // (`getEntry`); the built-in snapshot was never a source for what is sent.
  // It predates the preference and may be stale, so this change keeps that:
  // a Responses-only snapshot row still goes to Chat while the gateway is
  // unreachable — and the capability hint still reads the snapshot, as it
  // always did. The two were never equivalent and are asserted separately.
  const gateway = await listenGateway()
  try {
    const catalog = new ModelCatalog({ baseUrl: gateway.origin, apiKey: 'k' })
    const id = 'opencode-zen/muse-spark-1.3-contributor-free'
    assert.equal(catalog.requiresResponsesApi(id), true, 'capability hint reads the snapshot')
    assert.equal(catalog.apiFor(id), 'openai-completions', 'dispatch reads the directory only')
    const adapter = new MagpieAdapter(catalog, { magpieBaseUrl: gateway.origin, apiKey: 'not-needed', firstEventTimeoutMs: 10_000, idleTimeoutMs: 10_000 })
    const chunks = await streamOnce(adapter, { model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] })
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish') && (chunks.find((chunk) => chunk.type === 'finish') as { reason: unknown }).reason, { kind: 'stop' })
    assert.equal(gateway.wires[0]?.path, '/v1/chat/completions')
    assert.equal((gateway.wires[0]?.body as { model: string }).model, id, 'the id is sent verbatim')
  } finally {
    await gateway.close()
  }
})

test('once the directory lists the model, its row decides the wire', async () => {
  // The same id, now read from the gateway: the row (not the snapshot, not
  // the id) says Responses, and the preference can move it when both wires
  // are listed.
  const gateway = await listenGateway()
  try {
    const id = 'opencode-zen/muse-spark-1.3-contributor-free'
    for (const [row, wire] of [
      [entry(id, [RESPONSES]), '/v1/responses'],
      [entry(id, [CHAT, RESPONSES], RESPONSES), '/v1/responses'],
      [entry(id, [CHAT, RESPONSES], CHAT), '/v1/chat/completions'],
    ] as const) {
      gateway.wires.length = 0
      const adapter = adapterOver(catalogWith({ data: [row] }), gateway.origin)
      const chunks = await streamOnce(adapter, { model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] })
      assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish') && (chunks.find((chunk) => chunk.type === 'finish') as { reason: unknown }).reason, { kind: 'stop' })
      assert.equal(gateway.wires[0]?.path, wire)
    }
  } finally {
    await gateway.close()
  }
})

test('assistant history is tagged with the same wire the turn rides', async (t) => {
  const gateway = await listenGateway()
  try {
    const both: Array<{ name: string; prefers?: string; wire: string }> = [
      { name: 'responses', prefers: RESPONSES, wire: '/v1/responses' },
      { name: 'chat', prefers: CHAT, wire: '/v1/chat/completions' },
    ]
    for (const { name, prefers, wire } of both) {
      await t.test(name, async () => {
        gateway.wires.length = 0
        const adapter = adapterOver(catalogWith({ data: [entry('m', [CHAT, RESPONSES], prefers)] }), gateway.origin)
        const chunks = await streamOnce(adapter, { messages: [...wireMessages(['user', 'assistant'], true), ...wireMessages(['user'])] })
        const finish = chunks.find((chunk) => chunk.type === 'finish')
        assert.deepEqual(finish && (finish as { reason: unknown }).reason, { kind: 'stop' })
        assert.equal(gateway.wires[0]?.path, wire)
        // The request went out on one wire only: a history serialised for
        // the other wire could not have been understood by this endpoint.
        const body = gateway.wires[0]?.body as Record<string, unknown>
        const onResponses = wire.endsWith('/responses')
        assert.equal(Array.isArray(body.input), onResponses, 'Responses carries `input`')
        assert.equal(Array.isArray(body.messages), !onResponses, 'Chat Completions carries `messages`')
        // The past turn's tool call id survives on both wires.
        assert.equal(JSON.stringify(body).includes('call_1'), true)
      })
    }
  } finally {
    await gateway.close()
  }
})

test('the outbound model and the history carry one and the same api', async () => {
  // Observed where pi-ai reads it: the `model.api` the provider is called
  // with decides the endpoint, and every assistant history message's `api`
  // is what it serialises that turn for. They must be equal, per turn.
  const gateway = await listenGateway()
  try {
    for (const prefers of [RESPONSES, CHAT]) {
      const catalog = catalogWith({ data: [entry('m', [CHAT, RESPONSES], prefers)] })
      const seen: Array<{ model: { api: string }; history: string[] }> = []
      const provider = {
        stream: (model: { api: string }, context: { messages: Array<{ role: string; api?: string }> }) => {
          seen.push({ model, history: context.messages.filter((message) => message.role === 'assistant').map((message) => message.api ?? '') })
          return (async function* () {
            yield { type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], api: model.api, provider: 'dsh-magpie-connect', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 } } as PiEvent
          })()
        },
        streamSimple: () => {
          throw new Error('the adapter dispatches through provider.stream')
        },
      }
      const adapter = new MagpieAdapter(catalog, { magpieBaseUrl: gateway.origin, apiKey: 'not-needed', providerOverride: provider })
      await streamOnce(adapter, { messages: wireMessages(['user', 'assistant', 'assistant', 'user']) })
      const expected = catalog.apiFor('m')
      assert.equal(seen.length, 1)
      assert.equal(seen[0]?.model.api, expected)
      assert.deepEqual(seen[0]?.history, [expected, expected])
    }
  } finally {
    await gateway.close()
  }
})

test('a tool call and its result pair up on both wires', async () => {
  const gateway = await listenGateway()
  try {
    for (const prefers of [RESPONSES, CHAT]) {
      gateway.wires.length = 0
      const adapter = adapterOver(catalogWith({ data: [entry('m', [CHAT, RESPONSES], prefers)] }), gateway.origin)
      const messages = [...wireMessages(['user', 'assistant'], true), { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] } as HarnessMessage]
      const chunks = await streamOnce(adapter, { messages })
      const finish = chunks.find((chunk) => chunk.type === 'finish')
      assert.deepEqual(finish && (finish as { reason: unknown }).reason, { kind: 'stop' })
      assert.equal(JSON.stringify(gateway.wires[0]?.body).includes('call_1'), true)
    }
  } finally {
    await gateway.close()
  }
})
