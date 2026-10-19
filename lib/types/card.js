/** A channel that never shows anything: used when the scene seam is absent. */
export class RefusingChannel {
    request() {
        return Promise.resolve({ kind: 'refused' });
    }
    active() {
        return undefined;
    }
    settle() {
        return false;
    }
    subscribe() {
        return () => { };
    }
    lastRefusal() {
        return 'no scene surface is mounted';
    }
}
/** Our own card: pending slot + scene repaint notifications. */
export class SceneChannel {
    scenes;
    sceneId;
    logger;
    pending = null;
    listeners = new Set();
    refusal;
    constructor(scenes, sceneId, logger) {
        this.scenes = scenes;
        this.sceneId = sceneId;
        this.logger = logger;
    }
    active() {
        return this.pending?.input;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    lastRefusal() {
        return this.refusal;
    }
    settle(outcome) {
        const pending = this.pending;
        if (!pending)
            return false;
        this.pending = null;
        this.refusal = outcome.kind === 'refused' ? 'the card was answered with refuse'
            : outcome.kind === 'cancelled' ? 'the card was cancelled'
                : undefined;
        pending.resolve(outcome);
        this.notify();
        return true;
    }
    request(input, options = {}) {
        this.refusal = undefined;
        if (this.pending) {
            // Fail-closed rather than queue: two cards at once would make "which answer is whose"
            // ambiguous, and a queue would hold a live promise past the caller's patience.
            this.logger?.warn(`a card for ${this.pending.input.ref} is already open; refusing ${input.ref}`);
            this.refusal = `a card for ${this.pending.input.ref} is already open`;
            return Promise.resolve({ kind: 'refused' });
        }
        const signal = options.signal;
        if (signal?.aborted) {
            this.refusal = 'the tool call was already aborted';
            return Promise.resolve({ kind: 'cancelled' });
        }
        return new Promise((resolve) => {
            this.pending = { input, resolve };
            if (!this.scenes.open(this.sceneId)) {
                // No TUI front end (headless / web), or a scene this activation may not open: never report
                // success, and clear the slot.
                this.pending = null;
                this.refusal = 'the host did not open the scene';
                this.logger?.warn('no TUI front end accepted the scene; the request is refused');
                resolve({ kind: 'refused' });
                return;
            }
            signal?.addEventListener('abort', () => {
                const dropped = this.pending;
                this.pending = null;
                this.refusal = 'the tool call was aborted';
                this.notify();
                dropped?.resolve({ kind: 'cancelled' });
            }, { once: true });
            this.notify();
        });
    }
    notify() {
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch (error) {
                this.logger?.warn(`a card listener failed: ${error?.name ?? 'unknown'}`);
            }
        }
    }
}
