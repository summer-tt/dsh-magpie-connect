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
type Change = SessionRoute & { changes: Record<string, unknown>; batch: boolean; expectedRevision?: string; allowRunning?: true }
type Choice<T> = { options: readonly T[]; value: T }
type PendingWindow = { id: string; target: number; retained: number }
type WindowWarningReason = 'unavailable' | 'measurement-failed' | 'over-budget'
type WindowWarning = PendingWindow & { reason: WindowWarningReason }
type WindowState = { pendingWindow?: PendingWindow; windowWarning?: WindowWarning }
type SessionPreferences = SessionControlsSelection & WindowState

export type DraftControls = {
  speed?: Choice<SessionControlSpeed>
  contextWindow?: Choice<number>
  efforts?: string[]
}

type DraftControlsInput = Route & { controls: SessionControlsSelection }
export interface MagpieDraftModelControls {
  /** Read the route's available choices and recent defaults without accessing a Session. */
  describe(input: Route): DraftControls
  /** Proven invalid input has code `draft-model-controls-invalid`. Operational errors propagate. */
  validate(input: DraftControlsInput): void
  /** Seed explicit controls before the first prompt. Identical persisted receipts are no-ops. */
  initialize(input: DraftControlsInput & { sessionId: string }): void
}

export const DRAFT_MODEL_CONTROLS_INVALID = 'draft-model-controls-invalid'

class DraftModelControlsInvalidError extends Error {
  readonly code = DRAFT_MODEL_CONTROLS_INVALID
}

type SessionControlsChoices = DraftControls & {
  pendingWindow?: Pick<PendingWindow, 'id' | 'target'>
  windowWarning?: WindowWarning
}

export type SessionControlsView = SessionControlsChoices & (
  | { batch: true; revision: string; reasoningEffort: string | null; runningEdits?: true }
  | { batch?: never; revision?: never; reasoningEffort?: never; runningEdits?: never }
)

