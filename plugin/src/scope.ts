/**
 * Canonical workspace, worktree and claim-path identity for DeepCluster.
 *
 * Two coordinators may name the same directory through different case, a junction,
 * a symlink or a repository subdirectory. Every write claim and audit compares these
 * canonical identities so aliases cannot slip past the other writer. Display text keeps
 * the caller's path; only comparison keys are case-folded.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/scope
 */

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** Git locations discovered by a read-only probe. */
export interface GitLocation {
  /** Canonical repository top level; the root of every worktree. */
  readonly topLevel: string
  /** Canonical shared metadata directory, identical for every worktree of one repository. */
  readonly commonDir: string
}

/** Resolved identity of one physical worktree and the workspace inside it. */
export interface WorkspaceIdentity {
  /** Canonical absolute workspace path, used as the worker directory and journal root. */
  readonly workspace: string
  /** Comparison key for the workspace. */
  readonly workspaceKey: string
  /** Canonical physical worktree root: the Git top level, or the workspace outside Git. */
  readonly worktree: string
  /** Comparison key for the physical worktree. */
  readonly worktreeKey: string
  /** Canonical Git top level when the workspace is inside a repository. */
  readonly topLevel?: string
  /** Comparison key for the Git top level. */
  readonly topLevelKey?: string
  /** Canonical Git common directory shared by all worktrees of the repository. */
  readonly commonDir?: string
  /** Comparison key for the Git common directory. */
  readonly commonDirKey?: string
  /** `/`-separated workspace path relative to the worktree; empty at its root. */
  readonly workspacePrefix: string
}

/** A repository-relative write claim after syntactic normalization. */
export interface NormalizedClaimPath {
  /** `/`-separated path relative to the worktree; empty means the whole worktree. */
  readonly path: string
  /** True when the claim covers the path and all of its descendants. */
  readonly directory: boolean
  /** Case-folded comparison key on Windows. */
  readonly key: string
}

/** One claim target as a canonical absolute directory plus a relative path. */
export interface ClaimSpan {
  /** Canonical absolute directory the relative path is resolved against. */
  readonly root: string
  /** `/`-separated path relative to the root; empty covers the root itself. */
  readonly path: string
  /** True when the span covers the path and all of its descendants. */
  readonly directory: boolean
}

/** Raised when a declared write path is not an unambiguous repository-relative path. */
export class ClaimPathError extends Error {
  override name = 'ClaimPathError'
}

const RESERVED_SEGMENTS = new Set(['.git', '.deep-cluster'])
const GLOB_CHARACTERS = /[*?[\]{}]/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/**
 * Canonicalize an absolute path through its closest existing ancestor.
 * @param value - native absolute or relative path; relative paths resolve against the process directory.
 * @returns the real path, with missing descendants appended to their canonical parent.
 */
