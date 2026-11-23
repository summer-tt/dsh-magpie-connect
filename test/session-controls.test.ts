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
} from '../src/session-controls.ts'

const sol = { provider: 'magpie', model: 'codex/gpt-6.2-sol' }
const astra = { provider: 'magpie', model: 'codex/gpt-6.2-astra' }
const other = { provider: 'magpie', model: 'codex/gpt-6.2-sol-fast' }

type Route = typeof sol

interface StubAgent extends SessionControlsAgent {
  status: SessionControlsAgent['status']
  selected: Route
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

test('config enables the two exact routes and validates custom options', () => {
  const cfg = resolveConfig({ providerId: 'magpie' })
  assert.equal(cfg.sessionSpeedEnabled, true)
  assert.equal(cfg.sessionContextWindowEnabled, true)
  assert.deepEqual(cfg.sessionControlRoutes.map(({ provider, model }) => ({ provider, model })), [sol, astra])
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

test('apply registers GET/POST on connection.fetch and shares lifecycle data with the adapter', async (t) => {
  const path = statePath(t)
  __resetSettingsRoutes()
  const routes = new Map<string, { methods: string[]; fetch: (request: Request) => Promise<Response> }>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const disposers: Array<() => void> = []
  const agents = new Map<string, SessionControlsAgent>()
  let initiator: SessionControlsAgent | undefined
  let adapter: MagpieAdapter | undefined
  const ctx: PluginContext = {
    llm: { registerAdapter: (_providers, registered) => { adapter = registered as MagpieAdapter } },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: (key) => key === 'agents' && { get: (id: string) => agents.get(id), currentInitiator: () => initiator },
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
})
