// Port of WeakAuras/TSUHelpers.lua (the "allstates" helpers).
//
// A trigger in WeakAuras doesn't return true or false. It fills a keyed map of
// states: one entry per thing to show (one per buff, per party member, per
// cooldown). The display makes one clone per key. Writers call update/replace/
// remove, and the map records what actually changed, so the renderer touches
// only those clones and skips the frame entirely when nothing moved.

export type StateKey = string | number;

export interface BaseState {
  /** Hidden states stay in the map but aren't drawn. Defaults to true. */
  show?: boolean;
  [field: string]: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge `src` into `dst` in place. Returns whether anything changed. */
function merge(dst: Obj, src: Obj, replace: boolean): boolean {
  let changed = false;
  if (replace) {
    for (const k of Object.keys(dst)) {
      if (!(k in src)) {
        delete dst[k];
        changed = true;
      }
    }
  }
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v)) {
      if (!isObj(dst[k])) {
        dst[k] = {};
        changed = true;
      }
      if (merge(dst[k] as Obj, v, replace)) changed = true;
    } else if (Array.isArray(v)) {
      if (JSON.stringify(dst[k]) !== JSON.stringify(v)) {
        dst[k] = [...v];
        changed = true;
      }
    } else if (dst[k] !== v) {
      dst[k] = v;
      changed = true;
    }
  }
  return changed;
}

export class StateMap<S extends BaseState = BaseState> {
  private readonly states = new Map<StateKey, S>();
  private readonly dirty = new Set<StateKey>();

  /** Create the state, or deep-merge into it. Returns whether anything changed. */
  update(key: StateKey, partial: Partial<S>): boolean {
    const existing = this.states.get(key);
    if (!existing) return this.create(key, partial);
    const changed = merge(existing as Obj, partial as Obj, false);
    if (changed) this.dirty.add(key);
    return changed;
  }

  /** Create the state, or make it exactly `next`, dropping fields `next` lacks. */
  replace(key: StateKey, next: S): boolean {
    const existing = this.states.get(key);
    if (!existing) return this.create(key, next);
    const changed = merge(existing as Obj, next as Obj, true);
    if (changed) this.dirty.add(key);
    return changed;
  }

  remove(key: StateKey): boolean {
    if (!this.states.delete(key)) return false;
    this.dirty.add(key);
    return true;
  }

  removeAll(): boolean {
    if (this.states.size === 0) return false;
    for (const key of this.states.keys()) this.dirty.add(key);
    this.states.clear();
    return true;
  }

  get(key: StateKey): Readonly<S> | undefined {
    return this.states.get(key);
  }

  /** Visible states in insertion order. */
  visible(): [StateKey, Readonly<S>][] {
    return [...this.states].filter(([, s]) => s.show !== false);
  }

  get size(): number {
    return this.states.size;
  }

  get changed(): boolean {
    return this.dirty.size > 0;
  }

  /**
   * Hand the changed keys to the renderer and reset tracking. A key in
   * `removed` is gone; one in `updated` is new or different.
   */
  flush(): { updated: StateKey[]; removed: StateKey[] } {
    const updated: StateKey[] = [];
    const removed: StateKey[] = [];
    for (const key of this.dirty) (this.states.has(key) ? updated : removed).push(key);
    this.dirty.clear();
    return { updated, removed };
  }

  private create(key: StateKey, init: Partial<S>): boolean {
    const state = structuredClone(init) as S;
    state.show ??= true;
    this.states.set(key, state);
    this.dirty.add(key);
    return true;
  }
}
