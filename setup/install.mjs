import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const revision = '687f282e8625c6b8d11ff58211a90524be2e4317'
const patch = fileURLToPath(new URL('./dsh-v0.2.1-rc.2.patch', import.meta.url))
const plugin = fileURLToPath(new URL('../plugin/', import.meta.url))
const files = readFileSync(new URL('./plugin-files.txt', import.meta.url), 'utf8').trimEnd().split(/\r?\n/u)

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

function releaseFile(root, relative) {
  const components = relative.split('/')
  if (components.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(part))) {
    throw new Error(`Invalid release path in setup/plugin-files.txt: ${relative}`)
  }
  const physical = realpathSync.native(root)
  const file = path.join(physical, ...components)
  if (realpathSync.native(file) !== file || !lstatSync(file).isFile()) throw new Error(`Expected a regular release file at ${file}`)
  return file
}

function install() {
  if (process.argv.length !== 3) throw new Error('Usage: node setup/install.mjs <DSH checkout>')
  const dsh = realpathSync(path.resolve(process.argv[2]))
  const head = git(dsh, ['rev-parse', '--verify', 'HEAD'])
  if (head.status !== 0 || head.stdout.trim() !== revision) {
    throw new Error(`Use the DSH checkout at tag dsh-v0.2.1-rc.2 (${revision}).`)
  }
  const prefix = git(dsh, ['rev-parse', '--show-prefix'])
  if (prefix.status !== 0 || prefix.stdout.trim()) throw new Error('Pass the root of the DSH checkout.')
  const target = path.join(dsh, 'packages', 'experimental', 'deep-cluster')
  const alreadyCopied = existsSync(target)
  if (alreadyCopied && !lstatSync(target).isDirectory()) throw new Error(`Expected a physical directory at ${target}`)
  for (const file of files) {
    const from = releaseFile(plugin, file)
    if (alreadyCopied && !readFileSync(from).equals(readFileSync(releaseFile(target, file)))) {
      throw new Error(`Installed source differs at ${path.join(target, file)}. Choose a fresh DSH checkout to install this revision.`)
    }
  }
  const check = git(dsh, ['apply', '--check', patch])
  if (check.status === 0) {
    const applied = git(dsh, ['apply', patch])
    if (applied.status !== 0) throw new Error(applied.stderr)
  } else if (git(dsh, ['apply', '--reverse', '--check', patch]).status !== 0) {
    throw new Error(`DSH compatibility patch does not apply cleanly.\n${check.stderr}`)
  }
  if (!alreadyCopied) {
    const staging = mkdtempSync(path.join(path.dirname(target), '.deep-cluster-install-'))
    try {
      const pending = path.join(staging, 'plugin')
      for (const file of files) {
        const to = path.join(pending, file)
        mkdirSync(path.dirname(to), { recursive: true })
        copyFileSync(releaseFile(plugin, file), to)
      }
      renameSync(pending, target)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  console.log(`DeepCluster source and locked dependencies are ready in ${dsh}.`)
}

try { install() } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
