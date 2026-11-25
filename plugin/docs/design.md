---
description: "Design reference for DeepCluster task scheduling, cooperative leases, and observed capability evidence."
kind: "reference"
---

# DeepCluster execution design

English | [中文](design.zh.md)

## Summary

DeepCluster schedules explicit task graphs through existing DSH execution profiles. Its design favors bounded parallelism, observable failure, and independent verification tasks. This page separates findings in the cited research from the engineering choices used by this implementation.

## Table of Contents

- [Research basis](#research-basis)
- [Agent Orchestrator comparison](#agent-orchestrator-comparison)
- [Task scheduling](#task-scheduling)
- [Durable conversations and scheduled turns](#durable-conversations-and-scheduled-turns)
- [Resource ownership](#resource-ownership)
- [Version control and write ownership](#version-control-and-write-ownership)
- [Evidence and collaboration](#evidence-and-collaboration)
- [Dev Note](#dev-note)

<a id="research-basis"></a>
## Research basis

[Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296), revised in April 2026, evaluates 260 configurations and finds that coordination benefits depend on task structure; sequential planning can degrade with more agents, while architectures with central verification propagate fewer errors. DeepCluster’s inference from this result is to parallelize declared independent tasks and retain a controlling planner, rather than automatically increase worker count for every task. The paper does not establish that this scheduler is optimal.

[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) analyzes more than 1,600 traces and groups failures into system design, inter-agent alignment, and task verification. DeepCluster uses explicit acceptance labels, bounded repair attempts, failed-prerequisite blocking, and separate tester/reviewer roles as engineering responses to these categories. These mechanisms constrain workflow behavior; they do not establish the truth of an agent’s report.

[An LLM Compiler for Parallel Function Calling](https://arxiv.org/abs/2312.04511) separates planning, task fetching, and parallel execution. DeepCluster adopts the dependency-ready dispatch pattern for long-running workers. It does not use the paper’s planner or claim its reported benchmark improvements.

[etcd’s concurrency API](https://etcd.io/docs/v3.6/dev-guide/api_concurrency_reference_v3/) associates lock ownership with leases and exposes a lock key for transaction ownership checks. GPU command execution lacks an equivalent fencing transaction in this plugin. DeepCluster therefore treats lease expiration as a diagnostic signal rather than permission to start another GPU worker. This is a local implementation decision, not a distributed lease protocol.

<a id="agent-orchestrator-comparison"></a>
## Agent Orchestrator comparison

[Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) manages coding-agent sessions through a persistent daemon. The comparison below follows its published source and documentation; it does not establish local execution or feature parity. DeepCluster keeps task decomposition, worker allocation, acceptance, replanning, and responses to CI or review feedback with the supervising AI. Its deterministic scheduler executes the submitted graph and budgets.

| Capability | Agent Orchestrator reference | DeepCluster behavior |
|---|---|---|
| Planning and allocation | A project agent plans work and starts workers, as described in its [README](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/README.md). | The supervising AI submits explicit dependencies, roles, acceptance checks, and resource claims; the graph stays fixed during a run. |
| Observation and attention | [Replayable events](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/httpd/events.go) and a [durable notification service](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/service/notification/service.go) support catch-up and acknowledgement. | Journal cursors support incremental reads; the run listing exposes retained operations and derived attention reasons without acknowledging or changing them. |
| Feedback | [Lifecycle reactions](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/lifecycle/reactions.go) deduplicate CI, review, and conflict nudges. | Run-scoped supervisor and peer mailboxes carry explicitly submitted feedback. DeepCluster does not observe CI or review systems or dispatch repairs from their events. |
| Workspace isolation | A [workspace adapter](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/adapters/workspace/gitworktree/workspace.go) manages per-session Git worktrees. | Cooperative path claims permit disjoint writers in an existing workspace; DeepCluster does not create or integrate worktrees. |
| Worker sessions | Its [architecture](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/architecture.md) describes multiple agent adapters, persistent conversations, and detached provider hosts. | Supervisors may select durable DSH conversations for explicit single-step turns. Replacement creates a fresh native Session after confirmed old-worker settlement and copies only the explicit handoff. Disposable attempts remain available; interrupted operations are not replayed. |
| Service recovery | Its [architecture](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/architecture.md) separates controller generations from detached provider hosts. | Any configured harness can request Windows service startup. Durable launch records, exact process identities, and native range receipts support reconciliation and stale-owner recovery without replaying tasks. |
| Operator access | Its [status document](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/STATUS.md) describes desktop and mobile interfaces; cloud availability depends on the build, account, and control plane. | The optional DSH dashboard observes local workers; DeepCluster does not provide mobile pairing or multi-host execution. |

The useful distinction is between collecting facts and choosing work. A run may need attention because cleanup is unconfirmed, execution was interrupted, a deviation needs a decision, a task failed, or a write audit found a problem. Those reasons help the supervising AI choose its next read or plan; they neither verify a worker's report nor authorize a retry. [The API reference](../README.md#lease-hardware-and-inspect-outcomes) defines listing and journal semantics.

<a id="task-scheduling"></a>
## Task scheduling

The planner supplies a static directed acyclic graph. Missing dependency metadata preserves document-order execution. Explicit independent roots can overlap up to `maxConcurrency`; ready tasks are admitted in document order. Unknown references, cycles, duplicate ids, and invalid attempt budgets fail before any worker launches. No latency estimates or speculative task-value scores influence scheduling.

Batch composition prefixes each plan’s task identifiers and resolves its local dependencies before joining the graphs. Independent plan roots therefore remain independent, even when the first step omits dependency metadata. All graphs share the concurrency budget and resource namespace. Each task retains its source plan title and goal for prompts and ledger evidence.

Each task owns its attempts and repair budget. A passing repair allows another attempt without charging the ordinary attempt budget; every actual main-role invocation still increments the recorded attempt count. Repair workers acquire the same task resources. Failure blocks descendants by default; `dependency_policy: settled` instead waits for terminal prerequisite outcomes and admits a diagnostic reviewer or tester after a failure. A settled step receives the failed prerequisite evidence but cannot relabel that work or turn the overall failed run green. Independent tasks continue. Cancellation stops new dispatch and waits for running workers to settle; a cancelled step reports its phase instead of a fabricated missing report, and cancellation does not consume a retry.

Prerequisite summaries and reported checks enter the next worker’s ordinary DSH user request, making that model-visible handoff part of the child Session. Detailed artifacts remain in assigned workspace files. The graph is fixed for the duration of a run; changes require a new plan and run.

<a id="durable-conversations-and-scheduled-turns"></a>
## Durable conversations and scheduled turns

A persistent assignment separates its supervisor-owned identity and role from its native Session id, replacement generation, and process ownership generation. Admission saves the exact selection before launching a supported headless profile. Native turns use one step, one attempt, and no repair; the supervisor decides each subsequent turn. Replacement fences the old generation and requires joined teardown or exact settled-generation recovery evidence before allocating a fresh Session. Private history remains in the old Session; the successor receives explicit handoff text and independently selected [knowledge revisions](../README.md#share-knowledge-between-runs). Conversation continuity does not transfer claims or weaken plan validation.

The durable wake queue holds a fixed run request, exact session generation, one time or retained-operation trigger, and an expiry. It dispatches through ordinary admission using a stable idempotency key. Restart can recover an accepted operation without submitting new work under another key; worker failure never authorizes replay. Transient admission refusal has bounded retries, and cancellation is retained before joining late admission. The supervising AI chooses the plan and trigger; the queue cannot select workers, rewrite dependencies, or invent follow-up work. [The usage guide](../README.md#queue-a-bounded-wakeup) defines request and observation details.

Host policy hooks run fixed trusted programs before admission or tool execution and can only refuse or delegate to the normal pipeline. They receive structured action data rather than command interpolation. A static worker overlay loads the current run's policy context while native conversation history remains unchanged. Decisions enter the journal and ordinary tool-result logging; malformed results and execution failures refuse the action. Hook code has full host access, so policy decisions are workflow checks rather than an operating-system sandbox or a source of new permissions. [Configuration and limits](../README.md#configure-host-policy-hooks) remain deployment-owned.

<a id="resource-ownership"></a>
## Resource ownership

Each coordinator reserves conflicting resource names before admitting a task. Cross-process admission uses timestamped waiter tickets and atomic publication of a fully written ownership file. Resources are acquired in stable name order. Ties between tickets created in the same millisecond are resolved by their identifiers; exact arrival order is not promised.

The default hardware namespace is the master directory under the saved `dshPath`, shared across workspaces on this computer. Separate accounts or alternate lease roots require an explicitly shared directory. Hardware names must identify the same device consistently. A workspace resource is an exact-name lock; named resources are additive and never replace the worktree write claim described below. Planners must assign matching names to conflicting resource use and account for path aliases through the canonical write claim.

A runner settles only after managed process termination and descendant exit observation supported by the host's containment proof. Unknown cleanup retains the lease and aborts further dispatch in that run. Startup preserves uncertain active claims: known paths and resources block conflicting work, while unknown scope blocks fresh admission without hiding the inspection API. A WSL-launched Linux process is outside the Windows process range even on the native path; its exit cannot be observed, so the lease stays quarantined until an operator confirms termination. A dead coordinator PID alone does not establish that its descendants stopped; retained ownership requires the persistent service’s [startup recovery evidence](../README.md#persistent-local-service). The ownership file is a cooperative scheduling lock, not an operating-system restriction on unrelated GPU applications.

Corrupt ownership records fail closed. A live lease cannot expire into a second owner. Renewal atomically replaces diagnostic metadata; callers must serialize renewal and release for the same ownership token. Recovery quarantines abandoned files only after establishing quiescence; legacy uncertainty requires operator confirmation.

<a id="version-control-and-write-ownership"></a>
## Version control and write ownership

Each run resolves the workspace through its closest existing ancestor and real path, then records the physical worktree, Git top level, shared common directory, branch, HEAD, and the staged, dirty, and untracked path set. Git probes are read-only and set `GIT_OPTIONAL_LOCKS=0`; DeepCluster never commits, resets, stashes, cleans, or rebases. The staged set is read with `git ls-files --stage` and compared by entry content identity, so re-staging changed content, unstaging, and staged deletion are detected even when the porcelain status letter stays `M`. Worker instructions require preserving the recorded state, and post-step and final snapshots compare observed changes and claimed paths.

Write claims default to exclusive whole-worktree access when a step omits `access`. `access: read-only` declares no source writes and takes no write claim, while `access: write` with `writes:` reserves only the listed literal repository-relative paths; a trailing `/` covers descendants. Globs, absolute and drive-qualified paths, UNC paths, backslashes, `..` or `.` segments, `.git`, `.deep-cluster`, reserved Windows names, and symlink or junction escapes outside the worktree are rejected. Resources add exact-name locks and never replace the claim; `resources: none` does not opt out. `git: write` requires whole-worktree access, a real Git worktree, and the shared common-directory lock; it records permission to mutate Git metadata, not an instruction to do so.

Claims are acquired under one short cross-process registry mutex, published with unique exclusive files, renewed while held, and never replaced merely because their deadline expired or their PID appears dead. Overlap uses canonical absolute spans, so parent and child workspaces, nested repositories and submodules, and an outside non-Git ancestor containing the file conflict with each other, while separate physical worktrees may run concurrently. Git metadata is a separate accounting namespace and serializes through the shared common-directory claim. On Windows, the registry mutex uses a named pipe released by the operating system at owner exit. Ordinary admission waits for the configured bound; legacy directory mutexes require verified recovery. Released claims are retained at `<leaseRoot>/claim-history.json` for 1,000 releases or 12 hours; an audit window that starts before the recorded `prunedThrough` reports an unattributable change instead of naming a worker. Expiry or a dead PID alone never releases ownership.

The enforcement limit is explicit: a claim is a cooperative scheduling lock, not a sandbox. An arbitrary shell can write outside its declared paths. `access: read-only` is a declaration; when an active claim covers the changed path, snapshots cannot identify which writer changed it. A snapshot uses one read-only `git status --untracked-files=all`, one `git ls-files --stage`, and SHA-256 of pre-existing changes and claimed files, never a whole-tree hash, so a clean file changed and restored between snapshots, ignored or generated files, and other unobservable writes are not reported. HEAD, branch, and index entries are observed; reflogs, other refs, packed-refs, config, logs, index extensions and flags, and arbitrary common-directory files are not content-fingerprinted. A failed snapshot or detection step is visible and never becomes a pass.

<a id="evidence-and-collaboration"></a>
## Evidence and collaboration

The append-only journal identifies each run and writer. Sequence numbers belong to one writer rather than a global clock. Concurrent tasks using one writer append serially; readers reject corrupt complete records and ignore an incomplete final append. A journal write failure stops the operation instead of reporting an unrecorded success.

Each completed model step can append provider input/output token counts and observed response duration as `agent/usage`. Live throughput instead uses `agent/token-sample`: signed output-prefix token changes from the worker’s public `agent/assistant-stream` hook, observed by the controller and summed over the trailing five seconds. [Hugging Face Tokenizers.js](https://github.com/huggingface/tokenizers.js) encodes explicitly configured local model assets; this estimate excludes protocol special tokens and may differ from provider billing. Runtime tokenizer failures emit `agent/token-error` and disable counting for that stream; a later supported stream can recover. No text or reasoning content enters these numeric records. Usage, sample, error, and activity records drain before worker completion.

The ledger projects terminal task results into bounded examples and role counts. It retains acceptance labels, reported checks, summaries, duration, and success/failure/blocked status. A passing report requires affirmative evidence text and a successful worker exit, but that text is still a self-report. Independent tests, measured artifacts, and the controlling agent’s review determine whether a delivered result is trustworthy.

The planner should compare similar tasks, model settings, tools, and hardware before delegating from ledger examples. Small or biased samples cannot support a calibrated ability threshold. DeepCluster deliberately exposes examples rather than automatically promoting a role based on its pass rate.

Collaboration uses explicit graph dependencies, durable artifacts, and optional run-scoped peer mailboxes. Prerequisite summaries entering a dependent prompt generate directed handoff records. Worker tools publish messages atomically and retrieve them cooperatively; sent and retrieved receipts are distinct journal records. Retrieval is not proof that a model acted on a message. Retry processes can read earlier messages again. A supervisor on this computer may publish feedback to one exact run participant through `POST /v1/runs/<operationId>/messages`; the recipient still retrieves it explicitly, and the reserved sender identity cannot be a plan step id. The protocol ceiling is 16,000 characters per persisted message, so a smaller per-worker send budget cannot make an admitted message unreadable. Messages cannot change dependencies or transfer leases, and no wakeup is implied. Distributed ownership, dynamic graph rewriting, automatic workspace isolation, and journal retention are outside the implemented behavior.

<a id="dev-note"></a>
### Dev Note

Candidate extensions, not implemented behavior: prioritize CI and review observation that returns deduplicated facts to the supervising AI; per-step selection from explicitly configured worker profiles; and optional supervisor-requested worktrees with explicit integration ownership. Each needs its own acceptance evidence. Automatic allocation, autonomous Git changes, and unsupervised event-triggered repair loops are outside these candidates.
