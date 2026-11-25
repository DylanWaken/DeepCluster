/** Idempotent installation of the /DeepCluster planner workflow. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { skillMarkdown, skillTargetLabel } from './assets.ts'
import { configPath, saveConfig } from './config.ts'
import type {
  DeepClusterOptions,
  InstallReport,
  InstallTarget,
  InstallTargetId,
} from './types.ts'

/** Saved connection fields recovered from an installed skill. */
type SavedConnection = Pick<DeepClusterOptions,
  'apiEndpoint' | 'dashboardEndpoint' | 'dshPath' | 'serviceCliPath' | 'dashboardWorkspace' | 'dashboardWorkspaces'>

/** Preset ids installed when no generic root or explicit target list is configured. */
const PRESET_TARGETS: readonly InstallTargetId[] = ['cursor', 'codex']

/** Absolute `SKILL.md` path for one target. */
function skillPath(options: DeepClusterOptions, target: InstallTargetId): string {
  if (target === 'custom') {
    if (options.skillsRoot === undefined) {
      throw new Error('DeepCluster generic install requires an absolute skillsRoot')
    }
    return path.join(options.skillsRoot, options.commandName, 'SKILL.md')
  }
  const root = target === 'cursor' ? options.cursorSkillsRoot : options.codexSkillsRoot
  return path.join(root, options.commandName, 'SKILL.md')
}

/** Describe one install destination without touching disk. */
function describeTarget(options: DeepClusterOptions, target: InstallTargetId): InstallTarget {
  return { planner: target, file: skillPath(options, target), label: skillTargetLabel(options, target) }
}

/** Read a text file, treating absence as empty. */
async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Recover saved connection values from an installed skill so regeneration does not
 * discard a user-edited connection that is not yet in the saved configuration.
 * @param markdown - existing skill text, or null when the file is absent.
 * @returns only the saved values that are present and configured.
 */
function savedConnection(markdown: string | null): SavedConnection {
  if (markdown === null) return {}
  const field = (name: string): string | undefined => {
    const value = new RegExp(`^${name}:\\s*(.+)$`, 'mu').exec(markdown)?.[1]?.trim()
    return value === undefined || value === '' || value.startsWith('(not configured') ? undefined : value
  }
  const apiEndpoint = field('apiEndpoint')
  const dashboardEndpoint = field('dashboardEndpoint')
  const dshPath = field('dshPath')
  const serviceCliPath = field('serviceCliPath')
  const dashboardWorkspace = field('dashboardWorkspace')
  const serializedWorkspaces = field('dashboardWorkspaces')
  let dashboardWorkspaces: readonly string[] | undefined
  if (serializedWorkspaces !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(serializedWorkspaces)
    } catch {
      parsed = undefined
    }
    if (Array.isArray(parsed) && parsed.every(root => typeof root === 'string')) dashboardWorkspaces = parsed
  }
  return {
    ...apiEndpoint === undefined ? {} : { apiEndpoint },
    ...dashboardEndpoint === undefined ? {} : { dashboardEndpoint },
    ...dshPath === undefined ? {} : { dshPath },
    ...serviceCliPath === undefined ? {} : { serviceCliPath },
    ...dashboardWorkspace === undefined ? {} : { dashboardWorkspace },
    ...dashboardWorkspaces === undefined ? {} : { dashboardWorkspaces },
  }
}

/**
 * Fill connection values the caller did not configure from an installed skill.
 * Explicit settings always win; the merge itself does not touch disk.
 * @param options - resolved settings and explicit overrides.
 * @param markdown - existing skill text, or null when the file is absent.
 * @returns settings with absent connection fields recovered from the skill.
 */
