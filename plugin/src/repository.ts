/**
 * Read-only Git and workspace snapshots for claim, preservation and drift checks.
 *
 * DeepCluster never commits, resets, stashes, cleans or rebases. Every Git probe runs
 * with `GIT_OPTIONAL_LOCKS=0` so even an index refresh cannot mutate the worktree.
 * Content fingerprints cover only pre-existing changes and claimed paths, never the
 * whole tree: the cost of one audit is one `git status --untracked-files=all`, one
 * `git ls-files --stage` and the bounded hash of that path set. A clean file changed and
 * restored between snapshots is therefore unobservable, and ignored/generated files follow
 * Git's own ignore rules.
 *
 * The index snapshot is entry content identity (mode, object id, stage and path), so
 * re-staging changed content, unstaging and staged deletion are visible even when the
 * porcelain status letters do not change. It does not observe index extensions/flags,
 * reflogs, other refs or repository config; {@link workspaceDrift.commonDirChanged} also
 * reports only a different common-directory path, not arbitrary metadata mutation.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/repository
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { canonicalPath, comparisonKey, relativeKey, resolveWorkspaceIdentity,
  type GitLocation, type WorkspaceIdentity } from './scope.ts'

const exec = promisify(execFile)

/** Maximum output captured from one Git probe before the snapshot is reported unavailable. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024
/** Largest single file whose content is fingerprinted. */
const MAX_FINGERPRINT_BYTES = 8 * 1024 * 1024
/** Total content bytes fingerprinted for one snapshot. */
const MAX_FINGERPRINT_TOTAL = 64 * 1024 * 1024
/** Filesystem entries visited in a directory workspace before the walk is marked incomplete. */
const MAX_DIRECTORY_ENTRIES = 5000
/** Index entries retained by path for drift reporting; the digest still covers the rest. */
const MAX_INDEX_ENTRIES = 100_000
/** Maximum changed index paths reported for one drift comparison. */
const MAX_INDEX_DRIFT_PATHS = 2000

/** Read-only Git locations of one worktree. */
export interface GitContext extends GitLocation {
  /** Commit id reported by `git status --branch`, absent for an unborn branch. */
  readonly head?: string
  /** Branch name, `(detached)` when detached, absent for an unborn branch. */
  readonly branch?: string
}

/** One changed path reported by Git or by the bounded directory walk. */
export interface WorkspaceChange {
  /** `/`-separated path relative to the worktree. */
  readonly path: string
  /** Staged/index state, `.` when unchanged; `?` for untracked paths. */
  readonly index: string
  /** Worktree state, `.` when unchanged; `?` for untracked paths. */
  readonly worktree: string
  readonly kind: 'tracked' | 'untracked' | 'conflicted'
  /** Rename source when Git reports one. */
  readonly originalPath?: string
  /** File size in a bounded directory walk; Git snapshots use fingerprints instead. */
  readonly size?: number
  /** File modification time in a bounded directory walk; Git snapshots use fingerprints instead. */
  readonly mtimeMs?: number
}

/** Bounded content fingerprint for one observed path. */
export interface FileFingerprint {
  readonly exists: boolean
  readonly size: number
  readonly mtimeMs: number
  /** SHA-256 of file content, or null when the file exceeded a fingerprint bound. */
  readonly sha256: string | null
}

/** One index entry's content identity. */
export interface IndexEntryIdentity {
  /** `/`-separated path relative to the worktree. */
  readonly path: string
  /** Mode, object id and conflict stage; any change alters the staged content identity. */
  readonly identity: string
}

/** Read-only content identity of the Git index. */
export interface IndexIdentity {
  /** Paths keyed by case-folded path and conflict stage. */
  readonly entries: ReadonlyMap<string, IndexEntryIdentity>
  /** SHA-256 over every staged entry; detects changes beyond the retained path bound. */
  readonly digest: string
  /** False when the path map hit its bound; the digest still covers every entry. */
  readonly complete: boolean
}

