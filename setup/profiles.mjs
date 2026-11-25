import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function configure() {
  if (process.argv.length !== 3) throw new Error('Usage: node setup/profiles.mjs <built DSH checkout>')
  const dsh = realpathSync(path.resolve(process.argv[2]))
  const require = createRequire(path.join(dsh, 'apps', 'cli', 'package.json'))
  const packageName = '@deepseek-ai/dsh-experimental-deep-cluster'
  const manifestPath = require.resolve(`${packageName}/package.json`)
  for (const name of [packageName, `${packageName}/team`, `${packageName}/web`, `${packageName}/policy`]) {
    require.resolve(name)
  }
  const { initProfile, PROFILE_TEMPLATES, resolveProfileDir } = await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href
  )

  for (const [name, bundles] of [
    ['deep-cluster', [packageName]],
    ['cluster', PROFILE_TEMPLATES.headless.bundles],
  ]) {
    const target = resolveProfileDir(name)
    if (existsSync(target)) {
      const manifest = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'))
      const existing = manifest.dsh?.profile?.bundles
      if (!Array.isArray(existing) || !bundles.every(bundle => existing.includes(bundle))) {
        throw new Error(`Existing profile at ${target} needs these bundles: ${bundles.join(', ')}. Review its package.json.`)
      }
      console.log(`Using existing profile at ${target}`)
      if (name === 'cluster') {
        console.log(`For worker mailboxes, include the entries from ${path.join(path.dirname(manifestPath), 'team.patch.yml')} in this profile's cordis.patch.yml.`)
      }
      continue
    }
    const parent = path.dirname(target)
    mkdirSync(parent, { recursive: true })
    const staging = mkdtempSync(path.join(parent, '.deep-cluster-profile-'))
    try {
      const pending = path.join(staging, name)
      initProfile(pending, bundles)
      if (name === 'cluster') {
        copyFileSync(path.join(path.dirname(manifestPath), 'team.patch.yml'), path.join(pending, 'cordis.patch.yml'))
      }
      renameSync(pending, target)
      console.log(`Created ${target}`)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  console.log('The dashboard uses the shipped web profile with the DeepCluster web overlay.')
}

try { await configure() } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
