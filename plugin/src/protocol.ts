/** Structured worker self-reports and acceptance-label evidence checks. */

/** What a role agent decided about its step. */
export type ReportStatus = 'pass' | 'fail' | 'blocked'

/** Why an agent departed from the plan. */
export type ImprovisationKind = 'deviation' | 'blocker' | 'addition' | 'reduction'

/** A structured improvisation the planner must be told about. */
export interface Improvisation {
  readonly kind: ImprovisationKind
  readonly reason: string
  readonly planChange: string
}

/** A parsed agent report. */
export interface AgentReport {
  readonly status: ReportStatus
  /** The agent's own summary of what it did. */
  readonly summary: string
  /** Per-check results the agent claims. */
  readonly checks: readonly string[]
  /** Present when the agent departed from the plan. */
  readonly improvisation?: Improvisation
  /** True when the block was present and well formed. */
  readonly parsed: boolean
}

const OPEN = '[[DEEPCLUSTER]]'
const CLOSE = '[[/DEEPCLUSTER]]'

/** Raised when a report block exists but cannot be understood. */
export class ReportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportFormatError'
  }
}

/** Read a `key: value` line from the block body. */
function value(lines: readonly string[], key: string): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith(`${key}:`)) return trimmed.slice(key.length + 1).trim()
  }
  return undefined
}

/** Read the `checks:` bullets. */
function checkList(lines: readonly string[]): string[] {
  const start = lines.findIndex(line => line.trim().toLowerCase() === 'checks:')
  if (start < 0) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('-')) break
    items.push(trimmed.slice(1).trim())
  }
  return items
}

/**
 * Extract the machine-readable report from an agent's output.
 * Affirmative checks allow whitespace or `.`, `,`, `;`, `:`, `!` before evidence containing letters or digits.
 * @param output - the complete agent output.
 * @param acceptance - required check labels; omission only parses the self-report.
 * @returns the parsed report; `parsed` is false when no block was present.
 */
export function parseAgentReport(output: string, acceptance?: readonly string[]): AgentReport {
  const open = output.lastIndexOf(OPEN)
  if (open < 0) return { status: 'fail', summary: 'agent reported no DeepCluster block', checks: [], parsed: false }
  const close = output.indexOf(CLOSE, open)
  if (close < 0) throw new ReportFormatError('DeepCluster block was opened but never closed')
  if (output.indexOf(OPEN) !== open || output.slice(close + CLOSE.length).trim() !== '') {
    throw new ReportFormatError('Expected exactly one terminal DeepCluster report block')
  }
  const body = output.slice(open + OPEN.length, close).split(/\r?\n/u)
  const status = (value(body, 'status') ?? '').toLowerCase()
  if (status !== 'pass' && status !== 'fail' && status !== 'blocked') {
    throw new ReportFormatError(`report status must be pass, fail, or blocked; got "${status}"`)
  }
  const summary = value(body, 'summary') ?? ''
  if (summary.trim() === '') throw new ReportFormatError('DeepCluster report needs a summary')
  const checks = checkList(body)
  let missing: readonly string[] = []
  if (status === 'pass' && acceptance !== undefined) {
    missing = acceptance.filter((criterion) => {
      const prefix = `${criterion}:`
      const matched = checks.filter(check => check.startsWith(prefix))
      return matched.length !== 1 || !/^yes(?:[.,;:!\s])\s*(?=.*[\p{L}\p{N}])\S.+/iu.test((matched[0] ?? '').slice(prefix.length).trim())
    })
  }
  const improvises = (value(body, 'improvisation') ?? 'no').toLowerCase() === 'yes'
  let improvisation: Improvisation | undefined
  if (improvises) {
    const kind = (value(body, 'kind') ?? '').toLowerCase()
    if (!['deviation', 'blocker', 'addition', 'reduction'].includes(kind)) {
      throw new ReportFormatError(`improvisation needs kind: deviation|blocker|addition|reduction; got "${kind}"`)
    }
    const reason = value(body, 'reason')
    if (reason === undefined || reason === '') throw new ReportFormatError('improvisation needs a reason')
    improvisation = {
      kind: kind as ImprovisationKind,
      reason,
      planChange: value(body, 'plan_change') ?? '',
    }
  }
  return {
    status: missing.length > 0 ? 'fail' : status,
    summary: missing.length > 0 ? `Missing affirmative evidence for: ${missing.join('; ')}` : summary,
    checks, ...improvisation === undefined ? {} : { improvisation }, parsed: true,
  }
}

/** Text appended to every role prompt describing the required block. */
export const REPORT_CONTRACT = `
Finish your reply with exactly one report block and nothing after it:

${OPEN}
status: pass | fail | blocked
summary: one or two sentences describing what you actually did
checks:
- <each acceptance check you were given>: <yes|no> <evidence>
improvisation: no
${CLOSE}

If — and only if — you departed from the plan, set improvisation: yes and add:
kind: deviation | blocker | addition | reduction
reason: why the plan could not be followed as written
plan_change: what you did instead, phrased as a change to the plan

Do not claim a check passed without the command or measurement that shows it.
`
