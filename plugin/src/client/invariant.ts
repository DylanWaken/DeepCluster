/** Typed assertions for values the surrounding control flow already establishes; a failure names the violated invariant. */

/**
 * Read an array element the caller's loop bound or index arithmetic establishes.
 * @param values - sequence whose length bounds `index` by construction.
 * @param index - zero-based position the caller derived inside `values`.
 * @returns the element at `index`.
 * @throws {Error} when `index` is outside `values`, so the caller's bound is wrong.
 */
export function elementAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error(`required element ${String(index)} is outside a sequence of ${String(values.length)}`)
  return value
}

/**
 * Read a map entry the caller's construction establishes.
 * @param values - map the caller populated before every read.
 * @param key - key the caller established.
 * @returns the associated value.
 * @throws {Error} when `key` is absent, so the caller's construction is incomplete.
 */
export function entryOf<K, V>(values: ReadonlyMap<K, V>, key: K): V {
  const value = values.get(key)
  if (value === undefined) throw new Error(`required map entry ${String(key)} is missing`)
  return value
}

/**
 * Return a value the caller establishes is present.
 * @param value - possibly absent value.
 * @param what - invariant named in the failure message.
 * @returns the present value.
 * @throws {Error} when `value` is `null` or `undefined`.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`required ${what} is missing`)
  return value
}
