# Install and verify the DeepCluster service

Give a DSH agent this instruction to set up DeepCluster on the computer that will run the workers.

> Install the service from https://github.com/DylanWaken/DeepCluster.git. Follow docs/setup.md. Reuse a compatible installation if one is already running. Set up the DSH worker, start the service under a supervisor, run the read-only smoke test, and give me the connection details for my coding tool.

If you're the DSH agent receiving the request, run these steps on the worker host. Finish by reading a newly generated value with a real worker. Cursor, Claude Code, and Codex can connect afterward.

## 1. Get the release and find an existing installation

Use Git, Node.js 24 LTS, and pnpm 11.28.5. Verify them with `git --version`, `node --version`, and `pnpm --version`. You can install the pinned pnpm with `npm install --global pnpm@11.28.5`. Linux and macOS builds also need Node development headers and a C compiler (`cc`, or `musl-gcc` on musl Linux).

Get the DeepCluster source first so the installer and smoke test come from the same release. Run these commands in a stable parent directory with room for two checkouts. Record the resulting commit. If the caller requested a particular revision, check it out in the fresh clone before continuing.

```sh
git clone https://github.com/DylanWaken/DeepCluster.git
cd DeepCluster
git rev-parse HEAD
```

For an existing checkout, compare `git remote get-url origin`, `git status --short` and `git rev-parse HEAD` with the requested repository and revision. For the current public version, resolve `git ls-remote origin HEAD`. Reuse a matching clean checkout. Choose a new sibling directory for a different revision or a checkout with local changes.

Check the current OS user, `DSH_HOME` (default `~/.dsh`), and the per-user connection file. This command prints the fields used by the launcher.

```sh
node -e "
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
const configFile = path.join(home, '.deep-cluster', 'config.json')
const saved = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}
const { dshPath, cliPath, serviceCliPath, apiEndpoint, dashboardEndpoint } = saved
console.log(JSON.stringify({
  configFile, configExists: fs.existsSync(configFile),
  dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  dshPath, cliPath, serviceCliPath, workerProfile: saved.profile || 'cluster', apiEndpoint, dashboardEndpoint
}, null, 2))
"
```

The user may already have DSH without DeepCluster. Check any checkout named in the request, your current working directory, and the launcher that started this session. A DSH source checkout contains `apps/cli/package.json` and the root `pnpm-lock.yaml`. `DSH_HOME` holds profiles and user data. A global `dsh` executable can identify the launcher, but building the plugin requires source. If you find a clean source checkout at the pinned commit below, you can build there. Otherwise create a sibling checkout in step 2 and keep the DSH installation that runs this chat available.

Probe the saved `apiEndpoint` with `GET /v1/health`. For a first install, check whether anything already occupies API port 3789 or dashboard port 3788. Use a loopback HTTP client on this computer. Replace the origin in this command with the one you found.

```sh
node --input-type=module -e "
const response = await fetch('http://127.0.0.1:3789/v1/health', {
  signal: AbortSignal.timeout(3000), redirect: 'error'
})
if (response.status !== 200) throw Error('HTTP ' + response.status)
const { version, status, admissionBlocked, activeRuns, cleanupUnconfirmed, execution } = await response.json()
console.log(JSON.stringify({ version, status, admissionBlocked, activeRuns, cleanupUnconfirmed, execution }, null, 2))
"
```

If DeepCluster is already installed, compare it with the requested release. Run the following from the DeepCluster checkout. Substitute the actual DSH path for `../dsh` and the absolute patch path where indicated. The expected DSH commit is `687f282e8625c6b8d11ff58211a90524be2e4317`. The reverse-patch check verifies the installed changes without applying them.

```sh
git -C ../dsh rev-parse HEAD
git -C ../dsh apply --reverse --check "<absolute DeepCluster checkout>/setup/dsh-v0.2.1-rc.2.patch"
node -e "
const fs = require('node:fs'), path = require('node:path')
const installed = path.join(process.argv[1], 'packages/experimental/deep-cluster')
const files = fs.readFileSync('setup/plugin-files.txt', 'utf8').trimEnd().split(/\r?\n/)
for (const file of files) {
  const expected = fs.readFileSync(path.join('plugin', file))
  if (expected.compare(fs.readFileSync(path.join(installed, file))) !== 0) throw Error('Different installed file: ' + file)
}
console.log('Matched release source files:', files.length)
" ../dsh
```

