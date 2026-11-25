/** Run-scoped cooperative worker mailboxes; records remain available across worker retries. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import z from 'zod'
import type { RunId, TeamMessageId } from './types.ts'

/** Identity of one durable peer message. */
export type { TeamMessageId } from './types.ts'

/** Sender identity reserved for authenticated supervisor feedback, never a run participant. */
export const SUPERVISOR_STEP_ID = 'supervisor'

/**
 * Protocol ceiling for one persisted message. Per-worker `maxMessageChars`
 * bounds what that worker may send; it never makes an admitted record
 * unreadable, because a smaller recipient budget must not poison its inbox.
 */
export const MAX_TEAM_MESSAGE_CHARS = 16_000

/** Controller-created team description supplied to one worker. */
export interface WorkerTeam {
  readonly root: string
  readonly runId: RunId
  readonly stepId: string
  readonly participants: readonly string[]
}

/** A durable message; retrieval does not imply that its instructions were followed. */
export interface TeamMessage {
  readonly id: TeamMessageId
  readonly runId: RunId
  readonly fromStepId: string
  readonly toStepId: string
  readonly message: string
  readonly sentAt: string
}

/** Worker observation of a durable send or an inbox retrieval. */
export interface TeamMessageReceipt extends TeamMessage {
  readonly phase: 'sent' | 'delivered'
}

const manifestSchema = z.object({ runId: z.string().min(1), participants: z.array(z.string().min(1)).min(1) }).strict()
const messageSchema = z.object({ id: z.uuid(), runId: z.string().min(1), fromStepId: z.string().min(1),
  toStepId: z.string().min(1), message: z.string().min(1).max(MAX_TEAM_MESSAGE_CHARS), sentAt: z.iso.datetime() }).strict()

/**
 * Decode an untrusted worker receipt without treating malformed stdout as communication.
 * @param value - parsed receipt object from worker stdout.
 * @returns the validated receipt, or undefined when its fields are invalid.
 */
export function parseMessageReceipt(value: unknown): TeamMessageReceipt | undefined {
  const result = messageSchema.extend({ phase: z.enum(['sent', 'delivered']) }).safeParse(value)
  if (!result.success) return undefined
  return { ...result.data, id: result.data.id as TeamMessageId, runId: result.data.runId as RunId }
}

/**
 * Create a unique mailbox namespace before dispatching any worker.
 * @param workspace - journal-owning workspace.
 * @param runId - coordinator operation identifier.
 * @param participants - exact task identifiers accepted as message recipients.
 * @returns the absolute mailbox root.
 */
export async function createTeam(workspace: string, runId: RunId, participants: readonly string[]): Promise<string> {
  if (participants.includes(SUPERVISOR_STEP_ID)) {
    throw new Error(`Team participant ${SUPERVISOR_STEP_ID} is reserved for authenticated supervisor feedback`)
  }
  const root = path.join(workspace, '.deep-cluster', 'teams', runId)
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'team.json'), JSON.stringify({ runId, participants }), { flag: 'wx' })
  return root
}

/** Directory holding one recipient's durable messages. */
function recipientDirectory(root: string, stepId: string): string {
  return path.join(root, createHash('sha256').update(stepId).digest('hex'))
}

/** Publish one committed record through a pending file so readers never see a partial append. */
async function publishMessage(root: string, record: TeamMessage): Promise<void> {
  const directory = recipientDirectory(root, record.toStepId)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `${record.id}.pending`)
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx' })
  await rename(temporary, path.join(directory, `${record.id}.json`))
}

/**
 * Publish one authenticated supervisor message into the existing run mailbox.
 * The recipient must retrieve it explicitly through its inbox tool; this grants
 * no permissions, changes no dependency, and transfers no lease.
 * @param root - controller-created team directory.
 * @param runId - operation run identity; must match the persisted manifest.
 * @param toStepId - exact recipient participant.
 * @param message - bounded coordination text.
 * @param maxMessageChars - configured message budget.
 * @returns the committed message with the reserved supervisor sender identity.
 */
