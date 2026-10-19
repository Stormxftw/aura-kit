// Port of WeakAuras/TimeMachine.lua: undo/redo built from invertible actions.
//
// Every edit is a small record: (document id, action type, key path, payload).
// Each action type is registered with an actor (does the edit) and an
// inverter (describes the edit that undoes it). History is a list of changes,
// each holding a forward list and a backward list. Side effects, like
// "re-render this widget", hang off actions by name and are deduplicated when
// they are idempotent.
//
// One deliberate difference from the Lua: WeakAuras computes every inverse in
// a transaction before applying any of them, so two edits to the same path in
// one transaction can undo wrongly. Here each record is applied as it is
// appended and its inverse is taken from the live data, and `reject()` rolls
// the open transaction back.

import { Subscribable } from "./subscribable.js";

export type Key = string | number;
export type KeyPath = Key | readonly Key[];
type Obj = Record<Key, unknown>;

export interface ActionRecord {
  uid: string;
  type: string;
  path: KeyPath;
  payload?: unknown;
  /** Extra effects to run for this record only. */
  effects?: string[];
  /** Auto effects of the action to skip for this record. */
  suppress?: string[];
}

export interface ActionDef {
  actor: (data: Obj, path: KeyPath, payload: unknown) => void;
  inverter: (data: Obj, path: KeyPath, payload: unknown) => { type: string; path: KeyPath; payload?: unknown };
  autoEffects?: string[];
}

interface EffectDef {
  run: (uid: string, data: Obj) => void;
  /** Idempotent effects run once per document per step, after all records. */
  idempotent: boolean;
}

export interface Change {
  forward: ActionRecord[];
  backward: ActionRecord[];
  label?: string;
}

type Events = { step: [index: number]; reset: [reason: string] };

const clone = <T>(v: T): T => (v !== null && typeof v === "object" ? structuredClone(v) : v);

/** Walks to the parent of the last key, creating missing objects on the way. */
export function resolveKey(data: Obj, path: KeyPath): [Obj, Key] {
  if (!Array.isArray(path)) return [data, path as Key];
  let node = data;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as Key;
    const next = node[k];
    if (next === undefined || next === null) node[k] = {};
    else if (typeof next !== "object") throw new Error(`Path is not valid: ${path.join(".")} at ${k}`);
    node = node[k] as Obj;
  }
  return [node, path[path.length - 1] as Key];
}

const arrayAt = (data: Obj, path: KeyPath): unknown[] => {
  const [tbl, key] = resolveKey(data, path);
  const arr = tbl[key];
  if (!Array.isArray(arr)) throw new Error(`Not an array at ${String(path)}`);
  return arr;
};

export class TimeMachine {
  private readonly actions = new Map<string, ActionDef>();
  private readonly effects = new Map<string, EffectDef>();
  private changes: Change[] = [];
  private index = 0;
  private pending: Change | null = null;
  /** Idempotent effects owed by the open transaction, run once at its end. */
  private owed = new Map<string, Set<string>>();
  readonly events = new Subscribable<Events>();

  constructor(
    private readonly getData: (uid: string) => Obj | undefined,
    private readonly maxHistory = 200,
  ) {
    this.registerBuiltins();
  }

  registerAction(type: string, def: ActionDef): void {
    if (this.actions.has(type)) throw new Error(`Action already registered: ${type}`);
    this.actions.set(type, def);
  }

  registerEffect(name: string, run: EffectDef["run"], idempotent = true): void {
    if (this.effects.has(name)) throw new Error(`Effect already registered: ${name}`);
    this.effects.set(name, { run, idempotent });
  }

  /** Apply one edit. Outside a transaction it becomes its own undo step. */
  append(record: ActionRecord): void {
    const own = !this.pending;
    if (own) this.start();
    const pending = this.pending as Change;
    const inverse = this.invert(record);
    this.apply([record], this.owed);
    pending.forward.push(record);
    pending.backward.unshift(inverse);
    if (own) this.commit();
  }

  /** Group several edits into one undo step. Throwing inside rolls them all back. */
  transaction<T>(fn: () => T, label?: string): T {
    this.start(label);
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (err) {
      this.reject();
      throw err;
    }
  }

  start(label?: string): void {
    if (this.pending) throw new Error("A transaction is already open");
    this.pending = { forward: [], backward: [], label };
  }

  commit(): void {
    const pending = this.pending;
    if (!pending) throw new Error("No transaction to commit");
    this.pending = null;
    this.flushEffects(this.owed);
    if (pending.forward.length === 0) return;
    // A new edit after undoing discards the redo branch.
    this.changes.length = this.index;
    this.changes.push(pending);
    if (this.changes.length > this.maxHistory) this.changes.shift();
    this.index = this.changes.length;
    this.events.notify("step", this.index);
  }

