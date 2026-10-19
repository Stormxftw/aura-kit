// Port of WeakAuras/Animations.lua and the shape functions and presets in
// Prototypes.lua.
//
// What's worth copying:
// - One frame loop for every animation on the page. It starts when the first
//   animation is added and stops when the last one ends, so an idle page
//   costs nothing.
// - Each animation is a progress value (0..1) passed through an easing curve,
//   then through a "shape" per channel: translate, alpha, scale, rotate,
//   colour. Shapes are tiny pure functions (bounce, shake, pulse, spiral), so
//   new motions are one function each.
// - A display has three phases: "start" plays (reversed) when it appears,
//   "main" loops while it's visible, "finish" plays before it hides. Hiding
//   waits for the finish animation.
// - "relative" duration ties an animation to the display's own progress: a
//   pulse that runs once per cooldown, however long the cooldown is.

export type RGBA = [number, number, number, number];
export type Ease = "none" | "easeIn" | "easeOut" | "easeOutIn";

export const easings: Record<Ease, (p: number, power: number) => number> = {
  none: (p) => p,
  easeIn: (p, power) => p ** power,
  easeOut: (p, power) => 1 - (1 - p) ** power,
  easeOutIn: (p, power) => (p < 0.5 ? (p * 2) ** power * 0.5 : 1 - ((1 - p) * 2) ** power * 0.5),
};

type ScalarShape = (p: number, start: number, delta: number) => number;
type PairShape = (p: number, sx: number, sy: number, dx: number, dy: number) => [number, number];
type ColorShape = (p: number, from: RGBA, to: RGBA) => RGBA;

const TAU = Math.PI * 2;
const backAndForth = (p: number): number => (p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : (p - 1) * 4);
const sinePulse = (p: number): number => (Math.sin(p * TAU - Math.PI / 2) + 1) / 2;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpColor = (a: RGBA, b: RGBA, t: number): RGBA =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];

export const scalarShapes: Record<string, ScalarShape> = {
  straight: (p, s, d) => s + p * d,
  flash: (p, s, d) => s + (p < 0.5 ? p * 2 : (p - 1) * 2) * d,
  pulse: (p, s, d) => s + sinePulse(p) * d,
  backAndForth: (p, s, d) => s + backAndForth(p) * d,
  wobble: (p, s, d) => s + Math.sin(p * TAU) * d,
  hide: () => 0,
};

export const translateShapes: Record<string, PairShape> = {
  straight: (p, sx, sy, dx, dy) => [sx + p * dx, sy + p * dy],
  circle: (p, sx, sy, dx, dy) => [sx + dx * Math.cos(p * TAU), sy + dy * Math.sin(p * TAU)],
  circle2: (p, sx, sy, dx, dy) => [sx + dx * Math.sin(p * TAU), sy + dy * Math.cos(p * TAU)],
  spiral: (p, sx, sy, dx, dy) => [sx + p * dx * Math.cos(p * TAU), sy + p * dy * Math.sin(p * TAU)],
  spiralAndPulse: (p, sx, sy, dx, dy) => {
    const a = (p + 0.25) * TAU;
    return [sx + Math.cos(a) * dx * Math.cos(a * 2), sy + Math.abs(Math.cos(a)) * dy * Math.sin(a * 2)];
  },
  shake: (p, sx, sy, dx, dy) => [sx + backAndForth(p) * dx, sy + backAndForth(p) * dy],
  bounce: (p, sx, sy, dx, dy) => {
    const b = Math.sin(p * Math.PI);
    return [sx + b * dx, sy + b * dy];
  },
  bounceDecay: (p, sx, sy, dx, dy) => {
    const prog = (p * 3.5) % 1;
    const b = Math.sin(prog * Math.PI) * (Math.ceil(p * 3.5) / 4);
    return [sx + b * dx, sy + b * dy];
  },
  starShakeDecay: (p, _sx, _sy, dx, dy) => {
    const spokes = 10;
    const r = Math.min(Math.abs(dx), Math.abs(dy)) || 1;
    const step = ((4 * 2) / spokes) * Math.PI;
    const q = p * spokes;
    const i = Math.floor(q);
    const f = q - i;
    const a1 = i * step;
    const a2 = a1 + step;
    const ease = Math.sin((p * Math.PI) / 2);
    const x = f * r * Math.cos(a2) + (1 - f) * r * Math.cos(a1);
    const y = f * r * Math.sin(a2) + (1 - f) * r * Math.sin(a1);
    return [ease * x * (dx / r), ease * y * (dy / r)];
  },
};

