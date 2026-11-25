import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { Config, resolveConfig, type DshMagpieConnectConfig } from '../src/config.ts'
import { __resetSettingsRoutes, apply, SESSION_CONTROLS_API, type PluginContext } from '../src/index.ts'
import type { MagpieAdapter } from '../src/adapter/magpie-adapter.ts'
import {
  SessionControls,
  SessionControlsStore,
  handleSessionControls,
  type SessionControlsAgent,
  type SessionControlsCreated,
  type SessionModelSelection,
} from '../src/session-controls.ts'

const sol = { provider: 'magpie', model: 'codex/gpt-6.2-sol' }
const astra = { provider: 'magpie', model: 'codex/gpt-6.2-astra' }
const other = { provider: 'magpie', model: 'codex/gpt-6.2-sol-fast' }

type Route = typeof sol

interface StubAgent extends SessionControlsAgent {
  status: SessionControlsAgent['status']
  selected: SessionModelSelection
  active?: Route
  busy: boolean
  runMaintenance: NonNullable<SessionControlsAgent['runMaintenance']>
}

function stubAgent(id: string, route: Route = sol, parent?: string): StubAgent {
  const agent: StubAgent = {
    id,
    status: 'idle' as SessionControlsAgent['status'],
    selected: route,
    active: undefined as Route | undefined,
    busy: false,
    session: {
      id,
      header: parent ? { parentSession: parent, origin: 'subagent' } : {},
      requestHeader: () => agent.active && { config: agent.active },
    },
    model: { current: () => agent.selected },
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (agent.busy || agent.status !== 'idle') throw new Error('active work')
      return job(new AbortController().signal)
    },
  }
  return agent
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: release }
}

function statePath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-session-controls-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'session-controls.json')
}

function fixture(path: string, config: DshMagpieConnectConfig = {}, agents = new Map<string, SessionControlsAgent>()) {
  const store = new SessionControlsStore(path)
  const warnings: unknown[] = []
  const controls = new SessionControls({
    config: resolveConfig({ providerId: 'magpie', ...config }),
    store,
    agents: () => agents,
    catalogEfforts: () => ['low', 'medium', 'high'],
    warn: (error) => warnings.push(error),
  })
  return { store, agents, controls, warnings }
}

function add(f: ReturnType<typeof fixture>, agent: SessionControlsAgent, source: SessionControlsCreated['source'] = 'startup'): void {
  f.agents.set(agent.id, agent)
  f.controls.onCreated({ agent, source })
}

function getRequest(sessionId: string, route: Route = sol): Request {
  const query = new URLSearchParams({ sessionId, ...route })
  return new Request(`http://localhost${SESSION_CONTROLS_API}?${query}`)
}

