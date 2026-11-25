/** Distribution manifest, clean-pack staging, and portable documentation contracts. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOptions, skillMarkdown } from '../src/assets.ts'

const exec = promisify(execFile)
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-pack-'))
  temporary.push(dir)
  return dir
}

interface Manifest {
  readonly name: string
  readonly version: string
  readonly engines?: { readonly node?: string }
  readonly scripts?: Record<string, string>
  readonly exports?: Record<string, string | Record<string, string>>
  readonly files?: readonly string[]
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Manifest
}

function exportTargets(manifestValue: Manifest): string[] {
  const targets: string[] = []
  for (const value of Object.values(manifestValue.exports ?? {})) {
    if (typeof value === 'string') {
      targets.push(value)
      continue
    }
    for (const target of Object.values(value)) targets.push(target)
  }
  return [...new Set(targets)]
}

function filesPatternMatches(pattern: string, file: string): boolean {
  if (!pattern.includes('*')) {
    return file === pattern || file.startsWith(`${pattern.replace(/\/$/u, '')}/`)
  }
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*\//gu, '(?:.*/)?')
    .replace(/\*\*/gu, '.*')
    .replace(/\*/gu, '[^/]*')
  return new RegExp(`^${source}$`, 'u').test(file)
}

describe('published manifest', () => {
  it('exports every shipped patch and no absent source tree', async () => {
    const value = await manifest()
    for (const patch of ['cordis.patch.yml', 'api.patch.yml', 'web.patch.yml', 'team.patch.yml', 'telemetry.patch.yml']) {
      expect(value.exports?.[`./${patch}`]).toBe(`./${patch}`)
      await expect(stat(new URL(`../${patch}`, import.meta.url))).resolves.toBeTruthy()
    }
    expect(value.exports?.['./src/*']).toBeUndefined()
  })

  it('covers every public runtime declaration target with the published file list', async () => {
    const value = await manifest()
    const files = value.files ?? []
    for (const target of exportTargets(value)) {
      const file = target.replace(/^\.\//u, '')
      if (file === 'package.json') continue
      expect(files.some(pattern => filesPatternMatches(pattern, file)), `${file} is not covered by files`).toBe(true)
    }
    // Every reachable root chunk is shipped; prepack rejects stale chunks before packing.
    expect(files).toContain('lib/*.js')
    expect(files).toContain('skills')
  })

  it('declares public host peers for every shipped declaration and runtime service', async () => {
    const value = await manifest()
    const declarationHosts = [
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-subprocess',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-host-webserver',
    ]
    for (const name of declarationHosts) {
      expect(value.devDependencies?.[name]).toBe('workspace:*')
      expect(value.peerDependencies?.[name]).toBe('workspace:*')
      expect(value.dependencies?.[name]).toBeUndefined()
    }
    expect(value.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe('workspace:*')
    expect(value.devDependencies?.['@deepseek-ai/dsh-tools']).toBe('workspace:*')
    expect(value.engines?.node).toBe('^22.19.0 || >=24.0.0')
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    for (const name of declarationHosts) expect(readme).toContain(name)
    expect(readme).toContain('skipLibCheck: false')
    expect(readme).toContain('peer dependencies')
  })

  it('exposes an explicit clean step and refuses stale chunks at pack time', async () => {
    const value = await manifest()
    expect(value.scripts?.prepack).toBe('node scripts/pack-clean.mjs --check')
    expect(value.scripts?.['pack:clean']).toBe('node scripts/pack-clean.mjs')
    expect(value.scripts?.['pack:check']).toBe('node scripts/pack-clean.mjs --check')
  })

  it('keeps the packaged skill generated and neutral', async () => {
    const packaged = await readFile(new URL('../skills/DeepCluster/SKILL.md', import.meta.url), 'utf8')
    expect(packaged).toBe(skillMarkdown(resolveOptions(), 'custom'))
    expect(packaged).not.toMatch(/Codex|Cursor|relaunch\.ps1/u)
  })

  it('renders the saved connection and single-request workflow into the generated skill', () => {
    const worker = 'C:\\tools\\worker-wrapper.exe'
    const service = 'C:\\tools\\dsh.exe'
    const text = skillMarkdown(resolveOptions({ cliPath: worker, serviceCliPath: service }), 'custom')
    expect(text).toContain(`cliPath: ${worker}`)
    expect(text).toContain(`serviceCliPath: ${service}`)
    expect(text).toContain('service start')
    expect(text).toContain('view=report')
    expect(text).toContain('## Plan format')
    expect(text).toContain('## Review the report')
  })
})

describe('clean pack staging', () => {
  async function fixture(): Promise<string> {
    const root = await scratch()
    await mkdir(path.join(root, 'lib', 'types'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture-package',
      version: '1.0.0',
      main: 'lib/index.js',
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './api': { default: './lib/api.js' },
      },
      files: ['lib/index.js', 'lib/api.js', 'lib/plan-*.js', 'lib/install-*.js', 'lib/types/**/*.d.ts'],
    }))
    await writeFile(path.join(root, 'lib', 'index.js'), 'import { plan } from "./plan-current.js"\nexport { plan }\n')
    await writeFile(path.join(root, 'lib', 'api.js'), 'export { install } from "./install-current.js"\n')
    await writeFile(path.join(root, 'lib', 'plan-current.js'), 'export const plan = 1\n')
    await writeFile(path.join(root, 'lib', 'install-current.js'), 'export const install = 1\n')
    await writeFile(path.join(root, 'lib', 'install-stale1.js'), 'export const stale = 1\n')
    await writeFile(path.join(root, 'lib', 'web-stale2.js'), 'export const stale = 2\n')
    await writeFile(path.join(root, 'lib', 'types', 'index.d.ts'), 'export {}\n')
    return root
  }

  async function run(root: string, ...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const result = await exec(process.execPath, [
        fileURLToPath(new URL('../scripts/pack-clean.mjs', import.meta.url)),
        '--root', root, ...args,
      ])
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
  }

  it('reports unreachable chunks without deleting them', async () => {
    const root = await fixture()
    const result = await run(root, '--check')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('lib/install-stale1.js')
    expect(result.stderr).toContain('lib/web-stale2.js')
    expect(result.stderr).not.toContain('plan-current.js')
    await expect(stat(path.join(root, 'lib', 'install-stale1.js'))).resolves.toBeTruthy()
  })

  it('prunes only unreachable root chunks and keeps entries, reachable chunks, and types', async () => {
    const root = await fixture()
    expect((await run(root)).code).toBe(0)
    await expect(stat(path.join(root, 'lib', 'install-stale1.js'))).rejects.toThrow()
    await expect(stat(path.join(root, 'lib', 'web-stale2.js'))).rejects.toThrow()
    for (const file of ['index.js', 'api.js', 'plan-current.js', 'install-current.js']) {
      await expect(stat(path.join(root, 'lib', file))).resolves.toBeTruthy()
    }
    await expect(stat(path.join(root, 'lib', 'types', 'index.d.ts'))).resolves.toBeTruthy()
    expect((await run(root, '--check')).code).toBe(0)
  })

  it('fails instead of pruning everything when a declared entry is missing', async () => {
    const root = await fixture()
    await rm(path.join(root, 'lib', 'index.js'))
    const result = await run(root, '--check')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('declared entry lib/index.js is missing')
  })
})