/** One captured state of a worktree. */
export interface RepositorySnapshot {
  readonly identity: WorkspaceIdentity
  readonly git?: GitContext
  /** Content identity of the staged index; absent outside Git. */
  readonly index?: IndexIdentity
  readonly changes: readonly WorkspaceChange[]
  /** True when every configured probe completed; false when a bound truncated the walk. */
  readonly complete: boolean
  readonly fingerprints: ReadonlyMap<string, FileFingerprint>
  /** When this snapshot began reading; audits use it as the conservative window start. */
  readonly startedAt: string
  /** When every probe finished; audits use it as the window end. */
  readonly capturedAt: string
}

/** Snapshot capture settings owned by the coordinator. */
export interface SnapshotOptions {
  /** `/`-separated paths whose content is fingerprinted; defaults to every reported change. */
  readonly fingerprintPaths?: readonly string[]
  readonly signal?: AbortSignal
}

/** Raised when a required read-only Git probe cannot complete. */
export class RepositoryProbeError extends Error {
  override name = 'RepositoryProbeError'
  readonly code: 'not-a-repository' | 'unavailable' | 'failed'

  /**
   * @param code - stable probe failure discriminant.
   * @param message - actionable diagnostic.
   * @param options - optional underlying cause.
   */
  constructor(code: RepositoryProbeError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Raised when an audit comparison lacks a comparable snapshot field. */
export class RepositoryStateError extends Error {
  override name = 'RepositoryStateError'
}

/** Staged, modified and untracked path groups used in prompts and journals. */
export interface ChangeGroups {
  readonly staged: readonly string[]
  readonly modified: readonly string[]
  readonly untracked: readonly string[]
}

/**
 * Group changed paths for a worker prompt without changing their meaning.
 * @param snapshot - captured snapshot with changed paths.
 * @returns sorted staged, modified and untracked path groups.
 */
export function changeGroups(snapshot: Pick<RepositorySnapshot, 'changes'>): ChangeGroups {
  const staged = new Set<string>()
  const modified = new Set<string>()
  const untracked = new Set<string>()
  for (const change of snapshot.changes) {
    if (change.kind === 'untracked') { untracked.add(change.path); continue }
    if (change.index !== '.') staged.add(change.path)
    if (change.worktree !== '.') modified.add(change.path)
  }
  return { staged: [...staged].sort(), modified: [...modified].sort(), untracked: [...untracked].sort() }
}

/** Whether a path belongs to coordinator metadata and must not enter source accounting. */
function coordinatorMetadata(relative: string): boolean {
  return relative.split('/').some(segment => segment === '.deep-cluster' || segment === '.git')
}

/** Run one read-only Git probe with optional locks disabled. */
async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await exec('git', args, {
      cwd, windowsHide: true, timeout: 60_000, maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      ...signal === undefined ? {} : { signal },
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') {
      throw new RepositoryProbeError('unavailable', 'Git is not available for this workspace', { cause: error })
    }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
    if (/not a git repository/iu.test(stderr)) {
      throw new RepositoryProbeError('not-a-repository', 'not a Git repository', { cause: error })
    }
    throw new RepositoryProbeError('failed', `Git probe failed: ${stderr.trim() || failure.message}`, { cause: error })
  }
}

/**
 * Discover Git locations for a workspace without mutating it.
 * @param workspace - existing workspace directory.
 * @param signal - optional cancellation for the probe.
 * @returns Git locations, or undefined when the directory is not inside a worktree.
 */
export async function readGitContext(workspace: string, signal?: AbortSignal): Promise<GitContext | undefined> {
  let stdout: string
  try {
    ({ stdout } = await git(workspace, ['rev-parse', '--show-toplevel', '--git-common-dir', '--is-inside-work-tree'], signal))
  } catch (error) {
    if (error instanceof RepositoryProbeError && (error.code === 'not-a-repository' || error.code === 'unavailable')) return undefined
    throw error
  }
  const lines = stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  if (lines.length < 3 || lines[2] !== 'true') return undefined
  const topLevel = await canonicalPath(lines[0] as string)
  const common = lines[1] as string
  const commonDir = await canonicalPath(path.isAbsolute(common) ? common : path.join(workspace, common))
  return { topLevel, commonDir }
}

/** Parse `git status --porcelain=v2 --branch -z` into changed paths. */
function parsePorcelainV2(stdout: string): { changes: WorkspaceChange[]; head?: string; branch?: string } {
  const tokens = stdout.split('\u0000')
  const changes: WorkspaceChange[] = []
  let head: string | undefined
  let branch: string | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string
    if (token === '') continue
    if (token.startsWith('# ')) {
      if (token.startsWith('# branch.oid ')) {
        const value = token.slice('# branch.oid '.length).trim()
        if (value !== '(initial)') head = value
      } else if (token.startsWith('# branch.head ')) {
        branch = token.slice('# branch.head '.length).trim()
      }
      continue
    }
    const kind = token[0]
    if (kind === '?') {
      changes.push({ path: token.slice(2), index: '?', worktree: '?', kind: 'untracked' })
      continue
    }
    const fields = token.slice(2).split(' ')
    if (kind === '1') {
      const xy = (fields[0] ?? '..').slice(0, 2)
      changes.push({ path: fields.slice(7).join(' '), index: xy[0] ?? '.', worktree: xy[1] ?? '.', kind: 'tracked' })
      continue
    }
    if (kind === '2') {
      const xy = (fields[0] ?? '..').slice(0, 2)
      const original = tokens[++index] ?? undefined
      changes.push({ path: fields.slice(8).join(' '), index: xy[0] ?? '.', worktree: xy[1] ?? '.', kind: 'tracked',
        ...original === undefined ? {} : { originalPath: original } })
      continue
    }
    if (kind === 'u') {
      const xy = (fields[0] ?? '..').slice(0, 2)
      changes.push({ path: fields.slice(9).join(' '), index: xy[0] ?? '.', worktree: xy[1] ?? '.', kind: 'conflicted' })
    }
  }
  return { changes: changes.filter(change => change.path !== '' && !coordinatorMetadata(change.path)),
    ...head === undefined ? {} : { head }, ...branch === undefined ? {} : { branch } }
}

