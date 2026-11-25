/** The worker map: WebGL columns with floating labels positioned from projected anchors. */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClusterTaskId, ClusterTaskView } from '../dashboard-types.ts'
import { createMapScene, type MapAnchor, type MapData, type MapScene } from './ground-scene.ts'
import { entryOf, present } from './invariant.ts'
import css from './ClusterViews.module.css'

/** One labeled worker column. */
export interface MapWorker { readonly task: ClusterTaskView; readonly rate: number; readonly index: number }
/** One labeled connection endpoint that is not a worker. */
export interface MapTerminalLabel { readonly id: string; readonly label: string }

/** Map inputs; selection and camera commands are owned by the page. */
export interface MapViewProps extends PropsLocale<'deepCluster'> {
  readonly workers: readonly MapWorker[]
  readonly terminals: readonly MapTerminalLabel[]
  readonly data: MapData
  readonly selectedId: ClusterTaskId | null
  readonly active: boolean
  readonly select: (id: ClusterTaskId) => void
  readonly control: MutableRefObject<MapScene | null>
  readonly failed: (failed: boolean) => void
}

/**
 * Mount the map scene and keep its labels on their columns without re-rendering React per frame.
 * @param props - workers, scene data, selection, and the camera-control seat.
 * @returns the stage with labels.
 */
export function MapView({ workers, terminals, data, selectedId, active, select, control, failed, t }: MapViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const labels = useRef(new Map<string, HTMLElement>())
  const selectRef = useRef(select)
  selectRef.current = select
  const [state, setState] = useState<'ready' | 'failed' | 'mounting'>('mounting')
  const [retry, setRetry] = useState(0)
  const [hovered, setHovered] = useState<ClusterTaskId | null>(null)
  const priority = useRef(new Map<string, number>())
  priority.current = new Map(workers.map(({ task }) => [task.id as string, task.id === selectedId ? 0 : task.id === hovered ? 1
    : task.status === 'running' ? 2 : task.status === 'waiting' || task.status === 'queued' ? 3 : 4]))
  for (const terminal of terminals) priority.current.set(terminal.id, 3)
  useEffect(() => {
    const element = present(host.current, 'MapView host element')
    setState('mounting')
    const project = (anchors: readonly MapAnchor[]): void => {
      const depths = anchors.map(anchor => anchor.depth)
      const near = Math.min(...depths), far = Math.max(...depths)
      const origin = element.getBoundingClientRect()
      const placed = [...element.closest('[data-label-stage]')?.querySelectorAll('[data-label-obstacle]') ?? []].map((obstacle) => {
        const box = obstacle.getBoundingClientRect()
        return { x0: box.left - origin.left, y0: box.top - origin.top, x1: box.right - origin.left, y1: box.bottom - origin.top }
      })
      const ranked = [...anchors].sort((a, b) => (priority.current.get(a.id) ?? 5) - (priority.current.get(b.id) ?? 5) || a.depth - b.depth)
      for (const anchor of ranked) {
        const label = labels.current.get(anchor.id)
        if (label === undefined) continue
        const body = label.lastElementChild as HTMLElement | null
        const lead = Number.parseFloat(label.style.getPropertyValue('--lead')) || 22
        const width = body?.offsetWidth ?? 0, height = body?.offsetHeight ?? 0
        const y0 = anchor.y - lead - height - 4, y1 = anchor.y + 4
        const right = { x0: anchor.x - 4, y0, x1: anchor.x + width + 4, y1 }, left = { x0: anchor.x - width - 4, y0, x1: anchor.x + 4, y1 }
        const free = (rect: typeof right): boolean => !placed.some(other =>
          rect.x0 < other.x1 && rect.x1 > other.x0 && rect.y0 < other.y1 && rect.y1 > other.y0)
        const pinned = entryOf(priority.current, anchor.id) <= 1
        const rect = pinned || free(right) ? right : free(left) ? left : null
        const open = anchor.visible && rect !== null && (pinned || placed.length < 36)
        if (open) placed.push(rect)
        label.dataset.side = rect === left ? 'left' : 'right'
        const fade = far - near < 1 ? 1 : 1 - (anchor.depth - near) / (far - near) * 0.3
        label.style.transform = `translate3d(${anchor.x.toFixed(1)}px, ${anchor.y.toFixed(1)}px, 0)`
        label.style.opacity = anchor.visible ? fade.toFixed(3) : '0'
        label.style.visibility = anchor.visible ? 'visible' : 'hidden'
        label.style.zIndex = String(pinned ? 10000 : Math.round(9000 - anchor.depth * 10))
        if (open) delete label.dataset.collapsed; else label.dataset.collapsed = ''
      }
    }
    try {
      const scene = createMapScene(element, {
        select: (id) => { selectRef.current(id) }, hover: setHovered, project,
        fail: () => { control.current = null; setState('failed'); failed(true) },
      })
      control.current = scene
      setState('ready'); failed(false)
      return () => { scene.dispose(); control.current = null }
    } catch (_error) {
      // WebGL is optional; the worker list below the failure notice keeps every worker selectable.
      setState('failed'); failed(true)
    }
  }, [retry, control, failed])
  useEffect(() => { control.current?.update(data) }, [data, control, state])
  useEffect(() => { control.current?.active(active) }, [active, control, state])
  const bind = (id: string) => (element: HTMLElement | null): void => {
    if (element === null) labels.current.delete(id); else labels.current.set(id, element)
  }
  return <div className={css.stageHost}>
    <div ref={host} className={css.sceneHost} />
    {state === 'failed' && <div className={css.failure} role="alert"><p>{t('webglFailed')}</p>
      <button type="button" className={css.boxButton} onClick={() => { setRetry(value => value + 1) }}><i aria-hidden="true" />{t('retryMap')}</button>
      <ul className={css.fallback}>{workers.map(({ task, index }) => <li key={task.id}>
        <button type="button" aria-pressed={selectedId === task.id} onClick={() => { select(task.id) }}><span>{String(index).padStart(3, '0')}</span>{task.title}</button>
      </li>)}</ul>
    </div>}
    {state === 'ready' && <div className={css.labels}>
      {workers.map(({ task, rate, index }) => <button key={task.id} ref={bind(task.id)} type="button" className={css.mapLabel}
        data-worker-id={task.id} data-status={task.status} data-selected={selectedId === task.id || undefined}
        data-hovered={hovered === task.id || undefined}
        aria-label={t('selectWorker', { title: task.title })} aria-pressed={selectedId === task.id}
        style={{ ['--lead' as string]: `${String(34 + (index % 3) * 22)}px`, visibility: 'hidden' }} onClick={() => { select(task.id) }}>
        <span className={css.leader} aria-hidden="true" />
        <span className={css.labelBody}>
          <span className={css.labelTitle}>{task.title}</span>
          <span className={css.labelMeta}><span>{String(index).padStart(3, '0')}</span><span>{task.stepId}</span></span>
          <span className={css.labelState}><i aria-hidden="true" />{task.status === 'running' ? t(`activity.${task.activity}`) : t(`status.${task.status}`)}
            <b>{task.tokenSamples.length === 0 ? '—' : t('shortRate', { rate: rate.toFixed(1) })}</b></span>
        </span>
      </button>)}
      {terminals.map(terminal => <span key={terminal.id} ref={bind(terminal.id)} className={css.terminalLabel} style={{ visibility: 'hidden' }}>
        <span className={css.leader} aria-hidden="true" /><span className={css.terminalBody}>{terminal.label}</span>
      </span>)}
    </div>}
  </div>
}
