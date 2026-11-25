/** Source-mode subprocess fixture for host-wide resource exclusion. */
import { acquireLease, releaseLease } from '../src/lease.ts'

const root = process.argv[2]
const owner = process.argv[3]
if (root === undefined || owner === undefined) throw new Error('lease worker requires root and owner')
const release = new Promise<void>((resolve) => { process.once('message', () => { resolve() }) })
const lease = await acquireLease(root, 'gpu0', { owner, waitMs: 30_000 })
process.send?.('acquired')
await release
await releaseLease(root, lease)
process.disconnect()
