/** Control-room chrome: registration marks, chips, sliding-plate selectors, scrambled titles, and rolling numerals. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { elementAt } from './invariant.ts'
import { reducedMotion } from './motion.ts'
import css from './chrome.module.css'

const SCRAMBLE_GLYPHS = '#%&/\\|=+<>01_-'

/**
 * Resolve text left to right from terminal glyphs whenever it changes.
 * @param text - final text.
 * @param duration - resolve time in milliseconds.
 * @returns the text to display this frame.
 */
export function useScramble(text: string, duration = 440): string {
  const [shown, setShown] = useState(text)
  useEffect(() => {
    if (reducedMotion()) { setShown(text); return }
    const start = performance.now(), chars = Array.from(text)
    let frame = 0
    const tick = (now: number): void => {
      const k = Math.min(1, (now - start) / duration)
      if (k >= 1) { setShown(text); return }
      const resolved = Math.floor((1 - 2 ** (-10 * k)) * chars.length)
      let seed = chars.length * 31 + 7 + Math.floor(now / 50)
      setShown(chars.map((ch, index) => {
        if (index < resolved || ch === ' ') return ch
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return SCRAMBLE_GLYPHS.charAt(seed % SCRAMBLE_GLYPHS.length)
      }).join(''))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [text, duration])
  return shown
}

/**
 * Digits that roll up from their previous value; other glyphs change in place.
 * @param props - the value and an optional class.
 * @returns a fixed-width numeral.
 */
export function Roll({ value, className }: { readonly value: string; readonly className?: string | undefined }) {
  const previous = useRef(value)
  const [state, setState] = useState({ from: value, to: value, key: 0 })
  useEffect(() => {
    if (previous.current === value) return
    setState(current => ({ from: previous.current, to: value, key: current.key + 1 }))
    previous.current = value
  }, [value])
  const to = Array.from(state.to), from = Array.from(state.from.padStart(to.length).slice(-to.length))
  return <span className={`${css.roll} ${className ?? ''}`} aria-label={value}>
    {to.map((ch, index) => from[index] === ch || !/\d/u.test(ch) || state.key === 0
      ? <span key={`${String(index)}:${ch}`} className={css.rollCell} aria-hidden="true">{ch}</span>
      : <span key={`${String(index)}:${String(state.key)}`} className={css.rollCell} aria-hidden="true">
        <span className={css.rollTrack}><span>{from[index]}</span><span>{ch}</span></span>
      </span>)}
  </span>
}

/** Registration cross at a page corner. */
export function RegCross({ corner }: { readonly corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <span className={css.regCross} data-corner={corner} aria-hidden="true" />
}

/**
 * Letter-spaced chip: outlined, inverse, or accent with a square.
 * @param props - chip kind and content.
 * @returns the chip.
 */
export function Chip({ kind = 'plain', children, title }: { readonly kind?: 'plain' | 'inverse' | 'accent'; readonly children: ReactNode; readonly title?: string }) {
  return <span className={css.chip} data-kind={kind} title={title}>{kind === 'accent' && <i aria-hidden="true" />}{children}</span>
}

/** One option of a {@link PlateSelect}. */
export interface PlateOption<T extends string> { readonly id: T; readonly label: string; readonly index?: string; readonly mark?: boolean }

/**
 * Segmented selector whose inverse plate slides between options, inverting the text it covers.
 * @param props - options, current value, change handler, accessible name, and visual variant.
 * @returns a radio-group style selector.
 */
export function PlateSelect<T extends string>({ options, value, onChange, label, variant = 'nav' }: {
  readonly options: readonly PlateOption<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
  readonly label: string
  readonly variant?: 'nav' | 'toggle'
}) {
  const host = useRef<HTMLDivElement>(null)
  const [plate, setPlate] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const element = host.current?.querySelector<HTMLElement>(`[data-option="${value}"]`)
    if (element === null || element === undefined) return
    const update = (): void => { setPlate({ x: element.offsetLeft, w: element.offsetWidth }) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [value, options.length])
  const renderOptions = (inverse: boolean) => options.map(option => <button key={option.id} type="button" role={inverse ? undefined : 'radio'}
    aria-checked={inverse ? undefined : option.id === value} aria-hidden={inverse || undefined}
    tabIndex={inverse ? -1 : option.id === value ? 0 : -1}
    data-option={inverse ? undefined : option.id} className={css.plateOption}
    onClick={() => { onChange(option.id) }}
    onKeyDown={(event) => {
      const at = options.findIndex(candidate => candidate.id === value)
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (step === 0) return
      event.preventDefault()
      const next = elementAt(options, (at + step + options.length) % options.length)
      onChange(next.id)
      host.current?.querySelector<HTMLElement>(`[data-option="${next.id}"]`)?.focus()
    }}>
    {option.mark === true && <i className={css.toggleMark} aria-hidden="true" />}
    {option.index !== undefined && <span className={css.plateIndex}>{option.index}</span>}
    <span>{option.label}</span>
  </button>)
  return <div ref={host} className={css.plates} data-variant={variant} role="radiogroup" aria-label={label}>
    <div className={css.plateRow}>{renderOptions(false)}</div>
    {plate !== null && <div className={css.plate} style={{ transform: `translateX(${String(plate.x)}px)`, width: plate.w }} aria-hidden="true">
      <div className={css.plateClip}>
        <div className={css.plateInverse} style={{ transform: `translateX(${String(-plate.x)}px)` }}>{renderOptions(true)}</div>
      </div>
      {variant === 'nav' && <i className={css.plateTick} />}
    </div>}
  </div>
}

/**
 * Bracketed heading: four corner squares around a tracked label and a rolling number.
 * @param props - label and number.
 * @returns the heading block.
 */
export function Bracket({ label, value }: { readonly label: string; readonly value: string }) {
  return <span className={css.bracket}><i /><i /><i /><i /><span>{label}</span><Roll value={value} className={css.bracketNo} /></span>
}

/** Stroked ghost numeral behind a panel's content. */
export function Ghost({ text }: { readonly text: string }) { return <span className={css.ghost} aria-hidden="true">{text}</span> }

/** Halftone dots fading upward across the bottom of a panel. */
export function Halftone({ height = 220 }: { readonly height?: number }) {
  return <span className={css.halftone} style={{ height }} aria-hidden="true" />
}

/** Film grain over a panel. */
export function Grain() { return <span className={css.grain} aria-hidden="true" /> }