export async function sendSupervisorMessage(
  root: string, runId: RunId, toStepId: string, message: string, maxMessageChars: number,
): Promise<TeamMessage> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, 'team.json'), 'utf8')))
  if (manifest.runId !== runId) throw new Error('Supervisor message run does not match the team manifest')
  if (toStepId === SUPERVISOR_STEP_ID) throw new Error(`Team participant ${SUPERVISOR_STEP_ID} is reserved for authenticated supervisor feedback`)
  if (!manifest.participants.includes(toStepId)) throw new Error(`Unknown team recipient: ${toStepId}`)
  if (message.trim() === '' || message.length > Math.min(maxMessageChars, MAX_TEAM_MESSAGE_CHARS)) {
    throw new Error(`Message must contain 1 to ${String(Math.min(maxMessageChars, MAX_TEAM_MESSAGE_CHARS))} characters`)
  }
  const record: TeamMessage = { id: randomUUID() as TeamMessageId, runId,
    fromStepId: SUPERVISOR_STEP_ID, toStepId, message, sentAt: new Date().toISOString() }
  await publishMessage(root, record)
  return record
}

/** One worker identity and its already-returned message IDs, owned by its plugin lifetime. */
export class TeamMailbox {
  readonly #seen = new Set<TeamMessageId>()
  #receiving: Promise<void> = Promise.resolve()

  /**
   * @param team - validated run manifest and caller identity.
   * @param maxMessageChars - maximum message length this worker may send.
   * @param maxInboxMessages - maximum newly retrieved messages in one call.
   */
  private constructor(private readonly team: WorkerTeam, private readonly maxMessageChars: number,
    private readonly maxInboxMessages: number) {}

  /**
   * Validate persisted team identity before exposing messaging tools.
   * @param team - caller identity and the controller's mailbox root.
   * @param maxMessageChars - configured message budget.
   * @param maxInboxMessages - configured per-retrieval budget.
   * @returns a mailbox that accepts only members of the recorded run.
   */
  static async open(team: WorkerTeam, maxMessageChars: number, maxInboxMessages: number): Promise<TeamMailbox> {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(team.root, 'team.json'), 'utf8')))
    if (manifest.runId !== team.runId || !manifest.participants.includes(team.stepId)
      || manifest.participants.length !== team.participants.length
      || !manifest.participants.every(id => team.participants.includes(id))) throw new Error('Worker identity does not match its team manifest')
    return new TeamMailbox(team, maxMessageChars, maxInboxMessages)
  }

  private directory(stepId: string): string {
    return recipientDirectory(this.team.root, stepId)
  }

  /**
   * Atomically publish a message to a participant in this run.
   * @param toStepId - exact recipient task identifier.
   * @param message - bounded coordination text, never a permission or lease grant.
   * @returns the committed message; the recipient must retrieve it explicitly.
   */
  async send(toStepId: string, message: string): Promise<TeamMessage> {
    if (!this.team.participants.includes(toStepId)) throw new Error(`Unknown team recipient: ${toStepId}`)
    if (message.trim() === '' || message.length > this.maxMessageChars) throw new Error(`Message must contain 1 to ${this.maxMessageChars} characters`)
    const record: TeamMessage = { id: randomUUID() as TeamMessageId, runId: this.team.runId,
      fromStepId: this.team.stepId, toStepId, message, sentAt: new Date().toISOString() }
    await publishMessage(this.team.root, record)
    return record
  }

  /**
   * Retrieve messages not yet returned to this worker process, retaining durable records for retries.
   * @returns bounded messages in timestamp and identifier order; corrupt records fail the tool call.
   */
  async receive(): Promise<TeamMessage[]> {
    const work = this.#receiving.then(async () => await this.readMessages())
    this.#receiving = work.then(() => {}, () => {})
    return await work
  }

  private async readMessages(): Promise<TeamMessage[]> {
    const directory = this.directory(this.team.stepId)
    await mkdir(directory, { recursive: true })
    const records: TeamMessage[] = []
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue
      const value = messageSchema.parse(JSON.parse(await readFile(path.join(directory, file), 'utf8')))
      if (file !== `${value.id}.json` || value.runId !== this.team.runId || value.toStepId !== this.team.stepId
        || (value.fromStepId !== SUPERVISOR_STEP_ID && !this.team.participants.includes(value.fromStepId))) {
        throw new Error('Mailbox message does not match this team and recipient')
      }
      const record = { ...value, id: value.id as TeamMessageId, runId: value.runId as RunId }
      if (!this.#seen.has(record.id)) records.push(record)
    }
    records.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id))
    const selected = records.slice(0, this.maxInboxMessages)
    for (const record of selected) this.#seen.add(record.id)
    return selected
  }
}