function postRequest(sessionId: string, field: string, value: unknown, route: Route = sol, signal?: AbortSignal): Request {
  return new Request(`http://localhost${SESSION_CONTROLS_API}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...route, field, value }), signal,
  })
}

function send(f: ReturnType<typeof fixture>, request: Request): Promise<Response> {
  return handleSessionControls(request, () => f.controls, (error) => f.warnings.push(error))
}

function selection(f: ReturnType<typeof fixture>, sessionId: string, route: Route = sol) {
  return f.controls.resolve(route.provider, route.model, sessionId)
}

const defaultChoice = { speed: 'fast', contextWindow: 500_000 }

test('config enables the GPT-6.2 routes and validates custom options', () => {
  const cfg = resolveConfig({ providerId: 'magpie' })
  assert.equal(cfg.sessionSpeedEnabled, true)
  assert.equal(cfg.sessionContextWindowEnabled, true)
  assert.ok(cfg.sessionControlRoutes.some(({ provider, model }) => provider === sol.provider && model === sol.model))
  assert.ok(cfg.sessionControlRoutes.some(({ provider, model }) => provider === astra.provider && model === astra.model))
  assert.deepEqual(resolveConfig({ sessionControlRoutes: [] }).sessionControlRoutes, [])
  const validate = Config['~standard'].validate
  assert.deepEqual(validate({ sessionSpeedEnabled: false, apiKey: 'unchanged' }), { value: { sessionSpeedEnabled: false, apiKey: 'unchanged' } })
  const issue = (value: unknown): string => {
    const result = validate(value)
    return 'issues' in result ? result.issues[0]?.message ?? '' : ''
  }
  assert.match(issue({ sessionSpeedEnabled: 'false' }), /boolean/)
  assert.match(issue({ sessionControlRoutes: [sol, sol] }), /duplicates/)
  assert.match(issue({ sessionControlRoutes: [{ ...sol, contextWindow: { options: [1.5], default: 1.5 } }] }), /positive integer/)
  assert.match(issue({ sessionControlRoutes: [{ ...sol, speed: { options: ['fast'], default: 'standard' } }] }), /included/)
})

test('GPT-6.2 Group routes expose and save controls under their exact model IDs', async (t) => {
  const f = fixture(statePath(t))
  const variants = [
    { suffix: '', speed: 'fast', window: 500_000 },
    { suffix: '-272k', speed: 'standard', window: 272_000 },
    { suffix: '-500k-ultrafast', speed: 'ultrafast', window: 500_000 },
    { suffix: '-872k-fast', speed: 'fast', window: 872_000 },
  ]
  for (const family of ['sol', 'astra']) {
    for (const { suffix, speed, window } of variants) {
      const model = `group/gpt-6.2-${family}${suffix}`
      const route = { provider: 'magpie', model }
      add(f, stubAgent(model, route))
      const response = await send(f, getRequest(model, route))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true, value: {
        speed: { options: ['standard', 'fast', 'ultrafast'], value: speed },
        contextWindow: { options: [272_000, 500_000, 872_000], value: window },
      } })
      assert.equal((await send(f, postRequest(model, 'speed', 'ultrafast', route))).status, 200)
      assert.equal((await send(f, postRequest(model, 'contextWindow', 872_000, route))).status, 200)
      assert.deepEqual(selection(f, model, route), { speed: 'ultrafast', contextWindow: 872_000 })
    }
  }
  const route = { provider: 'magpie', model: 'group/gpt-6.2-sol-500k-ultrafast' }
  assert.deepEqual(selection(fixture(statePath(t), { sessionControlRoutes: [] }), route.model, route), {})
  assert.deepEqual(selection(f, 'unrelated', { provider: 'magpie', model: 'group/gpt-6.2-sol-preview' }), {})
})

test('GET loads options without updating recency and models/sessions keep separate snapshots', async (t) => {
  const path = statePath(t)
  const f = fixture(path)
  assert.deepEqual(f.controls.resolve(sol.provider, sol.model), {})
  assert.deepEqual(selection(f, 'never', other), {})
  assert.equal(existsSync(path), false)
  add(f, stubAgent('first'))
  add(f, stubAgent('second'))
  const save = await send(f, postRequest('first', 'speed', 'standard'))
  assert.equal(save.status, 200)
  assert.deepEqual(await save.json(), {
    ok: true,
    value: {
      speed: { options: ['standard', 'fast', 'ultrafast'], value: 'standard' },
      contextWindow: { options: [272_000, 500_000, 872_000], value: 500_000 },
    },
  })
  assert.deepEqual(selection(f, 'second'), defaultChoice)
  assert.equal((await send(f, getRequest('second'))).status, 200)
  add(f, stubAgent('third'))
  assert.deepEqual(selection(f, 'third'), { ...defaultChoice, speed: 'standard' })

  const fourth = stubAgent('fourth', astra)
  add(f, fourth)
  assert.deepEqual(selection(f, 'fourth', astra), defaultChoice)
  assert.equal((await send(f, postRequest('fourth', 'contextWindow', 872_000, astra))).status, 200)
  fourth.selected = sol
  assert.deepEqual(selection(f, 'fourth'), { ...defaultChoice, speed: 'standard' })
  fourth.selected = astra
  assert.deepEqual(selection(f, 'fourth', astra), { ...defaultChoice, contextWindow: 872_000 })
  add(f, stubAgent('unsupported', other))
  assert.deepEqual(await (await send(f, getRequest('unsupported', other))).json(), { ok: true, value: {} })
})

test('fresh and fork children capture the parent step’s actual route only once', async (t) => {
  const path = statePath(t)
  const f = fixture(path)
  const parent = stubAgent('parent')
  add(f, parent)
  add(f, stubAgent('recency'))
  add(f, stubAgent('astraRecency', astra))
  assert.equal((await send(f, postRequest('parent', 'speed', 'standard'))).status, 200)
  assert.equal((await send(f, postRequest('recency', 'speed', 'ultrafast'))).status, 200)
  assert.equal((await send(f, postRequest('astraRecency', 'contextWindow', 272_000, astra))).status, 200)

  parent.status = 'running'
  f.controls.observeStep(parent, sol)
  parent.active = astra
  parent.selected = astra
  const fresh = stubAgent('fresh', sol, parent.id)
  const fork = { ...stubAgent('fork', sol, parent.id), options: astra }
  const split = stubAgent('split', astra, parent.id)
  add(f, fresh)
  add(f, fork)
  add(f, split)
  assert.deepEqual(selection(f, 'fresh'), { ...defaultChoice, speed: 'standard' })
  assert.deepEqual(selection(f, 'fork'), { ...defaultChoice, speed: 'standard' })
  assert.deepEqual(selection(f, 'split', astra), { ...defaultChoice, contextWindow: 272_000 })
  const restarted = fixture(path, {}, f.agents)
  parent.active = sol
  add(restarted, stubAgent('late-install', sol, parent.id))
  assert.deepEqual(selection(restarted, 'late-install'), { ...defaultChoice, speed: 'standard' })

  parent.status = 'idle'
  parent.selected = sol
  assert.equal((await send(restarted, postRequest('parent', 'speed', 'fast'))).status, 200)
  for (const source of ['resume', 'clear', 'compact'] as const) {
    add(restarted, fresh, source)
    add(restarted, fork, source)
    assert.deepEqual(selection(restarted, 'fresh'), { ...defaultChoice, speed: 'standard' })
    assert.deepEqual(selection(restarted, 'fork'), { ...defaultChoice, speed: 'standard' })
  }
  assert.equal((await send(restarted, postRequest('recency', 'speed', 'ultrafast'))).status, 200)
  add(restarted, stubAgent('legacyChild', sol, parent.id), 'resume')
  assert.deepEqual(selection(restarted, 'legacyChild'), { ...defaultChoice, speed: 'ultrafast' })
})

test('owner route rejects invalid writes and checks idle, identity and route under reservation', async (t) => {
  const path = statePath(t)
  const f = fixture(path)
  const target = stubAgent('target')
  add(f, target)
  assert.equal((await send(f, getRequest('unknown'))).status, 404)
  assert.equal((await send(f, getRequest('target', astra))).status, 409)
  assert.equal((await send(f, postRequest('target', 'reasoningEffort', 'high'))).status, 400)
  assert.equal((await send(f, postRequest('target', 'contextWindow', '272000'))).status, 400)
  assert.equal((await send(f, postRequest('target', 'contextWindow', 123_000))).status, 400)
  assert.equal((await send(f, postRequest('target', 'speed', 'priority'))).status, 400)
  target.status = 'running'
  assert.equal((await send(f, postRequest('target', 'speed', 'standard'))).status, 409)
  target.status = 'idle'
  target.busy = true
  assert.equal((await send(f, postRequest('target', 'speed', 'standard'))).status, 409)

  target.runMaintenance = (job) => {
    target.selected = astra
    return job(new AbortController().signal)
  }
  assert.equal((await send(f, postRequest('target', 'speed', 'standard'))).status, 409)
  assert.deepEqual(selection(f, 'target'), defaultChoice)

  target.selected = sol
  target.runMaintenance = (job) => {
    f.agents.set(target.id, stubAgent(target.id))
    return job(new AbortController().signal)
  }
  assert.equal((await send(f, postRequest('target', 'speed', 'standard'))).status, 409)
  assert.deepEqual(selection(f, 'target'), defaultChoice)
})

test('queued writes revalidate new configuration and await the durable outcome', async (t) => {
  const path = statePath(t)
  const f = fixture(path)
  const first = stubAgent('first')
  const target = stubAgent('target')
  add(f, first)
  add(f, target)
  const reserved = deferred()
  const release = deferred()
  first.runMaintenance = async (job) => {
    reserved.resolve()
    await release.promise
    return job(new AbortController().signal)
  }
  let current = f.controls
  const handle = (request: Request) => handleSessionControls(request, () => current, (error) => f.warnings.push(error))
  const firstWrite = handle(postRequest('first', 'speed', 'standard'))
  await reserved.promise
  const queuedWrite = handle(postRequest('target', 'speed', 'ultrafast'))
  await setImmediate()
  let readFinished = false
  const queuedRead = handle(getRequest('target')).then((reply) => {
    readFinished = true
    return reply
  })
  await setImmediate()
  assert.equal(readFinished, false)
  const disabled = fixture(path, { sessionSpeedEnabled: false }, f.agents)
  current = disabled.controls
  release.resolve()
  assert.equal((await firstWrite).status, 409)
  assert.equal((await queuedWrite).status, 400)
  assert.deepEqual(await (await queuedRead).json(), {
    ok: true,
    value: { contextWindow: { options: [272_000, 500_000, 872_000], value: 500_000 } },
  })
  assert.deepEqual(selection(f, 'target'), defaultChoice)
  assert.deepEqual(selection(disabled, 'target'), { contextWindow: 500_000 })

  current = f.controls
  const a = handle(postRequest('first', 'speed', 'standard'))
  const b = handle(postRequest('target', 'contextWindow', 872_000))
  assert.deepEqual((await Promise.all([a, b])).map((reply) => reply.status), [200, 200])
  const restored = fixture(path, {}, f.agents)
  assert.deepEqual(selection(restored, 'first'), { ...defaultChoice, speed: 'standard' })
  assert.deepEqual(selection(restored, 'target'), { ...defaultChoice, contextWindow: 872_000 })
})

test('aborted and failed writes leave live and saved values intact', async (t) => {
  const path = statePath(t)
  const f = fixture(path)
  const target = stubAgent('target')
  add(f, target)
  const before = readFileSync(path, 'utf8')
  const cancel = new AbortController()
  const request = postRequest('target', 'speed', 'ultrafast', sol, cancel.signal)
  target.runMaintenance = (job) => {
    cancel.abort()
    return job(new AbortController().signal)
  }
  assert.equal((await send(f, request)).status, 409)
  assert.equal(readFileSync(path, 'utf8'), before)

  target.runMaintenance = (job) => job(new AbortController().signal)
  const backup = `${path}.backup`
  renameSync(path, backup)
  mkdirSync(path)
  const failure = await send(f, postRequest('target', 'speed', 'ultrafast'))
  assert.equal(failure.status, 500)
  assert.deepEqual(await failure.json(), { ok: false, error: 'Could not read or save Magpie session controls' })
  assert.equal(f.warnings.length, 1)
  assert.deepEqual(selection(f, 'target'), defaultChoice)
  assert.equal(readFileSync(backup, 'utf8'), before)
  rmSync(path, { recursive: true })
  renameSync(backup, path)
  assert.equal((await send(f, postRequest('target', 'speed', 'ultrafast'))).status, 200)
  assert.deepEqual(selection(f, 'target'), { ...defaultChoice, speed: 'ultrafast' })
})

test('independent flags preserve values, and stale options fall back to the configured default', async (t) => {
  const path = statePath(t)
  const f = fixture(path)
  add(f, stubAgent('target'))
  assert.equal((await send(f, postRequest('target', 'speed', 'ultrafast'))).status, 200)
  assert.equal((await send(f, postRequest('target', 'contextWindow', 272_000))).status, 200)
  for (const sessionSpeedEnabled of [true, false]) {
    for (const sessionContextWindowEnabled of [true, false]) {
      const flags = { sessionSpeedEnabled, sessionContextWindowEnabled }
      const current = fixture(path, flags, f.agents)
      const result = await send(current, getRequest('target'))
      assert.equal(result.status, 200)
      assert.deepEqual(Object.keys((await result.json()).value), [
        ...(sessionSpeedEnabled ? ['speed'] : []),
        ...(sessionContextWindowEnabled ? ['contextWindow'] : []),
      ])
      assert.deepEqual(selection(current, 'target'), {
        ...(sessionSpeedEnabled ? { speed: 'ultrafast' } : {}),
        ...(sessionContextWindowEnabled ? { contextWindow: 272_000 } : {}),
      })
    }
  }
  const revised = fixture(path, { sessionControlRoutes: [{
    ...sol, speed: { options: ['standard', 'fast'], default: 'standard' },
    contextWindow: { options: [500_000], default: 500_000 }, efforts: ['high', 'ultra'],
  }] }, f.agents)
  assert.deepEqual(selection(revised, 'target'), { speed: 'standard', contextWindow: 500_000 })
  const result = await send(revised, getRequest('target'))
  assert.deepEqual((await result.json()).value.efforts, ['high'])
  assert.deepEqual(selection(f, 'target'), { speed: 'ultrafast', contextWindow: 272_000 })
})

test('both fields disabled bypass unreadable preference state and leave native efforts available', async (t) => {
  const path = statePath(t)
  writeFileSync(path, 'not valid JSON')
  const disabled = fixture(path, {
    sessionSpeedEnabled: false,
    sessionContextWindowEnabled: false,
    sessionControlRoutes: [{ ...sol, efforts: ['low', 'medium'], speed: { options: ['fast'], default: 'fast' } }],
  })
  add(disabled, stubAgent('target'))
  assert.deepEqual(selection(disabled, 'target'), {})
  assert.deepEqual(await (await send(disabled, getRequest('target'))).json(), {
    ok: true, value: { efforts: ['low', 'medium'] },
  })
  assert.equal((await send(disabled, postRequest('target', 'speed', 'fast'))).status, 400)
  assert.deepEqual(disabled.warnings, [])
  const enabled = fixture(path, {}, disabled.agents)
  assert.deepEqual(selection(enabled, 'target'), {})
  assert.equal((await send(enabled, postRequest('target', 'speed', 'fast'))).status, 500)
  assert.equal(readFileSync(path, 'utf8'), 'not valid JSON')
})

function batchFixture(path: string, config: DshMagpieConnectConfig = {}, validateSelection = async (_selection: SessionModelSelection) => {}) {
  const f = fixture(path, config)
  const defaults: SessionModelSelection[] = []
  const controls = new SessionControls({
    config: resolveConfig({ providerId: 'magpie', ...config }),
    store: f.store,
    agents: () => f.agents,
    catalogEfforts: (model) => [sol.model, astra.model].includes(model) ? ['low', 'medium', 'high'] : [],
    validateSelection,
    saveDefaultSelection: async (selection) => { defaults.push(selection) },
    warn: (error) => f.warnings.push(error),
  })
  const agent = stubAgent('target')
  const selected: SessionModelSelection[] = []
  agent.model.select = (selection) => {
    selected.push(selection)
    agent.selected = selection
  }
  const result = { ...f, controls, selected, defaults, agent }
  add(result, agent)
  return result
}

function batchRequest(changes: unknown, expectedRevision?: string, route: Route = sol, sessionId = 'target', allowRunning?: true): Request {
  return new Request(`http://localhost${SESSION_CONTROLS_API}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...route, changes, expectedRevision, allowRunning }),
  })
}

