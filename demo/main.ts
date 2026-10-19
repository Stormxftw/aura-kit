// A cooldown tracker built from aura-kit, the way a WeakAuras display works:
// a trigger fills a state map, each state gets a clone, conditions restyle
// clones, a dynamic group lays them out, and the config is undoable,
// exportable and migrated on import.

import {
  Animator,
  ConditionRunner,
  ConditionScheduler,
  Migrator,
  StateMap,
  Subscribable,
  TimeMachine,
  Transmission,
  compileTemplate,
  createFormatters,
  defaultFormatFor,
  domTarget,
  formatTypes,
  grower,
  lifecycle,
  sorters,
  stateResolver,
  symbolsIn,
  type GrowConfig,
  type GroupChild,
  type OptionSchema,
} from "../src/index.js";

// ---- Config document, its migrations and its history ----------------------

interface GroupConfig {
  internalVersion?: number;
  layout: "HORIZONTAL" | "RIGHT" | "DOWN" | "CIRCLE" | "GRID";
  sort: "ascending" | "descending" | "none";
  space: number;
  warnAt: number;
  template: string;
  format: Record<string, unknown>;
}

const migrator = new Migrator<GroupConfig & Record<string, unknown>>([
  {
    version: 2,
    note: "growDirection was renamed layout",
    up: (d) => {
      if (d.growDirection) d.layout = d.growDirection as GroupConfig["layout"];
      delete d.growDirection;
    },
  },
  {
    version: 3,
    note: "Added the warning threshold; old configs warned at 3s",
    up: (d) => {
      d.warnAt ??= 3;
      d.format ??= {};
    },
  },
]);

const config: GroupConfig = {
  internalVersion: migrator.current,
  layout: "HORIZONTAL",
  sort: "ascending",
  space: 8,
  warnAt: 3,
  template: "%p",
  format: {},
};

const docs: Record<string, Record<string, unknown>> = { group: config as unknown as Record<string, unknown> };
const history = new TimeMachine((uid) => docs[uid]);
history.registerEffect("refresh", () => refreshAll(), true);

const edit = (path: string | string[], value: unknown) =>
  history.append({ uid: "group", type: "set", path, payload: value, effects: ["refresh"] });

// ---- Trigger: abilities on cooldown ------------------------------------------

const abilities = [
  { id: "fireball", name: "Fireball", icon: "🔥", cd: 8 },
  { id: "nova", name: "Frost Nova", icon: "❄️", cd: 12 },
  { id: "blink", name: "Blink", icon: "✨", cd: 5 },
  { id: "shield", name: "Ice Barrier", icon: "🛡️", cd: 20 },
  { id: "heal", name: "Renew", icon: "💚", cd: 3.5 },
];

type CooldownState = { show?: boolean; name: string; icon: string; expirationTime: number; duration: number; index: number };
const states = new StateMap<CooldownState>();
const now = () => performance.now() / 1000;
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cast(i: number) {
  const a = abilities[i]!;
  const t = now();
  states.update(a.id, { name: a.name, icon: a.icon, expirationTime: t + a.cd, duration: a.cd, index: i });
  clearTimeout(expiryTimers.get(a.id));
  expiryTimers.set(a.id, setTimeout(() => {
    states.remove(a.id);
    sync();
  }, a.cd * 1000));
  sync();
}

// ---- A shared ticker that runs only while something listens ----------------
// Subscribable reports its first and last subscriber, so the interval exists
// only while at least one icon is on screen.

const clock = new Subscribable<{ tick: [] }>();
let interval: ReturnType<typeof setInterval> | undefined;
const tickerNote = document.getElementById("ticker")!;
clock.onActiveChange("tick", (active) => {
  if (active) interval = setInterval(() => clock.notify("tick"), 100);
  else clearInterval(interval);
  tickerNote.textContent = active ? "Text ticker: running" : "Text ticker: stopped (nothing to update)";
});
tickerNote.textContent = "Text ticker: stopped (nothing to update)";

// ---- Clones ------------------------------------------------------------------

type Props = { color: string; glow: boolean };
const base: Props = { color: "rgba(255,255,255,0.9)", glow: false };

interface Clone {
  key: string;
  slot: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
  life: ReturnType<typeof lifecycle>;
  conditions: ConditionScheduler<Props>;
  untick: () => void;
  leaving: boolean;
}

const stage = document.getElementById("stage")!;
const logEl = document.getElementById("log")!;
const animator = new Animator();
const clones = new Map<string, Clone>();
let template = compileTemplate(config.template);
let formatters = createFormatters(config.template, config.format);

