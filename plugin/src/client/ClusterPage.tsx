/** DeepCluster control room: map and track views of recorded worker activity, backed by the framework resource lifetime. */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClusterTaskId, ClusterTaskView } from '../dashboard-types.ts'
import { rollingTokenRate, TOKEN_WINDOW_MS } from '../token-window.ts'
import { Bracket, Chip, Grain, PlateSelect, RegCross, Roll, useScramble } from './chrome.tsx'
import type { ColumnState, MapData, MapLink, MapScene } from './ground-scene.ts'
import { elementAt, present } from './invariant.ts'
import { en, type ClusterKey } from './locales.ts'
import { MapView, type MapTerminalLabel, type MapWorker } from './MapView.tsx'
import { CELL, cellSlot } from './routing.ts'
import { RateRecorder, TimelineRecorder, trackConnectors, trackRows } from './track-model.ts'
import { TRACK_SPAN_MAX, zoomPosition, zoomSpan, type TrackInset, type TrackScene, type TrackSceneData, type TrackWindow } from './track-scene.ts'
import { TrackView } from './TrackView.tsx'
import { WorkerCard } from './WorkerCard.tsx'
import css from './ClusterPage.module.css'

/** Page props supplied by the main-panel slot and typed locale namespace. */
export type ClusterPageProps = PropsRuntime<'main'> & PropsLocale<'deepCluster'>

/**
 * Render the sidebar's existing branch glyph; its owning row provides the accessible name.
 * @param props - icon size selected by the sidebar.
 * @returns a decorative branch icon.
 */
export function ClusterIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconBranchOutlineRegular size={size} /> }

type View = 'map' | 'tracks'
const COLUMN_BASE = 1.6
const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
const unfinished = (task: ClusterTaskView): boolean => task.status === 'running' || task.status === 'waiting' || task.status === 'queued'
const columnState = (task: ClusterTaskView): ColumnState => task.status === 'running' ? (task.activity === 'idle' ? 'idle' : 'running')
  : task.status === 'waiting' || task.status === 'queued' ? 'waiting' : task.status === 'passed' ? 'done' : 'failed'
const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

/** Header clock: time over the date, updated on the second. */
function HeaderClock() {
  const [at, setAt] = useState(() => new Date())
  useEffect(() => {
    let timer = 0
    const tick = (): void => { setAt(new Date()); timer = window.setTimeout(tick, 1005 - (Date.now() % 1000)) }
    timer = window.setTimeout(tick, 1005 - (Date.now() % 1000))
    return () => { clearTimeout(timer) }
  }, [])
  return <div className={css.clock}>
    <time dateTime={at.toISOString()}>{at.toLocaleTimeString([], { hour12: false })}</time>
    <span>{at.toLocaleDateString([], { weekday: 'short' })} · {pad(at.getDate())} {at.toLocaleDateString([], { month: 'short' })} {at.getFullYear()}</span>
  </div>
}

/**
 * Show recorded worker activity as a 3D map or as timeline tracks, with the selected worker's card and the records.
 * @param props - resource reader and locale function bound by the shell.
 * @returns the control room.
 */
