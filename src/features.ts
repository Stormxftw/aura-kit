// Port of WeakAuras/Features.lua: feature flags with a hydration step.
//
// Features are registered at module load, before saved settings exist. Once
// settings load, `hydrate` decides each flag: a saved choice wins, otherwise
// the flag turns on for the listed build types (dev, alpha, ...). Asking for a
// flag before hydration answers "off", and toggling before hydration throws,
// so nothing acts on a guess.

import { Subscribable } from "./subscribable.js";

export type BuildType = "dev" | "pr" | "alpha" | "beta" | "release";

export interface FeatureDef<D = unknown> {
  id: string;
  /** Build types where the flag defaults to on. */
  autoEnable?: BuildType[];
  /** Save the user's choice so it survives a reload. */
  persist?: boolean;
  /**
   * A document that needs this feature cannot work while it is off.
   * WeakAuras uses this to block an aura instead of letting it half-run.
   */
  requiredBy?: (doc: D) => boolean;
}

interface Feature<D> extends FeatureDef<D> {
  enabled: boolean;
  sub: Subscribable<{ enable: []; disable: [] }>;
}

export class Features<D = unknown> {
  private readonly feats = new Map<string, Feature<D>>();
  private hydrated = false;
  private store: Record<string, boolean> = {};

  constructor(private readonly buildType: BuildType) {}

  register(def: FeatureDef<D>): void {
    if (this.hydrated) throw new Error(`Cannot register "${def.id}" after hydration`);
    if (!this.feats.has(def.id)) this.feats.set(def.id, { ...def, enabled: false, sub: new Subscribable() });
  }

  /** Call once with persisted choices. Every subscriber then hears the final state. */
  hydrate(saved: Record<string, boolean>): void {
    this.store = saved;
    for (const f of this.feats.values()) {
      f.enabled = saved[f.id] ?? (f.autoEnable ?? []).includes(this.buildType);
    }
    // Set the flag first so subscribers that call enabled() get real answers.
    this.hydrated = true;
    for (const f of this.feats.values()) f.sub.notify(f.enabled ? "enable" : "disable");
  }

  enabled(id: string): boolean {
    return this.hydrated && (this.feats.get(id)?.enabled ?? false);
  }

  set(id: string, on: boolean): void {
    const f = this.feats.get(id);
    if (!f) return;
    if (!this.hydrated) throw new Error(`Cannot toggle "${id}" before hydration`);
    if (f.enabled === on) return;
    f.enabled = on;
    if (f.persist) this.store[id] = on;
    f.sub.notify(on ? "enable" : "disable");
  }

  list(): { id: string; enabled: boolean }[] {
    if (!this.hydrated) return [];
    return [...this.feats.values()]
      .map((f) => ({ id: f.id, enabled: f.enabled }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The persisted choices, for saving. */
  snapshot(): Record<string, boolean> {
    return { ...this.store };
  }

  /** Hide a code path behind a flag, with an optional fallback path. */
  wrap<A extends unknown[], R>(id: string, on: (...a: A) => R, off?: (...a: A) => R): (...a: A) => R | undefined {
    return (...a: A) => (this.enabled(id) ? on(...a) : off?.(...a));
  }

  subscribe(id: string, onEnable: () => void, onDisable: () => void): () => void {
    const f = this.feats.get(id);
    if (!f) return () => {};
    const a = f.sub.subscribe("enable", onEnable);
    const b = f.sub.subscribe("disable", onDisable);
    return () => { a(); b(); };
  }

  /** Can this document run with the current flags? Lists the flags blocking it. */
  canRun(doc: D): { ok: boolean; missing: string[] } {
    const missing = [...this.feats.values()]
      .filter((f) => f.requiredBy?.(doc) && !this.enabled(f.id))
      .map((f) => f.id);
    return { ok: missing.length === 0, missing };
  }
}