Reuse a live installation when these checks pass, health returns API version 1, and its reported launcher, checkout and worker profile agree with the saved connection. Confirm with the owner (Windows `service status`, or the host supervisor) that the process started from a successful build of this revision. Then [verify a worker](#5-verify-a-real-worker) using this release's smoke script. A stopped, matching build can proceed to [connection and startup](#3-initialize-the-service-connection-and-model).

If the source, build or running owner differs or cannot be established, build the requested revision separately. An active run or unconfirmed cleanup must settle before switching a shared connection or stopping its owner. Preserve the live service while confirming any needed replacement with its operator. For blocked admission, inspect the health issues and follow the [service recovery guide](../plugin/README.md#persistent-local-service).

If an unrelated process owns a port, choose two free loopback ports for this installation. Keep the chosen origins consistent in the connection, launcher and smoke test. A distinct `DSH_HOME` isolates DSH profiles and credentials. DeepCluster's connection file is under the **OS user's home**, even when `DSH_HOME` points elsewhere. Use a separate OS user for a second independent service. Controllers that operate on the same workspace or GPU need a common lease directory.

## 2. Build the pinned DSH runtime

Run these commands from the DeepCluster release checkout. If you found a clean DSH checkout at the pinned commit, skip the clone and substitute its path for `../dsh`. Otherwise clone into an unused sibling directory. Adjust the path to `setup/profiles.mjs` if your checkout names differ. Set any custom `DSH_HOME` before profile setup and keep it for the remaining commands.

```sh
git clone --depth 1 --branch dsh-v0.2.1-rc.2 https://github.com/deepseek-ai/deepseek-harness.git ../dsh
git -C ../dsh rev-parse HEAD
node setup/install.mjs ../dsh
cd ../dsh
pnpm install --frozen-lockfile
pnpm run build
node ../DeepCluster/setup/profiles.mjs .
```

The installer checks the DSH pin, applies the worker session and process-recovery changes, and copies the listed plugin sources. Leave the built checkout in place. Profile setup creates the `deep-cluster` coordinator and headless `cluster` worker.

## 3. Initialize the service connection and model

From the **built DSH checkout**, install DeepCluster into DSH's own skills directory. This writes the native `deep-cluster/SKILL.md` for the DSH supervisor and saves the connection at `~/.deep-cluster/config.json`. A first installation needs the absolute DSH checkout and both CLI paths. The examples use the default ports.

**PowerShell 7**

```powershell
$dcHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$dcDsh = (Resolve-Path .).Path
$dcCli = Join-Path $dcDsh 'apps/cli/lib/bin.js'
$dcApi = 'http://127.0.0.1:3789'
$dcDashboard = 'http://127.0.0.1:3788'
node $dcCli --profile deep-cluster install --skills-root (Join-Path $dcHome 'skills') --command-name deep-cluster --label DSH --dsh-path $dcDsh --cli $dcCli --service-cli $dcCli --api-endpoint $dcApi --dashboard-endpoint $dcDashboard
```

**Bash**

```bash
dc_home="${DSH_HOME:-$HOME/.dsh}"
dc_dsh="$(pwd -P)"
dc_cli="$dc_dsh/apps/cli/lib/bin.js"
dc_api='http://127.0.0.1:3789'
dc_dashboard='http://127.0.0.1:3788'
node "$dc_cli" --profile deep-cluster install --skills-root "$dc_home/skills" --command-name deep-cluster --label DSH --dsh-path "$dc_dsh" --cli "$dc_cli" --service-cli "$dc_cli" --api-endpoint "$dc_api" --dashboard-endpoint "$dc_dashboard"
```

For an existing installation, compare each saved value with the verified runtime. Preserve a custom worker wrapper or service launcher when it resolves to the verified worker or service, and keep the matching endpoints and dashboard roots. If all connection values are present and verified, refresh only DSH's skill through the saved **service CLI** with the target flags (`--skills-root … --command-name deep-cluster --label DSH`). If values are missing, add their individual connection flags to that command. Recheck the saved values before startup.

The default worker uses `deepseek-official` with `DEEPSEEK_API_KEY`. Use an existing key available to the service user through its launch environment or its private `$DSH_HOME/.env`. Check presence without displaying values. The scheduled-task or supervisor process must have access to that same credential. A variable set only in the installer's interactive shell can disappear when another process starts the API. For a shell-owned service, a missing key can be entered locally with PowerShell 7's `Read-Host -MaskInput` or Bash's `read -rsp`. For a managed service, use the service user's private DSH home or credential configuration. Keep credentials and private login URLs out of chat, command arguments, source checkouts and handoffs.

To reuse an existing **DSH account sign-in**, run workers under the same user and DSH home as the sign-in. Merge the entries below into that home's `profiles/cluster/cordis.patch.yml` once, keeping its team entries and any other settings.

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
```

## 4. Start the service

**Windows.** Use the supported DSH controller. It starts the API and dashboard in per-user scheduled tasks and can be called again to inspect or reuse a healthy installation. The service outlives the installing chat. When using a custom DSH home, the task user must resolve that same home when starting a new process.

```sh
node apps/cli/lib/bin.js --profile deep-cluster service start
node apps/cli/lib/bin.js --profile deep-cluster service status
```

Use the saved service CLI for an installation with a custom launcher. `service login-url` retrieves the private dashboard login locally. `service stop` stops the managed services after work settles.

**Linux or macOS.** Run the foreground API under an existing user-level supervisor. Its working directory is the built DSH checkout. Set the chosen port and state directories in Bash using the values from step 3.

```bash
export DSH_HOME="$dc_home"
export DEEPCLUSTER_API_PORT="${dc_api##*:}"
export DEEPCLUSTER_API_LEASE_ROOT="$dc_dsh/.deep-cluster/service-state"
export DEEPCLUSTER_API_STATE_DIRECTORY="$DEEPCLUSTER_API_LEASE_ROOT/api-state"
dc_overlay="$dc_dsh/packages/experimental/deep-cluster/api.patch.yml"
```

With a running systemd user manager, this starts a transient service and returns control to the installing agent. Use a credential already available to the worker through DSH's private home. The unit owns the process for the life of the user manager and can be stopped with `systemctl --user stop "deepcluster-api-$DEEPCLUSTER_API_PORT"`. [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)

```bash
systemd-run --user --unit="deepcluster-api-$DEEPCLUSTER_API_PORT" --working-directory="$dc_dsh" \
  --setenv=DSH_HOME --setenv=DEEPCLUSTER_API_PORT --setenv=DEEPCLUSTER_API_LEASE_ROOT --setenv=DEEPCLUSTER_API_STATE_DIRECTORY \
  "$(command -v node)" "$dc_cli" --profile deep-cluster --patch "$dc_overlay"
```

On a Mac or Linux host with tmux, the following starts the API in a detached terminal and leaves the agent's shell available. The named session keeps running until the API or tmux server exits. Use `tmux attach -t "deepcluster-api-$DEEPCLUSTER_API_PORT"` to inspect it. [tmux new-session](https://man.openbsd.org/tmux.1#new-session)

```bash
tmux new-session -d -s "deepcluster-api-$DEEPCLUSTER_API_PORT" -c "$dc_dsh" \
  -e "DSH_HOME=$DSH_HOME" -e "DEEPCLUSTER_API_PORT=$DEEPCLUSTER_API_PORT" \
  -e "DEEPCLUSTER_API_LEASE_ROOT=$DEEPCLUSTER_API_LEASE_ROOT" -e "DEEPCLUSTER_API_STATE_DIRECTORY=$DEEPCLUSTER_API_STATE_DIRECTORY" \
  "$(command -v node)" "$dc_cli" --profile deep-cluster --patch "$dc_overlay"
```

With launchd or a DSH persistent terminal, use this foreground command with the working directory and environment above. A persistent terminal owns the API while its host remains running. Open a second terminal for verification and report that lifetime in the handoff.

```bash
node "$dc_cli" --profile deep-cluster --patch "$dc_overlay"
```

For an optional Web dashboard on these hosts, set `DEEPCLUSTER_WORKSPACE` to the absolute project directory and run the following as a separate supervised process from the DSH checkout. Open the returned login URL locally. It contains a private token.

```bash
node "$dc_cli" --profile web --patch "$dc_dsh/packages/experimental/deep-cluster/web.patch.yml" --no-open --host 127.0.0.1 --port "${dc_dashboard##*:}"
```

## 5. Verify a real worker

From another shell using the service's DSH home, run `node apps/cli/lib/bin.js --profile deep-cluster doctor` in the DSH checkout. Expect `status: ready`, `admissionBlocked: false`, and the worker CLI, profile and API endpoint selected above. Then switch to the **DeepCluster repository** and test the actual API origin.

```sh
node tests/fresh-smoke.mjs http://127.0.0.1:3789
```

The script validates a plan, creates a random marker in a new temporary workspace and asks a read-only worker to read it. It checks the report against the file, verifies that the file stayed intact, and resubmits the same request to check the operation ID. This calls the configured model and can incur provider charges. Keep the operation ID and terminal result. On failure inspect the operation report and diagnose the worker's model credentials, profile or service ownership before retrying.

## Hand off to a coding tool

Give the coding agent the values from the verified installation, including the **effective DSH home**. DSH resolves this directory from the service environment. The DeepCluster connection file records the checkout, CLI paths and endpoints.

| Handoff field | Value to report |
| --- | --- |
| Source | Absolute DeepCluster checkout and Git revision |
| DSH | Absolute built checkout, pinned Git revision and effective `DSH_HOME` |
| Launchers | Absolute worker `cliPath`, service CLI (defaults to `cliPath`) and worker profile (defaults to `cluster`) |
| Connection | API origin, dashboard origin if running, and absolute path to the per-user connection JSON |
| Service owner | Windows scheduled tasks, user service name or persistent terminal, plus when it stops |
| Verification | Health result, read-only smoke operation ID and final pass/failure |

Leave the verified service available. The next agent can install its own skill and verify it from a project on this computer. [Connect Cursor, Claude Code, Codex or another tool](agent-skills.md)
