// Port of the ideas in WeakAuras/AuraEnvironment.lua.
//
// Every display that runs user code gets its own environment ("aura_env"): a
// private table for that display's variables, its user config, and a `saved`
// slot that survives reloads. Code runs with the right environment pushed on
// a stack, so a display that triggers another display's code nests cleanly.
// Errors are caught per display and reported against it by name and by
// phase ("Custom Trigger", "Custom Text"), so one broken widget can't take
// the page down and its author can see what failed.
//
// WeakAuras also blocks dangerous globals inside user code. In JavaScript,
// shadowing names is a speed bump, not a security boundary; run untrusted
// code in an iframe sandbox or a Worker instead.

export interface Env<C = unknown> {
  id: string;
  config: C;
  /** Persisted between sessions. Keep it small and serializable. */
  saved: unknown;
  /** Anything the user's code wants to keep between calls. */
  [key: string]: unknown;
}

export interface ScriptError {
  id: string;
  phase: string;
  error: unknown;
}

export class Environments<C = unknown> {
  private readonly envs = new Map<string, Env<C>>();
  private readonly stack: Env<C>[] = [];

  constructor(
    private readonly onError: (e: ScriptError) => void = (e) => console.error(`[${e.id}] ${e.phase}:`, e.error),
    private readonly maxSavedBytes = 16_000,
  ) {}

  get(id: string, config: C): Env<C> {
    let env = this.envs.get(id);
    if (!env) {
      env = { id, config: structuredClone(config), saved: undefined };
      this.envs.set(id, env);
    }
    return env;
  }

  /** The environment of the code running right now, if any. */
  get current(): Env<C> | undefined {
    return this.stack.at(-1);
  }

  /**
   * Run `fn` as display `id`. Errors are reported, not thrown, and the
   * result is undefined, so callers treat a failed script as "no answer".
   */
  run<R>(id: string, config: C, phase: string, fn: (env: Env<C>) => R): R | undefined {
    const env = this.get(id, config);
    this.stack.push(env);
    try {
      return fn(env);
    } catch (error) {
      this.onError({ id, phase, error });
      return undefined;
    } finally {
      this.stack.pop();
    }
  }

  rename(oldId: string, newId: string): void {
    const env = this.envs.get(oldId);
    if (!env) return;
    this.envs.delete(oldId);
    env.id = newId;
    this.envs.set(newId, env);
  }

  delete(id: string): void {
    this.envs.delete(id);
  }

  /** Drop runtime variables but keep `saved`, e.g. after the user edits code. */
  reset(id: string): void {
    const env = this.envs.get(id);
    if (env) this.envs.set(id, { id, config: env.config, saved: env.saved });
  }

  /** Collect every `saved` slot for persistence, warning about large ones. */
  exportSaved(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, env] of this.envs) {
      if (env.saved === undefined) continue;
      try {
        const json = JSON.stringify(env.saved);
        if (json.length > this.maxSavedBytes) {
          this.onError({ id, phase: "Saved data", error: new Error(`saved is ${json.length} bytes`) });
        }
        out[id] = json;
      } catch (error) {
        this.onError({ id, phase: "Saved data", error });
      }
    }
    return out;
  }

  importSaved(data: Record<string, string>, configs: Record<string, C>): void {
    for (const [id, json] of Object.entries(data)) {
      try {
        this.get(id, configs[id] as C).saved = JSON.parse(json);
      } catch (error) {
        this.onError({ id, phase: "Saved data", error });
      }
    }
  }
}

/**
 * Compile a user function from source, as WeakAuras' LoadFunction does, with
 * blocked globals shadowed to undefined. Not a security boundary (see above).
 */
export function compileUserFunction<F extends (...args: never[]) => unknown>(
  source: string,
  blocked: readonly string[] = ["fetch", "XMLHttpRequest", "WebSocket", "localStorage", "indexedDB", "eval", "Function"],
): F {
  const factory = new Function(...blocked, `"use strict"; return (${source});`);
  const fn = factory(...blocked.map(() => undefined));
  if (typeof fn !== "function") throw new Error("Source must evaluate to a function");
  return fn as F;
}
