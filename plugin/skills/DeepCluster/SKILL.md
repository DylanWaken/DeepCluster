---
name: "DeepCluster"
description: >-
  Delegate small tasks and routine operations to local DSH workers, including file discovery,
  focused reads, searches, routine edits, tests, builds, lint, data collection, log
  inspection and profiling. Use when asked to delegate or when a worker can perform
  a bounded task whose result you can check.
---
# DeepCluster

Installed for this harness. DeepCluster runs bounded plan steps on DSH worker agents on this computer and returns a compact evidence report. You own scope, acceptance, verification, and the final answer; workers own execution.

## Ensure the service

The API accepts local non-browser requests without credentials. Check `GET <apiEndpoint>/v1/health` from your terminal. If the foreground API is offline, open a separate terminal in `<dshPath>` with the same DSH home, model credentials, and state directories as the original installation. Use the block for your shell and leave that terminal open. If a service manager owns the API, use its configured startup command.

```bash
export DEEPCLUSTER_API_LEASE_ROOT="${DEEPCLUSTER_API_LEASE_ROOT:-$PWD/.deep-cluster/service-state}"
export DEEPCLUSTER_API_STATE_DIRECTORY="${DEEPCLUSTER_API_STATE_DIRECTORY:-$DEEPCLUSTER_API_LEASE_ROOT/api-state}"
export DEEPCLUSTER_API_PORT="${DEEPCLUSTER_API_PORT:-3789}"
node apps/cli/lib/bin.js --profile deep-cluster --patch "$PWD/packages/experimental/deep-cluster/api.patch.yml"
```

```powershell
if (!$env:DEEPCLUSTER_API_LEASE_ROOT) { $env:DEEPCLUSTER_API_LEASE_ROOT = Join-Path $PWD '.deep-cluster/service-state' }
if (!$env:DEEPCLUSTER_API_STATE_DIRECTORY) { $env:DEEPCLUSTER_API_STATE_DIRECTORY = Join-Path $env:DEEPCLUSTER_API_LEASE_ROOT 'api-state' }
if (!$env:DEEPCLUSTER_API_PORT) { $env:DEEPCLUSTER_API_PORT = '3789' }
node apps/cli/lib/bin.js --profile deep-cluster --patch "$PWD/packages/experimental/deep-cluster/api.patch.yml"
```

For a Windows installation using DeepCluster's managed service, run this in PowerShell from the DSH checkout when the connection fails. It starts the API and dashboard or reuses the existing service.

```powershell
& 'dsh' --profile deep-cluster service start
```

Recovery retains claims for workers whose termination is uncertain. When health shows `recoveryIssues[].blocksAdmission`, new runs can fail with `recovery-admission-blocked`. Inspect the reported issue and preserve the ownership records. Interrupted work needs a supervisor decision before resubmission.

## Delegate in one request

Write the plan to a file (for example `<workspace>/.deep-cluster/plan.md`). Choose a unique request key and save it beside the plan before submitting; replace `<request-key>` below with that value. Submit and receive the report in the same request:

```powershell
Invoke-RestMethod -Method Post -Headers @{ 'Idempotency-Key' = '<request-key>' } -ContentType 'text/markdown; charset=utf-8' -InFile <plan.md> "<apiEndpoint>/v1/runs?workspace=<url-encoded absolute workspace>&maxConcurrency=3&maxAttempts=1&maxRepairs=0&wait=1800&view=report" | ConvertTo-Json -Depth 6
```

```sh
curl -s --data-binary @<plan.md> -H 'Idempotency-Key: <request-key>' -H 'Content-Type: text/markdown' '<apiEndpoint>/v1/runs?workspace=<url-encoded absolute workspace>&maxConcurrency=3&maxAttempts=1&maxRepairs=0&wait=1800&view=report'
```

In PowerShell, encode the workspace with `[uri]::EscapeDataString('<absolute workspace>')`. `wait` holds the response up to that many seconds until the run settles. If the returned status is still active, repeat with `GET <apiEndpoint>/v1/runs/<operationId>?wait=1800&view=report`. Run the request in the background when your shell timeout is shorter than the wait.

After a lost response, resend the same key, plan, and options to recover the accepted operation without duplicating work. A changed plan or intentional new run needs a new key.

## Plan format

```markdown
# <title>
goal: <outcome of the whole plan>

## Step <id>: <title>
role: developer | tester | reviewer | perf
depends_on: none
access: read-only
hardware: none
acceptance:
- <short label of one checkable result>

<instructions: exact paths, commands, artifacts to write, and what not to touch>
```

