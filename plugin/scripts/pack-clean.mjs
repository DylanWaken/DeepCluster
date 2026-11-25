#!/usr/bin/env node
/**
 * Prune build chunks that no published entry can reach before `npm pack`.
 *
 * The build emits every bundle beside the previous ones (`clean: false`), so a
 * stale `install-<hash>.js` or `web-<hash>.js` would otherwise match the
 * manifest `lib/*.js` globs and enter a later distribution. This script walks
 * the relative JavaScript imports of every manifest runtime entry, keeps that
 * closure, and removes only root-level `lib/*.js` files outside it. `lib/types`
 * is never touched, and `--check` reports without mutating.
 */

import { readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root that owns `lib/` and `package.json`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Runtime JavaScript entries declared by a package manifest.
 * @param {Record<string, unknown>} manifest parsed `package.json`
 * @returns {Set<string>} `/`-separated package-relative entry paths
 */
export function exportedEntries(manifest) {
  const entries = new Set()
  const visit = (value) => {
    if (typeof value === 'string') {
      if (/^\.\/lib\/[^/]+\.js$/u.test(value)) entries.add(value.slice(2))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(manifest.exports)
  if (typeof manifest.main === 'string' && manifest.main.endsWith('.js')) entries.add(manifest.main)
  return entries
}

/**
 * Keep the relative JavaScript import closure of the published entries.
 * @param {string} root package root
 * @param {ReadonlySet<string>} entries package-relative entry paths
 * @returns {Promise<Set<string>>} package-relative reachable JavaScript files
 */
export async function reachableChunks(root, entries) {
  if (entries.size === 0) throw new Error('pack-clean: package.json declares no runtime entry')
  const reachable = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const relative = queue.pop()
    if (!relative.startsWith('lib/') || reachable.has(relative)) continue
    let source
    try {
      source = await readFile(path.join(root, relative), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`pack-clean: declared entry ${relative} is missing; build before packing`)
      throw error
    }
    reachable.add(relative)
    for (const match of source.matchAll(/["'](\.{1,2}\/[^"']*\.js)["']/gu)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
      if (resolved.startsWith('lib/') && !reachable.has(resolved)) queue.push(resolved)
    }
  }
  return reachable
}

/**
 * Find root-level `lib/*.js` files outside the entry closure.
 * @param {string} root package root
 * @returns {Promise<{ reachable: Set<string>, stale: string[] }>} sorted findings
 */
export async function analyze(root = PACKAGE_ROOT) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const reachable = await reachableChunks(root, exportedEntries(manifest))
  const lib = path.join(root, 'lib')
  const files = await readdir(lib, { withFileTypes: true }).then(
    entries => entries.filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => `lib/${entry.name}`),
    () => [],
  )
  return { reachable, stale: files.filter(file => !reachable.has(file)).sort() }
}

/**
 * Apply or check the clean-pack procedure.
 * @param {readonly string[]} argv command-line arguments
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root')
  const root = rootIndex === -1 ? PACKAGE_ROOT : path.resolve(argv[rootIndex + 1] ?? '')
  const check = argv.includes('--check')
  const { reachable, stale } = await analyze(root)
  if (stale.length === 0) {
    console.log(`pack-clean: ${String(reachable.size)} reachable chunk(s); no stale chunks`)
    return 0
  }
  if (check) {
    console.error(`pack-clean: ${String(stale.length)} stale chunk(s) unreachable from the published entries:`)
    for (const file of stale) console.error(`  ${file}`)
    console.error('pack-clean: run `pnpm --filter @deepseek-ai/dsh-experimental-deep-cluster pack:clean` before packing')
    return 1
  }
  for (const file of stale) await unlink(path.join(root, file))
  console.log(`pack-clean: removed ${String(stale.length)} stale chunk(s); kept ${String(reachable.size)} reachable`)
  return 0
}

if (import.meta.main) process.exitCode = await main()