async function batchView(f: ReturnType<typeof batchFixture>) {
  const response = await send(f, getRequest('target'))
  assert.equal(response.status, 200)
  const { ok, value } = await response.json()
  assert.equal(ok, true)
  assert.equal(value.batch, true)
  assert.equal(typeof value.revision, 'string')
  return value
}

test('running POST bypasses legacy validation and a restored shrink is checked once with a bounded fallback', async (t) => {
  let inputTokens = 250_000
  let initiator: SessionControlsAgent | undefined
  const f = batchFixture(statePath(t))
  const makeControls = (store: SessionControlsStore) => new SessionControls({
    config: resolveConfig({ providerId: 'magpie' }),
    store,
    agents: () => ({ get: (id) => f.agents.get(id), currentInitiator: () => initiator }),
    catalogEfforts: () => ['medium', 'high'],
    catalogHasModel: (model) => model === sol.model,
    validateSelection: async () => assert.fail('running POST called the asynchronous validator'),
    requestMarker: () => (request) => request === main,
    tokenMeter: () => ({ measure: () => ({ totalTokens: inputTokens }) }),
    warn: (error) => f.warnings.push(error),
  })
  const agent = f.agent
  const signal = new AbortController().signal
  const at = { agent, turn: 1, step: 2, signal }
  let main = { ...sol, sessionId: agent.id, signal, maxTokens: 40_000 }
  const controls = makeControls(f.store)
  const saving = { ...f, controls }
  const initial = await batchView(saving)
  assert.equal(initial.runningEdits, true)
  agent.status = 'running'
  const edit = { speed: 'ultrafast', contextWindow: 272_000, reasoningEffort: 'high' }
  assert.equal((await send(saving, batchRequest(edit, initial.revision))).status, 409)
  const reply = await send(saving, batchRequest(edit, initial.revision, sol, agent.id, true))
  assert.equal(reply.status, 200)
  const { value: saved } = await reply.json()
  assert.equal(saved.contextWindow.value, 500_000)
  assert.equal(saved.pendingWindow.target, 272_000)
  assert.equal(saved.reasoningEffort, 'high')
  assert.equal((await send(saving, batchRequest(edit, initial.revision, sol, agent.id, true))).status, 409)

  const restarted = makeControls(new SessionControlsStore(f.store.path))
  assert.deepEqual((await batchView({ ...f, controls: restarted })).pendingWindow, saved.pendingWindow)
  agent.session.requestHeader = () => ({ config: { ...sol, maxTokens: main.maxTokens } })
  initiator = agent
  restarted.observeStep(agent, agent.selected, at)
  assert.equal(restarted.resolve(sol.provider, sol.model, agent.id, signal).contextWindow, 272_000)
  assert.equal(restarted.resolve(sol.provider, sol.model, agent.id, signal, 'prepare').contextWindow, 500_000)
  restarted.prepareMainRequest(at)
  const candidate = restarted.resolve(sol.provider, sol.model, agent.id, signal, 'prepare')
  assert.equal(candidate.canDispatch?.(), false)
  const sent = async function* () { yield 'upstream' }
  async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const chunks: T[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }
  assert.deepEqual(await collect(restarted.guardStream({ ...main }, sent)), ['upstream'])
  const [finish] = await collect(restarted.guardStream(main, sent))
  if (!finish || typeof finish === 'string') assert.fail('over-budget candidate reached upstream')
  assert.equal(candidate.canDispatch?.(), false)
  const retry = { ...at, provider: sol.provider, failure: finish.reason.failure }
  assert.deepEqual(restarted.retryWindow(retry), { kind: 'retry' })
  assert.equal(restarted.retryWindow(retry), undefined)
  restarted.prepareMainRequest(at)
  const retained = restarted.resolve(sol.provider, sol.model, agent.id, signal, 'prepare')
  assert.equal(retained.contextWindow, 500_000)
  assert.equal(retained.speed, 'ultrafast')
  main = { ...main, maxTokens: 100_000 }
  assert.deepEqual(await collect(restarted.guardStream(main, sent)), ['upstream'])
  assert.equal(retained.canDispatch?.(), true)
  const view = await batchView({ ...f, controls: restarted })
  assert.deepEqual(view.windowWarning, { ...saved.pendingWindow, retained: 500_000, reason: 'over-budget' })
  assert.equal(view.pendingWindow, undefined)
  inputTokens = 450_000
  restarted.prepareMainRequest(at)
  const ordinaryRetry = restarted.resolve(sol.provider, sol.model, agent.id, signal, 'prepare')
  const [blocked] = await collect(restarted.guardStream(main, sent))
  if (!blocked || typeof blocked === 'string') assert.fail('over-budget retry reached upstream')
  assert.equal(blocked.reason.failure.code, 'MAGPIE_SESSION_WINDOW_BUDGET_FAILED')
  assert.equal(ordinaryRetry.canDispatch?.(), false)
  assert.deepEqual(f.warnings, [])
})