export const scaleShapes: Record<string, PairShape> = {
  straight: (p, sx, sy, tx, ty) => [sx + p * (tx - sx), sy + p * (ty - sy)],
  pulse: (p, sx, sy, tx, ty) => [sx + sinePulse(p) * (tx - 1), sy + sinePulse(p) * (ty - 1)],
  fauxSpin: (p, _sx, sy, tx, ty) => [Math.cos(p * TAU) * tx, sy + p * (ty - sy)],
  fauxFlip: (p, sx, _sy, tx, ty) => [sx + p * (tx - sx), Math.cos(p * TAU) * ty],
};

export const colorShapes: Record<string, ColorShape> = {
  straight: (p, a, b) => lerpColor(a, b, p),
  pulse: (p, a, b) => lerpColor(a, b, sinePulse(p)),
};

type ShapeRef<F> = string | F;

export interface AnimSpec {
  /** Seconds, or for "relative" a fraction of the target's own progress. */
  duration: number;
  durationType?: "seconds" | "relative";
  ease?: Ease;
  easeStrength?: number;
  translate?: { x: number; y: number; shape?: ShapeRef<PairShape> };
  alpha?: { to: number; shape?: ShapeRef<ScalarShape> };
  scale?: { x: number; y: number; shape?: ShapeRef<PairShape> };
  rotate?: { degrees: number; shape?: ShapeRef<ScalarShape> };
  color?: { to: RGBA; shape?: ShapeRef<ColorShape> };
}

export const presets = {
  // Start and finish
  slideTop: { duration: 0.25, translate: { x: 0, y: 50 }, alpha: { to: 0 } },
  slideBottom: { duration: 0.25, translate: { x: 0, y: -50 }, alpha: { to: 0 } },
  slideLeft: { duration: 0.25, translate: { x: -50, y: 0 }, alpha: { to: 0 } },
  slideRight: { duration: 0.25, translate: { x: 50, y: 0 }, alpha: { to: 0 } },
  fade: { duration: 0.25, alpha: { to: 0 } },
  grow: { duration: 0.25, scale: { x: 2, y: 2 }, alpha: { to: 0 } },
  shrink: { duration: 0.25, scale: { x: 0, y: 0 }, alpha: { to: 0 } },
  spiral: { duration: 0.5, translate: { x: 100, y: 100, shape: "spiral" }, alpha: { to: 0 } },
  bounceDecay: { duration: 1.5, translate: { x: 50, y: 50, shape: "bounceDecay" }, alpha: { to: 0 } },
  starShakeDecay: { duration: 1, translate: { x: 50, y: 50, shape: "starShakeDecay" }, alpha: { to: 0 } },
  // Main (looping)
  shake: { duration: 0.5, translate: { x: 10, y: 0, shape: "circle2" } },
  spin: { duration: 1, scale: { x: 1, y: 1, shape: "fauxSpin" } },
  flip: { duration: 1, scale: { x: 1, y: 1, shape: "fauxFlip" } },
  wobble: { duration: 0.5, rotate: { degrees: 3, shape: "wobble" } },
  pulse: { duration: 0.75, scale: { x: 1.05, y: 1.05, shape: "pulse" } },
  alphaPulse: { duration: 0.5, alpha: { to: 0.5, shape: "pulse" } },
  rotateClockwise: { duration: 0.75, rotate: { degrees: -360 } },
  bounce: { duration: 0.6, translate: { x: 0, y: 25, shape: "bounce" } },
} satisfies Record<string, AnimSpec>;

export type PresetName = keyof typeof presets;

/** What an animation drives. `null` means "back to your own value". */
export interface AnimTarget {
  setOffset(x: number, y: number): void;
  setAlpha(alpha: number | null): void;
  setScale(x: number, y: number): void;
  setRotation(degrees: number | null): void;
  setColor(color: RGBA | null): void;
  getAlpha(): number;
  getColor(): RGBA;
  /** 0..1 progress of the target's own timer, for "relative" animations. */
  progress?(): number;
}