export function preserveConnection(options: DeepClusterOptions, markdown: string | null): DeepClusterOptions {
  const saved = savedConnection(markdown)
  return {
    ...options,
    ...options.apiEndpoint === undefined && saved.apiEndpoint !== undefined ? { apiEndpoint: saved.apiEndpoint } : {},
    ...options.dashboardEndpoint === undefined && saved.dashboardEndpoint !== undefined
      ? { dashboardEndpoint: saved.dashboardEndpoint } : {},
    ...options.dshPath === undefined && saved.dshPath !== undefined ? { dshPath: saved.dshPath } : {},
    ...options.serviceCliPath === undefined && saved.serviceCliPath !== undefined
      ? { serviceCliPath: saved.serviceCliPath } : {},
    ...options.dashboardWorkspace === undefined && saved.dashboardWorkspace !== undefined
      ? { dashboardWorkspace: saved.dashboardWorkspace } : {},
    ...options.dashboardWorkspaces === undefined && saved.dashboardWorkspaces !== undefined
      ? { dashboardWorkspaces: saved.dashboardWorkspaces } : {},
  }
}

/**
 * Recover connection values from every known installed skill so a target change
 * inherits the previous connection. Earlier targets in describe order win.
 * @param options - resolved settings and explicit overrides.
 * @param targets - destinations to read; defaults to every described target.
 * @returns settings merged with skill-only saved values.
 */
export async function recoverInstalledConnection(
  options: DeepClusterOptions,
  targets: readonly InstallTarget[] = describeTargets(options),
): Promise<DeepClusterOptions> {
  let merged = options
  for (const target of targets) {
    merged = preserveConnection(merged, await readIfPresent(target.file))
  }
  return merged
}

/**
 * Write `content` only when it differs from what is already on disk.
 * @returns `'written'` or `'unchanged'`.
 */
async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  try {
    const existing = await readFile(file, 'utf8')
    if (existing === content) return 'unchanged'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return 'written'
}

/**
 * Install the `/DeepCluster` skill into the selected targets.
 * @param options - resolved settings; roots decide where files land.
 * @param targets - preset or generic destinations; defaults to the generic target when `skillsRoot` is set, otherwise both presets.
 * @returns the files written and the files already correct.
 */
export async function installPlannerAssets(
  options: DeepClusterOptions,
  targets?: readonly InstallTargetId[],
): Promise<InstallReport> {
  const ids: readonly InstallTargetId[] = targets
    ?? (options.skillsRoot === undefined ? PRESET_TARGETS : ['custom'])
  const selected = ids.map(target => describeTarget(options, target))
  const merged = await recoverInstalledConnection(options)
  const written: string[] = []
  const unchanged: string[] = []
  for (const target of selected) {
    const existing = await readIfPresent(target.file)
    const status = await writeIfChanged(target.file, skillMarkdown(preserveConnection(merged, existing), target))
    if (status === 'written') written.push(target.file)
    else unchanged.push(target.file)
  }
  return { written, unchanged }
}

/**
 * Install planner assets and persist the merged connection used to render them.
 * @param options - resolved settings and explicit overrides.
 * @param targets - preset or generic destinations; omitted uses the configured defaults.
 * @param file - configuration path override for isolated tests.
 * @param previousTargets - destinations saved before a target override, read to carry skill-only connection values.
 * @returns the files written and the files already correct.
 */
export async function installConfiguredPlannerAssets(
  options: DeepClusterOptions,
  targets?: readonly InstallTargetId[],
  file = configPath(),
  previousTargets: readonly InstallTarget[] = [],
): Promise<InstallReport> {
  const described = [...previousTargets, ...describeTargets(options)]
  const unique = new Map(described.map(target => [target.file, target]))
  const merged = await recoverInstalledConnection(options, [...unique.values()])
  const report = await installPlannerAssets(merged, targets)
  saveConfig(merged, file)
  return report
}

/**
 * Report every available skill destination without touching disk.
 * @param options - resolved settings.
 * @returns preset rows plus the generic row when `skillsRoot` is configured.
 */
export function describeTargets(options: DeepClusterOptions): InstallTarget[] {
  return [
    describeTarget(options, 'cursor'),
    describeTarget(options, 'codex'),
    ...options.skillsRoot === undefined ? [] : [describeTarget(options, 'custom')],
  ]
}