- Metadata precedes `acceptance:`; instructions follow after a blank line. Each step is a separate prompt, so repeat the paths and limits it needs.
- Omitted `depends_on` means the previous step must pass; `none` runs independently; otherwise list step ids.
- Omitted `access` reserves the whole worktree. Use `access: read-only`, or `access: write` with `writes: path/a.ts, dir/` (repository-relative, forward slashes) for disjoint concurrent writers.
- Declare `hardware: gpu0` on every step that touches the GPU, including tests and profilers; `hardware: none` forbids GPU use.
- Make tester and reviewer steps depend on implementation.

## Review the report

Each step reports `status`, `attempts`, `summary`, `checks` (every acceptance label with the worker's evidence), `changed` (paths the audit saw change during the step, including concurrent writers), and `auditProblem` (undeclared or unobservable writes). `open` lists plan deviations awaiting your decision; `failure` holds the tail of the failing output.

- Qualify a step from its checks and changed paths. Checks are worker self-reports: spot-check one cheap, decisive fact before relying on a result, and label unverified claims as worker-reported.
- `needs-ack`: read the step's `improvisation`, then POST <apiEndpoint>/v1/ack with JSON `{"workspace":"<absolute workspace>","id":"<open id>","reject":false,"note":"<decision>"}`. Resolving the last one makes the run `completed`, or `failed` when any was rejected.
- Failed or blocked: narrow the task or fix the plan and resubmit. Never lower acceptance to manufacture a pass.
- Cancel with POST <apiEndpoint>/v1/runs/<operationId>/cancel and body `{}`; it returns after worker teardown.
- Before planning similar work, GET <apiEndpoint>/v1/ledger?workspace=<url-encoded>&tail=20 returns the newest outcomes per role, including failures.

## Supervise multiple runs

- Discover retained runs with GET <apiEndpoint>/v1/runs?limit=20; add `workspace=<url-encoded>`, `status=running`, or `attention=true` to narrow the list. Follow a non-null `cursor` as the URL-encoded `after` value with the same filters while `more` is true. Restart the listing for fresh attention decisions; pages are a live inventory, not an event feed.
- Read a selected run's report before acting. Attention flags identify failed work, pending deviations, interrupted execution, audit problems, or unconfirmed cleanup. Reading a flag neither acknowledges a deviation nor proves cleanup. Keep allocation, acceptance, retry budgets, and replanning with the supervising AI.
- For incremental evidence, GET <apiEndpoint>/v1/journal?workspace=<url-encoded>&runId=<runId>&limit=20, then continue with its URL-encoded `after` cursor. If `reset` is true, inspect the replacement history before relying on earlier observations.
- Send bounded guidance to an active run with POST <apiEndpoint>/v1/runs/<operationId>/messages and JSON `{"toStepId":"<step-id>","message":"<guidance>"}`. Delivery requires the worker's `cluster_inbox` call; it does not wake a worker or change its claims, dependencies, or permissions.
- Treat CI failures and review comments as evidence to verify against the current revision. Decide whether an active worker can handle them within its assignment, continue an assigned native conversation, or submit a new bounded plan with explicit evidence and a new request key. DeepCluster does not watch PRs or merge changes.

## Reuse workspace knowledge

- Before planning, GET <apiEndpoint>/v1/briefing?workspace=<url-encoded>&limit=20 for bounded run and knowledge summaries, full attention counts, and truncation flags. GET <apiEndpoint>/v1/knowledge?workspace=<url-encoded> lists latest record summaries; GET <apiEndpoint>/v1/knowledge/<id>?workspace=<url-encoded>&revision=<number> reads the selected content. These reads do not acknowledge or dispatch work.
- Save reusable documents or lessons with POST <apiEndpoint>/v1/knowledge?workspace=<url-encoded> and JSON `{id,expectedRevision,kind,title,body,...}`. Generate a UUID and use revision 0 to create; updates require the current revision and replace the full content. Lessons require `evidence:[{operationId,stepId?}]` from retained, non-active runs in the same workspace. A failed run can support a lesson; inspect its evidence before trusting the conclusion.
- Protocol content starts proposed. Explicitly adopt or retire it with POST <apiEndpoint>/v1/knowledge/<id>/transition?workspace=<url-encoded> and `{expectedRevision,state:"adopted"|"retired"}`. Edits require fresh adoption. Knowledge is shared only within this API state directory and workspace; any accepted local caller can mutate it, so adoption is not authentication or a permission grant.
- To supply knowledge to workers, submit a JSON run request with `knowledge:[{id,revision}]` alongside `workspace` and `plans`; text submissions do not select it. Validate the same JSON with POST <apiEndpoint>/v1/plans/validate first. Protocols must be the currently adopted revision. Complete snapshots enter the recorded worker context; later edits or retirement do not change admitted runs. The same request key returns the original snapshots; changed selections need a new key.
- A selected protocol's `requireReviewAfterWrites` constraint requires a downstream, explicitly read-only reviewer or tester for every writable step and requested role. All `requiredAcceptanceLabels` must occur together on one qualifying review per role and writer. You allocate these steps; validation never adds them. GET <apiEndpoint>/v1/knowledge/<id>/usage?workspace=<url-encoded>&revision=<number>&limit=20 lists retained selections, not proven application or compliance.

## Continue or replace native workers

- Create an assignment with POST <apiEndpoint>/v1/sessions and `{id,workspace,title,role,handoff?}`: generate a UUID, use an absolute existing workspace and a specialist role. Creation starts no model. GET <apiEndpoint>/v1/sessions?workspace=<url-encoded>&limit=20 lists assignments; GET <apiEndpoint>/v1/sessions/<id> reads the current generation and native identity. Read after an uncertain create response; existing IDs conflict.
- Submit a JSON run with `session:{id,generation}`, exactly one step in that assignment's workspace and role, `maxAttempts:1`, and `maxRepairs:0`. These are native-turn defaults. Later settled successful turns resume the exact stored DSH Session. One generation owns at most one turn; failed or interrupted turns require replacement. Disposable runs remain available when no session is selected.
- Replace with POST <apiEndpoint>/v1/sessions/<id>/replace and `{generation,handoff}`. It fences, cancels, and joins old work before publishing a new generation and native Session. Only your explicit handoff carries over; select knowledge again. Old history remains intact, and old-generation requests cannot drive the successor. Read the assignment after an uncertain response before deciding what to do next.

## Queue bounded wakeups

- POST <apiEndpoint>/v1/wakeups with `{id,run,trigger,expiresAtISO}`; `run` is your complete fixed JSON run request including an exact native session generation. Use `trigger:{kind:"at",atISO}` or `{kind:"operation",operationId,when:"settled"|"attention"}` for a retained operation in the same workspace. Supply a future expiry later than a scheduled time. The queue executes your plan through ordinary admission; it does not allocate or replan.
- Reusing the same UUID with identical instructions returns the retained wakeup; different instructions conflict. GET <apiEndpoint>/v1/wakeups?workspace=<url-encoded>&limit=20 lists records; GET <apiEndpoint>/v1/wakeups/<id> reports state and accepted operation. POST <apiEndpoint>/v1/wakeups/<id>/cancel with `{}` persists cancellation and joins accepted work.
- Pending wakeups survive restart. Busy sessions and temporary admission limits retry within configured bounds; accepted execution is not replayed after failure or a lost response. Replacement invalidates an old-generation wakeup. Expiry stops unsubmitted admission. Each wakeup is one-shot: schedule another explicit request for another turn.

## Respect host policy decisions

- Host-configured `policyHooks` check live admission and tool execution using trusted fixed executables and arguments. Only `allow` continues; `deny`, `require-review`, errors, and exceeded budgets refuse the action. Inspect the recorded reason and revise the plan or request the appropriate supervisor decision; never widen permissions to bypass it.
- Plan validation checks structure without running policy programs. Tool denials are logged through the normal tool result. Hook executables have full host access and are not a security sandbox; their decisions cannot grant permissions, change claims, or allocate tasks. Configure trusted hooks through the API profile as documented in the README.

## Rules

- Delegate routine work by default: discovery, focused reads, searches, routine edits, tests, builds, lint, data collection, and log or profile analysis. Keep design, security judgment, and final integration yourself.
- Group tiny operations into one step; run independent steps in parallel with `depends_on: none`.
- DeepCluster never commits, resets, stashes, cleans, or rebases, and workers preserve existing Git state. Write claims coordinate workers; they are not a sandbox, and workers run with full access.
- Attribute work to DeepCluster only when its workers did it. Report measured results only; GPU performance claims state device, precision, sizes, timing method, and correctness tolerance.
- For a Windows managed dashboard, replace `service start` with `service login-url` in the PowerShell command above to obtain the private dashboard link for the user.

Reference: the package README covers recovery, ownership, journals, knowledge, native sessions, wakeups, and host policy configuration.

## Saved connection

apiEndpoint: (not configured)
dashboardEndpoint: http://127.0.0.1:3788
dshPath: (not configured)
cliPath: dsh
serviceCliPath: (not configured; service uses cliPath)
dashboardWorkspace: (not configured)
dashboardWorkspaces: (not configured)

Reinstalling regenerates this file from `~/.deep-cluster/config.json` and preserves these values. If no endpoint or dshPath is configured, ask the user for one before delegating.
