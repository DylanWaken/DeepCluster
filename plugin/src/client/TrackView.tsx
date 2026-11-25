/** The worker tracks: WebGL timeline with DOM track headers, ruler ticks, playhead, and message chips. */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClusterTaskId } from '../dashboard-types.ts'
import type { MapWorker } from './MapView.tsx'
import type { ClipKind, TrackConnector } from './track-model.ts'
import { present } from './invariant.ts'
import { createTrackScene, type TrackAnchor, type TrackInset, type TrackScene, type TrackSceneData, type TrackWindow } from './track-scene.ts'
import css from './ClusterViews.module.css'

/** Track-view inputs. */
export interface TrackViewProps extends PropsLocale<'deepCluster'> {
  readonly workers: readonly MapWorker[]
  readonly data: TrackSceneData
  readonly selectedId: ClusterTaskId | null
  readonly active: boolean
  readonly select: (id: ClusterTaskId) => void
  readonly control: MutableRefObject<TrackScene | null>
  readonly windowChange: (window: TrackWindow) => void
  /** CSS pixels covered by page overlays on each side of the stage. */
  readonly inset: TrackInset
}

const CLIP_ORDER: readonly ClipKind[] = ['thinking', 'command', 'tool', 'read', 'write', 'starting', 'waiting', 'queued', 'idle']
const tickText = (at: number, step: number): string => step >= 21_600_000
  ? new Date(at).toLocaleString([], { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit' })
  : new Date(at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', ...(step < 60_000 ? { second: '2-digit' } : {}) })

/**
 * Mount the track scene; overlays follow projected anchors imperatively.
 * @param props - workers, scene data, selection, and the window-control seat.
 * @returns the track stage.
 */
export function TrackView({ workers, data, selectedId, active, select, control, windowChange, inset, t }: TrackViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const selectRef = useRef(select)
  selectRef.current = select
  const windowRef = useRef(windowChange)
  windowRef.current = windowChange
  const [state, setState] = useState<'ready' | 'failed' | 'mounting'>('mounting')
  const [retry, setRetry] = useState(0)
  const [ticks, setTicks] = useState<readonly number[]>([])
  const stepRef = useRef(60_000)
  useEffect(() => {
    const element = present(host.current, 'TrackView host element')
    let lastWindow = ''
    const project = (anchors: readonly TrackAnchor[], window: TrackWindow): void => {
      const tickIds = anchors.filter(anchor => anchor.id.startsWith('tick:')).map(anchor => Number(anchor.id.slice(5)))
      const key = `${tickIds.join(',')}|${String(window.follow)}|${String(Math.round(Math.log(window.span) * 60))}`
      stepRef.current = window.step
      if (key !== lastWindow) { lastWindow = key; setTicks(tickIds); windowRef.current(window) }
      const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
      const rank = (id: string): number => id.startsWith('row:') ? 0 : 1
      for (const anchor of [...anchors].sort((a, b) => rank(a.id) - rank(b.id))) {
        const node = nodes.current.get(anchor.id)
        if (node === undefined) continue
        node.style.transform = `translate3d(${anchor.x.toFixed(1)}px, ${anchor.y.toFixed(1)}px, 0)`
        let visible = anchor.visible
        if (visible && (anchor.id.startsWith('row:') || anchor.id.startsWith('link:'))) {
          const box = node.getBoundingClientRect()
          const rect = { x0: box.left - 4, y0: box.top - 2, x1: box.right + 4, y1: box.bottom + 2 }
          visible = anchor.id.startsWith('row:') || !placed.some(other => rect.x0 < other.x1 && rect.x1 > other.x0 && rect.y0 < other.y1 && rect.y1 > other.y0)
          if (visible) placed.push(rect)
        }
        node.style.visibility = visible ? 'visible' : 'hidden'
      }
    }
    try {
      const scene = createTrackScene(element, {
        select: (id) => { selectRef.current(id) }, hover: () => {}, project,
        fail: () => { control.current = null; setState('failed') },
      })
      control.current = scene
      setState('ready')
      return () => { scene.dispose(); control.current = null }
    } catch (_error) {
      // WebGL is optional; the worker card and the records below remain available.
      setState('failed')
    }
  }, [retry, control])
  useEffect(() => { control.current?.inset(inset) }, [inset, control, state])
  useEffect(() => { control.current?.update(data) }, [data, control, state])
  useEffect(() => { control.current?.active(active) }, [active, control, state])
  useEffect(() => { if (selectedId !== null) control.current?.reveal(selectedId) }, [selectedId, control, state])
  useEffect(() => { if (active) control.current?.active(true) }, [ticks, active, control])
  const bind = (id: string) => (element: HTMLElement | null): void => {
    if (element === null) nodes.current.delete(id); else nodes.current.set(id, element)
  }
  const messages = data.connectors.filter((link): link is TrackConnector & { kind: 'message' } => link.kind === 'message')
  return <div className={css.stageHost}>
    <div ref={host} className={css.sceneHost} />
    {state === 'failed' && <div className={css.failure} role="alert"><p>{t('webglFailed')}</p>
      <button type="button" className={css.boxButton} onClick={() => { setRetry(value => value + 1) }}><i aria-hidden="true" />{t('retryMap')}</button></div>}
    {state === 'ready' && <div ref={overlay} className={css.labels}>
      {ticks.map(at => <span key={`tick:${String(at)}`} ref={bind(`tick:${String(at)}`)} className={css.tick} style={{ visibility: 'hidden' }}>{tickText(at, stepRef.current)}</span>)}
      <span ref={bind('now')} className={css.nowChip} style={{ visibility: 'hidden' }}>{t('now')}</span>
      {workers.map(({ task, rate, index }) => <button key={task.id} ref={bind(`row:${task.id}`)} type="button" className={css.trackHead}
        data-selected={selectedId === task.id || undefined} data-status={task.status} aria-pressed={selectedId === task.id}
        aria-label={t('selectWorker', { title: task.title })} style={{ visibility: 'hidden' }} onClick={() => { select(task.id) }}>
        <span className={css.trackNo}>{String(index).padStart(3, '0')}</span>
        <span className={css.trackTitle}>{task.title}</span>
        <span className={css.trackRate}>{task.tokenSamples.length === 0 ? '—' : t('shortRate', { rate: rate.toFixed(1) })}</span>
      </button>)}
      {messages.map(link => <span key={link.id} ref={bind(`link:${link.id}`)} className={css.linkChip} data-phase={link.phase} title={link.text} style={{ visibility: 'hidden' }}>
        <i aria-hidden="true" />{t(link.messageKind === 'handoff' ? 'handoffSupplied' : link.phase === 'sent' ? 'messageSent' : link.phase === 'delivered' ? 'messageDelivered' : 'messageRecorded')}
      </span>)}
    </div>}
    <ul className={css.clipLegend} aria-label={t('clipLegend')}>
      {CLIP_ORDER.map(kind => <li key={kind} data-kind={kind}><i aria-hidden="true" />{t(`clip.${kind}`)}</li>)}
    </ul>
  </div>
}