test('batch validates every field before a write, records raw effort and rejects stale revisions', async (t) => {
  const path = statePath(t)
  const validated: SessionModelSelection[] = []
  const f = batchFixture(path, {}, async (selection) => {
    validated.push(selection)
    if (selection.reasoningEffort === 'low') throw new Error('Low effort is unavailable')
  })
  const original = await batchView(f)
  assert.equal(original.reasoningEffort, null)
  assert.equal((await batchView(f)).revision, original.revision)
  const before = readFileSync(path, 'utf8')
  for (const changes of [{}, { speed: 'standard', extra: null }, { speed: 'standard', contextWindow: 123 },
    { speed: 'standard', reasoningEffort: 'ultra' }, { speed: 'standard', reasoningEffort: 'low' }]) {
    const reply = await send(f, batchRequest(changes, original.revision))
    assert.equal(reply.status, 400)
    assert.equal(readFileSync(path, 'utf8'), before)
  }
  assert.deepEqual(validated, [{ ...sol, reasoningEffort: 'low' }])
  assert.deepEqual(f.selected, [])
  assert.deepEqual(f.defaults, [])

  const changes = { speed: 'ultrafast', contextWindow: 872_000, reasoningEffort: 'high' }
  const writes = await Promise.all([send(f, batchRequest(changes, original.revision)),
    send(f, batchRequest({ speed: 'standard' }, original.revision))])
  assert.deepEqual(writes.map((response) => response.status).sort(), [200, 409])
  // Determine the winning request by its echoed value; request parsing can finish in either order.
  const first = await writes[0].json()
  if (!first.ok) {
    const retry = await send(f, batchRequest(changes, (await batchView(f)).revision))
    assert.equal(retry.status, 200)
  }
  const saved = await batchView(f)
  assert.notEqual(saved.revision, original.revision)
  assert.equal(saved.speed.value, 'ultrafast')
  assert.equal(saved.contextWindow.value, 872_000)
  assert.equal(saved.reasoningEffort, 'high')
  assert.deepEqual(f.selected, [{ ...sol, reasoningEffort: 'high' }])
  assert.deepEqual(f.defaults, f.selected)
  assert.deepEqual(selection(fixture(path, {}, f.agents), 'target'), { speed: 'ultrafast', contextWindow: 872_000 })

  const reset = await send(f, batchRequest({ reasoningEffort: null }, saved.revision))
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).value.reasoningEffort, null)
  assert.deepEqual(f.selected.at(-1), sol)
  assert.deepEqual(f.defaults.at(-1), sol)
})