export async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value)
  const missing: string[] = []
  let current = resolved
  for (;;) {
    try {
      const existing = await realpath(current)
      return missing.length === 0 ? existing : path.join(existing, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Case-folded comparison key for a native absolute path.
 * @param value - path to key.
 * @returns the path without trailing separators, lowercased on Windows.
 */
export function comparisonKey(value: string): string {
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/u, '') : resolved
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Case-folded comparison key for a `/`-separated relative path.
 * @param value - repository-relative path.
 * @returns the path lowercased on Windows.
 */
export function relativeKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Whether a comparison key is the root itself or one of its descendants.
 * @param root - native comparison key of the ancestor.
 * @param target - native comparison key to test.
 * @returns true when target equals root or lies below it.
 */
export function keyWithin(root: string, target: string): boolean {
  if (root === target) return true
  const separator = process.platform === 'win32' ? '\\' : '/'
  return target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)
}

/**
 * Convert a native relative path to `/` separators.
 * @param from - native base directory.
 * @param to - native target path.
 * @returns the target relative to the base, or an empty string when equal.
 */
export function relativePosix(from: string, to: string): string {
  const relative = path.relative(from, to)
  return relative === '' ? '' : relative.split(path.sep).join('/')
}

/**
 * Resolve the canonical workspace, physical worktree and shared Git identity.
 * @param workspace - existing workspace directory; symlinks are resolved.
 * @param git - read-only Git locations from {@link module:repository}, or undefined outside Git.
 * @returns canonical identity used for claims, journals and audit comparisons.
 */
export async function resolveWorkspaceIdentity(workspace: string, git?: GitLocation): Promise<WorkspaceIdentity> {
  const canonical = await canonicalPath(workspace)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new ClaimPathError(`workspace "${workspace}" is not a directory`)
  const topLevel = git === undefined ? undefined : await canonicalPath(git.topLevel)
  const commonDir = git === undefined ? undefined : await canonicalPath(git.commonDir)
  const worktree = topLevel ?? canonical
  const worktreeKey = comparisonKey(worktree)
  if (!keyWithin(worktreeKey, comparisonKey(canonical))) {
    throw new ClaimPathError(`workspace "${workspace}" is outside its worktree "${worktree}"`)
  }
  return {
    workspace: canonical,
    workspaceKey: comparisonKey(canonical),
    worktree,
    worktreeKey,
    ...topLevel === undefined ? {} : { topLevel, topLevelKey: comparisonKey(topLevel) },
    ...commonDir === undefined ? {} : { commonDir, commonDirKey: comparisonKey(commonDir) },
    workspacePrefix: relativePosix(worktree, canonical),
  }
}

/**
 * Normalize one declared repository-relative write path.
 *
 * The initial claim language accepts literal paths only: no globs, absolute paths,
 * drive or UNC forms, `..` segments, `.git` metadata, coordinator metadata, Windows
 * device names or ambiguous trailing characters. A trailing `/` marks a directory claim.
 * @param raw - plan text for one write path.
 * @returns the normalized claim path used for cross-process overlap checks.
 */
export function normalizeClaimPath(raw: string): NormalizedClaimPath {
  const value = raw.trim()
  if (value === '') throw new ClaimPathError('a write path must not be blank')
  if (value.includes('\\')) throw new ClaimPathError(`write path "${raw}" uses a backslash; use forward slashes`)
  if (value.startsWith('/')) throw new ClaimPathError(`write path "${raw}" must be repository-relative, not absolute`)
  if (/^[A-Za-z]:/u.test(value)) throw new ClaimPathError(`write path "${raw}" must be repository-relative, not drive-qualified`)
  if (value.startsWith('//')) throw new ClaimPathError(`write path "${raw}" must not be a UNC path`)
  if (GLOB_CHARACTERS.test(value)) throw new ClaimPathError(`write path "${raw}" must be literal; glob patterns are not supported`)
  if (/[\u0000-\u001f:]/u.test(value)) throw new ClaimPathError(`write path "${raw}" contains an unsupported character`)
  const directory = value.endsWith('/')
  const body = directory ? value.slice(0, -1) : value
  if (body === '') throw new ClaimPathError(`write path "${raw}" does not name a path`)
  const segments = body.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ClaimPathError(`write path "${raw}" must not contain empty, "." or ".." segments`)
    }
    if (RESERVED_SEGMENTS.has(segment.toLowerCase())) {
      throw new ClaimPathError(`write path "${raw}" must not claim Git or DeepCluster metadata`)
    }
    if (/[ .]$/u.test(segment)) throw new ClaimPathError(`write path "${raw}" has an ambiguous trailing space or dot`)
    if (process.platform === 'win32' && WINDOWS_RESERVED.test(segment)) {
      throw new ClaimPathError(`write path "${raw}" names a reserved Windows device`)
    }
  }
  const normalized = segments.join('/')
  return { path: normalized, directory, key: relativeKey(normalized) }
}

/** The whole-worktree claim. */
export const WORKTREE_CLAIM: NormalizedClaimPath = Object.freeze({ path: '', directory: true, key: '' })

