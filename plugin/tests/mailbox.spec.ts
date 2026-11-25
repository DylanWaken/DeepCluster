/** Cooperative mail delivery is scoped to one run and survives worker retries. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createTeam, parseMessageReceipt, sendSupervisorMessage, SUPERVISOR_STEP_ID, TeamMailbox, type WorkerTeam } from '../src/mailbox.ts'
import { MAX_TEAM_MESSAGE_CHARS } from '../src/mailbox.ts'
import type { RunId } from '../src/types.ts'
import { WorkerProgress } from '../src/progress.ts'

async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'deepcluster-mail-'))
  onTestFinished(async () => { await rm(workspace, { recursive: true, force: true }) })
  const runId = randomUUID() as RunId
  const root = await createTeam(workspace, runId, ['one', 'two'])
  const team: WorkerTeam = { root, runId, stepId: 'one', participants: ['one', 'two'] }
  return { team, sender: await TeamMailbox.open(team, 100, 2),
    receiver: await TeamMailbox.open({ ...team, stepId: 'two' }, 100, 2) }
}

describe('run mailboxes', () => {
  it('atomically sends concurrent messages and retrieves each once per worker process', async () => {
    const { team, sender, receiver } = await fixture()
    expect(await receiver.receive()).toEqual([])
    const sent = await Promise.all([sender.send('two', 'first fact'), sender.send('two', 'second fact')])
    const received = (await Promise.all([receiver.receive(), receiver.receive()])).flat()
    expect(received.map(record => record.id).sort()).toEqual(sent.map(record => record.id).sort())
    expect(await receiver.receive()).toEqual([])
    const retry = await TeamMailbox.open({ ...team, stepId: 'two' }, 100, 2)
    expect(await retry.receive()).toHaveLength(2)
    expect(await sender.receive()).toEqual([])
  })

  it('rejects unknown recipients, mismatched run identity and invalid content', async () => {
    const { team, sender } = await fixture()
    await expect(sender.send('../escape', 'hello')).rejects.toThrow('Unknown team recipient')
    await expect(sender.send('two', ' ')).rejects.toThrow('1 to 100')
    await expect(sender.send('two', 'x'.repeat(101))).rejects.toThrow('1 to 100')
    await expect(TeamMailbox.open({ ...team, runId: 'different' as RunId }, 100, 2)).rejects.toThrow('identity')
    await expect(TeamMailbox.open({ ...team, stepId: 'unlisted' }, 100, 2)).rejects.toThrow('identity')
  })

  it('fails on a corrupt committed message instead of silently discarding it', async () => {
    const { team, sender, receiver } = await fixture()
    const message = await sender.send('two', 'valid')
    const directory = path.join(team.root, createHash('sha256').update('two').digest('hex'))
    await writeFile(path.join(directory, `${message.id}.json`), JSON.stringify({ ...message, fromStepId: 'intruder' }))
    await expect(receiver.receive()).rejects.toThrow('does not match')
  })

  it('accepts bounded supervisor feedback only for an exact run participant', async () => {
    const { team, receiver } = await fixture()
    const sent = await sendSupervisorMessage(team.root, team.runId, 'two', 'check the fixture before reporting', 100)
    expect(sent).toMatchObject({ fromStepId: SUPERVISOR_STEP_ID, toStepId: 'two' })
    expect(await receiver.receive()).toEqual([sent])
    expect(await receiver.receive()).toEqual([])
    await expect(sendSupervisorMessage(team.root, team.runId, 'three', 'hello', 100)).rejects.toThrow('Unknown team recipient')
    await expect(sendSupervisorMessage(team.root, 'other-run' as RunId, 'two', 'hello', 100)).rejects.toThrow('run does not match')
    await expect(sendSupervisorMessage(team.root, team.runId, 'two', 'x'.repeat(101), 100)).rejects.toThrow('1 to 100')
  })

  it('does not let a smaller recipient budget poison the inbox for an admitted message', async () => {
    const { team } = await fixture()
    const small = await TeamMailbox.open({ ...team, stepId: 'two' }, 5, 2)
    const sent = await sendSupervisorMessage(team.root, team.runId, 'two', 'x'.repeat(64), 1000)
    await expect(small.receive()).resolves.toEqual([sent])
    await expect(small.send('one', 'x'.repeat(6))).rejects.toThrow('1 to 5')
    await expect(sendSupervisorMessage(team.root, team.runId, 'two', 'x'.repeat(MAX_TEAM_MESSAGE_CHARS + 1), MAX_TEAM_MESSAGE_CHARS + 1))
      .rejects.toThrow(`1 to ${String(MAX_TEAM_MESSAGE_CHARS)}`)
  })

  it('reserves the supervisor sender identity so no run participant can collide with it', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'deepcluster-mail-'))
    onTestFinished(async () => { await rm(workspace, { recursive: true, force: true }) })
    await expect(createTeam(workspace, randomUUID() as RunId, ['one', SUPERVISOR_STEP_ID]))
      .rejects.toThrow('reserved for authenticated supervisor feedback')
    const { team } = await fixture()
    await expect(sendSupervisorMessage(team.root, team.runId, SUPERVISOR_STEP_ID, 'hello', 100))
      .rejects.toThrow('reserved for authenticated supervisor feedback')
  })

  it('records distinct sent and retrieved receipts through the worker stdout parser', async () => {
    const { sender } = await fixture()
    const message = await sender.send('two', 'fact')
    const receipts: unknown[] = []
    const progress = new WorkerProgress()
    for (const phase of ['sent', 'delivered']) {
      progress.accept({ type: 'deepcluster_message', receipt: { ...message, phase } }, 1,
        { onMessage: (receipt) => { receipts.push(receipt) } })
    }
    expect(receipts).toEqual([{ ...message, phase: 'sent' }, { ...message, phase: 'delivered' }])
    expect(parseMessageReceipt({ ...message, phase: 'read minds' })).toBeUndefined()
    expect(parseMessageReceipt({ ...message, id: '../../bad', phase: 'sent' })).toBeUndefined()
  })
})