test('batch passes a matching current effort to native selection for recording', async (t) => {
  const f = batchFixture(statePath(t))
  const fallback = { ...sol, reasoningEffort: 'medium' }
  f.agent.selected = fallback
  const original = await batchView(f)
  const saved = await send(f, batchRequest({ reasoningEffort: 'medium' }, original.revision))
  assert.equal(saved.status, 200)
  assert.deepEqual(f.selected, [fallback])
  assert.deepEqual(f.defaults, [fallback])
})

test('batch rechecks the native effort after asynchronous validation', async (t) => {
  const validating = deferred()
  const resume = deferred()
  const f = batchFixture(statePath(t), {}, async () => {
    validating.resolve()
    await resume.promise
  })
  const pending = send(f, batchRequest({ speed: 'standard', reasoningEffort: 'high' }))
  await validating.promise
  f.agent.selected = { ...sol, reasoningEffort: 'medium' }
  resume.resolve()
  assert.equal((await pending).status, 409)
  const current = await batchView(f)
  assert.equal(current.reasoningEffort, 'medium')
  assert.equal(current.speed.value, 'fast')
  assert.deepEqual(f.selected, [])
})

test('native write failure restores session and recent preferences and reports failed compensation', async (t) => {
  const path = statePath(t)
  const f = batchFixture(path)
  const original = await batchView(f)
  const before = readFileSync(path, 'utf8')
  const select = f.agent.model.select!
  f.agent.model.select = (next) => {
    select(next)
    if (next.reasoningEffort === 'high') throw new Error('native append failed after changing the selection')
  }
  const changes = { speed: 'ultrafast', contextWindow: 872_000, reasoningEffort: 'high' }
  assert.equal((await send(f, batchRequest(changes, original.revision))).status, 500)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.deepEqual(await batchView(f), original)
  assert.deepEqual(f.selected, [{ ...sol, reasoningEffort: 'high' }, sol])
  assert.deepEqual(f.defaults, [])

  const backup = `${path}.written`
  f.agent.model.select = () => {
    renameSync(path, backup)
    mkdirSync(path)
    throw new Error('native append and preference restoration failed')
  }
  const failure = await send(f, batchRequest(changes, original.revision))
  assert.equal(failure.status, 500)
  assert.match((await failure.json()).error, /Could not restore.*confirm/)
  assert.ok(f.warnings.at(-1) instanceof AggregateError)
  assert.deepEqual(f.defaults, [])
  const recovered = await batchView(f)
  assert.equal(recovered.speed.value, 'ultrafast')
  assert.equal(recovered.contextWindow.value, 872_000)
  assert.equal(recovered.reasoningEffort, null)
  assert.notEqual(recovered.revision, original.revision)
})

