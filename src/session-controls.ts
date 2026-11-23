import { createHash, randomUUID } from 'node:crypto'
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
type SessionRoute = Route & { sessionId: string }
type Change = SessionRoute & { changes: Record<string, unknown>; batch: boolean; expectedRevision?: string }
type Choice<T> = { options: readonly T[]; value: T }

type SessionControlsChoices = {
  speed?: Choice<SessionControlSpeed>
  contextWindow?: Choice<number>
  efforts?: string[]
}

export type SessionControlsView = SessionControlsChoices & (
  | { batch: true; revision: string; reasoningEffort: string | null }
  | { batch?: never; revision?: never; reasoningEffort?: never }
)

/** Structural subset of the DSH agent APIs used by the Host plugin. */
export interface SessionControlsAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: {
    readonly id: string
    readonly header: { readonly parentSession?: string; readonly origin?: string }
    requestHeader?(): { config: SessionModelSelection } | undefined
  }
  readonly model: {
    current(): Readonly<SessionModelSelection> | undefined
    select?(selection: SessionModelSelection): void
  }
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

  peek(id: string, route: SessionControlRoute): SessionControlsSelection {
    const state = this.#read()
    return state.sessions[sessionRouteKey(id, route)] ?? effectiveSelection(route, state.recent[routeKey(route)])
  }

  /** Replace both preferences once and retain their previous state for synchronous compensation. */
  set(id: string, route: SessionControlRoute, change: SessionControlsSelection): () => void {
    const state = this.#read()
    const sessionKey = sessionRouteKey(id, route)
    const recentKey = routeKey(route)
    const recent = state.recent[recentKey]
    const next = { ...this.peek(id, route), ...change }
    this.#replace({
      ...state,
      recent: { ...state.recent, [recentKey]: { ...recent, ...change } },
      sessions: { ...state.sessions, [sessionKey]: next },
    })
    return () => this.#replace(state)
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

class SessionControlsUncertainError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'Could not restore Magpie session controls after a failed save; read the session controls to confirm the current values')
  }
}

interface SessionControlsOptions {
  config: ResolvedConfig
  store: SessionControlsStore
  agents: () => SessionControlsAgents | undefined
  catalogEfforts: (model: string) => readonly string[]
  validateSelection?: (selection: SessionModelSelection, signal: AbortSignal) => Promise<unknown>
  saveDefaultSelection?: (selection: SessionModelSelection) => Promise<void> | undefined
  warn: (error: unknown) => void
}

// Stable across overlapping plugin generations. Replacing an Agent or completing
// a write invalidates its prior revision even if its choices are unchanged.
const revisionSeeds = new WeakMap<SessionControlsAgent, string>()

