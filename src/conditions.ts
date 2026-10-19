// Port of WeakAuras/Conditions.lua: ordered "if this, change that" rules.
//
// A display has base properties (colour, alpha, text...). Conditions are an
// ordered list; each has a check against trigger states and a set of property
// changes. The resolved properties are the base with every active
// condition's changes laid on top in order, so later conditions win and a
// property snaps back to its base value when nothing overrides it.
//
// Two ideas from the Lua are worth copying:
//
// 1. Compile once. WeakAuras turns the condition config into Lua source and
//    loads it, so the hot path has no config lookups. Here the config is
//    compiled into closures, which gets the same benefit without eval.
// 2. Never poll for time. A check like "less than 5 seconds left" can't
//    become true by itself between events, but it will at a known moment:
//    expirationTime - 5. Evaluation returns the earliest such moment and the
//    caller sets one timer for it.

import type { BaseState } from "./stateMap.js";
import type { TriggerStates } from "./triggers.js";

export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Check =
  | { type: "and" | "or"; checks: Check[] }
  | { type: "number"; trigger: number; field: string; op: CompareOp; value: number }
  | { type: "string"; trigger: number; field: string; op: "==" | "!=" | "contains" | "matches"; value: string }
  | { type: "bool"; trigger: number; field: string; value: boolean }
  /** Seconds left until `field` (an absolute end time in seconds). */
  | { type: "remaining"; trigger: number; field: string; op: CompareOp; value: number; paused?: string; remainingField?: string }
  /** Seconds since `field` (an absolute start time in seconds). */
  | { type: "elapsed"; trigger: number; field: string; op: CompareOp; value: number }
  | {
      type: "custom";
      test: (states: TriggerStates, now: number) => boolean;
      /** When the answer could next flip on its own, if ever. */
      nextChange?: (states: TriggerStates, now: number) => number | undefined;
    };

export interface Condition<P> {
  check: Check;
  changes: Partial<P>;
  /** Else-if: skipped when the previous condition in the chain matched. */
  linked?: boolean;
  /** One-shot actions when the condition turns on or off (play a sound, log). */
  onActivate?: (states: TriggerStates) => void;
  onDeactivate?: (states: TriggerStates) => void;
}

export interface Evaluation<P> {
  props: P;
  /** Property names whose value differs from the previous evaluation. */
  changed: (keyof P)[];
  active: boolean[];
  /** Absolute time (same clock as `now`) to evaluate again, if needed. */
  recheckAt?: number;
}

/** Time-sensitive checks compare within this window for "==". */
const EQUAL_WINDOW = 0.05;

const compare = (a: number, op: CompareOp, b: number, tolerance = 0): boolean => {
  switch (op) {
    case "==": return a === b || Math.abs(a - b) < tolerance;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
  }
};

interface Compiled {
  test: (s: TriggerStates, now: number) => boolean;
  next: (s: TriggerStates, now: number) => number | undefined;
}

const never = (): undefined => undefined;
const field = (s: TriggerStates, t: number, f: string): unknown => s[t]?.[f];

const earliest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

