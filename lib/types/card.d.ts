import type { Scope } from './store.js';
/** What the human decided. A value never crosses this boundary. */
export type CardOutcome = {
    kind: 'stored';
    scope: Scope;
} | {
    kind: 'cancelled';
} | {
    kind: 'refused';
};
/** What the agent asked for; shown on the card. `sessionId` is the judge for `scope: session`. */
export interface CardRequest {
    ref: string;
    purpose: string;
    sessionId?: string | undefined;
}
export interface CardChannel {
    /** Ask the human. Resolves once the card is submitted, refused or cancelled. */
    request(input: CardRequest, options?: {
        signal?: AbortSignal;
    }): Promise<CardOutcome>;
    /** The request currently waiting for an answer, if any (the scene reads this each render). */
    active(): CardRequest | undefined;
    /** Called by the scene when the human acted. Returns false when nothing was pending. */
    settle(outcome: CardOutcome): boolean;
    /** Subscribe to "a card appeared or went away" so the scene can repaint. */
    subscribe(listener: () => void): () => void;
    /**
     * Why the last request produced no card, as a short reason code, or nothing when a card was
     * answered by a human. Never contains a value: only the tool's debug note reads this.
     */
    lastRefusal(): string | undefined;
}
/** The only scene seam we need. */
export interface ScenesSeam {
    open(id: string): boolean;
}
/** A channel that never shows anything: used when the scene seam is absent. */
export declare class RefusingChannel implements CardChannel {
    request(): Promise<CardOutcome>;
    active(): CardRequest | undefined;
    settle(): boolean;
    subscribe(): () => void;
    lastRefusal(): string | undefined;
}
/** Our own card: pending slot + scene repaint notifications. */
export declare class SceneChannel implements CardChannel {
    private readonly scenes;
    private readonly sceneId;
    private readonly logger?;
    private pending;
    private readonly listeners;
    private refusal;
    constructor(scenes: ScenesSeam, sceneId: string, logger?: {
        info(message: string): void;
        warn(message: string): void;
    } | undefined);
    active(): CardRequest | undefined;
    subscribe(listener: () => void): () => void;
    lastRefusal(): string | undefined;
    settle(outcome: CardOutcome): boolean;
    request(input: CardRequest, options?: {
        signal?: AbortSignal;
    }): Promise<CardOutcome>;
    private notify;
}
