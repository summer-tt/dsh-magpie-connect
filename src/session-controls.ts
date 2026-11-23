import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  isContextWindow,
  isSessionControlSpeed,
  type ResolvedConfig,
  type SessionControlOptions,
  type SessionControlRoute,
  type SessionControlSpeed,
} from './config.ts'

type Route = Pick<SessionControlRoute, 'provider' | 'model'>
export type SessionModelSelection = Route & { readonly reasoningEffort?: string }
export type SessionControlsSelection = { speed?: SessionControlSpeed; contextWindow?: number }
type Field = keyof SessionControlsSelection
type SessionRoute = Route & { sessionId: string }
type Change = SessionRoute & { field: Field; value: unknown }
type Choice<T> = { options: readonly T[]; value: T }

export interface SessionControlsView {
  speed?: Choice<SessionControlSpeed>
  contextWindow?: Choice<number>
  efforts?: string[]
}

/** Structural subset of the DSH agent APIs used by the Host plugin. */
export interface SessionControlsAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: {
    readonly id: string
    readonly header: { readonly parentSession?: string; readonly origin?: string }
    requestHeader?(): { config: SessionModelSelection } | undefined
  }
  readonly model: { current(): Readonly<SessionModelSelection> | undefined }
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

export interface SessionControlsAgents {
  get(id: string): SessionControlsAgent | undefined
  currentInitiator?(): SessionControlsAgent | undefined
}

export interface SessionControlsCreated {
  agent: SessionControlsAgent
  source: 'startup' | 'resume' | 'clear' | 'compact'
  signal?: AbortSignal
}

const routeKey = ({ provider, model }: Route) => JSON.stringify([provider, model])
const sessionRouteKey = (id: string, { provider, model }: Route) => JSON.stringify([id, provider, model])
const sameRoute = (left: Route, right: Route | undefined) => left.provider === right?.provider && left.model === right.model

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validSelection(value: unknown): value is SessionControlsSelection {
  return isRecord(value) && (value.speed === undefined || isSessionControlSpeed(value.speed)) &&
    (value.contextWindow === undefined || isContextWindow(value.contextWindow))
}

type Selections = Record<string, SessionControlsSelection>
interface State {
  version: 1
  recent: Selections
  sessions: Selections
}

function validSelections(value: unknown): value is Selections {
  return isRecord(value) && Object.values(value).every(validSelection)
}

/** Local owner state, shared by overlapping plugin generations in one DSH Host. */
export class SessionControlsStore {
  #state?: State
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  #read(): State {
    if (this.#state) return this.#state
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return (this.#state = { version: 1, recent: {}, sessions: {} })
    }
    const raw: unknown = JSON.parse(text)
    if (!isRecord(raw) || raw.version !== 1 || !validSelections(raw.recent) || !validSelections(raw.sessions)) {
      throw new Error('Invalid session controls state')
    }
    return (this.#state = { version: 1, recent: raw.recent, sessions: raw.sessions })
  }

  #replace(state: State): void {
    const text = JSON.stringify(state)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = openSync(temporary, 'wx', 0o600)
    try {
      try {
        writeFileSync(file, text, 'utf8')
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      renameSync(temporary, this.path)
    } catch (error) {
      try { rmSync(temporary, { force: true }) } catch { /* Keep the original write error. */ }
      throw error
    }
    this.#state = state
  }

  snapshot(id: string, route: SessionControlRoute, inherited?: SessionControlsSelection): SessionControlsSelection {
    const state = this.#read()
    const key = sessionRouteKey(id, route)
    const existing = state.sessions[key]
    if (existing) return existing
    const initial = effectiveSelection(route, inherited ?? state.recent[routeKey(route)])
    this.#replace({ ...state, sessions: { ...state.sessions, [key]: initial } })
    return initial
  }

  set(id: string, route: SessionControlRoute, change: RequiredChange): SessionControlsSelection {
    const state = this.#read()
    const sessionKey = sessionRouteKey(id, route)
    const recentKey = routeKey(route)
    const recent = state.recent[recentKey]
    const current = state.sessions[sessionKey] ?? effectiveSelection(route, recent)
    const next = { ...current, ...change }
    this.#replace({
      ...state,
      recent: { ...state.recent, [recentKey]: { ...recent, ...change } },
      sessions: { ...state.sessions, [sessionKey]: next },
    })
    return next
  }
}

const stores = new Map<string, { store: SessionControlsStore; users: number }>()

export function acquireSessionControlsStore(dataDir: string): { store: SessionControlsStore; release: () => void } {
  const path = resolve(dataDir, 'session-controls.json')
  const entry = stores.get(path) ?? { store: new SessionControlsStore(path), users: 0 }
  entry.users++
  stores.set(path, entry)
  let released = false
  return {
    store: entry.store,
    release: () => {
      if (released) return
      released = true
      if (--entry.users === 0) stores.delete(path)
    },
  }
}

