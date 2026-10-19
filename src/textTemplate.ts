// Port of the WeakAuras text placeholder engine (ReplacePlaceHolders and
// ParseTextStr in WeakAuras.lua).
//
//   "%p"            symbol "p" from the active trigger's state
//   "%2.stacks"     field "stacks" from trigger 2
//   "%{unit name}"  braces allow any characters in the symbol
//   "%%"            a literal percent sign
//   "\n"            (the two characters) becomes a newline
//
// The scanner is a four-state machine, not a regex, so templates are parsed
// once into segments and rendering is a straight walk. Parsing also tells you
// which symbols a template uses, which WeakAuras uses to give each one a
// default formatter and to show only the relevant format options.

export type Segment = { kind: "text"; value: string } | { kind: "symbol"; name: string };

const enum S {
  Normal,
  PercentStart,
  PercentRest,
  Braced,
}

const isWordChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46; // 0-9 A-Z a-z .

export function parseTemplate(template: string): Segment[] {
  const out: Segment[] = [];
  let text = "";
  let symbol = "";
  let state = S.Normal;

  const flushText = () => {
    if (text) out.push({ kind: "text", value: text.replace(/\\n/g, "\n") });
    text = "";
  };
  const flushSymbol = () => {
    flushText();
    out.push({ kind: "symbol", name: symbol });
    symbol = "";
  };

  for (const ch of template) {
    const c = ch.charCodeAt(0);
    switch (state) {
      case S.Normal:
        if (ch === "%") state = S.PercentStart;
        else text += ch;
        break;
      case S.PercentStart:
        if (ch === "%") {
          text += "%";
          state = S.Normal;
        } else if (ch === "{") {
          state = S.Braced;
        } else if (isWordChar(c)) {
          symbol = ch;
          state = S.PercentRest;
        } else {
          text += "%" + ch;
          state = S.Normal;
        }
        break;
      case S.PercentRest:
        if (isWordChar(c)) {
          symbol += ch;
        } else {
          flushSymbol();
          if (ch === "%") state = S.PercentStart;
          else {
            text += ch;
            state = S.Normal;
          }
        }
        break;
      case S.Braced:
        if (ch === "}") {
          flushSymbol();
          state = S.Normal;
        } else symbol += ch;
        break;
    }
  }

  if (state === S.PercentRest) flushSymbol();
  else if (state === S.PercentStart) text += "%";
  else if (state === S.Braced) text += "%{" + symbol; // unclosed brace stays literal
  flushText();
  return out;
}

export function symbolsIn(template: string): string[] {
  return [...new Set(parseTemplate(template).flatMap((s) => (s.kind === "symbol" ? [s.name] : [])))];
}

export type Formatter = (value: unknown) => string;

export interface CompiledTemplate {
  readonly symbols: readonly string[];
  render(resolve: (symbol: string) => unknown, formatters?: Readonly<Record<string, Formatter>>): string;
}

const show = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v);

export function compileTemplate(template: string): CompiledTemplate {
  const segments = parseTemplate(template);
  const symbols = [...new Set(segments.flatMap((s) => (s.kind === "symbol" ? [s.name] : [])))];
  return {
    symbols,
    render(resolve, formatters = {}) {
      let out = "";
      for (const seg of segments) {
        if (seg.kind === "text") out += seg.value;
        else {
          const value = resolve(seg.name);
          const fmt = formatters[seg.name];
          out += fmt ? fmt(value) : show(value);
        }
      }
      return out;
    },
  };
}

/**
 * Resolves symbols against trigger states the way WeakAuras does: "2.stacks"
 * reads trigger 2, a bare name reads the active trigger, and short aliases
 * (p, t, n, s, i) map to the common fields or computed values.
 */
export function stateResolver(
  states: readonly (Readonly<Record<string, unknown>> | undefined)[],
  activeTrigger: number,
  now: number,
  aliases: Readonly<Record<string, (s: Readonly<Record<string, unknown>>, now: number) => unknown>> = defaultAliases,
): (symbol: string) => unknown {
  return (symbol) => {
    const dot = symbol.indexOf(".");
    let trigger = activeTrigger;
    let name = symbol;
    if (dot > 0) {
      const n = Number(symbol.slice(0, dot));
      if (Number.isInteger(n)) {
        trigger = n;
        name = symbol.slice(dot + 1);
      }
    }
    const state = states[trigger];
    if (!state) return undefined;
    const alias = aliases[name];
    return alias ? alias(state, now) : state[name];
  };
}

export const defaultAliases: Record<string, (s: Readonly<Record<string, unknown>>, now: number) => unknown> = {
  // Progress: time left for timed states, value for static ones.
  p: (s, now) =>
    typeof s.expirationTime === "number" ? Math.max(0, s.expirationTime - now) : s.value,
  // Total: duration or the static maximum.
  t: (s) => s.duration ?? s.total,
  n: (s) => s.name,
  s: (s) => s.stacks,
  i: (s) => s.icon,
};