/**
 * Parse `git ls-files --stage -z` into entry content identities.
 *
 * The digest covers every entry; the path map stops at a fixed bound so a very large
 * index cannot grow the snapshot without limit. A bounded map reports `complete: false`
 * and drift then names `<git:index>` instead of inventing path detail it did not retain.
 */
function parseIndex(stdout: string): IndexIdentity {
  const entries = new Map<string, IndexEntryIdentity>()
  const digest = createHash('sha256')
  let count = 0
  for (const token of stdout.split('\u0000')) {
    if (token === '') continue
    count++
    digest.update(token).update('\u0000')
    if (entries.size >= MAX_INDEX_ENTRIES) continue
    const tab = token.indexOf('\t')
    if (tab < 0) continue
    const [mode, object, stage] = token.slice(0, tab).split(' ')
    const entryPath = token.slice(tab + 1)
    if (mode === undefined || object === undefined || stage === undefined || entryPath === '') continue
    entries.set(`${relativeKey(entryPath)}\u0000${stage}`,
      { path: entryPath, identity: `${mode} ${object} ${stage}` })
  }
  return { entries, digest: digest.digest('hex'), complete: count <= MAX_INDEX_ENTRIES }
}

/** Read the staged index content identity without mutating it. */
async function readIndexIdentity(root: string, signal?: AbortSignal): Promise<IndexIdentity> {
  const { stdout } = await git(root, ['ls-files', '--stage', '-z'], signal)
  return parseIndex(stdout)
}

