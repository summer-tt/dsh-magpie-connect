import { type ResolvedConfig, type SessionControlRoute, type SessionControlSpeed } from './config.ts';
type Route = Pick<SessionControlRoute, 'provider' | 'model'>;
export type SessionModelSelection = Route & {
    readonly reasoningEffort?: string;
};
export type SessionControlsSelection = {
    speed?: SessionControlSpeed;
    contextWindow?: number;
};
type SessionRoute = Route & {
    sessionId: string;
};
type Change = SessionRoute & {
    changes: Record<string, unknown>;
    batch: boolean;
    expectedRevision?: string;
    allowRunning?: true;
};
type Choice<T> = {
    options: readonly T[];
    value: T;
};
type PendingWindow = {
    id: string;
    target: number;
    retained: number;
};
type WindowWarningReason = 'unavailable' | 'measurement-failed' | 'over-budget';
type WindowWarning = PendingWindow & {
    reason: WindowWarningReason;
};
type WindowState = {
    pendingWindow?: PendingWindow;
    windowWarning?: WindowWarning;
};
type SessionPreferences = SessionControlsSelection & WindowState;
export type DraftControls = {
    speed?: Choice<SessionControlSpeed>;
    contextWindow?: Choice<number>;
    efforts?: string[];
};
type DraftControlsInput = Route & {
    controls: SessionControlsSelection;
};
export interface MagpieDraftModelControls {
    /** Read the route's available choices and recent defaults without accessing a Session. */
    describe(input: Route): DraftControls;
    /** Proven invalid input has code `draft-model-controls-invalid`. Operational errors propagate. */
    validate(input: DraftControlsInput): void;
    /** Seed explicit controls before the first prompt. Identical persisted receipts are no-ops. */
    initialize(input: DraftControlsInput & {
        sessionId: string;
    }): void;
}
export declare const DRAFT_MODEL_CONTROLS_INVALID = "draft-model-controls-invalid";
type SessionControlsChoices = DraftControls & {
    pendingWindow?: Pick<PendingWindow, 'id' | 'target'>;
    windowWarning?: WindowWarning;
};
export type SessionControlsView = SessionControlsChoices & ({
    batch: true;
    revision: string;
    reasoningEffort: string | null;
    runningEdits?: true;
} | {
    batch?: never;
    revision?: never;
    reasoningEffort?: never;
    runningEdits?: never;
});
/** Structural subset of the DSH agent APIs used by the Host plugin. */
export interface SessionControlsAgent {
    readonly id: string;
    readonly status: 'idle' | 'running';
    readonly session: {
        readonly id: string;
        readonly header: {
            readonly parentSession?: string;
            readonly origin?: string;
        };
        requestHeader?(): {
            config: SessionModelSelection & {
                maxTokens?: number;
            };
        } | undefined;
    };
    readonly model: {
        current(): Readonly<SessionModelSelection> | undefined;
        select?(selection: SessionModelSelection): void;
    };
    runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface SessionControlsAgents {
    get(id: string): SessionControlsAgent | undefined;
    currentInitiator?(): SessionControlsAgent | undefined;
}
export interface SessionControlsCreated {
    agent: SessionControlsAgent;
    source: 'startup' | 'resume' | 'clear' | 'compact';
    signal?: AbortSignal;
}
/** Local owner state, shared by overlapping plugin generations in one DSH Host. */
export declare class SessionControlsStore {
    #private;
    readonly path: string;
    constructor(path: string);
    snapshot(id: string, route: SessionControlRoute, inherited?: SessionControlsSelection): SessionPreferences;
    peek(id: string, route: SessionControlRoute): SessionPreferences;
    recent(route: SessionControlRoute): SessionControlsSelection;
    initializeDraft(sessionId: string, input: DraftControlsInput, validate: () => SessionControlRoute): void;
    /** Replace preferences once and retain their previous state for synchronous compensation. */
    set(id: string, route: SessionControlRoute, change: SessionControlsSelection, window?: WindowState): () => void;
    settleWindow(id: string, route: SessionControlRoute, candidate: PendingWindow, reason?: WindowWarningReason): void;
}
export declare function acquireSessionControlsStore(dataDir: string): {
    store: SessionControlsStore;
    release: () => void;
};
type StepPosition = {
    agent: SessionControlsAgent;
    turn: number;
    step: number;
    signal: AbortSignal;
};
export type SessionControlsRequestStart = StepPosition;
export type SessionControlsStep = StepPosition & {
    modelSelection: SessionModelSelection;
};
export type SessionControlsRequestError = StepPosition & {
    provider: string;
    failure: {
        code?: string;
    };
};
export type SessionControlsRequest = Route & {
    sessionId?: string;
    signal?: AbortSignal;
    maxTokens?: number;
    purpose?: string;
};
export type AgentLoopRequestMarker = (request: SessionControlsRequest) => boolean;
export interface SessionControlsTokenMeter {
    measure(session: SessionControlsAgent['session']): {
        totalTokens: number;
    };
}
export declare const WINDOW_BUDGET_FAILED = "MAGPIE_SESSION_WINDOW_BUDGET_FAILED";
interface SessionControlsOptions {
    config: ResolvedConfig;
    store: SessionControlsStore;
    agents: () => SessionControlsAgents | undefined;
    catalogEfforts: (model: string) => readonly string[];
    catalogHasModel?: (model: string) => boolean;
    draftCatalogStatus?: (model: string) => 'available' | 'unavailable' | 'pending';
    requestMarker?: () => AgentLoopRequestMarker | undefined;
    tokenMeter?: () => SessionControlsTokenMeter | undefined;
    validateSelection?: (selection: SessionModelSelection, signal: AbortSignal) => Promise<unknown>;
    saveDefaultSelection?: (selection: SessionModelSelection) => Promise<void> | undefined;
    warn: (error: unknown) => void;
}
export declare class SessionControls {
    #private;
    constructor(options: SessionControlsOptions);
    allowedEfforts(provider: string, model: string): readonly string[] | undefined;
    describeDraft(input: Route): DraftControls;
    validateDraft(input: DraftControlsInput): void;
    initializeDraft(input: DraftControlsInput & {
        sessionId: string;
    }): void;
    /** Capture the step already underway even if a new model is selected for the next step. */
    observeStep(agent: SessionControlsAgent, modelSelection: SessionModelSelection, position?: StepPosition): void;
    observeIdle(agent: SessionControlsAgent): void;
    prepareMainRequest(event: SessionControlsRequestStart): void;
    /** Gate only the loop-built main request after DSH records its final envelope. */
    guardStream<T>(request: SessionControlsRequest, next: () => AsyncIterable<T>): AsyncGenerator<T | {
        type: 'finish';
        reason: {
            kind: 'error';
            failure: {
                code: string;
                message: string;
            };
        };
    }>;
    retryWindow(event: SessionControlsRequestError): {
        kind: 'retry';
    } | undefined;
    initiatorReasoningEffort(provider: string, model: string): string | undefined;
    onCreated({ agent, source, signal }: SessionControlsCreated): void;
    resolve(provider: string, model: string, sessionId?: string, signal?: AbortSignal, phase?: 'model' | 'prepare' | 'stream'): SessionControlsSelection & {
        canDispatch?: () => boolean;
    };
    get(request: SessionRoute): SessionControlsView;
    checkChange(request: Change): {
        agent: SessionControlsAgent;
        reserve: <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    };
    get usesLocalCatalog(): boolean;
    setAllowRunning(request: Change, requestSignal: AbortSignal, getCurrent: () => SessionControls): SessionControlsView | Promise<SessionControlsView>;
    set(request: Change, requestSignal: AbortSignal, getCurrent: () => SessionControls): Promise<SessionControlsView>;
}
/** The DSH exact Fetch registry restricts both methods to authenticated owner Peers. */
export declare function handleSessionControls(request: Request, getCurrent: () => SessionControls, warn: (error: unknown) => void): Promise<Response>;
export {};