/** Structural subset of the DSH agent APIs used by the Host plugin. */
export interface SessionControlsAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: {
    readonly id: string
    readonly header: { readonly parentSession?: string; readonly origin?: string }
    requestHeader?(): { config: SessionModelSelection & { maxTokens?: number } } | undefined
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

interface State {
  version: 1
  recent: Record<string, SessionControlsSelection>
  sessions: Record<string, SessionPreferences>
  draftInitializations?: Record<string, DraftControlsInput>
}

function validDraftReceipt(value: unknown): value is DraftControlsInput {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string' && validSelection(value.controls)
}

function isWindowChange(value: unknown): value is PendingWindow {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    isContextWindow(value.target) && isContextWindow(value.retained) && value.target < value.retained
}

function validPreferences(value: unknown): value is SessionPreferences {
  if (!isRecord(value)) return false
  const { pendingWindow: pending, windowWarning: warning } = value
  if (!validSelection(value)) return false
  if (pending !== undefined) return warning === undefined && isWindowChange(pending)
  if (warning === undefined) return true
  if (!isRecord(warning)) return false
  const reason = warning.reason
  return isWindowChange(warning) && (reason === 'unavailable' || reason === 'measurement-failed' || reason === 'over-budget')
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
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.recent) || !Object.values(raw.recent).every(validSelection) ||
      !isRecord(raw.sessions) || !Object.values(raw.sessions).every(validPreferences) ||
      (raw.draftInitializations !== undefined && (!isRecord(raw.draftInitializations) ||
        !Object.values(raw.draftInitializations).every(validDraftReceipt)))) {
      throw new Error('Invalid session controls state')
    }
    return (this.#state = {
      version: 1,
      recent: raw.recent as State['recent'],
      sessions: raw.sessions as State['sessions'],
      draftInitializations: raw.draftInitializations as State['draftInitializations'],
    })
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

  snapshot(id: string, route: SessionControlRoute, inherited?: SessionControlsSelection): SessionPreferences {
    const state = this.#read()
    const key = sessionRouteKey(id, route)
    const existing = state.sessions[key]
    if (existing) return existing
    const initial = effectiveSelection(route, inherited ?? state.recent[routeKey(route)])
    this.#replace({ ...state, sessions: { ...state.sessions, [key]: initial } })
    return initial
  }

  peek(id: string, route: SessionControlRoute): SessionPreferences {
    const state = this.#read()
    return state.sessions[sessionRouteKey(id, route)] ?? effectiveSelection(route, state.recent[routeKey(route)])
  }

  recent(route: SessionControlRoute): SessionControlsSelection {
    return effectiveSelection(route, this.#read().recent[routeKey(route)])
  }

  initializeDraft(sessionId: string, input: DraftControlsInput, validate: () => SessionControlRoute): void {
    const state = this.#read()
    const receiptKey = JSON.stringify(sessionId)
    const { controls } = input
    const previous = state.draftInitializations?.[receiptKey]
    if (previous) {
      if (sameRoute(input, previous) && controls.speed === previous.controls.speed &&
        controls.contextWindow === previous.controls.contextWindow) return
      throw new DraftModelControlsInvalidError('This session already has a different Magpie draft initialization')
    }

    const route = validate()
    const key = sessionRouteKey(sessionId, route)
    // The Agent startup hook can already have captured the implicit defaults.
    // Preserve that snapshot for fields the draft did not set explicitly.
    const initial = state.sessions[key] ?? this.recent(route)
    const next: SessionPreferences = { ...initial, ...controls }
    if (controls.contextWindow !== undefined) {
      delete next.pendingWindow
      delete next.windowWarning
    }
    this.#replace({
      ...state,
      sessions: { ...state.sessions, [key]: next },
      draftInitializations: { ...state.draftInitializations, [receiptKey]: input },
    })
  }

  /** Replace preferences once and retain their previous state for synchronous compensation. */
  set(id: string, route: SessionControlRoute, change: SessionControlsSelection, window?: WindowState): () => void {
    const state = this.#read()
    const sessionKey = sessionRouteKey(id, route)
    const recentKey = routeKey(route)
    const previous = this.peek(id, route)
    const next = { ...previous, ...change }
    if (window !== undefined || change.contextWindow !== undefined) {
      next.pendingWindow = window?.pendingWindow
      next.windowWarning = window?.windowWarning
    }
    this.#replace({
      ...state,
      recent: Object.keys(change).length === 0 ? state.recent : {
        ...state.recent,
        [recentKey]: { ...state.recent[recentKey], ...change },
      },
      sessions: { ...state.sessions, [sessionKey]: next },
    })
    return () => this.#replace(state)
  }

  settleWindow(id: string, route: SessionControlRoute, candidate: PendingWindow, reason?: WindowWarningReason): void {
    const state = this.#read()
    const key = sessionRouteKey(id, route)
    const previous = state.sessions[key]
    if (previous?.pendingWindow?.id !== candidate.id ||
      effectiveSelection(route, previous).contextWindow !== candidate.retained) return
    const next: SessionPreferences = { ...previous, pendingWindow: undefined }
    if (reason === undefined) {
      next.contextWindow = candidate.target
      next.windowWarning = undefined
    } else {
      next.windowWarning = { ...candidate, reason }
    }
    this.#replace({ ...state, sessions: { ...state.sessions, [key]: next } })
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

type StepPosition = { agent: SessionControlsAgent; turn: number; step: number; signal: AbortSignal }
export type SessionControlsRequestStart = StepPosition
export type SessionControlsStep = StepPosition & { modelSelection: SessionModelSelection }
export type SessionControlsRequestError = StepPosition & { provider: string; failure: { code?: string } }
export type SessionControlsRequest = Route & { sessionId?: string; signal?: AbortSignal; maxTokens?: number; purpose?: string }
export type AgentLoopRequestMarker = (request: SessionControlsRequest) => boolean
export interface SessionControlsTokenMeter {
  measure(session: SessionControlsAgent['session']): { totalTokens: number }
}

type StepControls = {
  position: StepPosition
  selection: SessionModelSelection
  settings: SessionControlsSelection
  candidate?: PendingWindow
  route?: SessionControlRoute
  marker?: AgentLoopRequestMarker
  prepareMain?: boolean
  prepared?: { admitted: boolean }
  admission?: 'candidate' | 'rejected' | 'fallback' | 'checked' | 'blocked'
}

const REPREPARE_WINDOW = 'MAGPIE_REPREPARE_SESSION_WINDOW'
export const WINDOW_BUDGET_FAILED = 'MAGPIE_SESSION_WINDOW_BUDGET_FAILED'

function matchesPosition(step: StepControls, position: StepPosition): boolean {
  return step.position.signal === position.signal && step.position.turn === position.turn && step.position.step === position.step
}

interface SessionControlsOptions {
  config: ResolvedConfig
  store: SessionControlsStore
  agents: () => SessionControlsAgents | undefined
  catalogEfforts: (model: string) => readonly string[]
  catalogHasModel?: (model: string) => boolean
  draftCatalogStatus?: (model: string) => 'available' | 'unavailable' | 'pending'
  requestMarker?: () => AgentLoopRequestMarker | undefined
  tokenMeter?: () => SessionControlsTokenMeter | undefined
  validateSelection?: (selection: SessionModelSelection, signal: AbortSignal) => Promise<unknown>
  saveDefaultSelection?: (selection: SessionModelSelection) => Promise<void> | undefined
  warn: (error: unknown) => void
}

// Stable across overlapping plugin generations. Replacing an Agent or completing
// a write invalidates its prior revision even if its choices are unchanged.
const revisionSeeds = new WeakMap<SessionControlsAgent, string>()
// New Host generations can take over while a prepared request is still in flight.
const stepControls = new WeakMap<SessionControlsAgent, StepControls>()

function revisionFor(agent: SessionControlsAgent, route: Route, view: SessionControlsChoices, reasoningEffort: string | null,
  generation: string): string {
  const seed = revisionSeeds.get(agent) ?? randomUUID()
  revisionSeeds.set(agent, seed)
  return createHash('sha256').update(JSON.stringify([generation, seed, route.provider, route.model, view, reasoningEffort])).digest('base64url')
}

export class SessionControls {
  readonly #capabilities = new Map<string, SessionControlRoute>()
  readonly #stepRoutes = new WeakMap<SessionControlsAgent, SessionModelSelection>()
  readonly #options: SessionControlsOptions
  readonly #generation = randomUUID()

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

  describeDraft(input: Route): DraftControls {
    const route = this.#capabilities.get(routeKey(input))
    if (!route || this.#options.draftCatalogStatus?.(route.model) !== 'available') return {}
    const recent = this.#enabled(route) ? this.#options.store.recent(route) : undefined
    return this.#choices(route, recent)
  }

  #draftSelection(input: DraftControlsInput): SessionControlsSelection {
    if (!isRecord(input) || typeof input.provider !== 'string' || !input.provider.trim() ||
      typeof input.model !== 'string' || !input.model.trim()) {
      throw new DraftModelControlsInvalidError('Expected a Magpie provider and model')
    }
    const { controls } = input
    if (!validSelection(controls) || Object.keys(controls).some((field) => field !== 'speed' && field !== 'contextWindow')) {
      throw new DraftModelControlsInvalidError('Invalid Magpie draft controls')
    }
    const { speed, contextWindow } = controls
    return { ...(speed !== undefined && { speed }), ...(contextWindow !== undefined && { contextWindow }) }
  }

  #validateDraftRoute(input: DraftControlsInput): SessionControlRoute {
    const route = this.#capabilities.get(routeKey(input))
    if (route === undefined) throw new DraftModelControlsInvalidError('Magpie draft controls are unavailable for this model')
    for (const [field, value] of Object.entries(input.controls)) {
      if (!this.#allowsChoice(route, field, value)) {
        throw new DraftModelControlsInvalidError(`Invalid or unavailable Magpie draft control: ${field}`)
      }
    }
    const status = this.#options.draftCatalogStatus?.(route.model)
    if (status === 'unavailable') throw new DraftModelControlsInvalidError('The Magpie model is not available')
    if (status !== 'available') throw new Error('Magpie model catalog is not ready')
    return route
  }

  validateDraft(input: DraftControlsInput): void {
    const controls = this.#draftSelection(input)
    if (Object.keys(controls).length > 0) this.#validateDraftRoute({ ...input, controls })
  }

  initializeDraft(input: DraftControlsInput & { sessionId: string }): void {
    const controls = this.#draftSelection(input)
    if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
      throw new DraftModelControlsInvalidError('Expected a Session ID for Magpie draft initialization')
    }
    if (Object.keys(controls).length === 0) return
    const draft = { provider: input.provider, model: input.model, controls }
    this.#options.store.initializeDraft(input.sessionId, draft, () => this.#validateDraftRoute(draft))
  }

  #enabled(route: SessionControlRoute | undefined): boolean {
    return !!route && (
      (this.#options.config.sessionSpeedEnabled && route.speed !== undefined) ||
      (this.#options.config.sessionContextWindowEnabled && route.contextWindow !== undefined)
    )
  }

  /** Capture the step already underway even if a new model is selected for the next step. */
  observeStep(agent: SessionControlsAgent, modelSelection: SessionModelSelection, position?: StepPosition): void {
    this.#stepRoutes.set(agent, modelSelection)
    if (!position) return
    const previous = stepControls.get(agent)
    if (previous && matchesPosition(previous, position)) return
    stepControls.delete(agent)
    const route = this.#capabilities.get(routeKey(modelSelection))
    if (!route || !this.#enabled(route)) return
    try {
      const snapshot = this.#options.store.snapshot(agent.id, route)
      const settings = this.#enabledSelection(route, snapshot)
      const step: StepControls = { position, selection: modelSelection, settings, route }
      stepControls.set(agent, step)
      const candidate = snapshot.pendingWindow
      if (!candidate || candidate.retained !== settings.contextWindow || !route.contextWindow?.options.includes(candidate.target)) return
      const marker = this.#options.requestMarker?.()
      if (!marker || !this.#options.tokenMeter?.()?.measure) {
        this.#options.store.settleWindow(agent.id, route, candidate, 'unavailable')
        return
      }
      step.marker = marker
      step.candidate = candidate
      step.admission = 'candidate'
      step.settings = { ...settings, contextWindow: candidate.target }
    } catch (error) {
      this.#options.warn(error)
    }
  }

  observeIdle(agent: SessionControlsAgent): void {
    this.#stepRoutes.delete(agent)
    stepControls.delete(agent)
  }

  #canCheckWindow(): boolean {
    return typeof this.#options.requestMarker?.() === 'function' && typeof this.#options.tokenMeter?.()?.measure === 'function'
  }

  prepareMainRequest(event: SessionControlsRequestStart): void {
    const step = stepControls.get(event.agent)
    if (step?.candidate && matchesPosition(step, event)) {
      step.prepareMain = true
      step.prepared = undefined
    }
  }

  /** Gate only the loop-built main request after DSH records its final envelope. */
  async *guardStream<T>(request: SessionControlsRequest, next: () => AsyncIterable<T>): AsyncGenerator<T | {
    type: 'finish'; reason: { kind: 'error'; failure: { code: string; message: string } }
  }> {
    const agent = this.#options.agents()?.currentInitiator?.()
    const step = agent && stepControls.get(agent)
    if (!agent || !step?.candidate || !step.route || request.purpose !== undefined || request.sessionId !== agent.session.id ||
      request.signal !== step.position.signal || !sameRoute(request, step.selection) ||
      !step.marker?.(request)) {
      yield* next()
      return
    }
    let reason: WindowWarningReason | undefined
    if (step.admission === 'candidate' || step.admission === 'fallback' || step.admission === 'checked') {
      reason = step.prepared ? this.#budgetFailure(agent, request, step.settings.contextWindow!) : 'measurement-failed'
    }
    if (step.admission === 'candidate') {
      try {
        this.#options.store.settleWindow(agent.id, step.route, step.candidate, reason)
      } catch (error) {
        this.#options.warn(error)
        reason ??= 'measurement-failed'
      }
      if (reason !== undefined) {
        step.admission = 'rejected'
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: REPREPARE_WINDOW, message: 'Magpie could not use the requested context window',
        } } }
        return
      }
    }
    if (reason !== undefined || step.admission === 'blocked' || step.admission === 'rejected') {
      step.admission = 'blocked'
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: WINDOW_BUDGET_FAILED, message: 'Magpie could not verify that the request fits the retained context window',
      } } }
      return
    }
    step.admission = 'checked'
    if (step.prepared) step.prepared.admitted = true
    yield* next()
  }

  #budgetFailure(agent: SessionControlsAgent, request: SessionControlsRequest, window: number): WindowWarningReason | undefined {
    try {
      const header = agent.session.requestHeader?.()
      const output = request.maxTokens
      if (!header || !sameRoute(request, header.config) || output === undefined ||
        !Number.isSafeInteger(output) || output <= 0 || header.config.maxTokens !== output) return 'measurement-failed'
      const input = this.#options.tokenMeter?.()?.measure(agent.session).totalTokens
      if (input === undefined || !Number.isFinite(input) || input < 0) return 'measurement-failed'
      return input + output > window ? 'over-budget' : undefined
    } catch (error) {
      this.#options.warn(error)
      return 'measurement-failed'
    }
  }

  retryWindow(event: SessionControlsRequestError): { kind: 'retry' } | undefined {
    if (event.failure.code !== REPREPARE_WINDOW || event.signal.aborted) return undefined
    const step = stepControls.get(event.agent)
    if (!step?.candidate || step.admission !== 'rejected' || !matchesPosition(step, event) ||
      event.provider !== step.selection.provider) return undefined
    step.settings = { ...step.settings, contextWindow: step.candidate.retained }
    step.admission = 'fallback'
    return { kind: 'retry' }
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

  #enabledSelection(route: SessionControlRoute, selection?: SessionControlsSelection): SessionControlsSelection {
    const value = effectiveSelection(route, selection)
    return {
      ...(this.#options.config.sessionSpeedEnabled && value.speed !== undefined && { speed: value.speed }),
      ...(this.#options.config.sessionContextWindowEnabled && value.contextWindow !== undefined && { contextWindow: value.contextWindow }),
    }
  }

  resolve(provider: string, model: string, sessionId?: string, signal?: AbortSignal,
    phase: 'model' | 'prepare' | 'stream' = 'model'): SessionControlsSelection & { canDispatch?: () => boolean } {
    if (!sessionId) return {}
    const address = { provider, model }
    const route = this.#capabilities.get(routeKey(address))
    try {
      const agent = this.#options.agents()?.currentInitiator?.()
      const step = agent && stepControls.get(agent)
      if (step && agent?.session.id === sessionId && !step.position.signal.aborted &&
        (signal === undefined || signal === step.position.signal) && sameRoute(address, step.selection)) {
        if (!step.candidate || phase === 'model') return step.settings
        if (phase === 'prepare' && step.prepareMain && signal === step.position.signal) {
          step.prepareMain = false
          const prepared = { admitted: false }
          step.prepared = prepared
          return { ...step.settings, canDispatch: () => prepared.admitted }
        }
        // Unmarked auxiliary calls use the retained window. Native pressure
        // reads the prospective window through resolveModel above.
        return { ...step.settings, contextWindow: step.candidate.retained }
      }
      if (!route || !this.#enabled(route)) return {}
      return this.#enabledSelection(route, this.#options.store.snapshot(sessionId, route))
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

  #supportsRunningEdits(route: SessionControlRoute): boolean {
    return this.#options.catalogHasModel !== undefined && this.#capabilities.has(routeKey(route))
  }

  #allowsChoice(route: SessionControlRoute, field: string, value: unknown): boolean {
    switch (field) {
      case 'speed':
        return this.#options.config.sessionSpeedEnabled && isSessionControlSpeed(value) &&
          route.speed?.options.includes(value) === true
      case 'contextWindow':
        return this.#options.config.sessionContextWindowEnabled && isContextWindow(value) &&
          route.contextWindow?.options.includes(value) === true
      default:
        return false
    }
  }

  #choices(route: SessionControlRoute, selection?: SessionControlsSelection): DraftControls {
    const choices: DraftControls = {}
    const value = this.#enabledSelection(route, selection)
    if (route.speed && value.speed !== undefined) {
      choices.speed = { options: [...route.speed.options], value: value.speed }
    }
    if (route.contextWindow && value.contextWindow !== undefined) {
      choices.contextWindow = { options: [...route.contextWindow.options], value: value.contextWindow }
    }
    if (route.efforts !== undefined) choices.efforts = this.#efforts(route)
    return choices
  }

  #view(agent: SessionControlsAgent, route: SessionControlRoute, selection?: SessionPreferences): SessionControlsView {
    const view: SessionControlsChoices = this.#choices(route, selection)
    const efforts = view.efforts ?? this.#efforts(route)
    if (!this.#supportsBatch(agent, route)) return view
    const runningEdits = this.#supportsRunningEdits(route)
    const retained = view.contextWindow?.value
    if (runningEdits && retained !== undefined) {
      const pending = selection?.pendingWindow
      const warning = selection?.windowWarning
      if (pending?.retained === retained && route.contextWindow?.options.includes(pending.target)) {
        view.pendingWindow = { id: pending.id, target: pending.target }
      }
      if (warning?.retained === retained) view.windowWarning = warning
    }
    const reasoningEffort = agent.model.current()?.reasoningEffort ?? null
    return {
      ...view, batch: true, revision: revisionFor(agent, route, { ...view, efforts }, reasoningEffort, this.#generation),
      reasoningEffort, ...(runningEdits && { runningEdits: true }),
    }
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
          if (!this.#allowsChoice(route, field, value)) return valid(field)
          patch.speed = value as SessionControlSpeed
          break
        case 'contextWindow':
          if (!this.#allowsChoice(route, field, value)) return valid(field)
          patch.contextWindow = value as number
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
    patch: SessionControlsSelection, nextSelection: SessionModelSelection | undefined, running = false): SessionControlsView {
    const before = agent.model.current()!
    const select = agent.model.select?.bind(agent.model)
    let window: WindowState | undefined
    if (running && patch.contextWindow !== undefined) {
      const target = patch.contextWindow
      const retained = effectiveSelection(route, this.#options.store.peek(request.sessionId, route)).contextWindow!
      if (target <= retained) {
        delete patch.contextWindow
        window = {}
        if (target < retained) {
          const candidate = { id: randomUUID(), target, retained }
          window = this.#canCheckWindow() ? { pendingWindow: candidate } : { windowWarning: { ...candidate, reason: 'unavailable' } }
        }
      }
    }
    const restore = window !== undefined || Object.keys(patch).length > 0
      ? this.#options.store.set(request.sessionId, route, patch, window) : undefined
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

  get usesLocalCatalog(): boolean {
    return this.#options.catalogHasModel !== undefined
  }

  setAllowRunning(request: Change, requestSignal: AbortSignal, getCurrent: () => SessionControls): SessionControlsView | Promise<SessionControlsView> {
    const agent = this.#agentFor(request)
    const commit = (signal: AbortSignal, running: boolean): SessionControlsView => {
      if (requestSignal.aborted || signal.aborted || getCurrent() !== this || this.#agentFor(request) !== agent) {
        throw new SessionControlsError(409, 'The session or its controls changed')
      }
      const { route, patch, nextSelection } = this.#change(agent, request)
      if (!this.#supportsRunningEdits(route)) throw new SessionControlsError(400, 'Running session controls are unavailable for this model')
      if (!this.#options.catalogHasModel?.(route.model)) throw new SessionControlsError(400, 'Select an available model before changing session controls')
      const snapshot = this.#enabled(route) ? this.#options.store.peek(request.sessionId, route) : undefined
      if (request.expectedRevision !== this.#view(agent, route, snapshot).revision) {
        throw new SessionControlsError(409, 'The session controls changed')
      }
      return this.#commit(agent, request, route, patch, nextSelection, running)
    }
    if (agent.status === 'running') return commit(requestSignal, true)
    const { reserve } = this.checkChange(request)
    try {
      return reserve(async (signal) => commit(signal, false))
    } catch {
      throw new SessionControlsError(409, 'The session has active work')
    }
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
    const { changes, expectedRevision, allowRunning } = input
    if (keys.some((key) => key !== 'changes' && key !== 'expectedRevision' && key !== 'allowRunning') ||
      !isRecord(changes) || Object.keys(changes).length === 0 ||
      (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !expectedRevision.trim())) ||
      (allowRunning !== undefined && (allowRunning !== true || expectedRevision === undefined))) {
      throw new SessionControlsError(400, 'Invalid batch session controls input')
    }
    return { ...route, batch: true, changes, expectedRevision, allowRunning }
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
      const controls = getCurrent()
      if (change.allowRunning) {
        value = await controls.setAllowRunning(change, request.signal, getCurrent)
      } else {
        controls.checkChange(change)
        const write = writeQueue.then(() => {
          if (request.signal.aborted) throw new SessionControlsError(409, 'Session control request was cancelled')
          return getCurrent().set(change, request.signal, getCurrent)
        })
        writeQueue = write.catch(() => {})
        value = await write
      }
    } else {
      if (!getCurrent().usesLocalCatalog) await writeQueue
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
