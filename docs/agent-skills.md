# Connect the coding agent you’re using

Paste this into a local Cursor, Claude Code, Codex, or other coding-agent chat, with the project you want to work on open.

```text
Install a personal DeepCluster skill for the tool I'm using. Follow https://raw.githubusercontent.com/DylanWaken/DeepCluster/main/docs/agent-skills.md yourself, connect to my existing DSH service, and verify the skill with one read-only worker in this project.
```

**If you’re the coding agent receiving this guide, carry out the steps in your terminal.** Keep the current project’s absolute path for verification. The existing DSH installation supplies the skill generator. You can connect from any project on the service’s machine without cloning DeepCluster into it.

## Find the service

Start with the service handoff if the user supplied one. Otherwise read the saved connection on this machine and check the live API. Run this in Bash or PowerShell. It prints the relevant paths and profile names and reads no model credentials.

```sh
node --input-type=module -e "
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const home = process.env.USERPROFILE || process.env.HOME || homedir();
const config = join(home, '.deep-cluster', 'config.json');
const saved = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
const fields = ['dshPath', 'cliPath', 'serviceCliPath', 'profile', 'apiEndpoint', 'dashboardEndpoint'];
const settings = Object.fromEntries(fields.filter(k => saved[k] !== undefined).map(k => [k, saved[k]]));
console.log({ config, dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'), settings });
const url = new URL(process.argv[1] || saved.apiEndpoint || ('http://127.0.0.1:' + (process.env.DEEPCLUSTER_API_PORT || '3789')));
if (url.protocol !== 'http:' || ['127.0.0.1', '[::1]'].includes(url.hostname) === false || url.href !== url.origin + '/') throw Error('Expected a literal loopback HTTP origin');
const r = await fetch(new URL('/v1/health', url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
if (r.status !== 200) throw Error('Health returned HTTP ' + r.status);
const h = await r.json();
if (h.version !== 1 || h.status !== 'ready' || h.execution?.cli === undefined) throw Error('Unexpected DeepCluster health response');
console.log({ contacted: url.origin, admissionBlocked: h.admissionBlocked, workerProfile: h.execution.profile, workerCli: h.execution.cli, checkout: h.execution.dshPath, endpoints: h.execution.endpoints });
"
```

If the handoff names another loopback API, append its quoted origin after the closing `"` and run the probe again. You can also read **Saved connection** in an installed skill, including `$DSH_HOME/skills/deep-cluster/SKILL.md`. The API defaults to port 3789. The optional browser dashboard usually uses 3788 and has its own private login URL.

- **The DSH checkout** contains the built launcher `apps/cli/lib/bin.js`. Check the handoff, `settings.dshPath`, and the live `checkout.configured`. If those are missing, check for a checkout beside the current project, the saved `serviceCliPath`, or `dsh` on PATH.
- **The DSH home** contains `profiles/` and private user settings. Use the service’s `DSH_HOME` for the installer. Its default is `~/.dsh`. The probe shows your shell’s choice. A service using a custom home may have started in a different shell. Check its handoff or launch settings and confirm `profiles/deep-cluster/package.json` includes `@deepseek-ai/dsh-experimental-deep-cluster` in `dsh.profile.bundles`.
- **The manager CLI** loads the `deep-cluster` coordinator profile. Prefer the saved `serviceCliPath`, then the built launcher in the verified checkout, then an installed `dsh`. Verify your candidate with `--profile deep-cluster help` and look for `install` and `--skills-root`. A JavaScript entry needs `node`; invoke a native executable directly. The API’s `workerCli` can be a worker-only wrapper. Its `workerProfile` tells you which profile runs tasks.

