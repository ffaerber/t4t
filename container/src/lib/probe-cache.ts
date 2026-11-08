/**
 * Remembers which models passed the chat probe, so the heartbeat only has to
 * list models (`/v1/models`) and probes just the ones it has not seen yet.
 *
 * Probing every model on every heartbeat loads each one into the backend's
 * GPU every few minutes: a local GPU never goes idle (and a machine that
 * sleeps when idle never sleeps), and a backend that fits one model at a time
 * swaps them all in and out. A model is probed:
 *   - the first time it is listed (this still keeps non-chat models such as
 *     whisper out of the offerings);
 *   - again when it comes back after it was gone from the list, e.g. the
 *     backend restarted or its machine woke up;
 *   - after a failed probe, once `retryFailedMs` has passed.
 */
export class ProbeCache {
  private results = new Map<string, {ok: boolean; at: number}>()

  constructor(
    private readonly retryFailedMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The listed models that serve chat completions, probing only those
   *  without a current result. `onFail` hears about each failed probe. */
  async live(
    ids: string[],
    probe: (id: string) => Promise<void>,
    onFail: (id: string, err: unknown) => void = () => {},
  ): Promise<string[]> {
    const listed = new Set(ids)
    for (const id of [...this.results.keys()]) if (!listed.has(id)) this.results.delete(id)

    const live: string[] = []
    for (const id of ids) {
      const prev = this.results.get(id)
      if (!prev || (!prev.ok && this.now() - prev.at >= this.retryFailedMs)) {
        try {
          await probe(id)
          this.results.set(id, {ok: true, at: this.now()})
        } catch (err) {
          this.results.set(id, {ok: false, at: this.now()})
          onFail(id, err)
        }
      }
      if (this.results.get(id)!.ok) live.push(id)
    }
    return live
  }
}