export type Phase = "start" | "main" | "finish";

interface Running {
  target: AnimTarget;
  phase: Phase;
  spec: AnimSpec;
  progress: number;
  iteration?: number;
  inverse: boolean;
  loop: boolean;
  startAlpha: number;
  startColor: RGBA;
  onFinished?: () => void;
}

export interface FrameScheduler {
  request(cb: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

const rafScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
};

const resolveShape = <F>(ref: ShapeRef<F> | undefined, table: Record<string, F>, fallback: F): F =>
  typeof ref === "string" ? table[ref] ?? fallback : ref ?? fallback;

export class Animator {
  private readonly running = new Map<AnimTarget, Running>();
  private handle: number | undefined;
  private last: number | undefined;

  constructor(
    private readonly scheduler: FrameScheduler = rafScheduler,
    private readonly onError: (e: unknown) => void = (e) => console.error("Animation error:", e),
  ) {}

  /**
   * Returns false when the spec animates nothing, so the caller can skip
   * straight to the end (hide now instead of after a finish animation).
   */
  play(
    target: AnimTarget,
    phase: Phase,
    spec: AnimSpec | PresetName | undefined,
    opts: { inverse?: boolean; loop?: boolean; onFinished?: () => void } = {},
  ): boolean {
    const s = typeof spec === "string" ? (presets[spec] as AnimSpec) : spec;
    const animates = !!s && !!(s.translate || s.alpha || s.scale || s.rotate || s.color);
    const existing = this.running.get(target);
    if (!animates) {
      if (existing && (existing.phase !== phase || opts.loop)) this.cancel(target);
      return false;
    }
    // The same one-shot phase is already playing: let it finish.
    if (existing && existing.phase === phase && !opts.loop) return true;
    this.running.set(target, {
      target,
      phase,
      spec: s,
      progress: 0,
      inverse: opts.inverse ?? false,
      loop: opts.loop ?? false,
      // Taking over from another animation keeps the true resting values.
      startAlpha: existing?.startAlpha ?? target.getAlpha(),
      startColor: existing?.startColor ?? target.getColor(),
      onFinished: opts.onFinished,
    });
    this.ensureLoop();
    return true;
  }

  /** Stop an animation, restoring the target to rest. */
  cancel(target: AnimTarget, runOnFinished = false): boolean {
    const anim = this.running.get(target);
    if (!anim) return false;
    this.running.delete(target);
    this.restore(anim);
    if (runOnFinished) anim.onFinished?.();
    return true;
  }

  isAnimating(target: AnimTarget): Phase | undefined {
    return this.running.get(target)?.phase;
  }

  /** Advance every animation by `dt` seconds. The frame loop calls this. */
  tick(dt: number): void {
    for (const anim of [...this.running.values()]) this.step(anim, dt);
    if (this.running.size === 0) this.stopLoop();
  }

  private step(anim: Running, dt: number): void {
    const { spec, target } = anim;
    let finished = false;
    if ((spec.durationType ?? "seconds") === "seconds") {
      anim.progress += dt / (spec.duration > 0 ? spec.duration : 1);
      if (anim.progress >= 1) {
        anim.progress = 1;
        finished = true;
      }
    } else {
      const rel = target.progress?.() ?? 0;
      const raw = spec.duration > 0 ? rel / spec.duration : 0;
      const iteration = Math.floor(raw);
      anim.progress = raw - iteration;
      if (anim.iteration === undefined) anim.iteration = iteration;
      else if (anim.iteration !== iteration) {
        anim.iteration = undefined;
        finished = true;
      }
    }

    const p0 = anim.inverse ? 1 - anim.progress : anim.progress;
    const p = easings[spec.ease ?? "none"](p0, spec.easeStrength ?? 3);
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        this.onError(e);
      }
    };