/**
 * Resolve a claim through existing symlinks and junctions and reject escapes.
 *
 * Missing descendants are canonicalized through their closest existing ancestor, so a
 * new file inherits the canonical parent identity. A link that leaves the worktree, or a
 * declared file/directory kind that disagrees with the existing target, is rejected.
 * @param worktree - canonical physical worktree root.
 * @param claim - syntactically normalized claim.
 * @returns the claim with canonical case and alias resolution.
 */
export async function canonicalClaimPath(worktree: string, claim: NormalizedClaimPath): Promise<NormalizedClaimPath> {
  if (claim.path === '') return WORKTREE_CLAIM
  const root = await canonicalPath(worktree)
  const target = path.join(root, ...claim.path.split('/'))
  const resolved = await canonicalPath(target)
  const rootKey = comparisonKey(root)
  if (!keyWithin(rootKey, comparisonKey(resolved))) {
    throw new ClaimPathError(`write path "${claim.path}" resolves outside worktree "${root}"`)
  }
  const relative = relativePosix(root, resolved)
  const canonical = normalizeClaimPath(claim.directory ? `${relative}/` : relative)
  try {
    const info = await stat(resolved)
    if (claim.directory !== info.isDirectory()) {
      throw new ClaimPathError(`write path "${claim.path}" must ${claim.directory ? 'not ' : ''}end with "/" for its existing target`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return canonical
}

/**
 * Whether two claims can touch the same path.
 * @param left - first normalized claim.
 * @param right - second normalized claim.
 * @returns true for equal paths and for a directory claim over a descendant.
 */
export function claimsOverlap(left: NormalizedClaimPath, right: NormalizedClaimPath): boolean {
  if (left.path === '' || right.path === '') return true
  if (left.key === right.key) return true
  const cover = (outer: NormalizedClaimPath, inner: NormalizedClaimPath): boolean =>
    outer.directory && inner.key.startsWith(`${outer.key}/`)
  return cover(left, right) || cover(right, left)
}

/**
 * Whether a claim authorizes a `/`-separated changed path.
 * @param claim - normalized claim held by a writer.
 * @param pathKey - case-folded repository-relative path.
 * @returns true when the path is the claim or a descendant directory entry.
 */
export function claimCovers(claim: NormalizedClaimPath, pathKey: string): boolean {
  if (claim.path === '' || claim.key === pathKey) return true
  return claim.directory && pathKey.startsWith(`${claim.key}/`)
}

/**
 * Canonical absolute comparison key for a claim span.
 *
 * The root and relative path are folded by the same rules as every other claim key,
 * so a parent workspace claim and a child workspace claim meet at one physical path.
 * @param span - canonical root, relative path and directory flag.
 * @returns native absolute comparison key.
 */
export function claimSpanKey(span: ClaimSpan): string {
  const rootKey = comparisonKey(span.root)
  const relative = relativeKey(span.path)
  return relative === '' ? rootKey : path.join(rootKey, ...relative.split('/'))
}

/**
 * Whether two claim spans can touch the same physical file.
 *
 * A directory span covers its descendants; a file span covers only itself. Roots are
 * absolute, so scopes with different names still conflict when their paths overlap.
 * @param left - first canonical span.
 * @param right - second canonical span.
 * @returns true when both spans can name one path.
 */
export function claimSpansOverlap(left: ClaimSpan, right: ClaimSpan): boolean {
  const leftKey = claimSpanKey(left)
  const rightKey = claimSpanKey(right)
  if (leftKey === rightKey) return true
  if (left.directory && keyWithin(leftKey, rightKey)) return true
  return right.directory && keyWithin(rightKey, leftKey)
}

/**
 * Whether a span authorizes a changed absolute path.
 * @param span - canonical claim span.
 * @param targetKey - absolute comparison key of the changed path.
 * @returns true when the span covers the target path.
 */
export function claimSpanCovers(span: ClaimSpan, targetKey: string): boolean {
  const key = claimSpanKey(span)
  return key === targetKey || (span.directory && keyWithin(key, targetKey))
}
