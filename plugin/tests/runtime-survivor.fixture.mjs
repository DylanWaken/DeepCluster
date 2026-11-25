// Spawn a grandchild that outlives this parent, then report its pid and exit.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const pidFile = process.argv[2]
if (pidFile === undefined) process.exit(2)
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
  detached: true,
})
if (grandchild.pid === undefined) process.exit(3)
writeFileSync(pidFile, String(grandchild.pid))
grandchild.unref()
process.exit(0)
