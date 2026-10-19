// Port of the grow and sort functions in WeakAuras/RegionTypes/DynamicGroup.lua.
//
// A dynamic group lays out a changing set of children: icons appear and
// disappear and the rest slide into place. Two ideas are worth copying:
//
// - Layouts are factories: `grower(config)` does the config work once and
//   returns a cheap `(items) => positions` function for every relayout.
// - Sorts are composed from small comparators, and each sort declares which
//   state fields it reads (`dependsOn`). The group re-sorts only when one of
//   those fields changes, not on every update.

export interface LayoutItem {
  id: string;
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
}

/** Positions are offsets from the group's anchor, in WeakAuras axes (y up). */
export type Grower = (items: readonly LayoutItem[]) => Map<string, Position>;

export type Align = "start" | "center" | "end";

interface Common {
  space?: number;
  /** Show at most this many; the rest get no position. */
  limit?: number;
}

export type GrowConfig =
  | (Common & { grow: "RIGHT" | "LEFT" | "UP" | "DOWN"; align?: Align; stagger?: number })
  | (Common & { grow: "HORIZONTAL" | "VERTICAL"; align?: Align })
  | (Common & { grow: "CIRCLE" | "COUNTERCIRCLE"; radius?: number; constant?: "RADIUS" | "SPACING"; rotation?: number; arc?: number })
  | (Common & { grow: "GRID"; columns: number; rowSpace?: number; direction?: "RIGHT_DOWN" | "LEFT_DOWN" | "RIGHT_UP" | "LEFT_UP" });

const alignOffset = (size: number, max: number, align: Align): number =>
  align === "start" ? 0 : align === "end" ? max - size : (max - size) / 2;

export function grower(config: GrowConfig): Grower {
  const space = config.space ?? 2;
  const limit = config.limit ?? Infinity;

  switch (config.grow) {
    case "RIGHT":
    case "LEFT":
    case "UP":
    case "DOWN": {
      const horizontal = config.grow === "RIGHT" || config.grow === "LEFT";
      const sign = config.grow === "RIGHT" || config.grow === "UP" ? 1 : -1;
      const align = config.align ?? "center";
      const stagger = config.stagger ?? 0;
      return (items) => {
        const shown = items.slice(0, limit);
        const cross = Math.max(0, ...shown.map((i) => (horizontal ? i.height : i.width)));
        const out = new Map<string, Position>();
        let along = 0;
        shown.forEach((item, n) => {
          const len = horizontal ? item.width : item.height;
          const c = alignOffset(horizontal ? item.height : item.width, cross, align) + n * stagger;
          const a = sign * (along + len / 2);
          out.set(item.id, horizontal ? { x: a, y: c } : { x: c, y: a });
          along += len + space;
        });
        return out;
      };
    }

    case "HORIZONTAL":
    case "VERTICAL": {
      // Centered on the anchor: grows outward on both sides.
      const horizontal = config.grow === "HORIZONTAL";
      return (items) => {
        const shown = items.slice(0, limit);
        const total = shown.reduce((s, i) => s + (horizontal ? i.width : i.height), 0) + space * Math.max(0, shown.length - 1);
        const out = new Map<string, Position>();
        let along = -total / 2;
        for (const item of shown) {
          const len = horizontal ? item.width : item.height;
          const a = along + len / 2;
          out.set(item.id, horizontal ? { x: a, y: 0 } : { x: 0, y: -a });
          along += len + space;
        }
        return out;
      };
    }

    case "CIRCLE":
    case "COUNTERCIRCLE": {
      const dir = config.grow === "CIRCLE" ? 1 : -1;
      const start = ((config.rotation ?? 0) * Math.PI) / 180;
      const arc = ((config.arc ?? 360) * Math.PI) / 180;
      const full = (config.arc ?? 360) >= 360;
      return (items) => {
        const shown = items.slice(0, limit);
        const n = shown.length;
        const r =
          config.constant === "RADIUS" ? config.radius ?? 0 : n <= 1 ? 0 : (n * (space + (shown[0]?.width ?? 0))) / (2 * Math.PI);
        const step = n <= 1 ? 0 : full ? arc / n : arc / (n - 1);
        const out = new Map<string, Position>();
        shown.forEach((item, i) => {
          const theta = start + dir * i * step;
          out.set(item.id, { x: r * Math.sin(theta), y: r * Math.cos(theta) });
        });
        return out;
      };
    }

    case "GRID": {
      const cols = Math.max(1, config.columns);
      const rowSpace = config.rowSpace ?? space;
      const [h, v] = (config.direction ?? "RIGHT_DOWN").split("_") as ["RIGHT" | "LEFT", "DOWN" | "UP"];
      const hx = h === "RIGHT" ? 1 : -1;
      const vy = v === "UP" ? 1 : -1;
      return (items) => {
        const shown = items.slice(0, limit);
        const w = Math.max(0, ...shown.map((i) => i.width));
        const ht = Math.max(0, ...shown.map((i) => i.height));
        const out = new Map<string, Position>();
        shown.forEach((item, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          out.set(item.id, { x: hx * (col * (w + space) + w / 2), y: vy * (row * (ht + rowSpace) + ht / 2) });
        });
        return out;
      };
    }
  }
}