test('batch preserves independent flags, including effort on an unlisted Magpie route', async (t) => {
  for (const sessionSpeedEnabled of [true, false]) {
    for (const sessionContextWindowEnabled of [true, false]) {
      const f = batchFixture(statePath(t), { sessionSpeedEnabled, sessionContextWindowEnabled })
      const original = await batchView(f)
      assert.equal('speed' in original, sessionSpeedEnabled)
      assert.equal('contextWindow' in original, sessionContextWindowEnabled)
      const changes = { reasoningEffort: 'high', ...(sessionSpeedEnabled && { speed: 'standard' }),
        ...(sessionContextWindowEnabled && { contextWindow: 272_000 }) }
      assert.equal((await send(f, batchRequest(changes, original.revision))).status, 200)
      assert.equal((await batchView(f)).reasoningEffort, 'high')
      if (!sessionSpeedEnabled) assert.equal((await send(f, batchRequest({ speed: 'fast', reasoningEffort: 'low' }))).status, 400)
      if (!sessionContextWindowEnabled) assert.equal((await send(f, batchRequest({ contextWindow: 500_000, reasoningEffort: 'low' }))).status, 400)
      assert.equal((await batchView(f)).reasoningEffort, 'high')
    }
  }
  const path = statePath(t)
  writeFileSync(path, 'not valid JSON')
  const f = batchFixture(path, { sessionSpeedEnabled: false, sessionContextWindowEnabled: false, sessionControlRoutes: [] })
  const initial = await batchView(f)
  assert.equal((await batchView(f)).revision, initial.revision)
  assert.equal((await send(f, batchRequest({ reasoningEffort: 'medium' }, initial.revision))).status, 200)
  assert.equal((await batchView(f)).reasoningEffort, 'medium')
  assert.equal(readFileSync(path, 'utf8'), 'not valid JSON')

  for (const unsupported of [other, { ...sol, provider: 'other-provider' }]) {
    f.agent.selected = unsupported
    const get = await send(f, getRequest('target', unsupported))
    assert.deepEqual(await get.json(), { ok: true, value: {} })
    assert.equal((await send(f, batchRequest({ reasoningEffort: 'high' }, undefined, unsupported))).status, 400)
  }
})

