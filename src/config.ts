/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 *
 * The adapter registers a DSH LlmAdapter streaming directly from the Magpie
 * Magpie gateway (the configured API root): chat completions for most models plus the
 * Responses API for responses-only models. No child process, no proxy/pool.
 * The gateway needs no credential — `apiKey` defaults to a sentinel that
 * satisfies the pi-ai client without changing the wire.
 *
 * The settings sidebar page can override `baseUrl`/`apiKey` at runtime (saved
 * to `<dataDir>/settings.json`, applied without restart) and hides models
 * from the picker. Page values win per-field; patch config is the fallback.
 */
import { dshHomePath } from './homeDir.ts'
import type { MagpieSearchMode } from './settings.ts'

export const SESSION_CONTROL_SPEEDS = ['standard', 'fast', 'ultrafast'] as const
export type SessionControlSpeed = (typeof SESSION_CONTROL_SPEEDS)[number]

export interface SessionControlOptions<T> {
  readonly options: readonly T[]
  readonly default: T
}

export interface SessionControlRoute {
  readonly provider: string
  readonly model: string
  readonly speed?: SessionControlOptions<SessionControlSpeed>
  readonly contextWindow?: SessionControlOptions<number>
  /** Optional allowlist applied to this route's catalog reasoning efforts. */
  readonly efforts?: readonly string[]
}

export interface DshMagpieConnectConfig {
  /**
   * Provider route id registered into DSH (the grouping key in the model
   * picker). Changing it after sessions already reference the old id will
   * orphan those model selections — prefer `displayName` for a cosmetic
   * rename.
   */
  providerId?: string
  /**
   * Display name shown in the model picker for this provider.
   * Defaults to the explicit `providerId` when one is given,
   * otherwise to `'Magpie'`.
   */
  displayName?: string
  /**
   * Versioned API root, e.g. `http://127.0.0.1:3425/v1`. The version is part of
   * the value, not something this plugin adds: a gateway that later serves
   * `/v2` or `/v3` is reached by changing this one string. Trailing slashes are
   * stripped; the path is kept.
   */
  baseUrl?: string
  /**
   * Gateway credential. Required: an empty key leaves the plugin unconfigured
   * even though `baseUrl` has a default, so the picker stays empty until it is
   * set (both are required by `isConfigured`).
   */
  apiKey?: string
  /**
   * Plugin state directory (status snapshot, settings file, catalog cache).
   * Defaults to `$DSH_HOME/storages/magpie-connect`
   * (`~/.dsh/storages/magpie-connect`).
   */
  dataDir?: string
  /** Model list refresh interval in seconds. */
  refreshSeconds?: number
  /**
   * Connection-setup retries for transient upstream failures (429/5xx with
   * backoff). Turn-level retries stay owned by DSH.
   */
  maxRetries?: number
  /** Overall upstream request cap in milliseconds. */
  timeoutMs?: number
  /**
   * Stall watchdog: max wait for the first upstream event in milliseconds
   * (queueing happens here). Non-positive disables that phase.
   */
  firstEventTimeoutMs?: number
  /**
   * Stall watchdog: max silence between upstream events in milliseconds.
   * Non-positive disables that phase.
   */
  idleTimeoutMs?: number
  /** 网页搜索模式：`'mcp'` 使用 Magpie 网关原生 MCP 搜索，`'model'` 通过 `/messages` 调用指定模型搜索。 */
  searchMode?: MagpieSearchMode
  /** `'model'` 搜索模式下使用的 Magpie 模型 ID（留空时需在设置页选择）。 */
  searchModel?: string
  /** `'model'` 搜索模式下单次请求最多触发 `web_search` 工具的次数（正整数，默认 5）。 */
  searchMaxUses?: number
  /** 单次网页搜索请求超时（毫秒，默认 120000）。 */
  searchTimeoutMs?: number
  /**
   * Per-tool-call timeout (ms) for the Magpie MCP hub registered into DSH's
   * `ctx.mcpManager` when the settings page enables it. Hub tool calls can be
   * slow (a search, a browser action), so this is looser than DSH's 60s default.
   * Defaults to 120000.
   */
  mcpToolCallTimeoutMs?: number
  /**
   * The Magpie Library agent the hub URL names — the segment after
   * `/mcp/magpie/hub/`. Unset (`''`) means `dsh` (Magpie's built-in DSH agent,
   * shown in the Library as "DeepSeek Harness"). Magpie v0.1.4808+ answers a
   * known agent's address with its on-demand set (`find_tools`/`call_tool`/
   * `run_code`) past 10 tools, on a local or a remote install alike. Set `all`
   * to force the all-apps address `/mcp/magpie/hub` (every server, the plugin
   * does the on-demand); an agent address that lists nothing also falls back
   * there, which is how an older Magpie keeps working.
   */
  mcpAgent?: string
  /** Enable per-session request speed on supported routes. Defaults to true. */
  sessionSpeedEnabled?: boolean
  /** Enable per-session context budgets on supported routes. Defaults to true. */
  sessionContextWindowEnabled?: boolean
  /** Exact provider/model capabilities. An explicit list replaces the built-in routes. */
  sessionControlRoutes?: readonly SessionControlRoute[]
}

const defaultSessionControlRoutes: readonly SessionControlRoute[] = [
  'codex/gpt-6.2-sol',
  'codex/gpt-6.2-astra',
].map((model) => ({
  provider: 'magpie',
  model,
  speed: { options: SESSION_CONTROL_SPEEDS, default: 'fast' },
  contextWindow: { options: [272_000, 500_000, 872_000], default: 500_000 },
}))

export function isSessionControlSpeed(value: unknown): value is SessionControlSpeed {
  return SESSION_CONTROL_SPEEDS.some((speed) => speed === value)
}