describe('portable documentation', () => {
  async function read(relative: string): Promise<string> {
    return await readFile(new URL(`../${relative}`, import.meta.url), 'utf8')
  }

  it('has no machine-specific checkout path or Codex-only setup route', async () => {
    const docs = ['design.md', 'design.zh.md'].map(name => `docs/${name}`)
    for (const file of ['README.md', 'README.zh.md', 'AGENTS.md', ...docs, 'skills/DeepCluster/SKILL.md']) {
      expect(await read(file), `${file} must not hardcode this checkout`).not.toContain(process.cwd().replaceAll('\\', '/'))
    }
    const readme = await read('README.md')
    expect(readme).toContain('--skills-root')
    expect(readme).toContain('--label')
    expect(readme).toContain('--service-cli')
    expect(readme).toContain('serviceCliPath')
    expect(readme).toContain('Windows only')
    expect(readme).toContain('tarball')
    expect(readme).not.toMatch(/install --planner codex --command-name/u)
  })

  it('documents the single-request plan and review workflow in the shipped skill and the Chinese README', async () => {
    const skill = await read('skills/DeepCluster/SKILL.md')
    expect(skill).toContain('## Ensure the service')
    expect(skill).toContain('service start')
    expect(skill).toContain('view=report')
    expect(skill).toContain('## Plan format')
    expect(skill).toContain('## Review the report')
    expect(skill).toContain('POST <apiEndpoint>/v1/ack')
    const chinese = await read('README.zh.md')
    expect(chinese).toContain('--skills-root')
    expect(chinese).toContain('--service-cli')
    expect(chinese).not.toContain('Codex 工作流')
  })
})
