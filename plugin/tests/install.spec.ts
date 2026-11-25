/** Planner skill installation, generic targets, and saved-connection preservation. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOptions, skillMarkdown } from '../src/assets.ts'
import { loadConfig, saveConfig } from '../src/config.ts'
import {
  describeTargets,
  installConfiguredPlannerAssets,
  installPlannerAssets,
} from '../src/install.ts'
import type { DeepClusterOptions } from '../src/types.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-install-'))
  temporary.push(dir)
  return dir
}

function optionsIn(root: string, overrides: Partial<DeepClusterOptions> = {}): DeepClusterOptions {
  return {
    ...resolveOptions(),
    cursorSkillsRoot: path.join(root, 'cursor'),
    codexSkillsRoot: path.join(root, 'codex'),
    ...overrides,
  }
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown)
  if (match?.[1] === undefined) throw new Error('skill markdown has no YAML frontmatter')
  return load(match[1]) as Record<string, unknown>
}

describe('generic harness installation', () => {
  it('writes exactly <root>/<commandName>/SKILL.md and creates no preset directory', async () => {
    const root = await scratch()
    const skillsRoot = path.join(root, 'harness-skills')
    const options = optionsIn(root, { skillsRoot })
    const report = await installPlannerAssets(options)
    expect(report.written).toEqual([path.join(skillsRoot, 'DeepCluster', 'SKILL.md')])
    expect(report.unchanged).toEqual([])
    await expect(stat(path.join(root, 'cursor'))).rejects.toThrow()
    await expect(stat(path.join(root, 'codex'))).rejects.toThrow()
  })

  it('is idempotent and reports the unchanged generic file', async () => {
    const root = await scratch()
    const options = optionsIn(root, { skillsRoot: path.join(root, 'skills'), serviceCliPath: path.join(root, 'dsh.exe') })
    await installPlannerAssets(options)
    expect(await installPlannerAssets(options)).toEqual({
      written: [],
      unchanged: [path.join(root, 'skills', 'DeepCluster', 'SKILL.md')],
    })
  })

  it('treats every "(not configured ...)" marker as absent when reinstalling', async () => {
    const root = await scratch()
    const options = optionsIn(root, { skillsRoot: path.join(root, 'skills') })
    await installPlannerAssets(options)
    expect(await installPlannerAssets(options)).toEqual({
      written: [],
      unchanged: [path.join(root, 'skills', 'DeepCluster', 'SKILL.md')],
    })
  })

  it('rejects a generic install without an absolute skills root', async () => {
    const root = await scratch()
    await expect(installPlannerAssets(optionsIn(root), ['custom'])).rejects.toThrow(/skillsRoot/u)
    expect(() => resolveOptions({ skillsRoot: 'relative/skills' })).toThrow(/absolute path/u)
  })

  it('describes presets and adds the generic row only when configured', async () => {
    const root = await scratch()
    expect(describeTargets(optionsIn(root)).map(target => target.planner)).toEqual(['cursor', 'codex'])
    const generic = describeTargets(optionsIn(root, { skillsRoot: path.join(root, 'anywhere') }))
    expect(generic.map(target => target.planner)).toEqual(['cursor', 'codex', 'custom'])
    expect(generic.at(-1)).toEqual({
      planner: 'custom',
      file: path.join(root, 'anywhere', 'DeepCluster', 'SKILL.md'),
      label: 'this harness',
    })
  })

  it('uses the configured label and rejects labels that would break the skill line', async () => {
    const root = await scratch()
    const labelled = optionsIn(root, { skillsRoot: path.join(root, 'skills'), skillLabel: 'Acme Harness' })
    expect(skillMarkdown(labelled, 'custom')).toContain('Installed for Acme Harness.')
    expect(() => resolveOptions({ skillLabel: '   ' })).toThrow(/skillLabel must not be blank/u)
    expect(() => resolveOptions({ skillLabel: 'two\nlines' })).toThrow(/single line/u)
  })
})

describe('neutral generated text', () => {
  it('contains no Codex or Cursor wording and no unshipped helper', () => {
    const text = skillMarkdown(resolveOptions(), 'custom')
    expect(text).not.toMatch(/Codex|Cursor|relaunch\.ps1/u)
    expect(text).toContain('## Ensure the service')
    expect(text).toContain('service start')
    expect(text).toContain('without credentials')
    expect(text).toContain('## Plan format')
    expect(text).toContain('access: write')
    expect(text).toContain('## Review the report')
    expect(text).toContain('view=report')
    expect(text).toContain('POST <apiEndpoint>/v1/ack')
    expect(text).toContain('## Saved connection')
  })

  it('keeps preset shortcut output distinct from the generic target', () => {
    const options = resolveOptions()
    expect(skillMarkdown(options, 'codex')).toContain('Installed for Codex.')
    expect(skillMarkdown(options, 'cursor')).toContain('Installed for Cursor.')
    expect(skillMarkdown(options, 'custom')).not.toMatch(/Codex|Cursor/u)
  })

  it('renders the foreground profile and quotes the Windows managed launcher for PowerShell', () => {
    const text = skillMarkdown(resolveOptions({ serviceCliPath: "C:/Pat's DSH/dsh.exe", apiEndpoint: 'http://127.0.0.1:4789' }), 'custom')
    expect(text).toContain('node apps/cli/lib/bin.js --profile deep-cluster --patch "$PWD/packages/experimental/deep-cluster/api.patch.yml"')
    expect(text).toContain('export DEEPCLUSTER_API_PORT="${DEEPCLUSTER_API_PORT:-4789}"')
    expect(text).toContain("if (!$env:DEEPCLUSTER_API_PORT) { $env:DEEPCLUSTER_API_PORT = '4789' }")
    expect(text).toContain("& 'C:/Pat''s DSH/dsh.exe' --profile deep-cluster service start")
  })
})

describe('frontmatter', () => {
  it.each(['123', 'yes', 'no', 'on', 'off', 'null', 'true', 'false'])(
    'emits a quoted YAML string for command name %s',
    (commandName) => {
      const markdown = skillMarkdown(resolveOptions({ commandName }), 'custom')
      expect(parseFrontmatter(markdown).name).toBe(commandName)
    },
  )
})

describe('saved connection preservation', () => {
  it('recovers skill-only values and persists the same merged settings', async () => {
    const root = await scratch()
    const saved = resolveOptions({
      apiEndpoint: 'http://127.0.0.1:4999',
      dshPath: root,
      serviceCliPath: path.join(root, 'dsh.exe'),
      dashboardWorkspace: path.join(root, 'saved-workspace'),
      dashboardWorkspaces: [path.join(root, 'saved-extra')],
    })
    const codexFile = path.join(root, 'codex', 'DeepCluster', 'SKILL.md')
    await mkdir(path.dirname(codexFile), { recursive: true })
    await writeFile(codexFile, skillMarkdown(saved, 'codex'))
    const configFile = path.join(root, '.deep-cluster', 'config.json')
    const options = optionsIn(root)
    const report = await installConfiguredPlannerAssets(options, undefined, configFile)

    expect([...report.written, ...report.unchanged]).toHaveLength(2)
    expect(report.unchanged).toEqual([codexFile])
    const persisted = loadConfig(configFile)
    expect(persisted).toMatchObject({
      apiEndpoint: 'http://127.0.0.1:4999',
      dshPath: root,
      dashboardWorkspace: path.join(root, 'saved-workspace'),
      dashboardWorkspaces: [path.join(root, 'saved-extra')],
    })
    for (const target of describeTargets(options)) {
      const text = await readFile(target.file, 'utf8')
      expect(text).toContain('apiEndpoint: http://127.0.0.1:4999')
    }
  })

  it('carries the connection to a new target and persists it there', async () => {
    const root = await scratch()
    const saved = resolveOptions({
      apiEndpoint: 'http://127.0.0.1:4888',
      dshPath: root,
      dashboardWorkspace: path.join(root, 'dashboard-root'),
    })
    const codexFile = path.join(root, 'codex', 'DeepCluster', 'SKILL.md')
    await mkdir(path.dirname(codexFile), { recursive: true })
    await writeFile(codexFile, skillMarkdown(saved, 'codex'))

    const skillsRoot = path.join(root, 'other-harness')
    const configFile = path.join(root, '.deep-cluster', 'config.json')
    await installConfiguredPlannerAssets(optionsIn(root, { skillsRoot }), ['custom'], configFile)

    const generic = await readFile(path.join(skillsRoot, 'DeepCluster', 'SKILL.md'), 'utf8')
    expect(generic).toContain('Installed for this harness.')
    expect(generic).toContain('apiEndpoint: http://127.0.0.1:4888')
    expect(generic).toContain(`dashboardWorkspace: ${path.join(root, 'dashboard-root')}`)
    expect(loadConfig(configFile)).toMatchObject({
      apiEndpoint: 'http://127.0.0.1:4888',
      dashboardWorkspace: path.join(root, 'dashboard-root'),
    })
  })

  it('recovers a skill-only dashboard endpoint when the saved generic root changes', async () => {
    const root = await scratch()
    const skillsA = path.join(root, 'skills-a')
    const skillsB = path.join(root, 'skills-b')
    const configFile = path.join(root, '.deep-cluster', 'config.json')
    await installConfiguredPlannerAssets(
      optionsIn(root, { skillsRoot: skillsA, dashboardEndpoint: 'http://127.0.0.1:4799' }),
      ['custom'],
      configFile,
    )
    const saved = loadConfig(configFile)
    delete saved.dashboardEndpoint
    saveConfig(saved, configFile)
    const previousTargets = describeTargets(resolveOptions(saved))

    await installConfiguredPlannerAssets(
      optionsIn(root, { ...saved, skillsRoot: skillsB }),
      ['custom'],
      configFile,
      previousTargets,
    )

    const generic = await readFile(path.join(skillsB, 'DeepCluster', 'SKILL.md'), 'utf8')
    expect(generic).toContain('dashboardEndpoint: http://127.0.0.1:4799')
    expect(loadConfig(configFile).dashboardEndpoint).toBe('http://127.0.0.1:4799')
  })

  it('saves separate worker and service CLI paths and preserves both on reinstall', async () => {
    const root = await scratch()
    const worker = path.join(root, 'tools', 'worker-wrapper.exe')
    const service = path.join(root, 'apps', 'cli', 'lib', 'bin.js')
    const skillsA = path.join(root, 'skills-a')
    const skillsB = path.join(root, 'skills-b')
    const configFile = path.join(root, '.deep-cluster', 'config.json')
    await installConfiguredPlannerAssets(
      optionsIn(root, { skillsRoot: skillsA, cliPath: worker, serviceCliPath: service }),
      ['custom'],
      configFile,
    )
    expect(loadConfig(configFile)).toMatchObject({ cliPath: worker, serviceCliPath: service })
    const first = await readFile(path.join(skillsA, 'DeepCluster', 'SKILL.md'), 'utf8')
    expect(first).toContain(`cliPath: ${worker}`)
    expect(first).toContain(`serviceCliPath: ${service}`)
    expect(first).toContain('service start')

    const saved = loadConfig(configFile)
    await installConfiguredPlannerAssets(optionsIn(root, { ...saved, skillsRoot: skillsB }), ['custom'], configFile)
    expect(loadConfig(configFile)).toMatchObject({ cliPath: worker, serviceCliPath: service })
    expect(await readFile(path.join(skillsB, 'DeepCluster', 'SKILL.md'), 'utf8')).toContain(`serviceCliPath: ${service}`)

    const withoutService = { ...saved }
    delete withoutService.serviceCliPath
    saveConfig(withoutService, configFile)
    const skillsC = path.join(root, 'skills-c')
    await installConfiguredPlannerAssets(
      optionsIn(root, { ...withoutService, skillsRoot: skillsC }),
      ['custom'],
      configFile,
      describeTargets(resolveOptions(saved)),
    )
    expect(loadConfig(configFile).serviceCliPath).toBe(service)
    expect(await readFile(path.join(skillsC, 'DeepCluster', 'SKILL.md'), 'utf8')).toContain(`serviceCliPath: ${service}`)
  })

  it('keeps an explicit caller value over a saved skill value', async () => {
    const root = await scratch()
    const saved = resolveOptions({ apiEndpoint: 'http://127.0.0.1:4111' })
    const codexFile = path.join(root, 'codex', 'DeepCluster', 'SKILL.md')
    await mkdir(path.dirname(codexFile), { recursive: true })
    await writeFile(codexFile, skillMarkdown(saved, 'codex'))
    const configFile = path.join(root, '.deep-cluster', 'config.json')
    await installConfiguredPlannerAssets(
      optionsIn(root, { apiEndpoint: 'http://127.0.0.1:4222' }),
      ['cursor'],
      configFile,
    )
    const cursor = await readFile(path.join(root, 'cursor', 'DeepCluster', 'SKILL.md'), 'utf8')
    expect(cursor).toContain('apiEndpoint: http://127.0.0.1:4222')
    expect(loadConfig(configFile).apiEndpoint).toBe('http://127.0.0.1:4222')
  })
})
