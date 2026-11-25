/**
 * Public types for DeepCluster — the bridge that lets an external planner
 * (Cursor, Codex, or another HTTP client) hand a plan to the local API.
 *
 * The API owns scheduling; workers launch through a configured DSH profile.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Exact native Session allocation; resume never falls back to a fresh conversation. */
export interface WorkerSession {
  readonly mode: 'create' | 'resume'
  readonly id: SessionId
}

/** Opaque identity of one coordinator operation. */
export type RunId = Branded<'DeepClusterRunId'>

/** Opaque identity of one durable run-scoped peer message. */
export type TeamMessageId = Branded<'DeepClusterTeamMessageId'>

/** Opaque identity of one journal writer; sequence numbers are local to this identity. */
export type JournalWriterId = Branded<'DeepClusterJournalWriterId'>

/** Secret ownership capability for renewing or releasing a cooperative resource lock. */
export type LeaseToken = Branded<'DeepClusterLeaseToken'>

/** API owner generation whose worker ranges authorize recovery of its retained resources. */
export type OwnershipGeneration = Branded<'DeepClusterOwnershipGeneration'>

/** A built-in planner product whose skills root is a documented preset. */
export type PlannerId = 'cursor' | 'codex'

/** A preset planner or the caller-chosen skills root configured by `skillsRoot`. */
export type InstallTargetId = PlannerId | 'custom'

/** One install destination and the label written into its generated skill text. */
export interface InstallTarget {
  /** Preset planner, or `custom` for the configured `skillsRoot`. */
  readonly planner: InstallTargetId
  /** Absolute `SKILL.md` path. */
  readonly file: string
  /** Harness name shown near the top of the generated skill. */
  readonly label: string
}

/** One handoff; service and MCP callers supply a structured plan with acceptance checks. */
export interface HandoffRequest {
  /** Supervisor-persisted native identity; omission creates an ordinary disposable worker Session. */
  nativeSession?: WorkerSession
  /** Absolute per-run policy input read by the static worker policy plugin. */
  policyFile?: string
  /** Cancellation waits for the worker's complete process range to stop. */
  signal?: AbortSignal
  /** Observes stdout chunks for progress; omitted collects output only. */
  onStdout?: (chunk: string) => void
  /** Explicit worker plugin configuration passed through process environment variables. */
  env?: Readonly<Record<string, string>>
  /** The task in the planner's own words. Required and non-blank. */
  task: string
  /** Structured plan required by public service and MCP handoffs. */
  plan?: string
  /** Working directory for the executor; also its sandbox workspace root. */
  cwd?: string
  /** DSH profile to boot. Omitted uses the configured profile. */
  profile?: string
  /** Hard deadline in milliseconds. Omitted uses the configured timeout. */
  timeoutMs?: number
  /** Request JSON events from the low-level worker launcher. */
  json?: boolean
  /** Sandbox mode for the executor; omitted uses the configured full-access default. */
  permissionMode?: PermissionMode
}

/** Sandbox modes DeepCluster may select for one run. */
export type PermissionMode = 'workspace-write' | 'danger-full-access'

/** Observable worker activity derived from execution events, without reasoning content. */
export interface AgentActivity {
  readonly kind: 'thinking' | 'command' | 'read' | 'write' | 'tool' | 'idle'
  /** Tool name or bounded operation label; never private reasoning text. */
  readonly detail?: string
}

/** Bounded worker-visible output or tool execution detail for the control-room log. */
export interface AgentLog {
  readonly kind: 'output' | 'command' | 'tool'
  /** Observed text only; private reasoning events are excluded. */
  readonly text: string
}

/** One completed model step's provider usage and observed response throughput, including retries. */
export interface AgentUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Step start to first completed assistant output, excluding subsequent tool execution. */
  readonly elapsedMs: number
  /** Output tokens per elapsed second, including preparation and prefill rather than pure decode speed. */
  readonly tokensPerSecond: number
}

/** Incremental tokenizer-counted output observed from a worker's live model stream. */
export interface AgentTokenSample {
  /** Signed change after retokenizing the output prefix; merges can revise its last tokens. */
  readonly tokens: number
  /** Controller observation time in epoch milliseconds. */
  readonly observedAt: number
  readonly basis: 'tokenizer'
  /** Explicit configured tokenizer identifier, distinct from provider billing usage. */
  readonly tokenizer: string
}

