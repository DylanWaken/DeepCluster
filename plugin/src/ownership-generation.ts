/** Canonical generation tags and atomic resource-record publication. */
import { randomUUID } from 'node:crypto'
import { link, rename, unlink, writeFile } from 'node:fs/promises'
import type { OwnershipGeneration } from './types.ts'

/**
 * Recognize the UUID stored on generation-owned records.
 * @param value - untrusted persisted generation field.
 * @returns whether the value is a canonical generation identifier.
 */
export function isOwnershipGeneration(value: unknown): value is OwnershipGeneration {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

/**
 * Read the exact generation tag on an interrupted resource publication.
 * @param name - basename of a producer-owned staging file.
 * @returns its generation when the entire UUID suffix is canonical.
 */
export function preparedOwnershipGeneration(name: string): OwnershipGeneration | undefined {
  const match = /\.generation-([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/u.exec(name)
  return match !== null && isOwnershipGeneration(match[1]) && isOwnershipGeneration(match[2]) ? match[1] : undefined
}

/**
 * Publish complete resource JSON; interrupted staging files retain their generation tag.
 * @param file - final resource record path.
 * @param record - ownership fields to serialize.
 * @param generation - API generation whose receipts permit recovery.
 * @param replace - replace an existing token-checked record during renewal.
 * @returns after publication and removal of the temporary link.
 */
export async function publishOwnershipRecord(file: string, record: object,
  generation?: OwnershipGeneration, replace = false): Promise<void> {
  const temporary = `${file}${generation === undefined ? '' : `.generation-${generation}`}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx' })
  try {
    if (replace) await rename(temporary, file)
    else await link(temporary, file)
  } finally {
    try {
      await unlink(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
