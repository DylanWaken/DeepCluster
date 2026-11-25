# DeepCluster

![DeepCluster’s Tracks view showing parallel workers on a shared time axis.](docs/timeline.png)

With DeepCluster, one worker can update an API while another updates its client. A reviewer can wait for both changes and check that the client calls the new endpoint correctly. Your coding agent writes the steps as a Markdown plan. DeepSeek Harness (DSH) runs the workers on your computer and sends back one report with the evidence for each check.

![DeepCluster’s Map view showing workers and their connections in the control room.](docs/map.png)

*Three workers are running. Review is queued until they finish. Select a column in Map to see what that worker is doing.*

## Install from a DSH chat

Open DSH on the machine where you want the workers to run and send it this request.

```text
Install DeepCluster from https://github.com/DylanWaken/DeepCluster.git
Follow docs/setup.md in the version you clone. Build the plugin with DSH,
start the service, and verify it with a real worker. Give me the connection
details my coding tool will need.
```

DeepCluster's API and workers run locally. DSH sends model requests to the provider you choose. The [DSH installation guide](docs/setup.md) includes the pinned DSH version, build commands, and worker check.

## Connect your coding agent

Once the service is running, open a chat in the coding tool you want to use. Send it this request from one of your projects.

```text
Connect this coding tool to my local DeepCluster service using this guide:
https://raw.githubusercontent.com/DylanWaken/DeepCluster/main/docs/agent-skills.md
Find my DSH installation and install this tool's skill. If you can't identify
the installation, ask me where it is. Verify the connection with one read-only
worker in this project and show me how to invoke the skill.
```

| Supervisor | Personal skill directory | Try it in a new chat |
| --- | --- | --- |
| Cursor | `~/.cursor/skills` | `/deep-cluster` |
| Claude Code | `~/.claude/skills` | `/deep-cluster` |
| Codex | `~/.agents/skills` | `$deep-cluster` |

Your coding agent can use the saved DSH connection or the details from the install chat. The [agent connection guide](docs/agent-skills.md) also covers tools that use custom commands or project instructions.

For a first task, try the [sample plan](plugin/samples/parallel-plan.md). Two read-only workers inspect the installed DeepCluster package. One lists its entry points and the other lists its tests. A reviewer then names any entry points the tests missed.

## What the scheduler does

| Feature | What you can do with it |
| --- | --- |
| Dependencies | Start independent steps together. Make a test wait for the changes it exercises. |
| Shared files and GPUs | Give each writer its own files or directory. Reserve a GPU by name so two profilers can't use it at once. |
| Run reports | See what each worker tried, which files changed, and which checks need your attention. If you lose the HTTP response, retry with the same request key to retrieve the original run. |
| Live supervision | Watch the dashboard, message a worker, or cancel a run. |
| Follow-up work | Resume a named DSH session, pin a revision of a shared protocol, or schedule one follow-up when a run finishes. |

Run DeepCluster on a computer you trust. Any local, non-browser client can submit a plan without a bearer token, and workers run with your operating-system access. File claims keep cooperating writers apart. Your coding agent still needs to check the evidence before accepting a worker's result. [Plan format, HTTP API, policy hooks, and recovery](plugin/README.md)

DeepCluster is distributed under the [MIT license](LICENSE).
