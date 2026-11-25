/** Isolated crash fixture: an external command can outlive its lifecycle controller. */
import { spawn } from 'node:child_process'
import { withServiceLifecycleLock } from '../../src/service-lock.ts'
import { withServiceMutationIntent, withServiceMutationTransaction } from '../../src/service-intent.ts'

const [endpoint, intentFile, finishedFile, mode] = process.argv.slice(2)
if (endpoint === undefined || intentFile === undefined || finishedFile === undefined) throw new Error('fixture paths required')
await withServiceLifecycleLock(async () => {
  await withServiceMutationTransaction('isolated startup transaction', async () => {
    await withServiceMutationIntent('isolated delayed child', async () => {
      const child = spawn(process.execPath, ['-e',
        'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"finished"),600)', finishedFile],
      { stdio: 'ignore', windowsHide: true, detached: true })
      child.once('spawn', () => { if (mode !== 'after-command') process.send?.('mutating') })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`fixture child exited ${String(code)}`)) })
      })
    })
    if (mode === 'after-command') {
      process.send?.('mutating')
      await new Promise<void>(() => { /* model a queued task before readiness and state persistence */ })
    }
  }, { file: intentFile })
}, { pipeName: endpoint })
