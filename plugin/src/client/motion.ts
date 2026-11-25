/** Shared animation curves, springs, and a frame clock that stops when every animation settles. */

/** CSS form of {@link easeOut}; transitions and keyframes use the same curve as scripted motion. */
export const EASE_OUT_CSS = 'cubic-bezier(.16, 1, .3, 1)'

/**
 * Exponential ease-out matching {@link EASE_OUT_CSS}.
 * @param t - progress from 0 to 1.
 * @returns eased progress.
 */
export function easeOut(t: number): number { return t >= 1 ? 1 : 1 - 2 ** (-10 * t) }

/**
 * Cubic ease-in-out for symmetric camera moves.
 * @param t - progress from 0 to 1.
 * @returns eased progress.
 */
export function easeInOut(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2 }

/**
 * Whether the user asked the platform to minimize motion; every animation then jumps to its end state.
 * @returns true when `prefers-reduced-motion: reduce` matches.
 */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** A critically damped spring toward `to`. */
export interface Spring { x: number; v: number; to: number; readonly w: number; readonly eps: number }

/**
 * Create a spring at rest.
 * @param x - initial and target value.
 * @param w - angular frequency; larger settles faster.
 * @param eps - distance and speed scale at which the spring snaps to its target.
 * @returns the spring state.
 */
export function spring(x: number, w = 9, eps = 0.002): Spring { return { x, v: 0, to: x, w, eps } }

/**
 * Advance one spring.
 * @param s - spring to advance in place.
 * @param dt - elapsed seconds, already clamped by the clock.
 * @param reduce - jump to the target when motion is reduced.
 * @returns true while the spring still moves.
 */
export function stepSpring(s: Spring, dt: number, reduce: boolean): boolean {
  if (reduce) { s.x = s.to; s.v = 0; return false }
  const acceleration = s.w * s.w * (s.to - s.x) - 2 * s.w * s.v
  s.v += acceleration * dt
  s.x += s.v * dt
  if (Math.abs(s.to - s.x) < s.eps && Math.abs(s.v) < s.eps * 5) { s.x = s.to; s.v = 0; return false }
  return true
}

/** A fixed-duration tween; `progress` is eased on read. */
export interface Tween { readonly start: number; readonly duration: number }

/**
 * Eased progress of a tween.
 * @param tween - start time and duration in milliseconds.
 * @param now - current `performance.now()`.
 * @param reduce - report completion immediately when motion is reduced.
 * @param curve - easing function.
 * @returns eased progress from 0 to 1.
 */
export function tweenProgress(tween: Tween, now: number, reduce: boolean, curve: (t: number) => number = easeOut): number {
  if (reduce || tween.duration <= 0) return 1
  return curve(Math.min(1, Math.max(0, (now - tween.start) / tween.duration)))
}

/** A frame loop that runs only while its update reports motion. */
export interface FrameClock {
  /** Schedule frames until the update reports that everything settled. */
  wake(this: void): void
  /** Cancel the pending frame; a later {@link FrameClock.wake} restarts the loop. */
  stop(this: void): void
}

/**
 * Drive `update` from animation frames with measured, clamped time steps.
 * @param update - receives elapsed seconds and the frame time; returns true while anything still moves.
 * @returns the clock; it is idle until woken.
 */
export function frameClock(update: (dt: number, now: number) => boolean): FrameClock {
  let frame: number | null = null
  let last = 0
  const tick = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    frame = update(dt, now) ? requestAnimationFrame(tick) : null
  }
  return {
    wake() { if (frame === null) { last = performance.now(); frame = requestAnimationFrame(tick) } },
    stop() { if (frame !== null) cancelAnimationFrame(frame); frame = null },
  }
}