function revisionFor(agent: SessionControlsAgent, route: Route, view: SessionControlsChoices, reasoningEffort: string | null): string {
  const seed = revisionSeeds.get(agent) ?? randomUUID()
  revisionSeeds.set(agent, seed)
  return createHash('sha256').update(JSON.stringify([seed, route.provider, route.model, view, reasoningEffort])).digest('base64url')
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

  #route(request: SessionRoute): SessionControlRoute | undefined {
    if (request.provider !== this.#options.config.providerId) return undefined
    return this.#capabilities.get(routeKey(request)) ?? { provider: request.provider, model: request.model }
  }

  #efforts(route: SessionControlRoute): string[] {
    const { efforts } = route
    return this.#options.catalogEfforts(route.model).filter((effort) => efforts === undefined || efforts.includes(effort))
  }

  #supportsBatch(agent: SessionControlsAgent, route: SessionControlRoute): boolean {
    return !!(agent.runMaintenance && agent.model.select && this.#options.validateSelection &&
      (this.#enabled(route) || this.#efforts(route).length > 0))
  }

  #view(agent: SessionControlsAgent, route: SessionControlRoute, selection?: SessionControlsSelection): SessionControlsView {
    const view: SessionControlsChoices = {}
    const value = effectiveSelection(route, selection)
    if (this.#options.config.sessionSpeedEnabled && route.speed && value.speed !== undefined) {
      view.speed = { options: route.speed.options, value: value.speed }
    }
    if (this.#options.config.sessionContextWindowEnabled && route.contextWindow && value.contextWindow !== undefined) {
      view.contextWindow = { options: route.contextWindow.options, value: value.contextWindow }
    }
    const efforts = this.#efforts(route)
    if (route.efforts !== undefined) view.efforts = efforts
    if (!this.#supportsBatch(agent, route)) return view
    const reasoningEffort = agent.model.current()?.reasoningEffort ?? null
    return { ...view, batch: true, revision: revisionFor(agent, route, { ...view, efforts }, reasoningEffort), reasoningEffort }
  }

  get(request: SessionRoute): SessionControlsView {
    const agent = this.#agentFor(request)
    const route = this.#route(request)
    if (!route) return {}
    const snapshot = this.#enabled(route) ? this.#options.store.snapshot(request.sessionId, route) : undefined
    return this.#view(agent, route, snapshot)
  }

  #change(agent: SessionControlsAgent, request: Change) {
    const route = this.#route(request)
    if (!route || (request.batch && !this.#supportsBatch(agent, route))) {
      throw new SessionControlsError(400, 'Session controls are unavailable for this model')
    }
    const patch: SessionControlsSelection = {}
    let nextSelection: SessionModelSelection | undefined
    const valid = (field: string): never => {
      throw new SessionControlsError(400, `Invalid or unavailable session control: ${field}`)
    }
    for (const [field, value] of Object.entries(request.changes)) {
      switch (field) {
        case 'speed':
          if (!(this.#options.config.sessionSpeedEnabled && route.speed &&
            isSessionControlSpeed(value) && route.speed.options.includes(value))) return valid(field)
          patch.speed = value
          break
        case 'contextWindow':
          if (!(this.#options.config.sessionContextWindowEnabled && route.contextWindow &&
            isContextWindow(value) && route.contextWindow.options.includes(value))) return valid(field)
          patch.contextWindow = value
          break
        case 'reasoningEffort':
          if (agent.session.header.origin === 'subagent') {
            throw new SessionControlsError(409, 'The session is owned by subagent routing')
          }
          if (!(value === null || typeof value === 'string' && this.#efforts(route).includes(value))) return valid(field)
          nextSelection = { provider: route.provider, model: route.model, ...(value !== null && { reasoningEffort: value }) }
          break
        default:
          return valid(field)
      }
    }
    return { route, patch, nextSelection }
  }

  checkChange(request: Change) {
    const agent = this.#agentFor(request)
    if (agent.status !== 'idle') throw new SessionControlsError(409, 'The session is running')
    if (!agent.runMaintenance) throw new SessionControlsError(503, 'Session controls are unavailable')
    this.#change(agent, request)
    return { agent, reserve: agent.runMaintenance.bind(agent) }
  }

  #commit(agent: SessionControlsAgent, request: Change, route: SessionControlRoute,
    patch: SessionControlsSelection, nextSelection: SessionModelSelection | undefined): SessionControlsView {
    const before = agent.model.current()!
    const select = agent.model.select?.bind(agent.model)
    const restore = Object.keys(patch).length ? this.#options.store.set(request.sessionId, route, patch) : undefined
    // Let DSH deduplicate recorded selections. A matching current fallback
    // still needs to be recorded when the caller requests it explicitly.
    if (select && nextSelection) {
      try {
        select(nextSelection)
        const confirmed = agent.model.current()
        if (!sameRoute(before, confirmed) || confirmed?.reasoningEffort !== nextSelection.reasoningEffort) {
          throw new Error('Could not confirm the native model selection')
        }
      } catch (error) {
        const errors = [error]
        try { restore?.() } catch (failure) { errors.push(failure) }
        try {
          // An append can fail before changing the selection. If it did change,
          // compensate only while the selection still belongs to this batch.
          const actual = agent.model.current()
          if (!sameRoute(before, actual) || actual?.reasoningEffort !== before.reasoningEffort) {
            if (sameRoute(nextSelection, actual) && actual?.reasoningEffort === nextSelection.reasoningEffort) {
              select(before)
            }
            const current = agent.model.current()
            if (!sameRoute(before, current) || current?.reasoningEffort !== before.reasoningEffort) {
              throw new Error('Could not restore the native model selection')
            }
          }
        } catch (failure) { errors.push(failure) }
        if (errors.length > 1) throw new SessionControlsUncertainError(errors)
        throw error
      }
      // Match native selectModel: default persistence is a background side effect.
      try {
        this.#options.saveDefaultSelection?.(nextSelection)?.catch((error) => this.#options.warn(error))
      } catch (error) {
        this.#options.warn(error)
      }
    }
    revisionSeeds.delete(agent)
    const snapshot = this.#enabled(route) ? this.#options.store.peek(request.sessionId, route) : undefined
    return this.#view(agent, route, snapshot)
  }

  set(request: Change, requestSignal: AbortSignal, getCurrent: () => SessionControls): Promise<SessionControlsView> {
    const { agent, reserve } = this.checkChange(request)
    try {
      return reserve(async (signal) => {
        const active = AbortSignal.any([requestSignal, signal])
        const checkActive = () => {
          if (active.aborted || getCurrent() !== this || this.#agentFor(request) !== agent) {
            throw new SessionControlsError(409, 'The session or its controls changed')
          }
        }
        const view = (route: SessionControlRoute) => this.#view(agent, route,
          this.#enabled(route) ? this.#options.store.peek(request.sessionId, route) : undefined)
        checkActive()
        const change = this.#change(agent, request)
        if (request.batch) {
          const revision = view(change.route).revision
          if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
            throw new SessionControlsError(409, 'The session controls changed')
          }
          if (change.nextSelection) {
            try {
              // Validate the proposed effort without materializing native default effort.
              await this.#options.validateSelection?.(change.nextSelection, active)
            } catch (error) {
              checkActive()
              throw new SessionControlsError(400, error instanceof Error ? error.message : 'Invalid session model selection')
            }
            checkActive()
            if (revision !== view(change.route).revision) throw new SessionControlsError(409, 'The session controls changed')
            this.#change(agent, request)
          }
        }
        // Do not yield between the last check, preference replacement and native append.
        return this.#commit(agent, request, change.route, change.patch, change.nextSelection)
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
  const input = body as Record<string, unknown>
  const keys = Object.keys(input).filter((key) => !allowedQuery.some((id) => id === key))
  if (Object.hasOwn(input, 'changes')) {
    const { changes, expectedRevision } = input
    if (keys.some((key) => key !== 'changes' && key !== 'expectedRevision') ||
      !isRecord(changes) || Object.keys(changes).length === 0 ||
      (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !expectedRevision.trim()))) {
      throw new SessionControlsError(400, 'Invalid batch session controls input')
    }
    return { ...route, batch: true, changes, ...(expectedRevision !== undefined && { expectedRevision }) }
  }
  const { field, value } = input
  if (field !== 'speed' && field !== 'contextWindow') throw new SessionControlsError(400, 'Unknown session control')
  if (keys.some((key) => key !== 'field' && key !== 'value')) {
    throw new SessionControlsError(400, 'Unexpected session control input')
  }
  return { ...route, batch: false, changes: { [field]: value } }
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
    return reply(500, { ok: false, error: error instanceof SessionControlsUncertainError
      ? error.message : 'Could not read or save Magpie session controls' })
  }
}