const log = (line: string) => {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${logEl.textContent ?? ""}`.slice(0, 4000);
};

function makeRunner(key: string): ConditionRunner<Props> {
  return new ConditionRunner<Props>(base, [
    {
      check: { type: "remaining", trigger: 0, field: "expirationTime", op: "<", value: config.warnAt },
      changes: { color: "rgba(255,120,60,1)", glow: true },
      onActivate: () => log(`${key}: under ${config.warnAt}s, warning on`),
      onDeactivate: () => log(`${key}: warning off`),
    },
  ]);
}

function renderText(c: Clone) {
  const s = states.get(c.key);
  if (!s) return;
  const t = now();
  c.label.textContent = template.render(stateResolver([s], 0, t), formatters);
  c.icon.style.setProperty("--p", String(Math.max(0, (s.expirationTime - t) / s.duration)));
}

function createClone(key: string): Clone {
  const slot = document.createElement("div");
  slot.className = "slot";
  slot.style.left = "50%";
  slot.style.top = "50%";
  const icon = document.createElement("div");
  icon.className = "icon";
  icon.innerHTML = `<div class="sweep"></div><span class="emoji"></span><span class="label"></span>`;
  slot.append(icon);
  stage.append(slot);

  const target = domTarget(icon, {
    progress: () => {
      const s = states.get(key);
      return s ? 1 - Math.max(0, (s.expirationTime - now()) / s.duration) : 0;
    },
  });
  const clone: Clone = {
    key,
    slot,
    icon,
    label: icon.querySelector(".label")!,
    leaving: false,
    life: lifecycle(animator, target, { start: "slideBottom", finish: "grow" }, {
      show: () => {},
      hide: () => slot.remove(),
    }),
    conditions: undefined as unknown as ConditionScheduler<Props>,
    untick: () => {},
  };
  clone.conditions = new ConditionScheduler(makeRunner(key), () => [states.get(key)], (r) => {
    icon.style.borderColor = r.props.color;
    icon.classList.toggle("glow", r.props.glow);
  });
  clone.untick = clock.subscribe("tick", () => renderText(clone));
  return clone;
}

function sync() {
  const { updated, removed } = states.flush();
  for (const key of updated) {
    let c = clones.get(String(key));
    if (!c) {
      c = createClone(String(key));
      clones.set(String(key), c);
      c.life.show();
    }
    c.icon.querySelector(".emoji")!.textContent = states.get(key)!.icon;
    c.conditions.evaluate();
    renderText(c);
  }
  for (const key of removed) {
    const c = clones.get(String(key));
    if (!c) continue;
    clones.delete(String(key));
    c.untick();
    c.conditions.dispose();
    c.leaving = true;
    c.life.hide();
  }
  layout();
}

function layout() {
  const sort = config.sort === "none" ? sorters.none() : sorters[config.sort]();
  const children: (GroupChild & { key: string })[] = [...clones.values()].map((c) => {
    const s = states.get(c.key)!;
    return { id: c.key, key: c.key, index: s.index, state: s };
  });
  children.sort(sort.compare);
  const growCfg: GrowConfig =
    config.layout === "CIRCLE"
      ? { grow: "CIRCLE", space: config.space, constant: "SPACING" }
      : config.layout === "GRID"
        ? { grow: "GRID", columns: 3, space: config.space }
        : { grow: config.layout, space: config.space };
  const positions = grower(growCfg)(children.map((c) => ({ id: c.id, width: 56, height: 56 })));
  for (const child of children) {
    const pos = positions.get(child.id);
    const c = clones.get(child.key)!;
    c.slot.style.left = `calc(50% + ${pos?.x ?? 0}px)`;
    c.slot.style.top = `calc(50% - ${pos?.y ?? 0}px)`;
  }
}

// Re-sorting on a timer isn't needed: the sort reads expirationTime, which only
// changes when an ability is cast, and sync() lays out after every cast.

let compiledWarnAt = config.warnAt;

function refreshAll() {
  template = compileTemplate(config.template);
  formatters = createFormatters(config.template, config.format);
  // Conditions are compiled with the threshold baked in; rebuild only when it
  // changes, or every unrelated edit would replay their "turned on" actions.
  const rebuild = compiledWarnAt !== config.warnAt;
  compiledWarnAt = config.warnAt;
  for (const c of clones.values()) {
    renderText(c);
    if (!rebuild) continue;
    c.conditions.dispose();
    c.conditions = new ConditionScheduler(makeRunner(c.key), () => [states.get(c.key)], (r) => {
      c.icon.style.borderColor = r.props.color;
      c.icon.classList.toggle("glow", r.props.glow);
    });
    c.conditions.evaluate();
  }
  layout();
  renderControls();
}

// ---- Controls ------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const abilitiesEl = $("abilities");
abilities.forEach((a, i) => {
  const b = document.createElement("button");
  b.textContent = `${a.icon} ${a.name} (${a.cd}s)`;
  b.onclick = () => cast(i);
  abilitiesEl.append(b);
});

const layoutEl = $<HTMLSelectElement>("layout");
const sortEl = $<HTMLSelectElement>("sort");
const spaceEl = $<HTMLInputElement>("space");
const warnEl = $<HTMLInputElement>("warnAt");
const templateEl = $<HTMLInputElement>("template");
const formattersEl = $("formatters");
const undoEl = $<HTMLButtonElement>("undo");
const redoEl = $<HTMLButtonElement>("redo");
const historyNote = $("historyNote");

layoutEl.onchange = () => edit("layout", layoutEl.value);
sortEl.onchange = () => edit("sort", sortEl.value);
spaceEl.onchange = () => edit("space", Number(spaceEl.value));
warnEl.onchange = () => edit("warnAt", Number(warnEl.value));
templateEl.onchange = () => edit("template", templateEl.value);
undoEl.onclick = () => history.undo();
redoEl.onclick = () => history.redo();
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
  if (e.key === "z") { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); }
  if (e.key === "y") { e.preventDefault(); history.redo(); }
});
history.events.subscribe("step", () => renderControls());

/** The format options panel is generated from each format type's schema. */
function renderFormatters() {
  formattersEl.innerHTML = "";
  for (const symbol of symbolsIn(config.template)) {
    const box = document.createElement("div");
    box.className = "fmt";
    const typeName = (config.format[`${symbol}_format`] as string | undefined) ?? defaultFormatFor(symbol);
    const select = document.createElement("select");
    for (const [name, type] of Object.entries(formatTypes)) select.add(new Option(type.label, name, false, name === typeName));
    select.onchange = () => edit(["format", `${symbol}_format`], select.value);
    const head = document.createElement("label");
    head.className = "row";
    head.innerHTML = `<span>Format <code>%${symbol}</code></span>`;
    head.append(select);
    box.append(head);

    const type = formatTypes[typeName];
    const value = (o: OptionSchema) => config.format[`${symbol}_${o.key}`] ?? o.default;
    for (const opt of type?.options ?? []) {
      if (opt.showIf && !value(type!.options.find((o) => o.key === opt.showIf)!)) continue;
      const row = document.createElement("label");
      row.className = "row";
      row.innerHTML = `<span>${opt.label}</span>`;
      let input: HTMLInputElement | HTMLSelectElement;
      const key = ["format", `${symbol}_${opt.key}`];
      if (opt.type === "toggle") {
        input = Object.assign(document.createElement("input"), { type: "checkbox", checked: Boolean(value(opt)) });
        input.onchange = () => edit(key, (input as HTMLInputElement).checked);
      } else if (opt.type === "number") {
        input = Object.assign(document.createElement("input"), {
          type: "number", value: String(value(opt)), min: String(opt.min ?? ""), max: String(opt.max ?? ""), step: String(opt.step ?? 1),
        });
        input.style.width = "80px";
        input.onchange = () => edit(key, Number(input.value));
      } else {
        input = document.createElement("select");
        for (const [v, label] of Object.entries(opt.values)) (input as HTMLSelectElement).add(new Option(label, v, false, v === value(opt)));
        input.onchange = () => edit(key, input.value);
      }
      row.append(input);
      box.append(row);
    }
    formattersEl.append(box);
  }
}

function renderControls() {
  layoutEl.value = config.layout;
  sortEl.value = config.sort;
  spaceEl.value = String(config.space);
  warnEl.value = String(config.warnAt);
  templateEl.value = config.template;
  undoEl.disabled = !history.canUndo;
  redoEl.disabled = !history.canRedo;
  const next = history.peekUndo()?.forward[0];
  historyNote.textContent = next ? `Last: ${[next.path].flat().join(".")}` : "No edits yet";
  renderFormatters();
}

// ---- Share: export, import, migration ------------------------------------------

const transmission = new Transmission<Record<string, unknown>>("AK");
const shareEl = $<HTMLTextAreaElement>("share");
const shareNote = $("shareNote");
const note = (text: string, err = false) => {
  shareNote.textContent = text;
  shareNote.classList.toggle("err", err);
};

$("export").onclick = async () => {
  shareEl.value = await transmission.encode({ d: structuredClone(config) as unknown as Record<string, unknown>, v: migrator.current });
  note(`${shareEl.value.length} characters. Equal configs always give the same string.`);
};

$("import").onclick = async () => {
  const r = await transmission.decode(shareEl.value);
  if (!r.ok) return note(`Import failed while ${r.stage}: ${r.error}`, true);
  const doc = structuredClone(r.envelope.d) as GroupConfig & Record<string, unknown>;
  const m = migrator.modernize(doc);
  if (m.status === "too-new") return note(`This config is from version ${m.docVersion}; this page knows ${m.currentVersion}. Not loaded.`, true);
  if (m.status === "too-old") return note("This config is too old to load.", true);
  history.transaction(() => {
    for (const key of ["layout", "sort", "space", "warnAt", "template", "format"] as const) {
      if (doc[key] !== undefined) edit(key, doc[key]);
    }
  }, "import");
  note(m.status === "migrated" ? `Imported and migrated through v${m.applied.join(", v")}. Undo reverts the import.` : "Imported.");
};

$("legacy").onclick = async () => {
  // What an export from "version 1" of this page looked like.
  shareEl.value = await new Transmission("AK", 1).encode({
    d: { internalVersion: 1, growDirection: "CIRCLE", sort: "descending", space: 14, template: "%n %p" },
    v: 1,
  });
  note("An old, uncompressed v1 string with old field names. Press Import.");
};

renderControls();