test('subagent sessions retain speed and window writes but reject effort before changing any preference', async (t) => {
  const f = batchFixture(statePath(t))
  const child = stubAgent('child', sol, f.agent.id)
  child.model.select = (next) => { child.selected = next }
  add(f, child)
  const response = await send(f, getRequest(child.id))
  const { value: initial } = await response.json()
  assert.equal(initial.batch, true)
  for (const reasoningEffort of ['high', null]) {
    const blocked = await send(f, batchRequest({ speed: 'ultrafast', reasoningEffort }, initial.revision, sol, child.id))
    assert.equal(blocked.status, 409)
    assert.match((await blocked.json()).error, /owned by subagent routing/)
    assert.deepEqual(child.selected, sol)
    assert.deepEqual(selection(f, child.id), defaultChoice)
  }
  const saved = await send(f, batchRequest({ speed: 'ultrafast', contextWindow: 872_000 }, initial.revision, sol, child.id))
  assert.equal(saved.status, 200)
  assert.deepEqual(selection(f, child.id), { speed: 'ultrafast', contextWindow: 872_000 })
  assert.equal((await send(f, postRequest(child.id, 'speed', 'standard'))).status, 200)
  assert.deepEqual(f.defaults, [])
})

test('apply registers GET/POST on connection.fetch and shares lifecycle data with the adapter', async (t) => {
  const path = statePath(t)
  __resetSettingsRoutes()
  const routes = new Map<string, { methods: string[]; fetch: (request: Request) => Promise<Response> }>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const disposers: Array<() => void> = []
  const agents = new Map<string, SessionControlsAgent>()
  let initiator: SessionControlsAgent | undefined
  let adapter: MagpieAdapter | undefined
  const validationCalls: SessionModelSelection[] = []
  const defaultSaves: SessionModelSelection[] = []
  const providerReads: string[] = []
  let models = [{ id: 'codex/gpt-6.2-astra' }]
  const ctx: PluginContext = {
    llm: {
      registerAdapter: (_providers, registered) => { adapter = registered as MagpieAdapter },
      listModels: async (provider) => {
        providerReads.push(provider)
        return models
      },
      resolveCallConfig: async (requested) => {
        validationCalls.push(requested)
        return { ...requested, reasoningEffort: requested.reasoningEffort ?? 'medium' }
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: (key) => {
      if (key === 'agents') return { get: (id: string) => agents.get(id), currentInitiator: () => initiator }
      if (key === 'agentDefaultModel') return { saveSelection: async (value: SessionModelSelection) => { defaultSaves.push(value) } }
    },
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
    effect: (fn) => { disposers.push(fn()) },
    inject: (deps, fn) => {
      if (deps.includes('connection')) fn({ connection: { fetch: { register: (route: { path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      } } } })
    },
  }
  t.after(() => { for (const dispose of disposers) dispose() })
  apply(ctx, { providerId: 'magpie', dataDir: dirname(path) })
  const route = routes.get(SESSION_CONTROLS_API)
  assert.deepEqual(route?.methods, ['GET', 'POST'])
  const parent = stubAgent('host-parent')
  agents.set(parent.id, parent)
  const created = handlers.get('agent/created') as ((payload: SessionControlsCreated) => void) | undefined
  assert.ok(created)
  created({ agent: parent, source: 'startup' })
  assert.ok(adapter)
  assert.ok(route)
  assert.equal((await route.fetch(postRequest(parent.id, 'contextWindow', 872_000))).status, 200)
  initiator = parent
  assert.equal(adapter.resolveModel(sol.provider, sol.model).context.contextWindow, 872_000)
  initiator = undefined
  assert.notEqual(adapter.resolveModel(sol.provider, sol.model).context.contextWindow, 872_000)

  const target = stubAgent('target')
  target.selected = { ...sol, reasoningEffort: 'high' }
  target.model.select = (next) => { target.selected = next }
  agents.set(target.id, target)
  const initial = await (await route.fetch(getRequest(target.id))).json()
  assert.equal(initial.value.batch, true)
  const reset = { contextWindow: 872_000, reasoningEffort: null }
  const unlisted = await route.fetch(batchRequest(reset, initial.value.revision))
  assert.equal(unlisted.status, 400)
  assert.match((await unlisted.json()).error, /Select an available model/)
  assert.deepEqual(await (await route.fetch(getRequest(target.id))).json(), initial)
  assert.deepEqual(defaultSaves, [])
  const windowOnly = await route.fetch(batchRequest({ contextWindow: 272_000 }, initial.value.revision))
  assert.equal(windowOnly.status, 200)
  assert.equal((await windowOnly.json()).value.reasoningEffort, 'high')
  assert.deepEqual(providerReads, [sol.provider])
  assert.equal((await route.fetch(postRequest(target.id, 'speed', 'ultrafast'))).status, 200)

  models = [{ id: sol.model }]
  const current = await (await route.fetch(getRequest(target.id))).json()
  const saved = await route.fetch(batchRequest(reset, current.value.revision))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).value.reasoningEffort, null)
  assert.deepEqual(target.selected, sol)
  assert.deepEqual(validationCalls, [sol, sol])
  assert.deepEqual(providerReads, [sol.provider, sol.provider])
  assert.deepEqual(defaultSaves, [sol])
  initiator = target
  assert.equal(adapter.resolveModel(sol.provider, sol.model).context.contextWindow, 872_000)
})
