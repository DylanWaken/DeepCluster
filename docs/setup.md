# Install DeepCluster on a fresh DSH checkout

Install DeepCluster on the computer where your coding agent runs shell commands. The API listens on loopback. At the end of setup, you'll ask a worker to read a file and check its answer against the contents.

## 1. Install the tools and build DSH

Install Git, Node.js 24 LTS with its development headers, and pnpm 11.28.5. You can install that version of pnpm with `npm install --global pnpm@11.28.5`. On macOS and Linux the DSH native addon also needs a C compiler (`cc`, or `musl-gcc` on musl Linux).

Choose a directory with room for two checkouts. Leave them in place after setup so the saved paths keep working.

DSH uses `~/.dsh` for profiles and model credentials by default. If you want an isolated installation, set `DSH_HOME` to an absolute directory outside both checkouts before you start, and use it in every terminal running DSH.

```sh
git clone https://github.com/DylanWaken/DeepCluster.git
cd DeepCluster
git clone --depth 1 --branch dsh-v0.2.1-rc.2 https://github.com/deepseek-ai/deepseek-harness.git ../dsh
node setup/install.mjs ../dsh
cd ../dsh
pnpm install --frozen-lockfile
pnpm run build
node ../DeepCluster/setup/profiles.mjs .
```

The installer checks for DSH commit `687f282e8625c6b8d11ff58211a90524be2e4317` before copying the plugin. Its patch adds DeepCluster to the build and supplies the DSH APIs for worker sessions and process recovery. The last command sets up two profiles. The coordinator uses `deep-cluster` and the workers use `cluster`. The optional dashboard runs under DSH's existing `web` profile.

## 2. Connect your coding agent and model

Stay in the DSH checkout and run the install command for your coding tool. It writes your skill and saves the worker CLI path and local addresses in `~/.deep-cluster/config.json`. Choose a personal skills directory to keep those paths private. [Install the skill for your tool](agent-skills.md#install-the-skill)

The default worker uses the `deepseek-official` provider. It reads `DEEPSEEK_API_KEY` from the environment or from DSH's private `.env` fallback. If you already use a DSH account, skip to the sign-in instructions below. Otherwise, enter your key in the shell where you'll start the API. These prompts keep the key off screen and out of shell history.

**PowerShell 7**

```powershell
$env:DEEPSEEK_API_KEY = Read-Host -MaskInput 'DeepSeek API key'
```

**Bash**

```bash
read -rsp 'DeepSeek API key: ' DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY && echo
```

### Use an existing DSH account sign-in

To let workers use an existing DSH sign-in, use the same DSH home where you signed in. Append these entries to `$DSH_HOME/profiles/cluster/cordis.patch.yml`, below the existing team entries. They enable the local credential services and select the account provider for the worker.

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

## 3. Start the foreground API

Start the API from the DSH checkout and leave its terminal open. It listens on `127.0.0.1:3789` and stores run records and resource claims under `.deep-cluster/service-state`.

**PowerShell**

```powershell
$env:DEEPCLUSTER_API_LEASE_ROOT = Join-Path $PWD '.deep-cluster/service-state'
$env:DEEPCLUSTER_API_STATE_DIRECTORY = Join-Path $env:DEEPCLUSTER_API_LEASE_ROOT 'api-state'
node apps/cli/lib/bin.js --profile deep-cluster --patch "$PWD/packages/experimental/deep-cluster/api.patch.yml"
```

**Bash**

```bash
export DEEPCLUSTER_API_LEASE_ROOT="$PWD/.deep-cluster/service-state"
export DEEPCLUSTER_API_STATE_DIRECTORY="$DEEPCLUSTER_API_LEASE_ROOT/api-state"
node apps/cli/lib/bin.js --profile deep-cluster --patch "$PWD/packages/experimental/deep-cluster/api.patch.yml"
```

Open a second terminal in the DSH checkout and run `node apps/cli/lib/bin.js --profile deep-cluster doctor`. Look for `"status": "ready"`.

If another process uses the default port, set `DEEPCLUSTER_API_PORT` before starting the server. Regenerate the skill with the matching `--api-endpoint` and use that address for the smoke test and health checks. Controllers that share a workspace or GPU must also share the same lease directory.

## 4. Run a worker

Switch to the DeepCluster repository for this test.

```sh
node tests/fresh-smoke.mjs http://127.0.0.1:3789
```

The script writes a random value to a temporary file. It asks a read-only worker to find that value, checks its answer against the file, and verifies that the worker left the file alone. It also sends the same request twice and checks that both responses identify the same run. The worker calls your configured model, so your provider may charge for this test.

To try the skill in your coding agent, ask a worker to read the repository's license. When your runs finish, stop the foreground API with Ctrl+C. [Try the license task](agent-skills.md#verify-a-worker-run)

## Optional dashboard

With the foreground API running, open a second terminal in the DSH checkout. Set `DEEPCLUSTER_WORKSPACE` to the absolute path of the project you want to watch and launch the Web profile.

```sh
node apps/cli/lib/bin.js --profile web --patch ./packages/experimental/deep-cluster/web.patch.yml --no-open --host 127.0.0.1 --port 3788
```

Open the private login URL printed by the Web process. The dashboard shows runs for the selected workspace.

### Windows managed service

On Windows, stop the foreground API and dashboard before switching to scheduled tasks. Task Scheduler starts them in the task user's environment. If you set a key or a custom `DSH_HOME` only in your terminal, the tasks may not see it. Put the key in the task user's environment or DSH home `.env`, or use the account sign-in in that DSH home.

Start and check both services from the DSH checkout.

```sh
node apps/cli/lib/bin.js --profile deep-cluster service start
node apps/cli/lib/bin.js --profile deep-cluster service status
node apps/cli/lib/bin.js --profile deep-cluster service login-url
```

Open the returned login URL locally. It contains a private login token. To stop the managed services after workers finish, run `node apps/cli/lib/bin.js --profile deep-cluster service stop`. See the [service reference](../plugin/README.md#persistent-local-service) for ownership diagnostics and recovery.
