// Port of Private.format_types in WeakAuras/Types.lua.
//
// Each format type is defined once, with two halves side by side:
//   options  - a schema the settings UI renders (fields, defaults, when shown)
//   create   - builds the formatter function from the chosen settings
// Adding a format type is a single entry, and the UI and the runtime can't
// drift apart. Settings are stored flat as "<symbol>_<option>" keys, so a
// template's per-symbol settings sit in one plain object that serializes
// cleanly.

import { symbolsIn, type Formatter } from "./textTemplate.js";

export type OptionSchema =
  | { key: string; type: "toggle"; label: string; default: boolean; showIf?: string }
  | { key: string; type: "number"; label: string; default: number; min?: number; max?: number; step?: number; showIf?: string }
  | { key: string; type: "select"; label: string; default: string; values: Record<string, string>; showIf?: string };

export interface FormatType {
  label: string;
  options: OptionSchema[];
  /** Return undefined when the settings make the formatter a no-op. */
  create(get: <T>(key: string, fallback: T) => T): Formatter | undefined;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function pad(s: string, mode: "left" | "right" | "center", width: number): string {
  const n = width - [...s].length;
  if (n <= 0) return s;
  if (mode === "left") return " ".repeat(n) + s;
  if (mode === "right") return s + " ".repeat(n);
  const l = Math.floor(n / 2);
  return " ".repeat(l) + s + " ".repeat(n - l);
}

/** 1234 -> "1.2k", 5_600_000 -> "5.6M" */
export function abbreviateNumber(n: number, decimals = 1): string {
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) return (n / size).toFixed(decimals).replace(/\.0+$/, "") + suffix;
  }
  return String(Math.round(n));
}

/**
 * Durations the way WeakAuras shows them: "1h", "12m", "45", then decimals
 * under a threshold ("4.3") so the last seconds tick visibly.
 */
export function formatDuration(seconds: number, style: "auto" | "clock", decimalsBelow: number, decimals: number): string {
  if (seconds <= 0) return "0";
  if (style === "clock") {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < decimalsBelow) return seconds.toFixed(decimals);
  return String(Math.ceil(seconds));
}

export const formatTypes: Record<string, FormatType> = {
  none: { label: "None", options: [], create: () => undefined },

  string: {
    label: "Text",
    options: [
      { key: "abbreviate", type: "toggle", label: "Abbreviate", default: false },
      { key: "abbreviate_max", type: "number", label: "Max characters", default: 8, min: 1, max: 40, showIf: "abbreviate" },
      { key: "pad", type: "toggle", label: "Pad", default: false },
      { key: "pad_mode", type: "select", label: "Pad side", default: "left", values: { left: "Left", right: "Right", center: "Center" }, showIf: "pad" },
      { key: "pad_max", type: "number", label: "Pad to", default: 8, min: 1, max: 40, showIf: "pad" },
    ],
    create(get) {
      const abbreviate = get("abbreviate", false);
      const max = get("abbreviate_max", 8);
      const padOn = get("pad", false);
      const mode = get<"left" | "right" | "center">("pad_mode", "left");
      const width = get("pad_max", 8);
      if (!abbreviate && !padOn) return undefined;
      return (v) => {
        let s = str(v);
        if (abbreviate) s = [...s].slice(0, max).join("");
        return padOn ? pad(s, mode, width) : s;
      };
    },
  },

  number: {
    label: "Number",
    options: [
      { key: "decimals", type: "number", label: "Decimals", default: 0, min: 0, max: 4 },
      { key: "round", type: "select", label: "Rounding", default: "round", values: { round: "Round", floor: "Down", ceil: "Up" } },
    ],
    create(get) {
      const decimals = get("decimals", 0);
      const round = Math[get<"round" | "floor" | "ceil">("round", "round")];
      const f = 10 ** decimals;
      return (v) => {
        const n = num(v);
        return n === undefined ? str(v) : (round(n * f) / f).toFixed(decimals);
      };
    },
  },

  bigNumber: {
    label: "Big number",
    options: [{ key: "big_decimals", type: "number", label: "Decimals", default: 1, min: 0, max: 3 }],
    create(get) {
      const decimals = get("big_decimals", 1);
      return (v) => {
        const n = num(v);
        return n === undefined ? str(v) : abbreviateNumber(n, decimals);
      };
    },
  },

  timed: {
    label: "Time",
    options: [
      { key: "time_style", type: "select", label: "Style", default: "auto", values: { auto: "1h / 12m / 45 / 4.3", clock: "1:02:03" } },
      { key: "time_dynamic", type: "number", label: "Show decimals below (s)", default: 3, min: 0, max: 60 },
      { key: "time_precision", type: "number", label: "Decimals", default: 1, min: 0, max: 3 },
    ],
    create(get) {
      const style = get<"auto" | "clock">("time_style", "auto");
      const below = get("time_dynamic", 3);
      const precision = get("time_precision", 1);
      return (v) => {
        const n = num(v);
        return n === undefined ? str(v) : formatDuration(n, style, below, precision);
      };
    },
  },
};

export type FormatSettings = Record<string, unknown>;

/** Which format type a symbol gets when the user hasn't picked one. */
export const defaultFormatFor = (symbol: string): string => {
  const name = symbol.includes(".") ? symbol.slice(symbol.indexOf(".") + 1) : symbol;
  if (name === "p" || name === "t" || /time|duration|remaining/i.test(name)) return "timed";
  if (/^(s|stacks|value|total|count)$/i.test(name)) return "number";
  return "none";
};

/**
 * Builds formatters for every symbol in `template` from flat settings
 * (`<symbol>_format`, `<symbol>_<option>`). Mirrors CreateFormatters.
 */
export function createFormatters(template: string, settings: FormatSettings): Record<string, Formatter> {
  const out: Record<string, Formatter> = {};
  for (const symbol of symbolsIn(template)) {
    const typeName = (settings[`${symbol}_format`] as string | undefined) ?? defaultFormatFor(symbol);
    const type = formatTypes[typeName];
    if (!type) continue;
    const get = <T>(key: string, fallback: T): T => {
      const v = settings[`${symbol}_${key}`];
      return v === undefined ? fallback : (v as T);
    };
    const f = type.create(get);
    if (f) out[symbol] = f;
  }
  return out;
}