  reject(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) this.apply(pending.backward, this.owed);
    this.flushEffects(this.owed);
  }

  undo(): boolean {
    if (this.pending || this.index === 0) return false;
    const change = this.changes[this.index - 1] as Change;
    this.apply(change.backward);
    this.index--;
    this.events.notify("step", this.index);
    return true;
  }

  redo(): boolean {
    if (this.pending || this.index >= this.changes.length) return false;
    const change = this.changes[this.index] as Change;
    this.apply(change.forward);
    this.index++;
    this.events.notify("step", this.index);
    return true;
  }

  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.changes.length; }
  peekUndo(): Change | undefined { return this.changes[this.index - 1]; }
  peekRedo(): Change | undefined { return this.changes[this.index]; }

  /**
   * WeakAuras calls this DestroyTheUniverse: when data changes behind the
   * machine's back, the recorded inverses no longer hold, so drop history.
   */
  reset(reason: string): void {
    this.pending = null;
    this.changes = [];
    this.index = 0;
    this.events.notify("reset", reason);
    this.events.notify("step", 0);
  }

  private invert(record: ActionRecord): ActionRecord {
    const action = this.action(record.type);
    const inv = action.inverter(this.doc(record.uid), record.path, record.payload);
    return {
      uid: record.uid,
      type: inv.type,
      path: inv.path,
      payload: inv.payload,
      effects: record.effects ? [...record.effects].reverse() : undefined,
      suppress: record.suppress,
    };
  }

  /** With `deferred`, idempotent effects are collected there instead of run. */
  private apply(records: ActionRecord[], deferred?: Map<string, Set<string>>): void {
    const own = deferred ?? new Map<string, Set<string>>();
    for (const record of records) {
      const action = this.action(record.type);
      const data = this.doc(record.uid);
      action.actor(data, record.path, record.payload);
      const names = [
        ...(action.autoEffects ?? []).filter((e) => !record.suppress?.includes(e)),
        ...(record.effects ?? []),
      ];
      for (const name of names) {
        const effect = this.effects.get(name);
        if (!effect) throw new Error(`No effect registered: ${name}`);
        if (effect.idempotent) {
          let set = own.get(record.uid);
          if (!set) own.set(record.uid, (set = new Set()));
          set.add(name);
        } else {
          effect.run(record.uid, data);
        }
      }
    }
    if (!deferred) this.flushEffects(own);
  }

  private flushEffects(owed: Map<string, Set<string>>): void {
    const work = [...owed];
    owed.clear();
    for (const [uid, names] of work) {
      const data = this.getData(uid);
      // The document may have been deleted by the step itself.
      if (data) for (const name of names) this.effects.get(name)?.run(uid, data);
    }
  }

  private action(type: string): ActionDef {
    const action = this.actions.get(type);
    if (!action) throw new Error(`No action registered: ${type}`);
    return action;
  }

  private doc(uid: string): Obj {
    const data = this.getData(uid);
    if (!data) throw new Error(`No document with uid ${uid}`);
    return data;
  }

  private registerBuiltins(): void {
    const auto = ["changed"];
    this.registerEffect("changed", () => {}, true);

    this.registerAction("set", {
      actor: (data, path, value) => {
        const [tbl, key] = resolveKey(data, path);
        if (value === undefined) delete tbl[key];
        else tbl[key] = clone(value);
      },
      inverter: (data, path) => {
        const [tbl, key] = resolveKey(data, path);
        return { type: "set", path, payload: clone(tbl[key]) };
      },
      autoEffects: auto,
    });

    this.registerAction("setMany", {
      actor: (data, path, values) => {
        const [tbl, key] = resolveKey(data, path);
        const target = (tbl[key] ??= {}) as Obj;
        for (const [k, v] of Object.entries(values as Obj)) {
          if (v === undefined) delete target[k];
          else target[k] = clone(v);
        }
      },
      inverter: (data, path, values) => {
        const [tbl, key] = resolveKey(data, path);
        const target = (tbl[key] ?? {}) as Obj;
        const inverse: Obj = {};
        for (const k of Object.keys(values as Obj)) inverse[k] = clone(target[k]);
        return { type: "setMany", path, payload: inverse };
      },
      autoEffects: auto,
    });

    this.registerAction("insert", {
      actor: (data, path, payload) => {
        const { index, value } = payload as { index?: number; value: unknown };
        const arr = arrayAt(data, path);
        arr.splice(index ?? arr.length, 0, clone(value));
      },
      inverter: (data, path, payload) => {
        const { index } = payload as { index?: number };
        return { type: "remove", path, payload: index ?? arrayAt(data, path).length };
      },
      autoEffects: auto,
    });

    this.registerAction("remove", {
      actor: (data, path, index) => {
        const arr = arrayAt(data, path);
        arr.splice((index as number | undefined) ?? arr.length - 1, 1);
      },
      inverter: (data, path, index) => {
        const arr = arrayAt(data, path);
        const i = (index as number | undefined) ?? arr.length - 1;
        return { type: "insert", path, payload: { index: i, value: clone(arr[i]) } };
      },
      autoEffects: auto,
    });

    this.registerAction("swap", {
      actor: (data, path, payload) => {
        const [a, b] = payload as [number, number];
        const arr = arrayAt(data, path);
        [arr[a], arr[b]] = [arr[b], arr[a]];
      },
      inverter: (_data, path, payload) => ({ type: "swap", path, payload }),
      autoEffects: auto,
    });

    this.registerAction("move", {
      actor: (data, path, payload) => {
        const [from, to] = payload as [number, number];
        const arr = arrayAt(data, path);
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
      },
      inverter: (_data, path, payload) => {
        const [from, to] = payload as [number, number];
        return { type: "move", path, payload: [to, from] };
      },
      autoEffects: auto,
    });
  }
}