    if (spec.translate) {
      const { x, y, shape } = spec.translate;
      guard(() => target.setOffset(...resolveShape(shape, translateShapes, translateShapes.straight as PairShape)(p, 0, 0, x, y)));
    }
    if (spec.alpha) {
      const { to, shape } = spec.alpha;
      const f = resolveShape(shape, scalarShapes, scalarShapes.straight as ScalarShape);
      guard(() => target.setAlpha(Math.min(1, Math.max(0, f(p, anim.startAlpha, to - anim.startAlpha)))));
    }
    if (spec.scale) {
      const { x, y, shape } = spec.scale;
      guard(() => target.setScale(...resolveShape(shape, scaleShapes, scaleShapes.straight as PairShape)(p, 1, 1, x, y)));
    }
    if (spec.rotate) {
      const { degrees, shape } = spec.rotate;
      guard(() => target.setRotation(resolveShape(shape, scalarShapes, scalarShapes.straight as ScalarShape)(p, 0, degrees)));
    }
    if (spec.color) {
      const { to, shape } = spec.color;
      guard(() => target.setColor(resolveShape(shape, colorShapes, colorShapes.straight as ColorShape)(p, anim.startColor, to)));
    }

    if (!finished) return;
    if (anim.loop) {
      anim.progress = 0;
      return;
    }
    this.running.delete(target);
    this.restore(anim);
    anim.onFinished?.();
  }

  private restore(anim: Running): void {
    const t = anim.target;
    t.setOffset(0, 0);
    t.setAlpha(null);
    t.setScale(1, 1);
    t.setRotation(null);
    t.setColor(null);
  }

  private ensureLoop(): void {
    if (this.handle !== undefined) return;
    const frame = (time: number) => {
      const dt = this.last === undefined ? 0 : (time - this.last) / 1000;
      this.last = time;
      this.handle = undefined;
      this.tick(Math.min(dt, 0.25));
      if (this.running.size > 0) this.handle = this.scheduler.request(frame);
    };
    this.handle = this.scheduler.request(frame);
  }

  private stopLoop(): void {
    if (this.handle !== undefined) this.scheduler.cancel(this.handle);
    this.handle = undefined;
    this.last = undefined;
  }
}

/**
 * The display lifecycle from RegionPrototype.lua: start (reversed) then a
 * looping main animation on show; finish then the actual hide on hide.
 */
export function lifecycle(
  animator: Animator,
  target: AnimTarget,
  anims: { start?: AnimSpec | PresetName; main?: AnimSpec | PresetName; finish?: AnimSpec | PresetName },
  hooks: { show(): void; hide(): void },
) {
  let visible = false;
  const startMain = () => {
    animator.play(target, "main", anims.main, { loop: true });
  };
  return {
    show() {
      if (visible) return;
      visible = true;
      hooks.show();
      if (!animator.play(target, "start", anims.start, { inverse: true, onFinished: startMain })) startMain();
    },
    hide() {
      if (!visible) return;
      visible = false;
      const done = () => hooks.hide();
      if (!animator.play(target, "finish", anims.finish, { onFinished: done })) {
        animator.cancel(target);
        done();
      }
    },
    get visible() {
      return visible;
    },
  };
}

/**
 * Drive a DOM element. Offsets use WeakAuras' axis (positive y is up), and
 * colour goes to the `--aura-color` custom property for CSS to use.
 */
export function domTarget(el: HTMLElement, opts: { color?: RGBA; progress?: () => number } = {}): AnimTarget {
  let x = 0, y = 0, sx = 1, sy = 1, rot = 0;
  const base = opts.color ?? [1, 1, 1, 1];
  const apply = () => {
    el.style.transform = `translate(${x}px, ${-y}px) scale(${sx}, ${sy}) rotate(${-rot}deg)`;
  };
  const css = (c: RGBA) => `rgba(${c[0] * 255}, ${c[1] * 255}, ${c[2] * 255}, ${c[3]})`;
  return {
    setOffset(nx, ny) { x = nx; y = ny; apply(); },
    setScale(nx, ny) { sx = nx; sy = ny; apply(); },
    setRotation(d) { rot = d ?? 0; apply(); },
    setAlpha(a) { el.style.opacity = a === null ? "" : String(a); },
    setColor(c) { el.style.setProperty("--aura-color", css(c ?? base)); },
    getAlpha: () => (el.style.opacity === "" ? 1 : Number(el.style.opacity)),
    getColor: () => base,
    progress: opts.progress,
  };
}