/** Walk a directory workspace with a fixed bound and without following links. */
async function directoryChanges(root: string): Promise<{ changes: WorkspaceChange[]; complete: boolean }> {
  const changes: WorkspaceChange[] = []
  let complete = true
  const pending: string[] = ['']
  while (pending.length > 0) {
    const relative = pending.pop() as string
    let entries
    try {
      entries = await readdir(path.join(root, ...relative.split('/').filter(Boolean)), { withFileTypes: true })
    } catch (error: unknown) {
      // An unreadable directory makes the walk incomplete; it must never look empty.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { complete = false; continue }
      complete = false
      continue
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (coordinatorMetadata(child)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        if (changes.length + pending.length >= MAX_DIRECTORY_ENTRIES) { complete = false; return { changes, complete } }
        pending.push(child)
      } else {
        if (changes.length >= MAX_DIRECTORY_ENTRIES) { complete = false; return { changes, complete } }
        try {
          const info = await stat(path.join(root, ...child.split('/')))
          changes.push({ path: child, index: '?', worktree: '?', kind: 'untracked', size: info.size, mtimeMs: info.mtimeMs })
        } catch (error: unknown) {
          // A file disappearing during the bounded walk makes the observation incomplete.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { complete = false; continue }
          throw error
        }
      }
    }
  }
  return { changes: changes.sort((left, right) => left.path.localeCompare(right.path)), complete }
}

/**
 * Fingerprint a bounded path set.
 *
 * The set is pre-existing changes plus claimed files, so already-dirty work is visible
 * without hashing the repository. Oversized files keep their stat identity and report
 * `sha256: null`; that limitation is visible in the snapshot.
 * @param root - worktree or workspace root.
 * @param paths - `/`-separated relative paths.
 * @param signal - optional cancellation.
 * @returns fingerprints keyed by relative path; missing paths report `exists: false`.
 */
export async function fingerprintFiles(root: string, paths: readonly string[],
  signal?: AbortSignal): Promise<Map<string, FileFingerprint>> {
  const fingerprints = new Map<string, FileFingerprint>()
  let total = 0
  for (const relative of [...new Set(paths)].sort()) {
    signal?.throwIfAborted()
    const absolute = path.join(root, ...relative.split('/'))
    let info
    try {
      info = await stat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fingerprints.set(relative, { exists: false, size: 0, mtimeMs: 0, sha256: null })
      continue
    }
    if (!info.isFile()) continue
    let sha256: string | null = null
    if (info.size <= MAX_FINGERPRINT_BYTES && total + info.size <= MAX_FINGERPRINT_TOTAL) {
      const content = await readFile(absolute)
      sha256 = createHash('sha256').update(content).digest('hex')
      total += content.length
    }
    fingerprints.set(relative, { exists: true, size: info.size, mtimeMs: info.mtimeMs, sha256 })
  }
  return fingerprints
}

/**
 * Capture a bounded read-only view of a worktree.
 * @param workspace - existing workspace directory; Git metadata is discovered when present.
 * @param options - optional explicit fingerprint path set and cancellation.
 * @returns canonical identity, changed paths and bounded content fingerprints.
 */
export async function readRepositorySnapshot(workspace: string, options: SnapshotOptions = {}): Promise<RepositorySnapshot> {
  const startedAt = new Date().toISOString()
  const location = await readGitContext(workspace, options.signal)
  const identity = await resolveWorkspaceIdentity(workspace, location)
  const root = identity.worktree
  let changes: readonly WorkspaceChange[]
  let complete = true
  let gitContext: GitContext | undefined
  let index: IndexIdentity | undefined
  if (location !== undefined) {
    const status = await git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'], options.signal)
    const parsed = parsePorcelainV2(status.stdout)
    changes = parsed.changes
    index = await readIndexIdentity(root, options.signal)
    gitContext = { ...location, ...parsed.head === undefined ? {} : { head: parsed.head },
      ...parsed.branch === undefined ? {} : { branch: parsed.branch } }
  } else {
    const walked = await directoryChanges(root)
    changes = walked.changes
    complete = walked.complete
  }
  const paths = options.fingerprintPaths ?? (gitContext === undefined ? [] : changes.map(change => change.path))
  const fingerprints = await fingerprintFiles(root, paths, options.signal)
  return { identity, ...gitContext === undefined ? {} : { git: gitContext }, ...index === undefined ? {} : { index },
    changes, complete, fingerprints, startedAt, capturedAt: new Date().toISOString() }
}

