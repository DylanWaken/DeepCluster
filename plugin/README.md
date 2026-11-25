---
description: "Delegate bounded tasks to DSH workers with dependency scheduling, shared hardware leases, outcome examples, and a live dashboard."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-deep-cluster

English | [中文](README.zh.md)

## Summary

DeepCluster lets a controlling agent delegate focused implementation, test, review, data collection, and profiling tasks to DSH workers. The supervisor selects plans, knowledge, persistent conversations, and bounded future work; the coordinator executes those choices with dependency scheduling, exclusive resources, and optional host policy checks. Recorded outcomes and the optional dashboard support later decisions. Workers use an existing configured DSH execution profile; reports still require independent review.

## Table of Contents

- [Quick start](#quick-start)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="quick-start"></a>
## Quick start

For a fresh installation, follow the [DeepCluster setup guide](https://github.com/DylanWaken/DeepCluster/blob/main/docs/setup.md). It builds the pinned DSH revision with the session and subprocess support this plugin needs. The package-level commands below assume a DSH host that already contains those changes.

Install a supported `dsh` release first. This package targets the same `0.2.1-rc.2` release and Node `^22.19.0 || >=24.0.0`; obtain it from a local tarball ([build and pack](#build-pack-and-host-requirements)) or a matching published release, because this document does not assume registry publication. The managed lifecycle is Windows only; elsewhere run the API and dashboard under your own supervisor.

Use this one setup recipe, in order:

1. Install this package into the API's `deep-cluster` profile and into the dashboard's `web` profile. The API profile also needs the host WebServer that [api.patch.yml](api.patch.yml) inserts. `dsh plugin` initializes a missing profile and updates `dsh.profile.bundles` for packages that declare `dsh.bundle`; see [Install into dsh profiles](#install-into-dsh-profiles).

   ```sh
   dsh plugin --profile deep-cluster add <package-spec> <host-webserver-spec>
   dsh plugin --profile web add <package-spec>
   ```

2. Install the `/DeepCluster` skill for any harness and save the connection in the same command. The API and dashboard endpoints and the DSH installation directory must be saved before the first service start; see [Install the skill for any harness](#install-the-skill-for-any-harness). If the saved worker `cliPath` is a worker-only wrapper, also pass `--service-cli <absolute-dsh-cli>`; the persistent launcher uses that DSH CLI for `--profile deep-cluster` and `--profile web`, while workers keep using `cliPath`.

   ```sh
   dsh --profile deep-cluster install --skills-root <absolute-skills-dir> --api-endpoint http://127.0.0.1:3789 --dashboard-endpoint http://127.0.0.1:3788 --dsh-path <absolute-dsh-install-dir>
   ```

3. Start the persistent service from the controlling agent's own shell and read its private login URL. A first start also verifies the authenticated dashboard; see [Persistent local service](#persistent-local-service).

   ```sh
   dsh --profile deep-cluster service start
   dsh --profile deep-cluster service login-url
   ```

Reinstall the skill without connection flags to preserve the saved endpoints, DSH installation directory, dashboard roots, and both CLI paths; installation never reads or stores credentials. `--planner cursor|codex|all` keeps the preset roots; `--skills-root` and `--planner` cannot be combined, and `--label "<name>"` names the harness in the generated text.

<a id="use-this-package"></a>
## Use this package

<a id="install-into-dsh-profiles"></a>
### Install into dsh profiles

`dsh plugin --profile <name> add ...` runs pnpm in `$DSH_HOME/profiles/<name>` and reconciles `dsh.profile.bundles`; it initializes a missing profile from the shipped template when one exists, otherwise from `@deepseek-ai/dsh-base`. Profiles disable automatic peer installation, so name every peer the profile must resolve.

The API profile is `deep-cluster`: it needs this package and `@deepseek-ai/dsh-host-webserver`, because [api.patch.yml](api.patch.yml) inserts that service. The dashboard runs in the shipped `web` profile, so install this package there too; [web.patch.yml](web.patch.yml) resolves the package's bare and `/web` entries from that profile.

```sh
dsh plugin --profile deep-cluster add <package-spec> <host-webserver-spec>
dsh plugin --profile web add <package-spec>
```

`<package-spec>` is a local tarball path or a matching release. `<host-webserver-spec>` is `@deepseek-ai/dsh-host-webserver` from the same DSH release, or its tarball when that release is not available locally. The package keeps `@deepseek-ai/dsh-subprocess-local`, `@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/dsh-util-values`, `@deepseek-ai/schemastery`, `@huggingface/tokenizers`, and `zod` in `dependencies`; they must resolve from the registry, the local store, or local tarballs. This checkout documents source and tarball installation; it does not assert that the package is available from a registry.

The dedicated local HTTP API owns task operations. Install the skill with the saved connection as the [Quick start](#quick-start) shows. The API binds to `127.0.0.1:3789`; `DEEPCLUSTER_API_PORT` selects another port. It admits a request from this computer without credentials and rejects a non-loopback peer with 403 `remote-peer`, a browser-origin request, and a Host header that does not name this loopback listener. There is no bearer token: the token file, `--api-token-file`, `apiTokenFile`, and `DEEPCLUSTER_API_TOKEN_FILE` are retired; a saved `apiTokenFile` in `~/.deep-cluster/config.json` fails loud and must be deleted. The dashboard keeps the DSH Web login URL from `service login-url`. Commands, the MCP adapter, and the dashboard forward operations to this API. Configuration in `~/.deep-cluster/config.json` and the installed skill record the endpoint, DSH working directory, CLI paths, and dashboard roots. The packaged and installed skill come from the same `assets.ts` generator; installing again preserves a connection from the saved configuration or an existing installed skill, including after changing the target. If no connection is saved, `/DeepCluster` asks for an endpoint or a DSH installation containing the plugin before launching or connecting. The separate worker profile defaults to `cluster` and needs a working model, tools, and credentials; workers use full access with sandboxing disabled. `/DeepCluster` also supports proactive delegation of suitable routine work.

<a id="install-the-skill-for-any-harness"></a>
### Install the skill for any harness

On the first install, save the connection with the skill: pass an absolute `--dsh-path` plus the endpoints the service uses. The `--service-cli` line is only needed when the worker `cliPath` is a worker-only wrapper. Later reinstalls without connection flags preserve the saved values.

```sh
dsh --profile deep-cluster install --skills-root <absolute-skills-dir> \
  --api-endpoint http://127.0.0.1:3789 \
  --dashboard-endpoint http://127.0.0.1:3788 \
  --dsh-path <absolute-dsh-install-dir>
dsh --profile deep-cluster install --skills-root <absolute-skills-dir> --service-cli <absolute-dsh-cli>
dsh --profile deep-cluster install --skills-root <absolute-skills-dir> --label "<harness name>"
```

`--cli` saves the worker executable, which the executor always uses. `--service-cli` saves a separate DSH CLI used only to start the persistent API and dashboard with `--profile deep-cluster` and `--profile web`; when `serviceCliPath` is absent, the service falls back to `cliPath`. A worker-only wrapper that accepts `--profile cluster` and a worker prompt must not be used for service startup: save the actual DSH CLI with `--service-cli` and keep the wrapper in `cliPath`. The generic target writes only `<skills-root>/DeepCluster/SKILL.md`; it creates no Cursor or Codex directory. The generated text names the configured label (default `this harness`), contains no Codex- or Cursor-specific instruction, and does not reference an unshipped helper script. Preset installs remain available with `--planner cursor`, `--planner codex`, or `--planner all`. `--skills-root` and `--planner` select different targets and are rejected together; `--label` requires `--skills-root`. Installation persists the same merged endpoint, DSH path, dashboard roots, and both CLI paths that it renders into the skill.

The installed skill is a compact single-request guide: it ensures the service with `service start` (idempotent) when a request cannot connect, submits the plan file in one request with `wait` and `view=report`, reviews checks and changed paths, and spot-checks one decisive fact.

<a id="build-pack-and-host-requirements"></a>
### Build, pack, and host requirements

The source build is monorepo-only: `tsdown.config.ts` imports the shared `packages/client/tsdown.client.ts` preset and the host tsconfig references the workspace packages. Build artifacts with `pnpm run build:artifacts` from the checkout, then pack this package:

```sh
pnpm --filter @deepseek-ai/dsh-experimental-deep-cluster pack --pack-destination <absolute-output-dir>
```

The `prepack` script (`scripts/pack-clean.mjs --check`) refuses to pack while root-level `lib/*.js` chunks are unreachable from the published entries, so stale hashed `install-*` or `web-*` files cannot enter a later tarball. Run `pnpm --filter @deepseek-ai/dsh-experimental-deep-cluster pack:clean` once to prune them, or `pack:check` to report them without deleting; only unreachable root chunks are touched, never `lib/types`. The package can then be installed from the tarball in place of the `link:` dependency. There is no self-contained build outside the DSH workspace.

This package is version `0.2.1-rc.2` and targets the same DSH release. It requires Node `^22.19.0 || >=24.0.0`. Its bundle patch needs the declared runtime dependency `@deepseek-ai/dsh-subprocess-local`, and it shares `@deepseek-ai/cordis` 4.0.5 and `@deepseek-ai/dsh-tools` as peers. Because its published declarations and API overlay require the Host's own copies, it also declares `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-client-ui-slots`, and `@deepseek-ai/dsh-host-webserver` as peer dependencies. Install them from the matching DSH release or use the DSH profile; a fresh consumer must install those host packages before typechecking with `skipLibCheck: false`. The API profile above declares `@deepseek-ai/dsh-host-webserver`, which the API overlay requires. Install against a DSH release whose workspace package versions match this release; a mismatched Host is not supported. The API and Web overlays are consumed by the `dsh` launcher only.

### Source checkout

For source development only, build the checkout first, then link its package and host WebServer into the same profiles instead of installing a tarball:

```sh
pnpm run build:artifacts
dsh plugin --profile deep-cluster add link:<absolute-checkout>/packages/experimental/deep-cluster link:<absolute-checkout>/packages/host/webserver
dsh plugin --profile web add link:<absolute-checkout>/packages/experimental/deep-cluster
```

The checkout build is not self-contained: it consumes the DSH workspace and the shared client preset. In a source checkout, `pnpm dsh` runs the built launcher; for the persistent service, install with `--cli <absolute-checkout>/apps/cli/lib/bin.js` and `--dsh-path <absolute-checkout>` so both workers and scheduled tasks launch that entry. When the worker entry differs, pass `--service-cli <absolute-checkout>/apps/cli/lib/bin.js` instead so only scheduling and worker execution keep their separate entries. The `dsh` commands in the rest of this document are equivalent when a matching release is installed.

<a id="persistent-local-service"></a>
### Persistent local service

Start the API and the browser dashboard as persistent local services after the saved connection is verified. Before the first start, `~/.deep-cluster/config.json` must contain the `apiEndpoint` and `dshPath` saved by the skill install. `dshPath` is required: without it the service fails before creating files. Any agent, including a delegated worker, may invoke the supported `service start` command when the API cannot connect. Scheduled tasks own both services after the caller exits. The scheduled-task lifecycle is implemented on Windows only; on another platform the service commands fail before creating service files and the API and dashboard must be run through the operator's own supervisor. A WSL-launched Linux process is outside the Windows process range even on the native containment path, so descendant exit cannot be observed and the hardware lease remains quarantined.

`<dshPath>/.deep-cluster/service-state/` is the master directory. It holds `service/` (launch scripts, `service.json` ownership, `runs/<stamp>/api.log`, `dashboard.log`, `startup-url.txt`), `api-state/` (operation records, `api-owner.lock`), `leases/`, `claims/`, and `claim-history.json`. `DEEPCLUSTER_SERVICE_DIRECTORY`, `DEEPCLUSTER_API_STATE_DIRECTORY`, and `DEEPCLUSTER_API_LEASE_ROOT` override those paths. The saved configuration stays at `~/.deep-cluster/config.json`, and released-claim evidence is at `<leaseRoot>/claim-history.json`.

```sh
dsh --profile deep-cluster service start     # API then dashboard, verified
dsh --profile deep-cluster service status    # health, snapshot, owners, lock
dsh --profile deep-cluster service restart   # fresh browser login URL
dsh --profile deep-cluster service login-url # private URL for the controller
dsh --profile deep-cluster service stop      # refuses active runs and unconfirmed cleanup
dsh --profile deep-cluster service stop --confirm-cleanup-unconfirmed
dsh --profile deep-cluster service recover --dry-run # read-only lock diagnosis
dsh --profile deep-cluster service recover --confirm-lock-owner <owner> # operator-confirmed quarantine
```

Both services launch through supported `dsh` profiles as on-demand per-user scheduled tasks. The API uses `api.patch.yml` and the dashboard uses `web.patch.yml`; no boot or logon autorun is installed. The launcher starts both from the saved `serviceCliPath`, falling back to `cliPath` only when absent; worker execution always uses `cliPath`. Start reuses a healthy owned stack. Mutating lifecycle commands serialize across local configurations on one Windows named pipe held directly by the calling Node process. The saved `serviceLifecycleWaitMs` setting bounds contention (positive milliseconds, default 300000); the pipe accepts no commands and closes incoming connections. Windows releases its ownership when the controller exits, including a crash.

Each scheduled launch records its exact action before submission, and its service host persists a native process receipt before starting the API or dashboard. A later controller can reconcile a matching live listener with the launch evidence and readiness checks even if the original caller exited before saving `service.json`. Interrupted launches revoke future target startup, stop only their matching scheduled action, and await termination of their recorded native range; replaced tasks remain untouched. Launch records store deployment settings, never ambient credential values.

Before the first external mutation, the controller publishes `~/.deep-cluster/service-mutation.json`; the intent remains through commands, scheduled-task startup, readiness verification, and ownership persistence. Successful completion removes it. A failed action also removes it after rollback has durably confirmed settlement; any later effect revokes that confirmation before running. Healthy reuse and preflight refusals create no marker.

Start and restart automatically quarantine an interrupted intent after its exact controller has exited when durable settlement, a previous Windows boot, or complete native command receipts establish that its command processes have stopped. Native commands persist their named Windows Job receipt before the target starts; recovery terminates those recorded ranges and awaits their exit. Untracked child-producing effects revoke this recovery guarantee. Live matching controllers, incomplete evidence, and failed recovery retain the marker. For older or untracked commands, use `service recover-controller --dry-run`, verify the controller and all command descendants have stopped, then use `service recover-controller --confirm-controller-intent <id>`. Recovery preserves the exact marker as evidence; PID reuse and elapsed time alone never authorize it. Read-only status remains available.

The controller records PID and process start time in `<dshPath>/.deep-cluster/service-state/service/service.json`. Both scheduled tasks run hidden through `conhost.exe --headless`, continue on battery, and have no execution time limit. Stop and restart refuse active runs, mismatched process owners, and unconfirmed cleanup. Dashboard stop ends its scheduled task, then terminates the recorded process tree after re-verifying PID and start time. Clean API stop uses `/v1/service/shutdown` and normal runtime disposal releases ownership. `cleanupUnconfirmed` in `/v1/health` blocks stop until the operator verifies and terminates the process ranges and passes `--confirm-cleanup-unconfirmed`; this attestation does not release quarantined leases.

Startup checks the API lock’s own PID and process start time even when `service.json` is absent or stale. A matching live owner or an occupied API port blocks recovery. For a stopped owner from an earlier Windows boot, startup quarantines previous-boot ownership records while preserving operation history and current-boot owners. For a stopped owner from the current boot, complete native receipts permit terminating each recorded Windows Job before releasing only that generation’s ownership. Uncertain worker cleanup preserves its active leases, claims, and waiters. Known affected paths and resources remain unavailable to conflicting work; missing or malformed scope blocks all fresh admission while the API remains available for inspection. Worker recovery waits within `terminationGraceMs`, joins a timeout, and reports the retained ownership; uncertain controller or service-launch ownership remains subject to its stricter recovery checks.

Without complete native receipts, automatic lock recovery can also use a complete operation scan establishing settlement and existing, empty API-recorded lease and claim directories. Completed outcomes qualify unless they explicitly deny cleanup; failed, cancelled, or acknowledgement-pending outcomes require `result.cleanupConfirmed: true` and no error. An `owner-stopped` recovery result establishes only that the old API exited, not that its workers stopped. Read `/v1/health` for `recoveryIssues` with `kind`, `id`, `message`, `observedAt`, and optional `blocksAdmission: true`; the latter rejects fresh runs with 503 `recovery-admission-blocked`. Corrupt operation evidence stays intact and reserves known idempotency keys; the affected key returns 503 `operation-record-damaged`, while unrelated keys may proceed. Diagnostics refresh on the next service start or restart.

`service recover --dry-run` reports the evidence without mutation. Older locks without inspection metadata, and uncertain retained work, require the operator to inspect workers, leases, and quarantine events before `service recover --confirm-lock-owner <diagnosed owner>`. Recovery rechecks identity and idle proof under an API admission fence, renames the exact lock as evidence, and never deletes or replays operation, lease, or claim records. Live owners and ambiguous identities remain refused even with confirmation.

The fresh `dsh web:` login URL is written privately under `<dshPath>/.deep-cluster/service-state/service/runs/<stamp>/startup-url.txt` and returned only by `service login-url`. That private file is the only written copy: the tokenized URL must not enter a skill, plan, saved configuration, shared report, or API request body. Dashboard readiness requires authenticated HTML and a successful `/api/deepClusterDashboard/snapshot` read. Show the fresh URL to the user on first use and confirm the rendered panel in an actual browser.

The service validates its dashboard composition instead of assuming the saved `web` profile. [web.patch.yml](web.patch.yml) disables the bundle's duplicate `deep-cluster-subprocess` and launcher `deep-cluster-command` rows, disables the saved bare and dashboard rows when present, and inserts one bare package row plus one dashboard row under distinct service ids. The bare `@deepseek-ai/dsh-experimental-deep-cluster` row stays active because the browser client-module scan discovers the visible panel only through that exact specifier. The same overlay applies to a saved profile that already has dashboard rows and to a clean one. The saved `dashboardWorkspace` and `dashboardWorkspaces` settings supply the absolute primary root and additional roots; the launcher passes them as `DEEPCLUSTER_WORKSPACE` and `DEEPCLUSTER_WORKSPACES` (JSON array), and installing the skill preserves both. Neither has a hardcoded user path, and startup must fail loud if the composed configuration lacks one enabled bare row or one dashboard row.

### Write and inspect a plan

If you have a source checkout, [the parallel inspection example](samples/parallel-plan.md) is a small starting point; otherwise write the plan directly. Each step has a stable id, a specialist role, instructions, and at least one unique, nonblank acceptance bullet. Put step metadata before `acceptance:` and separate subsequent instructions from the acceptance list with a blank line. Metadata-looking lines in those instructions remain task text. A worker must repeat each acceptance label with `yes` and concrete evidence; missing evidence, a failed process, or an absent report fails the attempt.

The first submission creates the workspace's `.deep-cluster/` for the journal, team mailboxes, and plan files, with a `.gitignore` containing `*`; no repository ignore rule is needed.

```sh
dsh --profile deep-cluster coordinate --plan <absolute-plan.md> --concurrency 2 --dry-run
```

`--dry-run` calls `POST /v1/plans/validate` to check the workspace, plans, and budgets without starting workers or creating an operation. Remove it to submit through `POST /v1/runs`. `POST /v1/runs` accepts a `text/markdown` or `text/plain` plan body with `workspace`, `maxConcurrency`, `timeoutMs`, `maxAttempts`, and `maxRepairs` in the query, or a JSON body `{workspace, plans, ...}` with no query options; `POST /v1/plans/validate` accepts the same bodies. `Idempotency-Key` is optional; send one to make retries safe. `wait=<seconds>` holds the response until the run settles or the wait ends, bounded by the API maximum timeout, and `view=report` returns the compact report. `GET /v1/runs/:id` accepts `wait` and `view`; `POST /v1/runs/:id/cancel` with `{}` accepts `view` and waits for worker teardown. Reuse the same key and request after an uncertain submission; a changed request with that key is rejected. Omitted `depends_on` means the preceding step must pass. Use `depends_on: none` for independent tasks. Failure blocks dependent tasks while independent tasks finish. `dependency_policy: settled` instead waits for terminal prerequisite outcomes and runs a diagnostic reviewer or tester after a failure, without relabeling failed work or turning a failed run green. Attempts and repairs have separate per-step budgets; `maxRepairs: 0` forbids repair workers. Repairs inherit task instructions, role restrictions, and hardware allocation.

A `view=report` response carries `operationId`, `status`, `error` (`code: message` or null), `steps`, `open`, and `failure`. Each step has `id`, `role`, `status`, `attempts`, and `summary`, plus `checks` (acceptance label with worker evidence), `changed` (paths the audit saw change during the step), `auditProblem`, and `improvisation` when present. `open` lists unresolved improvisation ids; `failure` carries `stepId` and the last 4,000 characters of the failing output.

Repeat `--plan <file>` to submit multiple plans in one operation. Their roots can run together under the shared `--concurrency` limit; dependencies stay local to each plan, and task examples retain their source title and goal. Hardware and named resource locks remain shared across the batch.

### Version control and write claims

Each run records the canonical workspace, physical worktree, Git top level, shared common directory, branch, HEAD, and the exact staged, dirty, and untracked path set. The probe is read-only and runs with `GIT_OPTIONAL_LOCKS=0`; one snapshot reads `git status --untracked-files=all` plus `git ls-files --stage`, hashes pre-existing changes and claimed files, and compares staged-entry content identity rather than its porcelain status letter. Restaging changed content, unstaging, and staged deletion are therefore detected even when the status letter stays `M`. HEAD, branch, and index entries are preserved; reflogs, other refs, packed-refs, config, logs, index extensions and flags, and arbitrary common-directory files are not content-fingerprinted. Worker instructions carry the preservation rule and the observed paths. DeepCluster never commits, resets, stashes, cleans, or rebases.

Claims conflict by canonical absolute path, not by scope key: parent and child workspaces, nested repositories and submodules, and an outside non-Git ancestor that contains the claimed file all conflict with it. Separate physical worktrees remain parallel. Git metadata is its own accounting namespace and serializes through the shared common-directory claim; every `git: write` step also holds its whole worktree. Release evidence is durable at `<leaseRoot>/claim-history.json`, bounded to 1,000 released claims and 12 hours. When an audit window predates the recorded `prunedThrough`, an unauthorized change is reported as unattributable instead of blaming a worker. On Windows, the claim-registry mutex uses a named pipe that the operating system releases when its owner exits. Ordinary admission waits only for the configured bound; legacy directory mutexes require verified recovery.

Each plan step controls its write claim:

- Omitted `access` and `writes` reserve the whole physical worktree exclusively.
- `access: read-only` declares no source writes and takes no write claim. `access: write` without `writes` also reserves the whole worktree.
- `access: write` with `writes: path/a.ts, dir/` permits disjoint concurrent writers. Paths are literal and repository-relative; a trailing `/` covers descendants. Globs, absolute or drive-qualified paths, UNC paths, backslashes, `..` or `.` segments, `.git`, `.deep-cluster`, ambiguous Windows trailing space or dot, reserved device names, and symlink or junction escapes outside the worktree are rejected.
- `resources` add exact-name locks and never replace the write claim; `resources: none` declares no named lock and does not opt out. Use `access: read-only` to declare no writes. `git: write` requires whole-worktree access, a real Git worktree, and the common-directory lock, and still does not authorize DeepCluster to mutate Git.
- Claims match canonicalized absolute spans, so case aliases, junctions, symlinks, nested repositories, and an outside non-Git ancestor resolve to the same physical owner. A claim expires without transferring ownership; [service recovery](#persistent-local-service) must establish worker termination. An ordinary whole-worktree claim authorizes creating new files but does not authorize changing pre-existing dirty work; only an explicit `path` claim does.

Claims coordinate cooperating DeepCluster processes; they are not a sandbox. An arbitrary shell can write outside its declared paths. `access: read-only` is a declaration: if another active claim covers the path a read-only worker writes, the snapshots cannot tell the two writers apart, so that change may be attributed to the union of observed claims. Post-step and final snapshots report undeclared changes and pre-existing dirty files changed outside the claim, but only where Git or the bounded directory walk observes them; a specific writer is not identified. A clean file changed and restored between snapshots, ignored or generated files that follow Git ignore rules, and other unobservable writes are not detected. A failed snapshot or detection step is reported and never treated as a pass. Workers exchange prerequisite summaries and reported checks; detailed artifacts remain in the workspace.

<a id="lease-hardware-and-inspect-outcomes"></a>
### Lease hardware and inspect outcomes

Declare `hardware: gpu0` on every task that touches that GPU, including correctness tests and profilers. Tool names in task text and the `perf` role also infer a lease, but inference cannot determine arbitrary executable behavior or distinguish a saved report from a fresh measurement. Use `hardware: none` for explicitly CPU-only work, such as reviewing saved NCU reports; it suppresses inference, and that worker must not execute GPU work. A step accepts one hardware name or the reserved value `none`; empty or comma-separated step declarations are rejected. All API servers using the same device must use the same resource name and configured lease root.

```sh
dsh --profile deep-cluster lease status --resource gpu0
dsh --profile deep-cluster journal --cwd . --tail 60
dsh --profile deep-cluster ledger --cwd . --tail 20
```

A lease remains held until descendant process teardown is confirmed. An expired deadline is diagnostic and never transfers ownership. Unconfirmed teardown stops further dispatch in that run and retains its ownership; `error.code: cleanup-unconfirmed` does not claim the worker tree stopped. `/v1/health` counts those runs as `cleanupUnconfirmed`; graceful stop requires the explicit `--confirm-cleanup-unconfirmed` attestation. Recovery keeps known affected claims active so conflicting work waits; unknown scope can block all fresh admission as described in [Persistent local service](#persistent-local-service). A WSL-launched Linux process or any descendant outside the Windows range remains outside native termination guarantees. Recovery must establish termination before releasing ownership. Retries and repairs retain the configured permissions; output text never grants broader access.

The API exposes recorded activity through `GET /v1/journal?workspace=<absolute-path>&tail=60`, task outcomes through `GET /v1/ledger?tail=N` (the newest N task outcomes), and ownership through `/v1/leases?resource=gpu0`. Journal and ledger reads also accept `runId`, an opaque `after` cursor returned by the previous page, and `limit`; the response reports `cursor`, `more`, and `reset`, so a supervisor can read a long run incrementally without rescanning its history. A filtered read advances its cursor across skipped records, so later matching events are not lost. The commands above forward the tail form. The ledger separates failed and blocked counts; examples are worker reports, not calibrated capability probabilities. `needs-ack` means a reported plan deviation; `POST /v1/ack` accepts `{workspace,id,reject,note}` and settles the run once its last open improvisation is resolved: `completed`, or `failed` with code `improvisation-rejected` when any was rejected. Inspect the evidence before acknowledging, then update the plan. A supervisor on this computer may send bounded feedback to one exact run participant with `POST /v1/runs/<operationId>/messages` and `{toStepId, message}`; the recipient still retrieves it through `cluster_inbox`, and the message grants no permission, dependency change, wakeup, or lease transfer.

`GET /v1/runs` discovers retained operations across workspaces. Optional filters are an absolute `workspace`, one exact `status`, and `attention=true|false`; existing workspace aliases resolve to their physical path, while removed workspaces remain discoverable by their recorded absolute path. `limit` is a positive integer bounded by the API's `maxTail` and defaults to that bound. The response is `{runs, cursor, more}`. Each compact summary includes operation and run identities, workspace, status, timestamps, unresolved-deviation count, available step counts, and an `attention` array containing any recorded `cleanup-unconfirmed`, `interrupted`, `needs-ack`, `failed`, or `audit-problem` conditions. `attention=true` selects nonempty arrays; `false` selects empty arrays. Open the selected `GET /v1/runs/<operationId>?view=report` for detailed evidence. Listing never acknowledges deviations, retries workers, changes plans, or mutates Git; the supervising AI owns allocation and follow-up decisions.

Run pages sort by descending creation time and operation id. Pass the returned opaque `cursor` as `after` with the same filters; page size may change. A null cursor means no more currently matching records. Unknown, repeated, or invalid query fields return 400; malformed, mismatched, or unavailable cursor anchors return 400 `invalid-cursor`. The listing reads current state rather than a frozen snapshot: restart without `after` to discover newly submitted or newly matching operations ahead of a saved cursor. Use the journal cursor for incremental events. [The design comparison](docs/design.md#agent-orchestrator-comparison) explains this separation of observation from allocation and the remaining integration gaps.

<a id="share-knowledge-between-runs"></a>
### Share knowledge between runs

The supervising AI can retain documents, evidence-linked lessons, and versioned protocols for later plans. Knowledge belongs to one canonical workspace inside one API state directory; separate API state directories do not share it. Every route below requires `workspace=<url-encoded absolute existing path>`. Any same-computer caller accepted by the API can read, write, adopt, or retire knowledge: adoption records a workflow decision, not authenticated authority or additional operating-system permissions.

| Route | Result or request |
| --- | --- |
| `GET /v1/knowledge` | Latest summaries without bodies or evidence; optional `limit` and `after`, ascending record IDs, `{records,cursor,more}`. |
| `POST /v1/knowledge` | Full replacement `{id,expectedRevision,kind,title,body,...}`; a caller-generated UUID and `expectedRevision: 0` create a record, while updates require its current revision. Conflicts return 409. |
| `GET /v1/knowledge/:id` | `{record}` with full content; optional `revision` selects history, otherwise the latest revision. |
| `POST /v1/knowledge/:id/transition` | `{expectedRevision,state}` with `state` set to `adopted` or `retired`; only protocols have lifecycle transitions. |
| `GET /v1/knowledge/:id/usage` | Required exact `revision`, optional `limit`; retained runs that selected it, with `count` and `truncated`. Selection does not prove application or compliance. |
| `GET /v1/briefing` | Optional `limit`; bounded run and knowledge summaries, adopted protocol heads, lessons, observation time, per-collection counts and truncation, and attention counts across all matching retained runs. Reads have no execution or acknowledgement effects. |

`kind` is `document`, `lesson`, or `protocol`. A lesson requires `evidence: [{operationId,stepId?}]` referring to retained, non-active operations in the same workspace; a named step must exist in their result or last recorded progress. Failed and interrupted work can support a lesson, but the citation does not verify its conclusion. Protocol content writes always create a proposed revision. Adoption requires the current revision; retirement prevents new selection, and editing an adopted protocol requires adopting its new revision before selection. Existing history and admitted snapshots remain unchanged. `limit` is bounded by `maxTail`; knowledge record, body, reference, and snapshot budgets are configured by `maxKnowledgeRecords`, `maxKnowledgeBodyBytes`, `maxKnowledgeReferences`, and `maxKnowledgeSnapshotBytes`.

Select exact revisions with `knowledge: [{id,revision}]` in the JSON request to `POST /v1/runs` or `POST /v1/plans/validate`; text plan submissions do not select knowledge. Documents and lessons are reference material; selected protocols must be the currently adopted head. Admission retains complete snapshots in the operation and `run/start` journal event, and every worker attempt receives the same full context in its logged request. A retry with the same idempotency key and request returns the original operation and snapshots even after later edits or retirement. New or changed selections need a new request key. The supervising AI still owns allocation, acceptance, and replanning.

A selected protocol may declare `constraints.requireReviewAfterWrites: ["reviewer","tester"]`, either role alone, and optional `requiredAcceptanceLabels`. Every writable step, including omitted `access`, then needs an explicitly `access: read-only` downstream step for each required role. Dependencies may be transitive and a shared review may cover multiple writers; all exact labels must appear together on one qualifying review for each role and writer. Admission rejects an unsatisfied plan without adding steps. These checks validate plan structure, not successful execution, worker honesty, or tool permissions.

<a id="continue-or-replace-a-worker"></a>
### Continue or replace a worker

Create a supervisor-assigned worker with `POST /v1/sessions` and `{id,workspace,title,role,handoff?}`. Supply a fresh UUID, an absolute existing workspace, and one role: `developer`, `reviewer`, `tester`, or `perf`. Creation saves generation 1 and a new native DSH Session identity without starting a model. `GET /v1/sessions` requires `workspace` and accepts an optional bounded `limit`; `GET /v1/sessions/:id` reads the current assignment. After an uncertain create response, read that id before retrying: an existing identity conflicts.

Submit a JSON run with `session: {id,generation}` and exactly one plan step in the assigned workspace and role. Native turns require `maxAttempts: 1` and `maxRepairs: 0`, which are their defaults; a step cannot add retries. The first turn creates the allocated Session with `--new-session-id`; later turns use `--session-id` after completed or acknowledgement-pending work has confirmed cleanup. The worker must emit one matching opening Session event. Each turn owns a fresh managed process range and joins teardown before releasing resources. Concurrent turns are refused. Failed or interrupted turns require explicit replacement rather than automatic replay. A selected protocol requiring downstream review after writing cannot fit this one-step turn; use an ordinary multi-step plan that satisfies it.

Replace with `POST /v1/sessions/:id/replace` and `{generation,handoff}`. It fences the old generation, cancels and joins its active turn, then publishes the next generation with a fresh native Session id. Unconfirmed old cleanup refuses replacement until recovery establishes that its range settled. Old history and lineage remain; only the explicit handoff is copied, and each run selects its own knowledge revisions. Old generation requests and wakeups cannot drive the successor. Read the current record after an uncertain replacement. `maxNativeSessions` and `maxSessionHandoffBytes` bound retention and handoff size. The worker profile must support the headless identity flags and retain its cwd, ownership, and preset checks.

<a id="queue-a-bounded-wakeup"></a>
### Queue a bounded wakeup

`POST /v1/wakeups` accepts `{id,run,trigger,expiresAtISO}` for one future run. The UUID identifies immutable instructions: the same request returns the retained wakeup; changed instructions conflict. `run` is the complete JSON run request with a fixed single-step plan and exact `session: {id,generation}`. Choose `{kind:"at",atISO}` for a time or `{kind:"operation",operationId,when:"settled"|"attention"}` for a retained operation in the same workspace. Expiry must be explicit and later than a scheduled time. The queue submits through ordinary admission; it never selects roles, adds tasks, or replans.

`GET /v1/wakeups` requires `workspace` and accepts an optional bounded `limit`; `GET /v1/wakeups/:id` shows state, attempts, accepted operation, and failure. `POST /v1/wakeups/:id/cancel` with `{}` persists cancellation and joins accepted work. Pending requests survive restart. The durable `wakeup:<id>` key recovers an accepted operation after a lost result; completed or failed worker execution is never replayed. Busy sessions and temporary admission limits retry within `maxWakeupAttempts` and `wakeupRetryDelayMs`; shutdown preserves pending work without spending that budget. Expiry prevents unsubmitted admission, and generation changes invalidate old requests. `maxWakeups` bounds retention; `wakeupPollIntervalMs` controls polling. Submit another explicit request for another turn; wakeups do not recur.

<a id="configure-host-policy-hooks"></a>
### Configure host policy hooks

Configure `policyHooks` on the API profile's `deep-cluster-api` row. Each entry supplies `{id,command,args,events,timeoutMs,maxInputBytes,maxOutputBytes}`; `events` contains `admission`, `tool`, or both. Executables and arguments are trusted host settings, never substituted model input. The program reads the private JSON file named by `DEEPCLUSTER_POLICY_REQUEST_FILE`, containing `{event,workspace,subject}`. Admission subjects contain the plan and selected session; tool subjects contain the tool name and arguments. Stdout must be exactly `{decision:"allow"|"deny"|"require-review",reason:"..."}`.

Hooks run in order until refusal. Errors, malformed output, nonzero exit, exceeded budgets, and timeout refuse the action; uncertain process cleanup retains ownership. `require-review` also refuses execution and requires a supervisor decision; it creates no automatic approval. Admission decisions enter the journal, and tool denials use the ordinary logged tool-result path. `POST /v1/plans/validate` checks structure without executing hooks; live admission executes them. A static worker overlay reads a fresh per-run context file, so continuation receives current policy settings.

The per-run `.deep-cluster/policy-<runId>.json` remains as immutable execution-configuration evidence. Each private `.deep-cluster/policy-inputs/<uuid>.json` is removed only after that hook's cleanup is confirmed. Unconfirmed admission-hook cleanup persists a health-visible `policy-hook` recovery issue with `blocksAdmission: true`. The API can still start and expose diagnostics, but fresh admission remains blocked until recovery verifies that the recorded native generation has settled; an API process exit alone does not clear it.

Hooks can refuse actions but cannot grant permissions, enlarge claims, rewrite plans, or allocate work. Their executables have the host's full operating-system access; this is not a security sandbox. Install only trusted programs. Allocation, evidence review, and subsequent plans remain the supervising AI's responsibility.

### Observe the dashboard

The optional [Web overlay](web.patch.yml) adds a dedicated DeepCluster page through the authenticated DSH Remote service. The map view shows each worker as a glossy white column on a graphite platform; column height follows the worker's live token rate, and smooth routed links across the platform trace recorded messages, dependency waits, and resource waits. Selecting a column or its label opens the worker card with that worker's profile, live log, and messages.

The tracks view lists workers vertically on a shared time axis. Each row places a token-rate history curve above activity clips for thinking, command, read, write, tool, starting, waiting, queued, and idle; the bold ribbon plots tokens per wall-clock second over a fading fill, and each clip is colored and patterned per activity kind with a matching legend. Gray ribbons beneath the tracks trace messages, and dashed ribbons trace dependencies.

The header view selector or keys 1 and 2 switch views. The map controls pan, orbit, zoom, and reset the camera; the track controls zoom time at the pointer, pan, scroll rows, fit, and follow live (which keeps the window at the current time even when no worker runs), and a time-zoom slider sets the visible span. Below the views, records list hardware leases, the outcome ledger, and the activity timeline.

Live tokens per second uses tokenizer-counted output deltas observed in the trailing five seconds, divided by five. The optional worker `/telemetry` plugin samples public assistant-stream events every 250 ms by default, including text, reasoning, and tool arguments without exporting their contents. It retokenizes cumulative prefixes and includes signed merge corrections. This is a local tokenizer estimate, distinct from provider billing counts; missing or failed instrumentation is unavailable. Provider input/output totals still update after completed steps and reset on each worker attempt.

Configure the worker profile with local `tokenizerFile` and `tokenizerConfigFile`, a descriptive `tokenizer` label, the matching `models` aliases, and optional `sampleIntervalMs`. Download assets from the selected model’s official repository, such as [DeepSeek V4.1 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/main), before launch. Add `@deepseek-ai/dsh-experimental-deep-cluster/telemetry` to that profile’s patch; the profile must depend on this package. A model alias mismatch reports unavailable rather than using another tokenizer.

The [telemetry patch](telemetry.patch.yml) shows the required `insert` wrapper for a new worker plugin; set its three tokenizer environment variables or replace them with local paths and a label. The [team patch](team.patch.yml) enables `cluster_message` and `cluster_inbox` when a coordinator supplies a run identity. Merge these patch operations into the worker profile. Messages stay within their run’s task list, survive worker retries, and become delivered records when the recipient’s tool retrieves them. Workers poll cooperatively between work units; messaging does not interrupt requests or change dependencies or leases. The supervisor sender identity is reserved and cannot be a plan step id, so API-origin and peer-origin messages cannot be conflated. The protocol admits at most 16,000 characters per persisted message; a worker's configured `maxMessageChars` bounds what it sends and never makes an admitted message unreadable for a smaller recipient budget.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [bundle patch](cordis.patch.yml) mounts the existing DSH subprocess provider, the DeepCluster service, and its command consumer. The [API overlay](api.patch.yml) replaces the command consumer with a loopback WebServer and the `/api` plugin. Workers launch through `dsh` profiles. The Web Remote forwards dashboard requests to the API and validates returned dashboard data; the API refuses browser-origin requests. No agent-loop, session, sandbox, or application-boot change is required: the package uses the public `subprocess`, `cmdlineArgs`/`appExit`/`appReady`, `webServer`, `typert`, tool, and client-slot services, and the `dsh` launcher owns application startup.

The [coordinator](src/coordinator.ts) validates the graph, admits ready tasks in plan order, and reserves the worktree write claim and named resource locks before dispatch. The [scope](src/scope.ts), [claims](src/claims.ts), and [repository](src/repository.ts) modules canonicalize worktree identity, publish cross-process write claims atomically, and capture read-only Git and dirty-state snapshots. The [lease implementation](src/lease.ts) publishes complete ownership files atomically and retains them through confirmed worker teardown. The [journal](src/journal.ts) serializes each writer’s appends, identifies writers and runs, and reports committed corruption. The [capability ledger](src/ledger.ts) projects terminal task evidence from that journal.

The clean-pack procedure in [scripts/pack-clean.mjs](scripts/pack-clean.mjs) prunes only root-level `lib/*.js` chunks unreachable from the manifest's runtime entries, so stale hashed build files cannot enter a later tarball. It never touches `lib/types`, and `--check` reports without deleting.

The [design reference](docs/design.md) explains the research-informed choices and verification limits. Scheduler tests use controlled completion signals and independent worker processes to exercise overlap, dependency failures, cancellation, and exclusive hardware ownership.

[Relic's plugin implementation](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/plugins/relic/relic_core/store.py) separates shared work and organization protocols from replaceable sessions; its [delivery tests](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/plugins/relic/tests/test_hook_delivery.py) preserve unread messages when context is truncated. DeepCluster uses durable knowledge, explicit revision selection, and bounded briefings while retaining supervisor-authored task graphs and cooperative mailboxes. Relic's [source README](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/README.md) distinguishes its unified Windows/macOS source candidate from published downloads; the [product page](https://www.hongyidu.ai/relic/en/plugins) and [validation record](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/docs/validation.md) are separate evidence for released features and host testing. Source availability alone does not establish complete host support.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Planner instructions](AGENTS.md) define delegation and verification responsibilities.
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/architecture.md) describes supported DSH extension points and application launch.
- [Windows failure handling](docs/windows-console-boundary.md) describes diagnosis without automatic permission escalation.

-----

<a id="model-experience"></a>
## Model Experience

### Worker requests and prerequisite evidence

#### What the model sees

Each worker receives its role rules, plan goal, assigned instructions, acceptance checks, held hardware names, available prerequisite or retry evidence, selected knowledge revisions, and any explicit session handoff. These inputs enter the child through the normal logged DSH user request. Native continuation also includes the retained conversation; replacement begins a fresh one. Knowledge bodies cannot override user or repository instructions, roles, dependencies, claims, or acceptance checks. The `[[DEEPCLUSTER]]` reporting instructions are owned by [the report protocol](src/protocol.ts); workers return checked self-reports, while separate tester and reviewer steps provide additional scrutiny.

#### Token effect

Each attempt and repair creates a separate worker request. Role instructions, task details, dependency evidence, selected knowledge snapshots, and tool results consume that worker’s context. Knowledge admission bounds snapshot bytes and does not silently truncate bodies. The controlling agent reads only the reports and artifacts it chooses; adding workers can increase total model usage.

#### KV Cache effect

Disposable workers have separate Sessions; explicitly selected native generations retain their own conversation between turns. Provider caching may reuse stable input, but DeepCluster does not guarantee shared worker KV caches or provider cache hits.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Leases coordinate cooperating processes on one host. They do not fence unrelated applications, provide multi-host scheduling, or recover GPU work outside the recorded native process range.
- Write claims coordinate cooperating DeepCluster processes, not the operating system. Arbitrary shell writes can leave the claimed paths, a clean file changed and restored between snapshots is unobservable, and ignored/generated files are not audited. A failed snapshot is reported rather than converted into a pass.
- The persistent service lifecycle and its scheduled tasks are Windows only; a WSL-launched descendant is outside the Windows process range, so its exit cannot be confirmed and the lease remains quarantined.
- Workers cooperate through task dependencies, workspace artifacts, and run-scoped peer mailboxes that recipients actively retrieve. Automatic worktree isolation and mid-run graph replanning are not implemented.
- Native conversations use DSH’s supported headless Session lifecycle, not external-agent private-session import. Wakeups execute fixed one-shot plans; policy hooks and protocol checks do not restrict operating-system access or grant peer-voted authority.
- The ledger reflects actual submitted tasks and worker reports. Small samples, changing models, and different toolchains prevent interpreting role pass rates as reliable capability guarantees.
- The dashboard reads and projects the workspace journal. Journal rotation is detected and rebuilds the observation, but journal retention and archival limits are not implemented; run-scoped cursors bound repeated reads but do not index historical runs.
- Installing a planner skill does not configure model credentials. The API retains idempotency records; reaching their configured limit rejects new submissions. After an interrupted server, inspect journals and leases before resubmitting work; incomplete operations are not resumed automatically.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