function compileCheck(check: Check): Compiled {
  switch (check.type) {
    case "and":
    case "or": {
      const parts = check.checks.map(compileCheck);
      const all = check.type === "and";
      return {
        test: (s, now) => (all ? parts.every((p) => p.test(s, now)) : parts.some((p) => p.test(s, now))),
        next: (s, now) => parts.reduce<number | undefined>((acc, p) => earliest(acc, p.next(s, now)), undefined),
      };
    }
    case "number": {
      const { trigger, field: f, op, value } = check;
      return {
        test: (s) => {
          const v = field(s, trigger, f);
          return typeof v === "number" && compare(v, op, value);
        },
        next: never,
      };
    }
    case "string": {
      const { trigger, field: f, op, value } = check;
      const re = op === "matches" ? new RegExp(value) : null;
      return {
        test: (s) => {
          const v = field(s, trigger, f);
          if (typeof v !== "string") return false;
          if (op === "==") return v === value;
          if (op === "!=") return v !== value;
          if (op === "contains") return v.includes(value);
          return (re as RegExp).test(v);
        },
        next: never,
      };
    }
    case "bool": {
      const { trigger, field: f, value } = check;
      return { test: (s) => Boolean(field(s, trigger, f)) === value, next: never };
    }
    case "remaining": {
      const { trigger, field: f, op, value, paused, remainingField } = check;
      const left = (s: TriggerStates, now: number): number | undefined => {
        const end = field(s, trigger, f);
        if (typeof end !== "number" || end === 0) return undefined;
        if (paused && field(s, trigger, paused)) {
          const r = remainingField ? field(s, trigger, remainingField) : undefined;
          return typeof r === "number" ? r : 0;
        }
        return end - now;
      };
      return {
        test: (s, now) => {
          const l = left(s, now);
          return l !== undefined && compare(l, op, value, EQUAL_WINDOW);
        },
        // The answer flips when remaining time crosses `value`.
        next: (s, now) => {
          const end = field(s, trigger, f);
          if (typeof end !== "number" || (paused && field(s, trigger, paused))) return undefined;
          const at = end - value;
          return at >= now ? at : undefined;
        },
      };
    }
    case "elapsed": {
      const { trigger, field: f, op, value } = check;
      return {
        test: (s, now) => {
          const start = field(s, trigger, f);
          return typeof start === "number" && compare(now - start, op, value, EQUAL_WINDOW);
        },
        next: (s, now) => {
          const start = field(s, trigger, f);
          if (typeof start !== "number") return undefined;
          const at = start + value;
          return at >= now ? at : undefined;
        },
      };
    }
    case "custom": {
      const { test, nextChange } = check;
      return {
        test: (s, now) => {
          try {
            return test(s, now);
          } catch {
            return false;
          }
        },
        next: nextChange ?? never,
      };
    }
  }
}

export class ConditionRunner<P extends object> {
  private readonly compiled: { cond: Condition<P>; c: Compiled }[];
  private previous: P;
  private wasActive: boolean[];

  constructor(private readonly base: P, conditions: Condition<P>[]) {
    this.compiled = conditions.map((cond) => ({ cond, c: compileCheck(cond.check) }));
    this.previous = { ...base };
    this.wasActive = conditions.map(() => false);
  }

  evaluate(states: TriggerStates<BaseState>, now: number): Evaluation<P> {
    const props = { ...this.base };
    const active: boolean[] = [];
    let recheckAt: number | undefined;
    let chainMatched = false;

    this.compiled.forEach(({ cond, c }) => {
      if (!cond.linked) chainMatched = false;
      const on = !chainMatched && c.test(states, now);
      if (on) chainMatched = true;
      active.push(on);
      if (on) Object.assign(props, cond.changes);
      recheckAt = earliest(recheckAt, c.next(states, now));
    });

    // Fire one-shots after the props are settled, in order.
    active.forEach((on, i) => {
      const cond = (this.compiled[i] as { cond: Condition<P> }).cond;
      if (on && !this.wasActive[i]) cond.onActivate?.(states);
      if (!on && this.wasActive[i]) cond.onDeactivate?.(states);
    });

    const changed = (Object.keys(props) as (keyof P)[]).filter((k) => props[k] !== this.previous[k]);
    this.previous = props;
    this.wasActive = active;
    return { props, changed, active, recheckAt };
  }
}

/**
 * Re-runs a ConditionRunner exactly when a time-based check can flip, with a
 * single timer. Call `evaluate` whenever trigger states change too.
 */
export class ConditionScheduler<P extends object> {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly runner: ConditionRunner<P>,
    private readonly getStates: () => TriggerStates,
    private readonly onResult: (r: Evaluation<P>) => void,
    private readonly clock: () => number = () => performance.now() / 1000,
  ) {}

  evaluate(): Evaluation<P> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const result = this.runner.evaluate(this.getStates(), this.clock());
    if (result.recheckAt !== undefined) {
      // A hair past the boundary so a strict "<" has flipped by then.
      const delay = Math.max(0, (result.recheckAt - this.clock()) * 1000 + 1);
      this.timer = setTimeout(() => this.evaluate(), delay);
    }
    this.onResult(result);
    return result;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
