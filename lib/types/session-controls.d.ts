import { type ResolvedConfig, type SessionControlRoute, type SessionControlSpeed } from './config.ts';
type Route = Pick<SessionControlRoute, 'provider' | 'model'>;
export type SessionModelSelection = Route & {
    readonly reasoningEffort?: string;
};
export type SessionControlsSelection = {
    speed?: SessionControlSpeed;
    contextWindow?: number;
};
type Field = keyof SessionControlsSelection;
type SessionRoute = Route & {
    sessionId: string;
};
type Change = SessionRoute & {
    field: Field;
    value: unknown;
};
type Choice<T> = {
    options: readonly T[];
    value: T;
};
export interface SessionControlsView {
    speed?: Choice<SessionControlSpeed>;
    contextWindow?: Choice<number>;
    efforts?: string[];
}
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
    set(id: string, route: SessionControlRoute, change: RequiredChange): SessionControlsSelection;
}
export declare function acquireSessionControlsStore(dataDir: string): {
    store: SessionControlsStore;
    release: () => void;
};
type RequiredChange = {
    speed: SessionControlSpeed;
} | {
    contextWindow: number;
};
interface SessionControlsOptions {
    config: ResolvedConfig;
    store: SessionControlsStore;
    agents: () => SessionControlsAgents | undefined;
    catalogEfforts: (model: string) => readonly string[];
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
