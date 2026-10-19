// How WeakAuras combines several triggers into one "show / hide" answer
// (evaluateTriggerStateTriggers in WeakAuras.lua), and which trigger feeds
// the display's text, icon and progress (activeTriggerMode).

import type { BaseState, StateKey } from "./stateMap.js";

export type TriggerLogic = "all" | "any" | ((active: readonly boolean[]) => boolean);

/** "first" means the first trigger that's active, otherwise a fixed index. */
export type ActiveTriggerMode = "first" | number;

export function shouldShow(active: readonly boolean[], logic: TriggerLogic): boolean {
  if (logic === "all") return active.length > 0 && active.every(Boolean);
  if (logic === "any") return active.some(Boolean);
  try {
    return Boolean(logic(active));
  } catch {
    // A broken custom combination hides the display rather than crashing it.
    return false;
  }
}

export function pickActiveTrigger(active: readonly boolean[], mode: ActiveTriggerMode): number {
  if (mode === "first") {
    const i = active.indexOf(true);
    return i === -1 ? 0 : i;
  }
  return mode;
}

/** States for one clone: entry `i` is trigger i's state for the same key, if any. */
export type TriggerStates<S extends BaseState = BaseState> = (Readonly<S> | undefined)[];

/**
 * Each trigger fills its own keyed map. A clone exists for every key of the
 * active trigger; the other triggers' states with the same key ride along so
 * conditions and text can read them (`%2.stacks`).
 */
export function cloneStates<S extends BaseState>(
  maps: readonly { visible(): [StateKey, Readonly<S>][]; get(k: StateKey): Readonly<S> | undefined }[],
  activeIndex: number,
): Map<StateKey, TriggerStates<S>> {
  const out = new Map<StateKey, TriggerStates<S>>();
  const driver = maps[activeIndex];
  if (!driver) return out;
  for (const [key] of driver.visible()) {
    out.set(key, maps.map((m) => {
      const own = m.get(key);
      if (own) return own;
      // Single-state triggers use the "" key; share it with every clone.
      return m.get("");
    }));
  }
  return out;
}
