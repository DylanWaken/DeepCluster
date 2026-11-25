/** The selected worker's profile card: identity, telemetry, and its recorded log or messages. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClusterMessageView, ClusterTaskView, ClusterTimelineEntry } from '../dashboard-types.ts'
import { Chip, Ghost, Halftone, Roll, useScramble } from './chrome.tsx'
import { en, type ClusterKey } from './locales.ts'
import css from './WorkerCard.module.css'

/** Card inputs; the surrounding page owns selection and view changes. */
export interface WorkerCardProps extends PropsLocale<'deepCluster'> {
  readonly task: ClusterTaskView | undefined
  readonly index: number
  readonly rate: number
  readonly logs: readonly ClusterTimelineEntry[]
  readonly messages: readonly ClusterMessageView[]
  readonly view: 'map' | 'tracks'
  readonly focus: () => void
  readonly openOther: () => void
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')
const clock = (at: string): string => new Date(at).toLocaleTimeString([], { hour12: false })

/**
 * Render the RhinE-style worker card.
 * @param props - selected task, its records, and actions.
 * @returns the card panel.
 */
export function WorkerCard({ task, index, rate, logs, messages, view, focus, openOther, t }: WorkerCardProps) {
  const [page, setPage] = useState<'logs' | 'messages'>('logs')
  const title = useScramble(task?.title ?? t('awaiting'))
  const label = (prefix: 'role' | 'event', value: string): string => {
    const key = `${prefix}.${value}`
    return key in en ? t(key as ClusterKey) : value
  }
  const phase = (message: ClusterMessageView): string => t(message.kind === 'handoff' ? 'handoffSupplied'
    : message.phase === 'sent' ? 'messageSent' : message.phase === 'delivered' ? 'messageDelivered' : 'messageRecorded')
  const step = pad(index, 3)
  const runCode = task === undefined ? '—' : task.runId.replace(/[^a-z0-9]/giu, '').slice(-4).toUpperCase().padStart(4, '0')
  const cells: readonly [ClusterKey, string][] = task === undefined ? [] : [
    ['kRate', task.tokenSamples.length === 0 ? '—' : rate.toFixed(1)],
    ['kAttempt', pad(task.attempt, 2)],
    ['kInput', task.usage === null ? '—' : task.usage.inputTokens.toLocaleString()],
    ['kOutput', task.usage === null ? '—' : task.usage.outputTokens.toLocaleString()],
    ['kDepends', task.dependencies.length === 0 ? '—' : task.dependencies.join(', ')],
    ['kResource', task.waitingResource ?? (task.resources.length === 0 ? '—' : task.resources.join(', '))],
  ]
  const rows = page === 'logs' ? logs.length : messages.length
  return <aside className={css.card} aria-label={t('workerContext')}>
    <Halftone height={220} />
    <Ghost text={task === undefined ? '—' : step} />
    <div className={css.top}>
      <i className={css.square} aria-hidden="true" /><span className={css.eyebrow}>{t('profileEyebrow')}</span><span className={css.rule} aria-hidden="true" />
      <Chip kind="inverse">{t('stepChip', { step: task === undefined ? '—' : step })}</Chip>
    </div>
    {task === undefined ? <p className={css.empty}>{t('noRunSelected')}</p> : <div key={task.id} className={css.body}>
      <div className={css.chips}>
        <Chip kind="inverse">{t(`status.${task.status}`)}</Chip>
        {task.status === 'running' && <Chip kind="accent">{t(`activity.${task.activity}`)}</Chip>}
        <Chip>{label('role', task.role)}</Chip>
      </div>
      <h2 className={css.title} title={task.title}><span>{title}</span></h2>
      <p className={css.loaded}>{t('taskLoaded')}</p>
      <p className={css.loadedLine}><i aria-hidden="true" />{task.stepId} · {task.detail === '' ? t(`activity.${task.activity}`) : task.detail}</p>
      {task.tokenError !== null && <p role="status" className={css.error}>{t('tokenFailed', { message: task.tokenError })}</p>}
      <div className={css.profileBar}><span>{t('profile')}</span><span>{t('runCode', { run: runCode })}</span></div>
      <dl className={css.cells}>{cells.map(([key, value]) => <div key={key}><dt>{t(key)}</dt>
        <dd title={value}>{key === 'kRate' && value !== '—' ? <><Roll value={value} /><small>{t('rateUnit')}</small></> : value}</dd></div>)}</dl>
      <div className={css.listHead}>
        <span>{t(page === 'logs' ? 'workerLogs' : 'workerMessages')}</span><span data-live={task.status === 'running' || undefined}>{pad(rows, 2)}</span>
      </div>
      <ol key={page} className={css.list} aria-label={t(page === 'logs' ? 'workerLogs' : 'workerMessages')}>
        {page === 'logs' && (logs.length === 0 ? <li className={css.none}>{t('noWorkerLogs')}</li> : logs.map((event, position) => <li key={event.id}
          style={{ animationDelay: `${String(Math.min(position, 14) * 26)}ms` }} data-latest={position === 0 || undefined}>
          <span className={css.no}>{position === 0 ? '▶' : pad(logs.length - position, 3)}</span>
          <span className={css.what}>{event.type === 'agent/activity' ? t(`activity.${event.activity}`) : label('event', event.type)}
            {event.detail !== '' && <small title={event.detail}>{event.detail}</small>}</span>
          <time dateTime={event.at}>{clock(event.at)}</time>
        </li>))}
        {page === 'messages' && (messages.length === 0 ? <li className={css.none}>{t('noMessages')}</li> : messages.map((message, position) => <li key={message.id}
          style={{ animationDelay: `${String(Math.min(position, 14) * 26)}ms` }}>
          <span className={css.no}>{pad(messages.length - position, 3)}</span>
          <span className={css.what}>{message.fromStepId === 'controller' ? t('controller') : message.fromStepId} → {message.toStepId}
            <small className={css.phase}>{phase(message)}</small><small title={message.message}>{message.message}</small></span>
          <time dateTime={message.at}>{clock(message.at)}</time>
        </li>))}
      </ol>
      <div className={css.buttons}>
        <button type="button" className={css.primary} onClick={focus} aria-keyshortcuts="F">
          <i className={css.play} aria-hidden="true" /><span>{t('focusWorker')}</span><kbd>{t('focusKey')}</kbd>
        </button>
        <button type="button" className={css.secondary} onClick={openOther}>
          <span>{t(view === 'map' ? 'openTracks' : 'openMap')}</span>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 9 9 1M3.5 1H9v5.5" /></svg>
        </button>
      </div>
    </div>}
    <nav className={css.pages} aria-label={t('cardPages')}>
      {(['logs', 'messages'] as const).map(id => <button key={id} type="button" aria-pressed={page === id} onClick={() => { setPage(id) }}
        aria-label={t(id === 'logs' ? 'workerLogs' : 'workerMessages')}><i aria-hidden="true" /></button>)}
      <span>{t(page === 'logs' ? 'workerLogs' : 'workerMessages')}</span>
    </nav>
  </aside>
}