function choiceValue<T>(capability: SessionControlOptions<T>, value: T | undefined): T {
  return value !== undefined && capability.options.includes(value) ? value : capability.default
}

function effectiveSelection(route: SessionControlRoute, value?: SessionControlsSelection): SessionControlsSelection {
  return {
    ...(route.speed && { speed: choiceValue(route.speed, value?.speed) }),
    ...(route.contextWindow && { contextWindow: choiceValue(route.contextWindow, value?.contextWindow) }),
  }
}

class SessionControlsError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type RequiredChange = { speed: SessionControlSpeed } | { contextWindow: number }

interface SessionControlsOptions {
  config: ResolvedConfig
  store: SessionControlsStore
  agents: () => SessionControlsAgents | undefined
  catalogEfforts: (model: string) => readonly string[]
  warn: (error: unknown) => void
}

export class SessionControls {
  readonly #capabilities = new Map<string, SessionControlRoute>()
  readonly #stepRoutes = new WeakMap<SessionControlsAgent, SessionModelSelection>()
  readonly #options: SessionControlsOptions

  constructor(options: SessionControlsOptions) {
    this.#options = options
    for (const route of options.config.sessionControlRoutes) {
      if (route.provider !== options.config.providerId) continue
      this.#capabilities.set(routeKey(route), route)
    }
  }

  allowedEfforts(provider: string, model: string): readonly string[] | undefined {
    return this.#capabilities.get(routeKey({ provider, model }))?.efforts
  }

  #enabled(route: SessionControlRoute | undefined): boolean {
    return !!route && (
      (this.#options.config.sessionSpeedEnabled && route.speed !== undefined) ||
      (this.#options.config.sessionContextWindowEnabled && route.contextWindow !== undefined)
    )
  }

  /** Capture the step already underway even if a new model is selected for the next step. */
  observeStep(agent: SessionControlsAgent, modelSelection: SessionModelSelection): void {
    this.#stepRoutes.set(agent, modelSelection)
  }

  observeIdle(agent: SessionControlsAgent): void {
    this.#stepRoutes.delete(agent)
  }

  #actualSelection(agent: SessionControlsAgent): SessionModelSelection | undefined {
    return agent.status === 'running'
      ? this.#stepRoutes.get(agent) ?? agent.session.requestHeader?.()?.config ?? agent.model.current()
      : agent.model.current()
  }

  initiatorReasoningEffort(provider: string, model: string): string | undefined {
    const agent = this.#options.agents()?.currentInitiator?.()
    const selection = agent && this.#actualSelection(agent)
    return sameRoute({ provider, model }, selection) ? selection?.reasoningEffort : undefined
  }