export function isContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validOptions<T>(value: unknown, valid: (item: unknown) => item is T): value is SessionControlOptions<T> {
  if (!isRecord(value) || !Array.isArray(value.options)) return false
  const { options } = value
  return options.length > 0 && [...options].every(valid) && new Set(options).size === options.length &&
    valid(value.default) && options.includes(value.default)
}

function validateSessionControlConfig(config: DshMagpieConnectConfig): void {
  for (const key of ['sessionSpeedEnabled', 'sessionContextWindowEnabled'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
  }
  const routes = config.sessionControlRoutes
  if (routes === undefined) return
  if (!Array.isArray(routes)) throw new Error('sessionControlRoutes must be an array')
  const seen = new Set<string>()
  for (const [index, route] of routes.entries()) {
    const key = `sessionControlRoutes[${index}]`
    if (!isRecord(route) || !isNonemptyString(route.provider) || !isNonemptyString(route.model)) {
      throw new Error(`${key} must specify a provider and model`)
    }
    const id = JSON.stringify([route.provider, route.model])
    if (seen.has(id)) throw new Error(`${key} duplicates the provider/model route`)
    seen.add(id)
    if (route.speed !== undefined && !validOptions(route.speed, isSessionControlSpeed)) {
      throw new Error(`${key}.speed needs distinct speed options and a default included in them`)
    }
    if (route.contextWindow !== undefined && !validOptions(route.contextWindow, isContextWindow)) {
      throw new Error(`${key}.contextWindow needs distinct positive integer options and a default included in them`)
    }
    if (route.efforts !== undefined && (!Array.isArray(route.efforts) || ![...route.efforts].every(isNonemptyString))) {
      throw new Error(`${key}.efforts must be an array of nonempty strings`)
    }
  }
}

/** Cordis Standard Schema. Existing settings still use their original normalization. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-magpie-connect',
    validate(value: unknown): { value: DshMagpieConnectConfig } | { issues: { message: string }[] } {
      if (value === undefined) return { value: {} }
      if (!isRecord(value)) return { issues: [{ message: 'Expected a Magpie configuration object' }] }
      try {
        validateSessionControlConfig(value)
        return { value }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}

export const defaults = {
  providerId: 'dsh-magpie-connect',
  displayName: 'Magpie',
  baseUrl: 'http://127.0.0.1:3425/v1',
  apiKey: '',
  refreshSeconds: 300,
  maxRetries: 2,
  timeoutMs: 300_000,
  firstEventTimeoutMs: 90_000,
  idleTimeoutMs: 60_000,
  searchMode: 'mcp' as MagpieSearchMode,
  searchModel: '',
  searchMaxUses: 5,
  searchTimeoutMs: 120_000,
  mcpToolCallTimeoutMs: 120_000,
  mcpAgent: '',
  sessionSpeedEnabled: true,
  sessionContextWindowEnabled: true,
  sessionControlRoutes: defaultSessionControlRoutes,
} as const

type RequiredConfig = 'providerId' | 'refreshSeconds' | 'searchMode' | 'searchModel' | 'searchMaxUses' | 'searchTimeoutMs' | 'mcpToolCallTimeoutMs' | 'mcpAgent'
  | 'sessionSpeedEnabled' | 'sessionContextWindowEnabled' | 'sessionControlRoutes'

export type ResolvedConfig = Required<Pick<DshMagpieConnectConfig, RequiredConfig>> &
  DshMagpieConnectConfig & { displayName: string; baseUrl: string; apiKey: string; dataDir: string }

export function resolveConfig(config: DshMagpieConnectConfig = {}): ResolvedConfig {
  validateSessionControlConfig(config)
  const providerId = config.providerId ?? defaults.providerId
  return {
    ...defaults,
    ...config,
    providerId,
    displayName: config.displayName ?? (config.providerId ?? defaults.displayName),
    baseUrl: config.baseUrl ?? defaults.baseUrl,
    apiKey: config.apiKey ?? defaults.apiKey,
    dataDir: config.dataDir ?? dshHomePath('storages', 'magpie-connect'),
    searchMode: config.searchMode === 'model' ? 'model' : defaults.searchMode,
    searchModel: typeof config.searchModel === 'string' ? config.searchModel.trim() : defaults.searchModel,
    searchMaxUses:
      typeof config.searchMaxUses === 'number' && Number.isInteger(config.searchMaxUses) && config.searchMaxUses > 0
        ? config.searchMaxUses
        : defaults.searchMaxUses,
    searchTimeoutMs:
      typeof config.searchTimeoutMs === 'number' && Number.isFinite(config.searchTimeoutMs) && config.searchTimeoutMs > 0
        ? Math.floor(config.searchTimeoutMs)
        : defaults.searchTimeoutMs,
    mcpToolCallTimeoutMs:
      typeof config.mcpToolCallTimeoutMs === 'number' &&
      Number.isFinite(config.mcpToolCallTimeoutMs) &&
      config.mcpToolCallTimeoutMs > 0
        ? Math.floor(config.mcpToolCallTimeoutMs)
        : defaults.mcpToolCallTimeoutMs,
    // Normalized in mcp.ts; here keep the raw string so '' (all-apps) survives.
    mcpAgent: typeof config.mcpAgent === 'string' ? config.mcpAgent : defaults.mcpAgent,
    sessionSpeedEnabled: config.sessionSpeedEnabled ?? defaults.sessionSpeedEnabled,
    sessionContextWindowEnabled: config.sessionContextWindowEnabled ?? defaults.sessionContextWindowEnabled,
    sessionControlRoutes: config.sessionControlRoutes ?? defaults.sessionControlRoutes,
  }
}
