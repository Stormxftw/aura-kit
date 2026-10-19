// Port of WeakAuras/SubscribableObject.lua.
//
// Unlike a plain event emitter, it tells the owner when an event gains its
// first subscriber and loses its last one. WeakAuras uses this to switch
// expensive work on and off: a timer, a game-event registration or a polling
// loop only runs while something is listening.

export type EventMap = Record<string, unknown[]>;
type Handler<A extends unknown[]> = (...args: A) => void;

export interface SubscribeOptions {
  /** Run before existing subscribers instead of after them. */
  highPriority?: boolean;
}

export class Subscribable<E extends EventMap> {
  private readonly lists = new Map<keyof E, Handler<never[]>[]>();
  private readonly activity = new Map<keyof E, (active: boolean) => void>();

  /** Returns an unsubscribe function. Subscribing the same handler twice is a no-op. */
  subscribe<K extends keyof E>(event: K, handler: Handler<E[K]>, options: SubscribeOptions = {}): () => void {
    let list = this.lists.get(event);
    if (!list) {
      list = [];
      this.lists.set(event, list);
    }
    const h = handler as unknown as Handler<never[]>;
    if (!list.includes(h)) {
      const wasEmpty = list.length === 0;
      if (options.highPriority) list.unshift(h);
      else list.push(h);
      if (wasEmpty) this.activity.get(event)?.(true);
    }
    return () => this.unsubscribe(event, handler);
  }

  unsubscribe<K extends keyof E>(event: K, handler: Handler<E[K]>): void {
    const list = this.lists.get(event);
    if (!list) return;
    const index = list.indexOf(handler as unknown as Handler<never[]>);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length === 0) this.activity.get(event)?.(false);
  }

  /**
   * Called with `true` when `event` gets its first subscriber and `false`
   * when its last one leaves. This is the hook for lazy start/stop.
   */
  onActiveChange<K extends keyof E>(event: K, callback: (active: boolean) => void): void {
    this.activity.set(event, callback);
  }

  notify<K extends keyof E>(event: K, ...args: E[K]): void {
    const list = this.lists.get(event);
    if (!list || list.length === 0) return;
    // Copy so a handler can unsubscribe itself mid-dispatch.
    for (const handler of [...list]) (handler as unknown as Handler<E[K]>)(...args);
  }

  has(event: keyof E): boolean {
    return (this.lists.get(event)?.length ?? 0) > 0;
  }

  clear(): void {
    for (const [event, list] of this.lists) {
      if (list.length > 0) this.activity.get(event)?.(false);
    }
    this.lists.clear();
  }
}
