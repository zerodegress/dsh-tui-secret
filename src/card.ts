// The card: how a request from the agent reaches the human inside the TUI scene.
//
// Shape decision (design §2.2): we render the card ourselves — the host's scene seam is
// fire-and-forget (`open(id): boolean`), so the *result* travels through this channel's own
// pending slot plus a promise the scene resolves. No host package, no extra dependency.
//
// One card at a time: a second request while a card is open is refused (fail-closed, no
// queue), and an aborted tool call clears the slot without writing anything.
import type { Scope } from './store.js'

/** What the human decided. A value never crosses this boundary. */
export type CardOutcome =
  | { kind: 'stored'; scope: Scope }
  | { kind: 'cancelled' }
  | { kind: 'refused' }

/** What the agent asked for; shown on the card. `sessionId` is the judge for `scope: session`. */
export interface CardRequest {
  ref: string
  purpose: string
  sessionId?: string | undefined
}

export interface CardChannel {
  /** Ask the human. Resolves once the card is submitted, refused or cancelled. */
  request(input: CardRequest, options?: { signal?: AbortSignal }): Promise<CardOutcome>
  /** The request currently waiting for an answer, if any (the scene reads this each render). */
  active(): CardRequest | undefined
  /** Called by the scene when the human acted. Returns false when nothing was pending. */
  settle(outcome: CardOutcome): boolean
  /** Subscribe to "a card appeared or went away" so the scene can repaint. */
  subscribe(listener: () => void): () => void
}

/** The only scene seam we need. */
export interface ScenesSeam {
  open(id: string): boolean
}

/** A channel that never shows anything: used when the scene seam is absent. */
export class RefusingChannel implements CardChannel {
  request(): Promise<CardOutcome> {
    return Promise.resolve({ kind: 'refused' })
  }

  active(): CardRequest | undefined {
    return undefined
  }

  settle(): boolean {
    return false
  }

  subscribe(): () => void {
    return () => {}
  }
}

/** Our own card: pending slot + scene repaint notifications. */
export class SceneChannel implements CardChannel {
  private pending: { input: CardRequest; resolve: (outcome: CardOutcome) => void } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly scenes: ScenesSeam,
    private readonly sceneId: string,
    private readonly logger?: { info(message: string): void; warn(message: string): void },
  ) {}

  active(): CardRequest | undefined {
    return this.pending?.input
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  settle(outcome: CardOutcome): boolean {
    const pending = this.pending
    if (!pending) return false
    this.pending = null
    pending.resolve(outcome)
    this.notify()
    return true
  }

  request(input: CardRequest, options: { signal?: AbortSignal } = {}): Promise<CardOutcome> {
    if (this.pending) {
      // Fail-closed rather than queue: two cards at once would make "which answer is whose"
      // ambiguous, and a queue would hold a live promise past the caller's patience.
      this.logger?.warn(`a card for ${this.pending.input.ref} is already open; refusing ${input.ref}`)
      return Promise.resolve({ kind: 'refused' })
    }
    const signal = options.signal
    if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' })

    return new Promise<CardOutcome>((resolve) => {
      this.pending = { input, resolve }
      if (!this.scenes.open(this.sceneId)) {
        // No TUI front end (headless / web): never report success, and clear the slot.
        this.pending = null
        this.logger?.warn('no TUI front end accepted the scene; the request is refused')
        resolve({ kind: 'refused' })
        return
      }
      signal?.addEventListener('abort', () => {
        const dropped = this.pending
        this.pending = null
        this.notify()
        dropped?.resolve({ kind: 'cancelled' })
      }, { once: true })
      this.notify()
    })
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.logger?.warn(`a card listener failed: ${(error as Error)?.name ?? 'unknown'}`)
      }
    }
  }
}