If the API is offline, use its recorded startup method with the same DSH home and state directories. If the installation is missing, live and saved settings conflict, or several installations fit, ask for the missing path or service handoff. A remote VM or container has its own loopback and filesystem. Run these steps in the service’s environment. [Set up a new service](https://github.com/DylanWaken/DeepCluster/blob/main/docs/setup.md)

## Install the skill

Identify your client from the current session. Choose **one row** and use its personal skills root. Honor a custom root configured in the client.

| Current client | Personal skills root | Installer label | How to find and invoke it |
| --- | --- | --- | --- |
| Cursor | `~/.cursor/skills` | `Cursor` | Look in **Customize → Skills**. Select `/deep-cluster` in Agent chat. [Cursor skills](https://cursor.com/docs/skills) |
| Claude Code | `~/.claude/skills` | `Claude Code` | Open `/skills` and invoke `/deep-cluster`. [Claude Code skills](https://code.claude.com/docs/en/skills) |
| Codex | `~/.agents/skills` | `Codex` | Type `$` to select `deep-cluster`, or enter `$deep-cluster`. The CLI also lists it in `/skills`. [Codex skills](https://developers.openai.com/codex/skills/) |

For Codex, use the personal directory that the running client scans. Some installations also discover user skills under `$CODEX_HOME/skills`. If your client exposes that directory for user skills, pass its absolute path to the installer. Confirm that Codex discovers the file you just installed, especially if the project already has a skill with the same name.

Substitute the verified launcher, absolute skills root, and client label below. Expand `~` before passing the directory. Run the command from the current project. For a native DSH launcher, replace `node "/absolute/path/to/apps/cli/lib/bin.js"` with its invocation.

```sh
node "/absolute/path/to/apps/cli/lib/bin.js" --profile deep-cluster install --skills-root "/absolute/personal/skills" --command-name deep-cluster --label "your client"
```

The installer prints the skill path under `written` or `unchanged` and saves the chosen target. With an existing connection, leave all connection flags off to preserve custom ports, worker wrappers, and the separate service launcher. If the saved connection is incomplete, supply **only missing values** from the verified installation. The flags are `--dsh-path`, `--api-endpoint`, `--dashboard-endpoint`, `--cli` for the worker, and `--service-cli` for the manager. For an unsaved custom worker profile, `--profile <worker-name>` **after** `install` selects that worker setting. Leave keys, dashboard login URLs, and credential files in their existing locations.

Read `deep-cluster/SKILL.md` at the reported path and check its saved connection. Find the skill in your client’s list or invoke it by name. If live discovery needs a new chat, finish the worker check by reading the installed file, and report that discovery still needs a reload.

### Other coding tools

If your tool supports `SKILL.md`, find its documented personal skills directory, pass that as `--skills-root`, and use its name for `--label`. Otherwise, generate the file under `~/.deep-cluster/skills` and write a personal command in the tool’s native format. Its instruction can be as short as “When asked to use DeepCluster, read [absolute path to the generated SKILL.md] and follow it for this project.” A tool without personal commands can load the file as a saved prompt. Use its supported shell or HTTP client for requests.

## Verify a worker run

Use the installed skill in the **original project**. Choose an existing, non-secret text file, such as `LICENSE` or `README.md`. Substitute its relative path in this plan. Keep the expected answer out of the worker prompt.

```markdown
# Verify the DeepCluster connection
goal: Read one project file and return its fingerprint.

## Step fingerprint: Fingerprint a project file
role: reviewer
depends_on: none
access: read-only
hardware: none
acceptance:
- File fingerprint

Compute the SHA-256 of the exact bytes of LICENSE in the workspace. Include the full hexadecimal digest in the evidence for File fingerprint. Leave project files unchanged.
```

Send the plan to the verified API using the original project’s absolute path as `workspace`, one worker, one attempt, and zero repairs. Follow the installed skill’s idempotency and polling instructions until the operation settles. Independently compute the digest from the project directory.

```sh
node -e "const fs=require('node:fs'),crypto=require('node:crypto'); console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "LICENSE"
```

Check for `completed`, one passing `fingerprint` step, a matching digest in `checks`, and no unexpected changed paths or open deviations. Give the user the skill path, how to invoke it, the operation ID, and the file you checked. If admission is blocked or the model call fails, report the diagnostic and the check that remains. Model sign-in belongs to the DSH worker environment.
