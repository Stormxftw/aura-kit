import { describe, expect, it, vi } from "vitest";
import {
  Animator,
  ConditionRunner,
  Environments,
  Features,
  Migrator,
  StateMap,
  Subscribable,
  TimeMachine,
  Transmission,
  compileTemplate,
  createFormatters,
  grower,
  lifecycle,
  needsResort,
  parseTemplate,
  pickActiveTrigger,
  shouldShow,
  sorters,
  stateResolver,
  stripFields,
  symbolsIn,
  type AnimTarget,
  type GroupChild,
  type RGBA,
} from "../src/index.js";

describe("Subscribable", () => {
  it("reports first and last subscriber so work can start and stop lazily", () => {
    const sub = new Subscribable<{ tick: [n: number] }>();
    const activity: boolean[] = [];
    sub.onActiveChange("tick", (on) => activity.push(on));
    const seen: string[] = [];
    const offA = sub.subscribe("tick", (n) => seen.push(`a${n}`));
    sub.subscribe("tick", (n) => seen.push(`b${n}`), { highPriority: true });
    sub.notify("tick", 1);
    offA();
    sub.clear();
    expect(seen).toEqual(["b1", "a1"]);
    expect(activity).toEqual([true, false]);
  });
});

describe("TimeMachine", () => {
  const setup = () => {
    const docs: Record<string, Record<string, unknown>> = { a: { name: "x", list: [1, 2, 3], style: { color: "red" } } };
    const tm = new TimeMachine((uid) => docs[uid]);
    const renders: string[] = [];
    tm.registerEffect("render", (uid) => renders.push(uid), true);
    return { docs, tm, renders, doc: docs.a as Record<string, unknown> };
  };

  it("undoes and redoes sets, inserts, removes and moves", () => {
    const { tm, doc } = setup();
    tm.append({ uid: "a", type: "set", path: "name", payload: "y" });
    tm.append({ uid: "a", type: "insert", path: "list", payload: { value: 4 } });
    tm.append({ uid: "a", type: "remove", path: "list", payload: 0 });
    tm.append({ uid: "a", type: "move", path: "list", payload: [0, 2] });
    tm.append({ uid: "a", type: "set", path: ["style", "color"], payload: "blue" });
    expect(doc).toEqual({ name: "y", list: [3, 4, 2], style: { color: "blue" } });
    while (tm.undo());
    expect(doc).toEqual({ name: "x", list: [1, 2, 3], style: { color: "red" } });
    while (tm.redo());
    expect(doc).toEqual({ name: "y", list: [3, 4, 2], style: { color: "blue" } });
  });

  it("treats a transaction as one step and handles repeat edits to one path", () => {
    const { tm, doc } = setup();
    tm.transaction(() => {
      tm.append({ uid: "a", type: "insert", path: "list", payload: { value: 9 } });
      tm.append({ uid: "a", type: "remove", path: "list", payload: 3 });
      tm.append({ uid: "a", type: "set", path: "name", payload: "1" });
      tm.append({ uid: "a", type: "set", path: "name", payload: "2" });
    });
    expect(doc.name).toBe("2");
    tm.undo();
    expect(doc).toEqual({ name: "x", list: [1, 2, 3], style: { color: "red" } });
    expect(tm.canUndo).toBe(false);
  });

  it("rolls back a transaction that throws", () => {
    const { tm, doc } = setup();
    expect(() =>
      tm.transaction(() => {
        tm.append({ uid: "a", type: "set", path: "name", payload: "half" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(doc.name).toBe("x");
    expect(tm.canUndo).toBe(false);
  });

  it("runs idempotent effects once per document per step", () => {
    const { tm, renders } = setup();
    tm.transaction(() => {
      tm.append({ uid: "a", type: "set", path: "name", payload: "1", effects: ["render"] });
      tm.append({ uid: "a", type: "set", path: "name", payload: "2", effects: ["render"] });
    });
    expect(renders).toEqual(["a"]);
    renders.length = 0;
    tm.undo();
    expect(renders).toEqual(["a"]);
  });

  it("drops the redo branch after a new edit", () => {
    const { tm } = setup();
    tm.append({ uid: "a", type: "set", path: "name", payload: "1" });
    tm.undo();
    tm.append({ uid: "a", type: "set", path: "name", payload: "2" });
    expect(tm.canRedo).toBe(false);
  });
});

describe("Features", () => {
  it("answers off before hydration, then uses saved choice over build default", () => {
    const f = new Features<{ needsUndo?: boolean }>("alpha");
    f.register({ id: "undo", autoEnable: ["alpha"], persist: true, requiredBy: (d) => !!d.needsUndo });
    f.register({ id: "debug", autoEnable: ["dev"] });
    expect(f.enabled("undo")).toBe(false);
    expect(() => f.set("undo", true)).toThrow();
    const heard: string[] = [];
    f.subscribe("undo", () => heard.push("on"), () => heard.push("off"));
    f.hydrate({ debug: true });
    expect(f.enabled("undo")).toBe(true);
    expect(f.enabled("debug")).toBe(true);
    f.set("undo", false);
    expect(heard).toEqual(["on", "off"]);
    expect(f.snapshot()).toEqual({ debug: true, undo: false });
    expect(f.canRun({ needsUndo: true })).toEqual({ ok: false, missing: ["undo"] });
    expect(f.wrap("debug", () => "yes", () => "no")()).toBe("yes");
  });
});

describe("StateMap", () => {
  it("tracks only real changes and reports removals", () => {
    const m = new StateMap<{ show?: boolean; stacks?: number; info?: { a: number } }>();
    m.update("x", { stacks: 1, info: { a: 1 } });
    m.update("y", { stacks: 2 });
    expect(m.flush()).toEqual({ updated: ["x", "y"], removed: [] });
    expect(m.update("x", { stacks: 1, info: { a: 1 } })).toBe(false);
    expect(m.changed).toBe(false);
    m.update("x", { info: { a: 2 } });
    m.remove("y");
    expect(m.flush()).toEqual({ updated: ["x"], removed: ["y"] });
    m.replace("x", { stacks: 5 });
    expect(m.get("x")).toEqual({ stacks: 5 });
    expect(m.get("x")?.show).toBeUndefined();
  });

  it("defaults show to true on create", () => {
    const m = new StateMap();
    m.update("", {});
    expect(m.get("")?.show).toBe(true);
  });
});

describe("triggers", () => {
  it("combines with all, any and custom logic", () => {
    expect(shouldShow([true, false], "all")).toBe(false);
    expect(shouldShow([true, false], "any")).toBe(true);
    expect(shouldShow([true, false, true], (t) => !!t[0] && !!t[2])).toBe(true);
    expect(shouldShow([true], () => { throw new Error("x"); })).toBe(false);
    expect(pickActiveTrigger([false, true, true], "first")).toBe(1);
  });
});

describe("ConditionRunner", () => {
  type Props = { color: string; alpha: number; glow: boolean };
  const base: Props = { color: "white", alpha: 1, glow: false };

  it("layers active conditions in order and reverts when they turn off", () => {
    const runner = new ConditionRunner<Props>(base, [
      { check: { type: "number", trigger: 0, field: "stacks", op: ">=", value: 3 }, changes: { color: "orange" } },
      { check: { type: "number", trigger: 0, field: "stacks", op: ">=", value: 5 }, changes: { color: "red", glow: true } },
    ]);
    expect(runner.evaluate([{ stacks: 5 }], 0).props).toEqual({ color: "red", alpha: 1, glow: true });
    const r = runner.evaluate([{ stacks: 3 }], 0);
    expect(r.props).toEqual({ color: "orange", alpha: 1, glow: false });
    expect(r.changed.sort()).toEqual(["color", "glow"]);
    expect(runner.evaluate([{ stacks: 0 }], 0).props).toEqual(base);
  });

  it("supports else-if chains with linked conditions", () => {
    const runner = new ConditionRunner<Props>(base, [
      { check: { type: "bool", trigger: 0, field: "a", value: true }, changes: { alpha: 0.5 } },
      { check: { type: "bool", trigger: 0, field: "b", value: true }, changes: { alpha: 0.2 }, linked: true },
    ]);
    expect(runner.evaluate([{ a: true, b: true }], 0).active).toEqual([true, false]);
    expect(runner.evaluate([{ a: false, b: true }], 0).props.alpha).toBe(0.2);
  });

  it("returns the exact time a timer check flips instead of polling", () => {
    const runner = new ConditionRunner<Props>(base, [
      {
        check: {
          type: "and",
          checks: [
            { type: "remaining", trigger: 0, field: "expirationTime", op: "<", value: 5 },
            { type: "string", trigger: 1, field: "unit", op: "contains", value: "boss" },
          ],
        },
        changes: { color: "red" },
      },
    ]);
    const states = [{ expirationTime: 20 }, { unit: "boss1" }];
    const early = runner.evaluate(states, 10);
    expect(early.props.color).toBe("white");
    expect(early.recheckAt).toBe(15);
    expect(runner.evaluate(states, 15.01).props.color).toBe("red");
  });

  it("fires one-shot actions on transitions only", () => {
    const on = vi.fn();
    const off = vi.fn();
    const runner = new ConditionRunner<Props>(base, [
      { check: { type: "bool", trigger: 0, field: "x", value: true }, changes: {}, onActivate: on, onDeactivate: off },
    ]);
    runner.evaluate([{ x: true }], 0);
    runner.evaluate([{ x: true }], 0);
    runner.evaluate([{ x: false }], 0);
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("text templates", () => {
  it("parses %sym, %2.field, %{braced}, %% and \\n", () => {
    expect(parseTemplate("%p left%%\\n%{unit name}:%2.stacks")).toEqual([
      { kind: "symbol", name: "p" },
      { kind: "text", value: " left%\n" },
      { kind: "symbol", name: "unit name" },
      { kind: "text", value: ":" },
      { kind: "symbol", name: "2.stacks" },
    ]);
    expect(symbolsIn("%n %n %s")).toEqual(["n", "s"]);
    expect(parseTemplate("100%")).toEqual([{ kind: "text", value: "100%" }]);
  });

  it("renders against trigger states with per-symbol formatters", () => {
    const template = "%n: %p (%1.stacks)";
    const states = [{ name: "Shield", expirationTime: 12.3, stacks: 1500 }, { stacks: 2300 }];
    const resolve = stateResolver(states, 0, 10);
    const formatters = createFormatters(template, { "1.stacks_format": "bigNumber", p_time_dynamic: 3 });
    expect(compileTemplate(template).render(resolve, formatters)).toBe("Shield: 2.3 (2.3k)");
  });

  it("builds string formatters from flat settings", () => {
    const f = createFormatters("%n", { n_format: "string", n_abbreviate: true, n_abbreviate_max: 3, n_pad: true, n_pad_max: 5 });
    expect(f.n?.("Fireball")).toBe("  Fir");
  });
});

describe("Migrator", () => {
  type Doc = { internalVersion?: number; color?: string; colour?: string; size?: number };
  const migrator = new Migrator<Doc>([
    { version: 2, note: "rename colour to color", up: (d) => { d.color = d.colour; delete d.colour; } },
    { version: 3, note: "size became required", up: (d) => { d.size ??= 32; } },
  ]);

  it("runs every newer step in order once", () => {
    const r = migrator.modernize({ internalVersion: 1, colour: "red" });
    expect(r).toMatchObject({ status: "migrated", applied: [2, 3], doc: { internalVersion: 3, color: "red", size: 32 } });
    expect(migrator.modernize(r.doc).status).toBe("current");
  });

  it("refuses documents from the future", () => {
    expect(migrator.modernize({ internalVersion: 9 }).status).toBe("too-new");
  });
});

describe("Transmission", () => {
  const t = new Transmission<{ id: string; secret?: string; list: number[] }>("AK");

  it("round-trips through a compact versioned string", async () => {
    const env = { d: { id: "a", list: Array.from({ length: 200 }, (_, i) => i % 7) }, v: 3 };
    const s = await t.encode(env);
    expect(s.startsWith("!AK:2!")).toBe(true);
    expect(s.length).toBeLessThan(JSON.stringify(env).length);
    const back = await t.decode(s);
    expect(back).toEqual({ ok: true, envelope: env, encoding: 2 });
  });

  it("is deterministic regardless of key order", async () => {
    const a = await t.encode({ v: 1, d: { list: [], id: "x" } });
    const b = await t.encode({ d: { id: "x", list: [] }, v: 1 });
    expect(a).toBe(b);
  });

  it("still reads the older uncompressed encoding", async () => {
    const old = new Transmission<{ id: string }>("AK", 1);
    const s = await old.encode({ d: { id: "legacy" }, v: 1 });
    expect(s.startsWith("!AK:1!")).toBe(true);
    expect(await t.decode(s)).toMatchObject({ ok: true, encoding: 1 });
  });

  it("says which stage failed", async () => {
    expect(await t.decode("hello")).toMatchObject({ ok: false, stage: "format" });
    expect(await t.decode("!AK:2!@@@")).toMatchObject({ ok: false, stage: "decoding" });
    expect(await t.decode("!AK:2!AAAA")).toMatchObject({ ok: false, stage: "decompressing" });
    expect(await t.decode("!AK:7!AAAA")).toMatchObject({ ok: false, stage: "format" });
  });

  it("strips fields that must not be shared", () => {
    expect(stripFields({ id: "a", secret: "s", list: [] }, { secret: true })).toEqual({ id: "a", list: [] });
  });
});

describe("Environments", () => {
  it("isolates errors per display and nests environments", () => {
    const errors: string[] = [];
    const envs = new Environments<{ n: number }>((e) => errors.push(`${e.id}/${e.phase}`));
    const inner = envs.run("outer", { n: 1 }, "Custom Trigger", (env) => {
      env.counter = 1;
      const r = envs.run("inner", { n: 2 }, "Custom Text", () => envs.current?.id);
      expect(envs.current?.id).toBe("outer");
      return r;
    });
    expect(inner).toBe("inner");
    expect(envs.run("bad", { n: 0 }, "Custom Trigger", () => { throw new Error("x"); })).toBeUndefined();
    expect(errors).toEqual(["bad/Custom Trigger"]);
  });

  it("persists saved data and keeps it across reset", () => {
    const envs = new Environments<null>();
    envs.get("a", null).saved = { best: 3 };
    envs.reset("a");
    expect(envs.exportSaved()).toEqual({ a: '{"best":3}' });
  });
});

describe("Animator", () => {
  const fakeTarget = () => {
    const log: Record<string, unknown> = { alpha: 1 };
    const t: AnimTarget = {
      setOffset: (x, y) => { log.offset = [Math.round(x), Math.round(y)]; },
      setAlpha: (a) => { log.alpha = a ?? 1; },
      setScale: (x, y) => { log.scale = [x, y]; },
      setRotation: (d) => { log.rotation = d; },
      setColor: (c) => { log.color = c; },
      getAlpha: () => log.alpha as number,
      getColor: (): RGBA => [1, 1, 1, 1],
    };
    return { t, log };
  };
  const manual = { request: () => 1, cancel: () => {} };

  it("plays a start animation reversed, then loops main, then finishes before hiding", () => {
    const animator = new Animator(manual);
    const { t, log } = fakeTarget();
    const hooks = { show: vi.fn(), hide: vi.fn() };
    const lc = lifecycle(animator, t, { start: "slideTop", main: "pulse", finish: "fade" }, hooks);
    lc.show();
    animator.tick(0);
    expect(log.offset).toEqual([0, 50]); // reversed: starts away, slides in
    animator.tick(0.25);
    expect(animator.isAnimating(t)).toBe("main");
    lc.hide();
    expect(hooks.hide).not.toHaveBeenCalled();
    animator.tick(0.1);
    expect(log.alpha as number).toBeLessThan(1);
    animator.tick(0.2);
    expect(hooks.hide).toHaveBeenCalledOnce();
    expect(log.alpha).toBe(1); // restored to rest
  });

  it("hides at once when there is no finish animation", () => {
    const animator = new Animator(manual);
    const { t } = fakeTarget();
    const hooks = { show: vi.fn(), hide: vi.fn() };
    const lc = lifecycle(animator, t, {}, hooks);
    lc.show();
    lc.hide();
    expect(hooks.hide).toHaveBeenCalledOnce();
  });
});

describe("layout", () => {
  const items = [
    { id: "a", width: 10, height: 10 },
    { id: "b", width: 10, height: 10 },
    { id: "c", width: 10, height: 10 },
  ];

  it("grows right, centred, and in a grid", () => {
    expect([...grower({ grow: "RIGHT", space: 2 })(items).values()].map((p) => p.x)).toEqual([5, 17, 29]);
    expect([...grower({ grow: "HORIZONTAL", space: 2 })(items).values()].map((p) => p.x)).toEqual([-12, 0, 12]);
    const grid = grower({ grow: "GRID", columns: 2, space: 0 })(items);
    expect(grid.get("c")).toEqual({ x: 5, y: -15 });
    expect(grower({ grow: "DOWN", limit: 2 })(items).size).toBe(2);
  });

  it("places a circle at equal angles", () => {
    const circle = grower({ grow: "CIRCLE", constant: "RADIUS", radius: 10 })(items.concat({ id: "d", width: 10, height: 10 }));
    expect(circle.get("a")?.y).toBeCloseTo(10);
    expect(circle.get("b")?.x).toBeCloseTo(10);
  });

  it("composes sorts and knows when to re-sort", () => {
    const kids: GroupChild[] = [
      { id: "a", index: 0, state: { expirationTime: 30 } },
      { id: "b", index: 1, state: { expirationTime: 10 } },
      { id: "c", index: 2, state: {}, pinned: true },
    ];
    const def = sorters.hybrid();
    expect([...kids].sort(def.compare).map((k) => k.id)).toEqual(["c", "b", "a"]);
    expect(needsResort(def, ["stacks"])).toBe(false);
    expect(needsResort(def, ["expirationTime"])).toBe(true);
  });
});