/** Changed path plus the reason the two snapshots disagree. */
export interface ChangeDrift {
  readonly path: string
  readonly reason: 'added' | 'removed' | 'status' | 'content'
}

/** Worktree drift between two snapshots of the same workspace. */
export interface WorkspaceDrift {
  readonly changes: readonly ChangeDrift[]
  readonly headChanged: boolean
  readonly branchChanged: boolean
  /** A different canonical common-directory path; this does not observe refs, config or logs. */
  readonly commonDirChanged: boolean
  /** The staged entry content identity changed, including re-staging or unstaging. */
  readonly indexChanged: boolean
  /** Paths whose staged entry identity changed; `<git:index>` when the path bound hid detail. */
  readonly stagedPaths: readonly string[]
}

/** Compare staged entry content identities. */
function indexDrift(before: IndexIdentity | undefined, after: IndexIdentity | undefined): { changed: boolean; paths: string[] } {
  if (before === undefined || after === undefined) return { changed: false, paths: [] }
  if (before.digest === after.digest) return { changed: false, paths: [] }
  if (!before.complete || !after.complete) return { changed: true, paths: ['<git:index>'] }
  const paths = new Set<string>()
  for (const [key, entry] of after.entries) {
    const previous = before.entries.get(key)
    if (previous === undefined || previous.identity !== entry.identity) paths.add(entry.path)
  }
  for (const [key, entry] of before.entries) if (!after.entries.has(key)) paths.add(entry.path)
  const sorted = [...paths].sort()
  return { changed: true, paths: sorted.length > MAX_INDEX_DRIFT_PATHS
    ? [...sorted.slice(0, MAX_INDEX_DRIFT_PATHS), '<git:index>']
    : sorted }
}

/**
 * Compare two snapshots; only paths present in either snapshot or fingerprint set are evaluated.
 * @param before - earlier snapshot of the same physical worktree.
 * @param after - later snapshot.
 * @returns changed paths, staging transitions and Git identity changes.
 */
export function workspaceDrift(before: RepositorySnapshot, after: RepositorySnapshot): WorkspaceDrift {
  if (comparisonKey(before.identity.worktree) !== comparisonKey(after.identity.worktree)) {
    throw new RepositoryStateError('snapshots describe different physical worktrees')
  }
  const previous = new Map(before.changes.map(change => [relativeKey(change.path), change]))
  const current = new Map(after.changes.map(change => [relativeKey(change.path), change]))
  const changes: ChangeDrift[] = []
  for (const [key, change] of current) {
    const old = previous.get(key)
    if (old === undefined) changes.push({ path: change.path, reason: 'added' })
    else if (old.index !== change.index || old.worktree !== change.worktree || old.kind !== change.kind) {
      changes.push({ path: change.path, reason: 'status' })
    } else if (change.mtimeMs !== undefined && old.mtimeMs !== undefined &&
      (change.size !== old.size || change.mtimeMs !== old.mtimeMs)) {
      changes.push({ path: change.path, reason: 'content' })
    }
  }
  for (const [key, change] of previous) {
    if (!current.has(key)) changes.push({ path: change.path, reason: 'removed' })
  }
  for (const [relative, old] of before.fingerprints) {
    const next = after.fingerprints.get(relative)
    if (next === undefined) continue
    if (old.exists !== next.exists || old.sha256 !== next.sha256 ||
      (old.sha256 === null && next.sha256 === null && (old.size !== next.size || old.mtimeMs !== next.mtimeMs))) {
      changes.push({ path: relative, reason: 'content' })
    }
  }
  const index = indexDrift(before.index, after.index)
  return {
    changes,
    headChanged: before.git?.head !== after.git?.head,
    branchChanged: before.git?.branch !== after.git?.branch,
    commonDirChanged: before.git?.commonDir === undefined || after.git?.commonDir === undefined
      ? before.git?.commonDir !== after.git?.commonDir
      : comparisonKey(before.git.commonDir) !== comparisonKey(after.git.commonDir),
    indexChanged: index.changed,
    stagedPaths: index.paths,
  }
}