  onCreated({ agent, source, signal }: SessionControlsCreated): void {
    if (source !== 'startup' || signal?.aborted) return
    const selected = agent.model.current()
    if (!selected) return
    const route = this.#capabilities.get(routeKey(selected))
    if (!route || !this.#enabled(route)) return
    try {
      const { origin, parentSession } = agent.session.header
      const parent = origin === 'subagent' && parentSession ? this.#options.agents()?.get(parentSession) : undefined
      const inherited = parent && sameRoute(route, this.#actualSelection(parent))
        ? this.#options.store.snapshot(parent.id, route)
        : undefined
      this.#options.store.snapshot(agent.id, route, inherited)
    } catch (error) {
      this.#options.warn(error)
    }
  }

  resolve(provider: string, model: string, sessionId?: string): SessionControlsSelection {
    if (!sessionId) return {}
    const route = this.#capabilities.get(routeKey({ provider, model }))
    if (!route || !this.#enabled(route)) return {}
    try {
      const value = effectiveSelection(route, this.#options.store.snapshot(sessionId, route))
      return {
        ...(this.#options.config.sessionSpeedEnabled && value.speed !== undefined && { speed: value.speed }),
        ...(this.#options.config.sessionContextWindowEnabled && value.contextWindow !== undefined && { contextWindow: value.contextWindow }),
      }
    } catch (error) {
      this.#options.warn(error)
      return {}
    }
  }

  #agentFor(request: SessionRoute): SessionControlsAgent {
    const agent = this.#options.agents()?.get(request.sessionId)
    if (!agent || agent.session.id !== request.sessionId) throw new SessionControlsError(404, 'Session is not active')
    if (!sameRoute(request, agent.model.current())) throw new SessionControlsError(409, 'The session model changed')
    return agent
  }

  #view(route: SessionControlRoute | undefined, selection?: SessionControlsSelection): SessionControlsView {
    if (!route) return {}
    const view: SessionControlsView = {}
    const value = effectiveSelection(route, selection)
    if (this.#options.config.sessionSpeedEnabled && route.speed && value.speed !== undefined) {
      view.speed = { options: route.speed.options, value: value.speed }
    }
    if (this.#options.config.sessionContextWindowEnabled && route.contextWindow && value.contextWindow !== undefined) {
      view.contextWindow = { options: route.contextWindow.options, value: value.contextWindow }
    }
    const allowedEfforts = route.efforts
    if (allowedEfforts !== undefined) {
      view.efforts = this.#options.catalogEfforts(route.model).filter((effort) => allowedEfforts.includes(effort))
    }
    return view
  }

  get(request: SessionRoute): SessionControlsView {
    this.#agentFor(request)
    const route = this.#capabilities.get(routeKey(request))
    const snapshot = route && this.#enabled(route) ? this.#options.store.snapshot(request.sessionId, route) : undefined
    return this.#view(route, snapshot)
  }

  #change(request: Change): { route: SessionControlRoute; patch: RequiredChange } {
    const route = this.#capabilities.get(routeKey(request))
    const { field, value } = request
    if (field === 'speed' && this.#options.config.sessionSpeedEnabled && route?.speed &&
      isSessionControlSpeed(value) && route.speed.options.includes(value)) return { route, patch: { speed: value } }
    if (field === 'contextWindow' && this.#options.config.sessionContextWindowEnabled && route?.contextWindow &&
      isContextWindow(value) && route.contextWindow.options.includes(value)) return { route, patch: { contextWindow: value } }
    throw new SessionControlsError(400, `Invalid or unavailable session control: ${field}`)
  }

  checkChange(request: Change) {
    const agent = this.#agentFor(request)
    if (agent.status !== 'idle') throw new SessionControlsError(409, 'The session is running')
    if (!agent.runMaintenance) throw new SessionControlsError(503, 'Session controls are unavailable')
    this.#change(request)
    return { agent, reserve: agent.runMaintenance.bind(agent) }
  }

  set(request: Change, requestSignal: AbortSignal, getCurrent: () => SessionControls): Promise<SessionControlsView> {
    const { agent, reserve } = this.checkChange(request)
    try {
      return reserve(async (signal) => {
        // No yield between validation and rename. DSH model selection can
        // change while asynchronous maintenance is waiting for I/O.
        if (requestSignal.aborted || signal.aborted || getCurrent() !== this || this.#agentFor(request) !== agent) {
          throw new SessionControlsError(409, 'The session or its controls changed')
        }
        const { route, patch } = this.#change(request)
        const value = this.#options.store.set(request.sessionId, route, patch)
        return this.#view(route, value)
      })
    } catch {
      // rc.5 throws synchronously when another maintenance task owns the idle phase.
      throw new SessionControlsError(409, 'The session has active work')
    }
  }
}

const allowedQuery = ['sessionId', 'provider', 'model'] as const

function parseRoute(input: unknown): SessionRoute {
  if (!isRecord(input)) throw new SessionControlsError(400, 'Expected an object with sessionId, provider and model')
  const { sessionId, provider, model } = input
  if (typeof sessionId !== 'string' || !sessionId.trim() || typeof provider !== 'string' || !provider.trim() ||
    typeof model !== 'string' || !model.trim()) {
    throw new SessionControlsError(400, 'Expected sessionId, provider and model')
  }
  return { sessionId, provider, model }
}

function parseChange(body: unknown): Change {
  const route = parseRoute(body)
  const { field, value } = body as Record<string, unknown>
  if (field !== 'speed' && field !== 'contextWindow') throw new SessionControlsError(400, 'Unknown session control')
  if (Object.keys(body as object).some((key) => key !== 'field' && key !== 'value' && !allowedQuery.some((id) => id === key))) {
    throw new SessionControlsError(400, 'Unexpected session control input')
  }
  return { ...route, field, value }
}

let writeQueue: Promise<unknown> = Promise.resolve()

/** The DSH exact Fetch registry restricts both methods to authenticated owner Peers. */
export async function handleSessionControls(
  request: Request,
  getCurrent: () => SessionControls,
  warn: (error: unknown) => void,
): Promise<Response> {
  const reply = (status: number, payload: unknown) => Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
  try {
    let value: SessionControlsView
    if (request.method === 'POST') {
      const change = parseChange(await request.json().catch(() => undefined))
      getCurrent().checkChange(change)
      const write = writeQueue.then(() => {
        if (request.signal.aborted) throw new SessionControlsError(409, 'Session control request was cancelled')
        return getCurrent().set(change, request.signal, getCurrent)
      })
      writeQueue = write.catch(() => {})
      value = await write
    } else {
      await writeQueue
      const query = new URL(request.url).searchParams
      value = getCurrent().get(parseRoute(Object.fromEntries(allowedQuery.map((key) => [key, query.get(key)]))))
    }
    return reply(200, { ok: true, value })
  } catch (error) {
    if (error instanceof SessionControlsError) return reply(error.status, { ok: false, error: error.message })
    warn(error)
    return reply(500, { ok: false, error: 'Could not read or save Magpie session controls' })
  }
}
