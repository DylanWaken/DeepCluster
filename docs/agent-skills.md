# Connect your coding agent

The skill gives your coding agent a way to hand work to DSH and read the result. DSH workers use their own model credentials. Your Cursor, Claude Code, or Codex account stays with the tool where you're chatting.

First build DSH and create the worker profiles. Then open a terminal in the DSH checkout, where you'll find `apps/cli/lib/bin.js`. Keep the same `DSH_HOME` you used during setup. [Install DSH](setup.md)

## Install the skill

Choose your client and run its command in PowerShell or Bash. The installer writes `deep-cluster/SKILL.md` in the skills directory and saves the connection in `~/.deep-cluster/config.json`. If you changed either port during setup, use that port here too.

### Cursor

```sh
node apps/cli/lib/bin.js --profile deep-cluster install --command-name deep-cluster --skills-root "$HOME/.cursor/skills" --label Cursor --dsh-path "$PWD" --cli "$PWD/apps/cli/lib/bin.js" --service-cli "$PWD/apps/cli/lib/bin.js" --api-endpoint http://127.0.0.1:3789 --dashboard-endpoint http://127.0.0.1:3788
```

Open a local project in Cursor and look for `deep-cluster` under **Customize → Skills**. Type `/deep-cluster` in Agent chat to use it. If you only want the skill in one project, use the absolute path to that project's `.cursor/skills` directory. Keep the skill name lowercase so it matches the directory name. [Cursor Agent Skills](https://cursor.com/docs/skills)

### Claude Code

```sh
node apps/cli/lib/bin.js --profile deep-cluster install --command-name deep-cluster --skills-root "$HOME/.claude/skills" --label "Claude Code" --dsh-path "$PWD" --cli "$PWD/apps/cli/lib/bin.js" --service-cli "$PWD/apps/cli/lib/bin.js" --api-endpoint http://127.0.0.1:3789 --dashboard-endpoint http://127.0.0.1:3788
```

Start `claude` in your project. Check that `deep-cluster` appears in `/skills`, then type `/deep-cluster` at the prompt. For a project-only installation, use the absolute path to its `.claude/skills` directory. [Claude Code skills](https://code.claude.com/docs/en/skills)

### Codex

```sh
node apps/cli/lib/bin.js --profile deep-cluster install --command-name deep-cluster --skills-root "$HOME/.agents/skills" --label Codex --dsh-path "$PWD" --cli "$PWD/apps/cli/lib/bin.js" --service-cli "$PWD/apps/cli/lib/bin.js" --api-endpoint http://127.0.0.1:3789 --dashboard-endpoint http://127.0.0.1:3788
```

Start Codex in your project. Type `$` to pick a skill, or enter `$deep-cluster` directly. The CLI also lists installed skills under `/skills`. If you installed it while Codex was open and it hasn't appeared, reopen the session. For a project-only installation, use the absolute path to its `.agents/skills` directory. [OpenAI's guide to local skills](https://developers.openai.com/codex/skills/)

After an update, run the same command again. If the skill is already current, the installer lists it under `unchanged`. Each teammate should generate their own copy because the file contains paths on the computer that created it.

## Verify a worker run

Start the local API, then check it from your coding agent's terminal. You should see HTTP 200 and a JSON health record. If the agent runs remotely or inside a container, its loopback address refers to that environment. DSH needs to be reachable there. [Start the API](setup.md)

```sh
node --input-type=module -e "const r = await fetch('http://127.0.0.1:3789/v1/health'); console.log(r.status, await r.text()); process.exitCode = Number(!r.ok)"
```

Open the DeepCluster repository as your project. Select the skill and send it this request.

> Delegate one read-only reviewer step to a DSH worker. Have it read the first nonempty line of LICENSE, with that line as its acceptance evidence. Use one attempt, no repairs, and no GPU. Wait for the report and give me the operation ID, status, and the line the worker read.

Look for an `operationId` and a reviewer entry under `steps`. Its evidence should include `MIT License`, the first line of the file. If the run fails, read the report's `error` and `failure` fields. For a model authentication error, check the credentials available to the DSH worker. [Compare the answer with LICENSE](../LICENSE)

## Ask an AI to integrate another tool

If your tool reads `SKILL.md`, the installer can write a skill for it directly. Other tools can load that file from a custom command or from their project instructions. The tool needs a terminal or HTTP client on the machine running the API. Paste this prompt into your tool and fill in the three bracketed values.

```text
Connect [tool name] to DeepCluster. My prepared DSH checkout is [absolute DSH path]
and my DeepCluster checkout is [absolute DeepCluster path]. Use the DSH_HOME
configured for these profiles. Use this tool’s documented personal skill
directory and invocation syntax. Read docs/agent-skills.md and plugin/README.md
in the DeepCluster checkout, and confirm this tool can send a local HTTP request
to my configured API's /v1/health.

Use the DSH deep-cluster profile's install command shown in the guide. Generate
a skill named deep-cluster, supply my tool's absolute skills root and label,
and use my configured loopback endpoints. If the tool uses a different
instruction format, generate SKILL.md in a local directory and create a native
command or project instruction that reads it when I request DeepCluster.

Preserve the generated plan format, dependency and write declarations, stable
idempotency key for retries, polling, and report checks. Keep the original
permissions and local-only connection. Store model credentials in DSH.

Verify discovery from this tool. Use the skill to submit the LICENSE reviewer
task in the DeepCluster checkout, inspect the terminal report, and compare the
worker's evidence with LICENSE. Give me the installed path, invocation,
operation ID and observed result. Report any check the tool could not perform.
```