/** The outcome of one handoff. `ok` is true only for a clean zero exit. */
export interface HandoffResult {
  readonly ok: boolean
  readonly exitCode: number
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** The exact command line, for logs and for the planner to reproduce. */
  readonly command: string
}

/** Resolved DeepCluster settings shared by the plugin, the CLI, and the MCP server. */
export interface DeepClusterOptions {
  /** Dedicated loopback HTTP origin; absent until the user supplies an endpoint or launches a local installation. */
  readonly apiEndpoint?: string
  /** Loopback origin serving the authenticated DeepCluster dashboard; defaults to `http://127.0.0.1:3788`. */
  readonly dashboardEndpoint?: string
  /** User-provided DSH checkout containing the DeepCluster plugin; retained for API startup. */
  readonly dshPath?: string
  /** Absolute primary workspace the dashboard projects; defaults to the service command's cwd. */
  readonly dashboardWorkspace?: string
  /** Additional absolute workspace roots the dashboard projects. */
  readonly dashboardWorkspaces?: readonly string[]
  /** Deadline for each HTTP request, independent of worker execution deadlines. */
  readonly apiRequestTimeoutMs: number
  /** Interval between operation status requests. */
  readonly apiPollIntervalMs: number
  /** Maximum wait for another service lifecycle controller; defaults to five minutes. */
  readonly serviceLifecycleWaitMs: number
  /** Worker sandbox mode; full access by default for DeepCluster. */
  readonly permissionMode: PermissionMode
  /** Combined stdout/stderr byte limit for one worker. */
  readonly maxOutputBytes: number
  /** Grace period before forced process-range termination. */
  readonly terminationGraceMs: number
  /** Absolute path to a built `dsh` entry (`apps/cli/lib/bin.js`), or a command name on PATH; workers use only this entry. */
  readonly cliPath: string
  /** `dsh` entry for the persistent API and dashboard only; absent falls back to `cliPath`. */
  readonly serviceCliPath?: string
  /** DSH profile that executes handoffs. */
  readonly profile: string
  /** Slash-command/skill name installed into each planner. */
  readonly commandName: string
  /** Where Cursor discovers skills. */
  readonly cursorSkillsRoot: string
  /** Where Codex discovers skills. */
  readonly codexSkillsRoot: string
  /** Absolute skills root for a harness without a preset; setting it selects the generic install target. */
  readonly skillsRoot?: string
  /** Harness label for generic install text; defaults to `this harness`. */
  readonly skillLabel?: string
  /** Default handoff deadline in milliseconds. */
  readonly timeoutMs: number
}

/** Result of installing planner assets. */
export interface InstallReport {
  readonly written: string[]
  readonly unchanged: string[]
}

/** Plugin configuration; every field has a working default. */
export interface DeepClusterConfig {
  /** Dedicated loopback HTTP origin. */
  apiEndpoint?: string
  /** Dashboard loopback origin; defaults to `http://127.0.0.1:3788`. */
  dashboardEndpoint?: string
  /** User-provided DSH checkout used to launch the API. */
  dshPath?: string
  /** Saved absolute primary dashboard workspace root. */
  dashboardWorkspace?: string
  /** Saved additional absolute dashboard workspace roots. */
  dashboardWorkspaces?: readonly string[]
  /** Per-request HTTP timeout; defaults to 30 seconds. */
  apiRequestTimeoutMs?: number
  /** Operation status polling interval; defaults to one second. */
  apiPollIntervalMs?: number
  /** Service lifecycle serialization deadline; defaults to 300000 milliseconds. */
  serviceLifecycleWaitMs?: number
  /** Worker sandbox mode; defaults to danger-full-access. */
  permissionMode?: PermissionMode
  /** Combined stdout/stderr byte limit; defaults to 16 MiB. */
  maxOutputBytes?: number
  /** Process termination grace; defaults to 5 seconds. */
  terminationGraceMs?: number
  /** Built DSH CLI entry, or a command name on PATH; workers use only this entry. */
  cliPath?: string
  /** DSH CLI entry for persistent service launch only; absent falls back to `cliPath`. */
  serviceCliPath?: string
  /** Execution profile. */
  profile?: string
  /** Installed command name. */
  commandName?: string
  /** Cursor skills root override. */
  cursorSkillsRoot?: string
  /** Codex skills root override. */
  codexSkillsRoot?: string
  /** Absolute skills root for a harness without a preset; selects the generic install target. */
  skillsRoot?: string
  /** Harness label for generic install text. */
  skillLabel?: string
  /** Default handoff deadline in milliseconds. */
  timeoutMs?: number
}