export function ClusterPage({ useResource, t }: ClusterPageProps) {
  const [retry, setRetry] = useState(0)
  const [run, setRun] = useState<string | null>('active')
  const [view, setView] = useState<View>('map')
  const [selectedId, setSelectedId] = useState<ClusterTaskId | null>(null)
  const [mode, setMode] = useState<'pan' | 'orbit'>('pan')
  const [mapFailed, setMapFailed] = useState(false)
  const [trackWindow, setTrackWindow] = useState<TrackWindow | null>(null)
  const mapControl = useRef<MapScene | null>(null)
  const trackControl = useRef<TrackScene | null>(null)
  const recorder = useRef(new RateRecorder())
  const timelineRecorder = useRef(new TimelineRecorder())
  const topLeft = useRef<HTMLDivElement>(null)
  const [trackInset, setTrackInset] = useState<TrackInset>({ top: 120, right: 24, bottom: 24, left: 20 })
  const state = useResource<'deepcluster'>(`dsh-resource://deepcluster/journal?retry=${String(retry)}`)
  const data = state.value
  const ownedRunIds = data?.activeRunIds ?? null
  const activeRuns = new Set<string>(ownedRunIds ?? data?.tasks.filter(task => !task.runId.startsWith('legacy') && unfinished(task)).map(task => task.runId))
  const included = (id: string): boolean => run === null || run === id || (run === 'active'
    && (activeRuns.has(id) || (ownedRunIds === null && activeRuns.size === 0 && id === data?.runs[0]?.id)))
  const tasks = useMemo(() => data?.tasks.filter(task => included(task.runId)) ?? [], [data, run, ownedRunIds?.join(',')])
  const timeline = useMemo(() => data?.timeline.filter(event => included(event.runId)) ?? [], [data, run, ownedRunIds?.join(',')])
  const messages = useMemo(() => data?.messages.filter(message => included(message.runId)) ?? [], [data, run, ownedRunIds?.join(',')])
  const outcomes = data?.outcomes.filter(outcome => included(outcome.runId)) ?? []
  const allLeases = data?.leases ?? []
  const leases = allLeases.filter(lease => run !== 'active' || ownedRunIds === null || activeRuns.has(lease.runId))
  const otherQuarantines = run === 'active' && ownedRunIds !== null
    ? allLeases.filter(lease => lease.status === 'quarantined' && !activeRuns.has(lease.runId)) : []
  const [now, setNow] = useState(() => Date.now())
  const lastSampleAt = tasks.reduce((last, task) => task.tokenSamples.reduce((at, sample) => Math.max(at, sample.observedAt), last), 0)
  const live = tasks.some(unfinished)
  useEffect(() => {
    const current = Date.now()
    setNow(current)
    if (!live && (lastSampleAt === 0 || current >= lastSampleAt + TOKEN_WINDOW_MS)) return
    const timer = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (!live && at >= lastSampleAt + TOKEN_WINDOW_MS) clearInterval(timer)
    }, 250)
    return () => { clearInterval(timer) }
  }, [lastSampleAt, live])
  useEffect(() => { recorder.current.record(tasks) }, [tasks])
  const history = useMemo(() => timelineRecorder.current.record(timeline), [timeline])
  const label = (prefix: 'role' | 'event', value: string): string => {
    const key = `${prefix}.${value}`
    return key in en ? t(key as ClusterKey) : value
  }

  const workers: MapWorker[] = tasks.map((task, index) => ({ task, index: index + 1, rate: rollingTokenRate(task.tokenSamples, now) }))
  const order = (task: ClusterTaskView): number => task.status === 'running' ? 0 : task.status === 'waiting' ? 1 : task.status === 'queued' ? 2 : 3
  const selected = workers.find(worker => worker.task.id === selectedId)
    ?? [...workers].reverse().sort((a, b) => order(a.task) - order(b.task))[0]
  const totalRate = workers.reduce((sum, worker) => sum + worker.rate, 0)
  const ceiling = Math.max(100, Math.ceil(Math.max(0, ...workers.map(worker => worker.rate)) / 100) * 100)
  const trackCeiling = Math.max(100, Math.ceil(recorder.current.peak(tasks.map(task => task.id)) / 100) * 100)
  const heightKey = workers.map(worker => `${worker.task.id}:${worker.rate.toFixed(1)}:${worker.task.status}:${worker.task.activity}`).join('|')

  const { mapData, terminalLabels } = useMemo(() => {
    const terminals = new Map<string, MapTerminalLabel & { cell: { i: number; j: number } }>()
    const terminal = (name: string): string => {
      const id = `terminal:${name}`
      if (!terminals.has(id)) terminals.set(id, { id, label: name, cell: { i: -1, j: terminals.size } })
      return id
    }
    const links: MapLink[] = []
    for (const { task } of workers) {
      for (const dependency of task.dependencies) {
        const predecessor = tasks.find(candidate => candidate.runId === task.runId && candidate.stepId === dependency)
        if (task.status === 'queued' && predecessor !== undefined && predecessor.status !== 'passed') {
          links.push({ id: `dependency:${task.id}:${dependency}`, from: predecessor.id, to: task.id, kind: 'dependency', flowing: false })
        }
      }
      if (task.status === 'waiting' && task.waitingResource !== null) {
        const held = leases.find(lease => lease.resource === task.waitingResource)
        const holder = held === undefined ? undefined
          : tasks.find(candidate => candidate.runId === held.runId && candidate.stepId === held.stepId)
        links.push({ id: `lease:${task.id}:${task.waitingResource}`, from: task.id, to: holder?.id ?? terminal(task.waitingResource), kind: 'lease', flowing: false })
      }
    }
    const delivered = new Set<string>()
    for (const message of messages) {
      const recipient = tasks.find(task => task.runId === message.runId && task.stepId === message.toStepId)
      const sender = tasks.find(task => task.runId === message.runId && task.stepId === message.fromStepId)
      if (recipient === undefined || (sender === undefined && message.fromStepId !== 'controller')) continue
      const id = `message:${message.runId}:${message.fromStepId}:${message.toStepId}`
      if (delivered.has(id)) continue
      delivered.add(id)
      links.push({ id, from: sender?.id ?? terminal(t('controller')), to: recipient.id, kind: 'message', flowing: message.phase === 'sent' || unfinished(recipient) })
    }
    const rise = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(Math.max(1, workers.length))) * CELL * 0.4))
    const value: MapData = {
      columns: workers.map(({ task, rate }, index) => ({ id: task.id, cell: cellSlot(index), height: COLUMN_BASE + rate / ceiling * rise,
        state: columnState(task), selected: selected?.task.id === task.id })),
      terminals: [...terminals.values()].map(({ id, cell }) => ({ id, cell })), links, maxHeight: COLUMN_BASE + rise,
    }
    return { mapData: value, terminalLabels: [...terminals.values()].map(({ id, label: name }) => ({ id, label: name })) }
  }, [heightKey, messages, leases.map(lease => lease.resource).join(','), selected?.task.id, ceiling, t])

  const trackData = useMemo((): TrackSceneData => {
    const rows = trackRows(tasks, history, now)
    return {
      rows: rows.map((row, index) => {
        const worker = elementAt(workers, index)
        return { id: row.id, clips: row.clips, marks: row.marks, rate: recorder.current.series(row.id), state: columnState(worker.task),
          selected: selected?.task.id === row.id, height: 0.5 + worker.rate / ceiling * 5 }
      }),
      connectors: trackConnectors(tasks, rows, messages, now), ceiling: trackCeiling, live, selection: run ?? '',
      start: Math.min(...rows.map(row => row.start), now), end: Math.max(...rows.map(row => row.end), 0),
    }
  }, [tasks, history, messages, Math.floor(now / 1000), selected?.task.id, ceiling, trackCeiling, heightKey, live, run])

  const hasRuns = data !== undefined && data.runs.length > 0
  useEffect(() => {
    const element = topLeft.current
    if (element === null) return
    const observer = new ResizeObserver(() => {
      const top = Math.round(element.offsetTop + element.offsetHeight + 28)
      setTrackInset(current => current.top === top ? current : { ...current, top })
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [hasRuns])

  const select = useCallback((id: ClusterTaskId) => { setSelectedId(id) }, [])
  const focus = useCallback(() => {
    if (selected === undefined) return
    if (view === 'map') mapControl.current?.focus(selected.task.id); else trackControl.current?.reveal(selected.task.id)
  }, [selected?.task.id, view])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, select, textarea, [contenteditable="true"]') != null) return
      if (event.key === '1') setView('map')
      else if (event.key === '2') setView('tracks')
      else if (event.key === 'f' || event.key === 'F') focus()
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key) }
  }, [focus])

  const section = useScramble(`${view === 'map' ? '01' : '02'} · ${t(view === 'map' ? 'section.map' : 'section.tracks')}`)
  const logs = selected === undefined ? [] : timeline.filter(event => event.runId === selected.task.runId && event.stepId === selected.task.stepId && event.type !== 'agent/message')
  const inbox = selected === undefined ? [] : messages.filter(message => message.runId === selected.task.runId
    && (message.toStepId === selected.task.stepId || message.fromStepId === selected.task.stepId))
  const runTitle = run === null ? t('allRuns') : run === 'active' ? t(ownedRunIds === null ? 'activeRuns' : 'activeApiRuns') : data?.runs.find(item => item.id === run)?.title ?? run
  const extent = { start: trackData.start, end: Math.max(trackData.end, live ? now : trackData.end) }
  const span = Math.max(1, extent.end - extent.start)
  const trackSpan = trackWindow?.span ?? TRACK_SPAN_MAX
  const position = Math.round(zoomPosition(trackSpan) * 1000)
  const fillStyle: CSSProperties & Record<'--fill', string> = { '--fill': `${String(position / 10)}%` }
  const along = (at: number): number => Math.min(100, Math.max(0, (at - extent.start) / span * 100))
  const counts = [
    ['mRunning', tasks.filter(task => task.status === 'running').length],
    ['mQueued', tasks.filter(task => task.status === 'queued' || task.status === 'waiting').length],
    ['mPassed', tasks.filter(task => task.status === 'passed').length],
    ['mLeases', leases.length],
  ] as const

  return <section className={css.page} aria-label={t('panel')}>
    <div className={css.frame}>
      <header className={css.header}>
        <RegCross corner="tl" /><RegCross corner="tr" />
        <div className={css.emblem} aria-hidden="true"><svg viewBox="0 0 92 44"><path d="M22 34V18h6v16zM33 34V10h6v24zM44 34V22h6v12zM55 34V14h6v20zM66 34V26h6v8z" /><path d="M18 36.5h58" strokeWidth="1" /></svg></div>
        <div className={css.identity}>
          <strong>{t('brand')}</strong>
          <span className={css.spread}><span>{t('spread1')}</span><span>·</span><span>{t('spread2')}</span><span>·</span><span>{t('spread3')}</span></span>
          <span className={css.term}><span>{t('term1')}</span><b>{t('term2')}</b></span>
        </div>
        <nav className={css.nav}><PlateSelect label={t('views')} value={view} onChange={setView}
          options={[{ id: 'map', index: '01', label: t('viewMap') }, { id: 'tracks', index: '02', label: t('viewTracks') }]} /></nav>
        {data !== undefined && data.runs.length > 0 && <label className={css.field}><span>{t('runs')}</span>
          <select value={run ?? ''} onChange={(event) => { setRun(event.target.value || null); setSelectedId(null) }}>
            <option value="active">{t(ownedRunIds === null ? 'activeRuns' : 'activeApiRuns')}</option>
            <option value="">{t('allRuns')}</option>
            {data.runs.map((item) => {
              const label = `${item.title} · ${new Date(item.startedAt).toLocaleString()}`
              return <option key={item.id} value={item.id}>{label}</option>
            })}
          </select></label>}
        <HeaderClock />
      </header>

      <div className={css.body}>
        <div className={css.stage} data-label-stage="">
          {(state.status === 'loading' || state.status === 'none') && <p role="status" className={css.notice}>{t(state.status === 'loading' ? 'loading' : 'unavailable')}</p>}
          {state.status === 'failed' && <div role="alert" className={css.notice}><p>{t('failed')}</p>
            <button type="button" className={css.boxButton} onClick={() => { setRetry(value => value + 1) }}><i aria-hidden="true" />{t('retry')}</button></div>}
          {data !== undefined && data.runs.length === 0 && <div className={css.notice}><p className={css.noticeTitle}>{t('emptyTitle')}</p><p>{t('empty')}</p></div>}
          {data !== undefined && data.runs.length > 0 && <>
            <div className={css.view} data-active={view === 'map' || undefined} aria-hidden={view !== 'map'}>
              <MapView workers={workers} terminals={terminalLabels} data={mapData} selectedId={selected?.task.id ?? null} active={view === 'map'}
                select={select} control={mapControl} failed={setMapFailed} t={t} />
            </div>
            <div className={css.view} data-active={view === 'tracks' || undefined} aria-hidden={view !== 'tracks'}>
              <TrackView workers={workers} data={trackData} selectedId={selected?.task.id ?? null} active={view === 'tracks'}
                select={select} control={trackControl} windowChange={setTrackWindow} inset={trackInset} t={t} />
            </div>
            <div className={css.fadeRight} aria-hidden="true" /><div className={css.fadeBottom} aria-hidden="true" />
            <div ref={topLeft} className={css.topLeft} data-view={view} data-label-obstacle="">
              <span className={css.filter}><span>{t('filter')} · “{runTitle}” · {t('workerCount', { count: pad(tasks.length) })}</span></span>
              {view === 'map' && <ul className={css.legend} aria-label={t('graphLegend')}>
                <li data-kind="message">{t('messageEdges')}</li><li data-kind="dependency">{t('dependencyEdges')}</li><li data-kind="lease">{t('leaseEdges')}</li>
              </ul>}
              {run === 'active' && ownedRunIds !== null && activeRuns.size === 0 && <p className={css.inlineNote}>{t('noActiveRuns')}</p>}
              <div className={css.caption} key={view}>
                <p className={css.captionIndex}><i aria-hidden="true" />{view === 'map' ? '01' : '02'} · {t(view === 'map' ? 'section.map' : 'section.tracks')}</p>
                {view === 'map' ? <>
                  <p className={css.captionText}>{t('mapDescription')}</p>
                  <p className={css.hint}>{t('graphHint')}</p>
                </> : <p className={css.captionText}>{t('tracksDescription')} {t('tracksHint')}</p>}
              </div>
            </div>
            {view === 'map' && <div className={css.selectNumeral} data-label-obstacle="">
              <span className={css.selectEyebrow}>{t('selectEyebrow')}</span>
              <span className={css.numeral}><Roll value={pad(selected?.index ?? 0)} /><small>/ {pad(workers.length)}</small></span>
              <div className={css.ruler}>
                <button type="button" aria-label={t('chooseWorker')} disabled={workers.length === 0}
                  onClick={() => {
                    const current = present(selected, 'ClusterPage selection-ruler worker')
                    const next = elementAt(workers, (current.index - 2 + workers.length) % workers.length)
                    select(next.task.id)
                  }}>↑</button>
                <span className={css.ticks}>{workers.map(worker => <button key={worker.task.id} type="button" title={worker.task.title}
                  aria-label={t('selectWorker', { title: worker.task.title })} aria-pressed={worker === selected} data-status={worker.task.status}
                  onClick={() => { select(worker.task.id) }}><i /></button>)}</span>
                <button type="button" aria-label={t('chooseWorker')} disabled={workers.length === 0}
                  onClick={() => {
                    const current = present(selected, 'ClusterPage selection-ruler worker')
                    const next = elementAt(workers, current.index % workers.length)
                    select(next.task.id)
                  }}>↓</button>
              </div>
            </div>}
          </>}
        </div>
        <div className={css.cardColumn}>
          <WorkerCard task={selected?.task} index={selected?.index ?? 0} rate={selected?.rate ?? 0} logs={logs} messages={inbox} view={view}
            focus={focus} openOther={() => { setView(current => current === 'map' ? 'tracks' : 'map') }} t={t} />
        </div>
      </div>

      <div className={css.transport}>
        <dl className={css.counts}>{counts.map(([key, count]) =>
          <div key={key}><dt>{t(key)}</dt><dd><Roll value={pad(count)} /></dd></div>)}</dl>
        <div className={css.seek}>
          <span className={css.readout} data-live={live || undefined}>{elapsed(extent.end - extent.start)}</span>
          <div className={css.seekLine}>
            <span className={css.startMark} data-on={live || undefined}>{t('event.run/start')}</span>
            <span className={css.seekFill} style={view === 'tracks' && trackWindow !== null
              ? { left: `${String(along(trackWindow.start))}%`, width: `${String(Math.max(0.5, along(trackWindow.end) - along(trackWindow.start)))}%` }
              : { left: 0, width: `${String(along(live ? now : extent.end))}%` }} />
            {live && <span className={css.playhead} style={{ left: `${String(along(now))}%` }} />}
            <span className={css.nowPlaying}><b data-live={live || undefined}>{t(live ? 'live' : 'standby')}</b>
              {selected !== undefined && <span>{selected.task.title} · {selected.task.status === 'running' ? t(`activity.${selected.task.activity}`) : t(`status.${selected.task.status}`)}</span>}</span>
          </div>
          <span className={css.readout}><Roll value={totalRate.toFixed(1).padStart(5, '0')} /><small>{t('rateUnit')}</small></span>
        </div>
        <div className={css.controls}>
          {view === 'map' ? <>
            <PlateSelect variant="toggle" label={t('graphLabel')} value={mode} onChange={(value) => { setMode(value); mapControl.current?.mode(value) }}
              options={[{ id: 'pan', label: t('panMap'), mark: true }, { id: 'orbit', label: t('orbitMap'), mark: true }]} />
            <button type="button" className={css.boxButton} disabled={mapFailed} aria-label={t('zoomIn')} onClick={() => { mapControl.current?.zoom(1.25) }}>+</button>
            <button type="button" className={css.boxButton} disabled={mapFailed} aria-label={t('zoomOut')} onClick={() => { mapControl.current?.zoom(0.8) }}>−</button>
            <button type="button" className={css.boxButton} disabled={mapFailed} onClick={() => { mapControl.current?.reset() }}><i aria-hidden="true" />{t('resetMap')}</button>
          </> : <>
            <button type="button" className={css.boxButton} data-on={trackWindow?.follow === true || undefined} aria-pressed={trackWindow?.follow === true}
              onClick={() => { trackControl.current?.follow() }}><i aria-hidden="true" />{t('followLive')}</button>
            <label className={css.zoomSlider}><span>{t('timeZoom')}</span><input type="range" min={0} max={1000} step={1} value={position} aria-valuetext={elapsed(trackSpan)} style={fillStyle} onChange={(event) => { trackControl.current?.span(zoomSpan(Number(event.currentTarget.value) / 1000)) }} /></label>
            <button type="button" className={css.boxButton} aria-label={t('zoomIn')} onClick={() => { trackControl.current?.zoom(1.5) }}>+</button>
            <button type="button" className={css.boxButton} aria-label={t('zoomOut')} onClick={() => { trackControl.current?.zoom(1 / 1.5) }}>−</button>
            <button type="button" className={css.boxButton} onClick={() => { trackControl.current?.fit() }}><i aria-hidden="true" />{t('fitTracks')}</button>
          </>}
        </div>
      </div>

      <footer className={css.status}>
        <span className={css.sectionBar} aria-hidden="true" /><span className={css.section}>{section}</span>
        <span className={css.signature}>
          {data !== undefined && <span>{t('signature', { workers: pad(tasks.length), events: pad(timeline.length, 3) })}</span>}
          <b>{t('brand')}</b><i aria-hidden="true" />
        </span>
      </footer>
      <Grain />
    </div>

    {data !== undefined && <div className={css.records}>
      <section className={css.record}>
        <header className={css.recordHead}><Bracket label={t('leases')} value={pad(leases.length, 3)} /><span>{data.workspaces.join(' · ')}</span></header>
        <div className={css.heavy} />
        {leases.length === 0 ? <p className={css.muted}>{t('noLeases')}</p> : <ol className={css.table}>{leases.map((lease, index) => <li key={lease.resource} data-status={lease.status}>
          <span className={css.no}>{pad(index + 1, 3)}</span><strong>{lease.resource}</strong><span>{t('owner', { step: lease.stepId })}</span>
          {lease.status === 'quarantined' ? <Chip kind="accent">{t('quarantined')}{lease.detail === '' ? '' : `: ${lease.detail}`}</Chip> : <Chip>{new Date(lease.acquiredAt).toLocaleTimeString([], { hour12: false })}</Chip>}
        </li>)}</ol>}
        {otherQuarantines.length > 0 && <aside className={css.inlineNote} aria-label={t('historicalQuarantines')}>
          <p>{t('historicalQuarantines')}</p><ul>{otherQuarantines.map(lease => <li key={lease.resource}><strong>{lease.resource}</strong>{' · '}{t('quarantined')}{lease.detail === '' ? '' : `: ${lease.detail}`}</li>)}</ul>
        </aside>}
      </section>
      <section className={css.record}>
        <header className={css.recordHead}><Bracket label={t('ledger')} value={pad(outcomes.length, 3)} /><span>{t('ledgerHint')}</span></header>
        <div className={css.heavy} />
        {outcomes.length === 0 ? <p className={css.muted}>{t('noOutcomes')}</p> : <ol className={css.table}>{outcomes.map((outcome, index) => <li key={outcome.id}>
          <details className={css.outcome}>
            <summary><span className={css.no}>{pad(outcomes.length - index, 3)}</span>
              <Chip kind={outcome.status === 'pass' ? 'inverse' : 'accent'}>{t(outcome.status === 'pass' ? 'success' : outcome.status === 'blocked' ? 'blockedOutcome' : 'failure')}</Chip>
              <strong>{outcome.title}</strong><span className={css.role}>{label('role', outcome.role)}</span></summary>
            <p>{outcome.summary}</p><p className={css.checksHead}>{t('checks')}</p><ul>{outcome.checks.map(check => <li key={check}>{check}</li>)}</ul>
          </details>
        </li>)}</ol>}
      </section>
      <section className={css.record}>
        <details className={css.timeline}>
          <summary className={css.recordHead}><Bracket label={t('timeline')} value={pad(timeline.length, 3)} /><i className={css.disclosure} aria-hidden="true" /><span>{data.updatedAt === null ? t('unknownTime') : `${t('updated')} · ${new Date(data.updatedAt).toLocaleString()}`}</span></summary>
          <div className={css.heavy} />
          {timeline.length === 0 ? <p className={css.muted}>{t('noTimeline')}</p> : <ol className={css.table} aria-label={t('timeline')}>{timeline.map(event => <li key={event.id}>
            <time className={css.no} dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time>
            <strong>{event.type === 'agent/activity' ? t(`activity.${event.activity}`) : label('event', event.type)}</strong>
            {event.stepId !== '' && <span className={css.role}>{event.stepId}</span>}
            {event.detail !== '' && <span className={css.detail}>{event.detail}</span>}
          </li>)}</ol>}
        </details>
      </section>
      <p className={css.statusNote}>{t('statusNote')}</p>
    </div>}
  </section>
}
