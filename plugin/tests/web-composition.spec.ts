/** The service dashboard overlay composes once on saved and clean web profiles. */
import { readFile } from 'node:fs/promises'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const BARE = '@deepseek-ai/dsh-experimental-deep-cluster'
const WEB = '@deepseek-ai/dsh-experimental-deep-cluster/web'
const COMMAND = '@deepseek-ai/dsh-experimental-deep-cluster/command'
const SUBPROCESS = '@deepseek-ai/dsh-subprocess-local'

/** Load the shipped overlay through the same YAML dialect the Loader uses. */
async function overlay(): Promise<PatchOptions[]> {
  const text = await readFile(new URL('../web.patch.yml', import.meta.url), 'utf8')
  const parsed = load(text, { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error('web.patch.yml must be an entry patch list')
  return parsed as PatchOptions[]
}

function compose(base: EntryOptions[], patches: PatchOptions[]): { rows: EntryOptions[]; warnings: string[] } {
  const warnings: string[] = []
  // The !!js expressions stay unconsumed here; composition order, ids and disabled state are the behavior under test.
  const rows = applyEntryPatches(base, patches, (message: string) => { warnings.push(message) })
  return { rows, warnings }
}

function active(rows: EntryOptions[], name: string): EntryOptions[] {
  return rows.filter(row => row.disabled !== true && row.name === name)
}

it('composes exactly one active bare client row and dashboard row on the saved web profile', async () => {
  const patches = await overlay()
  const saved: EntryOptions[] = [
    { id: 'subprocess', name: SUBPROCESS },
    { id: 'deep-cluster-subprocess', name: SUBPROCESS },
    { id: 'deep-cluster', name: BARE },
    { id: 'deep-cluster-command', name: COMMAND },
    { id: 'deep-cluster-dashboard', name: WEB, config: { workspace: 'D:/saved-profile-root' } },
  ]
  const { rows, warnings } = compose(saved, patches)
  expect(active(rows, BARE)).toHaveLength(1)
  expect(active(rows, WEB)).toHaveLength(1)
  expect(active(rows, COMMAND)).toHaveLength(0)
  expect(rows.filter(row => row.id === 'deep-cluster-subprocess' && row.disabled !== true)).toHaveLength(0)
  expect(warnings).toEqual([])
  const dashboardConfig = JSON.stringify(active(rows, WEB)[0]?.config)
  // The service row, not the saved profile row, owns the deployment roots.
  expect(dashboardConfig).toContain('process.env.DEEPCLUSTER_WORKSPACE ?? process.env.DEEPCLUSTER_DASHBOARD_WORKSPACE ?? process.cwd()')
  expect(dashboardConfig).toContain("JSON.parse(process.env.DEEPCLUSTER_WORKSPACES ?? '[]')")
  expect(dashboardConfig).not.toContain('D:/saved-profile-root')
})

it('composes the same single client and dashboard rows on a clean web profile', async () => {
  const patches = await overlay()
  const clean: EntryOptions[] = [{ id: 'subprocess', name: SUBPROCESS }]
  const { rows, warnings } = compose(clean, patches)
  expect(active(rows, BARE)).toHaveLength(1)
  expect(active(rows, WEB)).toHaveLength(1)
  expect(active(rows, COMMAND)).toHaveLength(0)
  // The saved-row disables warn-and-skip on a profile that never had them; that is not a composition failure.
  expect(warnings).toHaveLength(4)
  expect(warnings.every(message => message.includes('not found'))).toBe(true)
})
