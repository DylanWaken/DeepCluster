/** Source-mode subprocess fixture for controller-owned service lifecycle locking. */
import { appendFile } from 'node:fs/promises'
import { withServiceLifecycleLock } from '../../src/service-lock.ts'

const mode = process.argv[2]
const pipeName = process.argv[3]
const markerFile = process.argv[4]
const id = process.argv[5]
const holdMs = Number(process.argv[6] ?? '0')
if (mode === undefined || pipeName === undefined || markerFile === undefined || id === undefined) {
  throw new Error('service-lock child requires mode, endpoint, marker file, and id')
}

if (mode === 'serial') {
  await withServiceLifecycleLock(async () => {
    await appendFile(markerFile, `enter ${id}\n`)
    await new Promise<void>((resolve) => { setTimeout(resolve, holdMs) })
    await appendFile(markerFile, `exit ${id}\n`)
  }, { pipeName, timeoutMs: 30_000 })
} else if (mode === 'hold') {
  await withServiceLifecycleLock(async () => {
    await appendFile(markerFile, `enter ${id}\n`)
    process.send?.('acquired')
    await new Promise<never>(() => {})
  }, { pipeName, timeoutMs: 30_000 })
} else {
  throw new Error(`unknown service-lock child mode ${mode}`)
}
