/** Saved DeepCluster settings; explicit overrides take precedence and invalid files fail loading. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveOptions } from './assets.ts'
import type { DeepClusterConfig, DeepClusterOptions } from './types.ts'

/**
 * Locate the persisted configuration below the selected home directory.
 * @param home - user home; omitted uses the platform home environment variables.
 * @returns the configuration file path.
 */
export function configPath(home = process.env.USERPROFILE ?? process.env.HOME ?? ''): string {
  return path.join(home, '.deep-cluster', 'config.json')
}

/**
 * Read the persisted configuration.
 * @param file - override for tests.
 * @returns the stored fields, or an empty object when absent; malformed or inaccessible files reject.
 */
export function loadConfig(file = configPath()): DeepClusterConfig {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('DeepCluster config must be an object')
  const result: DeepClusterConfig = {}
  const strings = ['cliPath', 'serviceCliPath', 'profile', 'commandName', 'cursorSkillsRoot', 'codexSkillsRoot', 'skillsRoot', 'skillLabel', 'apiEndpoint', 'dashboardEndpoint', 'dshPath', 'dashboardWorkspace'] as const
  const numbers = ['timeoutMs', 'maxOutputBytes', 'terminationGraceMs', 'apiRequestTimeoutMs', 'apiPollIntervalMs', 'serviceLifecycleWaitMs'] as const
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'apiTokenFile') {
      throw new Error(`DeepCluster setting apiTokenFile is retired: the API admits same-computer requests without a token. Delete it from ${file}.`)
    } else if (key === 'permissionMode') {
      if (value !== 'danger-full-access' && value !== 'workspace-write') throw new Error('Invalid DeepCluster permissionMode')
      result.permissionMode = value
    } else if (strings.some(field => field === key)) {
      if (typeof value !== 'string') throw new Error(`DeepCluster config ${key} must be a string`)
      Object.assign(result, { [key]: value })
    } else if (key === 'dashboardWorkspaces') {
      if (!Array.isArray(value) || value.some(root => typeof root !== 'string')) throw new Error('DeepCluster config dashboardWorkspaces must be an array of strings')
      result.dashboardWorkspaces = value as string[]
    } else if (numbers.some(field => field === key)) {
      if (typeof value !== 'number') throw new Error(`DeepCluster config ${key} must be a number`)
      Object.assign(result, { [key]: value })
    } else throw new Error(`Unknown DeepCluster setting: ${key}`)
  }
  return result
}

/**
 * Persist configuration.
 * @param config - fields to store.
 * @param file - override for tests.
 */
export function saveConfig(config: DeepClusterConfig, file = configPath()): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, undefined, 2)}\n`, 'utf8')
}

/**
 * Resolve settings as saved file → explicit overrides.
 * @param overrides - the caller's explicit fields; these win.
 * @param file - override for tests.
 * @returns complete settings.
 */
export function resolveConfiguredOptions(overrides: DeepClusterConfig = {}, file = configPath()): DeepClusterOptions {
  return resolveOptions({ ...loadConfig(file), ...overrides })
}
