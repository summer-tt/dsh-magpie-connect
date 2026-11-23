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
};
type Choice<T> = {
    options: readonly T[];
    value: T;
};
type SessionControlsChoices = {
    speed?: Choice<SessionControlSpeed>;
    contextWindow?: Choice<number>;
    efforts?: string[];
};
export type SessionControlsView = SessionControlsChoices & ({
    batch: true;
    revision: string;
    reasoningEffort: string | null;
} | {
    batch?: never;
    revision?: never;
    reasoningEffort?: never;
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
            config: SessionModelSelection;
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
    snapshot(id: string, route: SessionControlRoute, inherited?: SessionControlsSelection): SessionControlsSelection;
    peek(id: string, route: SessionControlRoute): SessionControlsSelection;
    /** Replace both preferences once and retain their previous state for synchronous compensation. */
    set(id: string, route: SessionControlRoute, change: SessionControlsSelection): () => void;
}
export declare function acquireSessionControlsStore(dataDir: string): {
    store: SessionControlsStore;
    release: () => void;
};
interface SessionControlsOptions {
    config: ResolvedConfig;
    store: SessionControlsStore;
    agents: () => SessionControlsAgents | undefined;
    catalogEfforts: (model: string) => readonly string[];
    validateSelection?: (selection: SessionModelSelection, signal: AbortSignal) => Promise<unknown>;
    saveDefaultSelection?: (selection: SessionModelSelection) => Promise<void> | undefined;
    warn: (error: unknown) => void;
}
export declare class SessionControls {
    #private;
    constructor(options: SessionControlsOptions);
    allowedEfforts(provider: string, model: string): readonly string[] | undefined;
    /** Capture the step already underway even if a new model is selected for the next step. */
    observeStep(agent: SessionControlsAgent, modelSelection: SessionModelSelection): void;
    observeIdle(agent: SessionControlsAgent): void;
    initiatorReasoningEffort(provider: string, model: string): string | undefined;
    onCreated({ agent, source, signal }: SessionControlsCreated): void;
    resolve(provider: string, model: string, sessionId?: string): SessionControlsSelection;
    get(request: SessionRoute): SessionControlsView;
    checkChange(request: Change): {
        agent: SessionControlsAgent;
        reserve: <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    };
    set(request: Change, requestSignal: AbortSignal, getCurrent: () => SessionControls): Promise<SessionControlsView>;
}
/** The DSH exact Fetch registry restricts both methods to authenticated owner Peers. */
export declare function handleSessionControls(request: Request, getCurrent: () => SessionControls, warn: (error: unknown) => void): Promise<Response>;
export {};