// ---- Sorting ---------------------------------------------------------------

/** Negative, positive, or 0 for "no opinion, ask the next comparator". */
export type Compare<T> = (a: T, b: T) => number;

export function composeSorts<T>(...compares: Compare<T>[]): Compare<T> {
  return (a, b) => {
    for (const c of compares) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
}

const get = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

/** Missing values sort last either way, as WeakAuras does. */
export function sortBy<T>(path: readonly string[], direction: "asc" | "desc" = "asc"): Compare<T> {
  const sign = direction === "asc" ? 1 : -1;
  return (a, b) => {
    const va = get(a, path);
    const vb = get(b, path);
    if (va === vb) return 0;
    if (va === undefined || va === null) return 1;
    if (vb === undefined || vb === null) return -1;
    return (va < vb ? -1 : 1) * sign;
  };
}

export interface SortDef<T> {
  compare: Compare<T>;
  /** State fields this sort reads. Re-sort only when one changes. */
  dependsOn: ReadonlySet<string>;
}

export interface GroupChild {
  id: string;
  /** Order in the group's configuration, the final tie-breaker. */
  index: number;
  state: Record<string, unknown>;
  /** Pinned children ("hybrid" in WeakAuras) sort before or after the rest. */
  pinned?: boolean;
}

export const sorters = {
  none: (): SortDef<GroupChild> => ({ compare: sortBy(["index"]), dependsOn: new Set() }),
  ascending: (field = "expirationTime"): SortDef<GroupChild> => ({
    compare: composeSorts(sortBy(["state", field], "asc"), sortBy(["index"])),
    dependsOn: new Set([field]),
  }),
  descending: (field = "expirationTime"): SortDef<GroupChild> => ({
    compare: composeSorts(sortBy(["state", field], "desc"), sortBy(["index"])),
    dependsOn: new Set([field]),
  }),
  hybrid: (field = "expirationTime", pinnedFirst = true, direction: "asc" | "desc" = "asc"): SortDef<GroupChild> => ({
    compare: composeSorts<GroupChild>(
      (a, b) => (a.pinned === b.pinned ? 0 : (a.pinned ? -1 : 1) * (pinnedFirst ? 1 : -1)),
      sortBy(["state", field], direction),
      sortBy(["index"]),
    ),
    dependsOn: new Set([field]),
  }),
};

/** True when a state change touched a field the sort reads. */
export const needsResort = (def: { dependsOn: ReadonlySet<string> }, changedFields: Iterable<string>): boolean => {
  for (const f of changedFields) if (def.dependsOn.has(f)) return true;
  return false;
};
