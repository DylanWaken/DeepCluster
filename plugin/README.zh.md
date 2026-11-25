---
description: "向 DSH 工作代理委派有界任务，支持依赖调度、共享硬件租约、结果示例和实时仪表盘。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-deep-cluster

[English](README.md) | 中文

## 概述

DeepCluster 让控制代理将范围明确的实现、测试、审查、数据收集和性能分析任务委派给 DSH 工作代理。监督方选择计划、知识、持久会话和有界的后续工作；协调器通过依赖调度、独占资源和可选宿主策略检查执行这些选择。已记录的结果和可选仪表盘支持后续决策。工作代理使用已配置的 DSH 执行 profile；报告仍需独立审查。

## 目录

- [快速开始](#quick-start)
- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="quick-start"></a>
## 快速开始

首次安装请按 [DeepCluster 安装指南](https://github.com/DylanWaken/DeepCluster/blob/main/docs/setup.md) 构建指定版本的 DSH，并应用本插件所需的会话和子进程补丁。下方的包级命令要求 DSH 宿主已包含这些更改。

先安装受支持的 `dsh` 发行版。本包面向同一 `0.2.1-rc.2` 发行版，要求 Node `^22.19.0 || >=24.0.0`；请从本地 tarball（[构建与打包](#build-pack-and-host-requirements)）或匹配的已发布发行版获取本包，本文不假定它已发布到注册表。托管生命周期仅支持 Windows；其他平台请通过自己的监督进程运行 API 和仪表盘。

按顺序使用同一套安装步骤：

1. 将本包安装到 API 的 `deep-cluster` profile 和仪表盘的 `web` profile。API profile 还需要 [api.patch.yml](api.patch.yml) 插入的宿主 WebServer。`dsh plugin` 会初始化缺失的 profile，并为声明 `dsh.bundle` 的包更新 `dsh.profile.bundles`；参见[安装到 dsh profile](#install-into-dsh-profiles)。

   ```sh
   dsh plugin --profile deep-cluster add <package-spec> <host-webserver-spec>
   dsh plugin --profile web add <package-spec>
   ```

2. 为任意 harness 安装 `/DeepCluster` 技能，并在同一命令中保存连接。API 和仪表盘端点以及 DSH 安装目录必须在首次启动服务前保存；参见[为任意 harness 安装技能](#install-the-skill-for-any-harness)。如果已保存的工作代理 `cliPath` 是仅用于工作代理的包装器，还要传入 `--service-cli <absolute-dsh-cli>`；持久化启动器会用该 DSH CLI 启动 `--profile deep-cluster` 和 `--profile web`，而工作代理继续使用 `cliPath`。

   ```sh
   dsh --profile deep-cluster install --skills-root <absolute-skills-dir> --api-endpoint http://127.0.0.1:3789 --dashboard-endpoint http://127.0.0.1:3788 --dsh-path <absolute-dsh-install-dir>
   ```

3. 从控制代理自己的 shell 启动持久化服务，并读取其私有登录 URL。首次启动还会验证经过身份验证的仪表盘；参见[持久化本地服务](#persistent-local-service)。

   ```sh
   dsh --profile deep-cluster service start
   dsh --profile deep-cluster service login-url
   ```

不带连接参数重新安装技能会保留已保存的端点、DSH 安装目录、仪表盘根目录以及两条 CLI 路径；安装从不读取或存储凭据。`--planner cursor|codex|all` 保留预设根目录；`--skills-root` 不能与 `--planner` 同时使用，`--label "<名称>"` 为生成文本命名 harness。

<a id="use-this-package"></a>
## 使用本包

<a id="install-into-dsh-profiles"></a>
### 安装到 dsh profile

`dsh plugin --profile <name> add ...` 在 `$DSH_HOME/profiles/<name>` 中运行 pnpm，并同步 `dsh.profile.bundles`；缺失的 profile 在存在随附模板时从模板初始化，否则从 `@deepseek-ai/dsh-base` 初始化。Profile 禁用自动 peer 安装，因此必须显式列出它需要解析的每个 peer。

API profile 是 `deep-cluster`：它需要本包和 `@deepseek-ai/dsh-host-webserver`，因为 [api.patch.yml](api.patch.yml) 会插入该服务。仪表盘运行在随附的 `web` profile 中，因此也要在那里安装本包；[web.patch.yml](web.patch.yml) 从该 profile 解析包的裸入口和 `/web` 入口。

```sh
dsh plugin --profile deep-cluster add <package-spec> <host-webserver-spec>
dsh plugin --profile web add <package-spec>
```

`<package-spec>` 是本地 tarball 路径或匹配的发行版。`<host-webserver-spec>` 是来自同一 DSH 发行版的 `@deepseek-ai/dsh-host-webserver`，或该发行版在本地不可用时的 tarball。本包在 `dependencies` 中保留 `@deepseek-ai/dsh-subprocess-local`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-util-values`、`@deepseek-ai/schemastery`、`@huggingface/tokenizers` 和 `zod`；它们必须能从注册表、本地存储或本地 tarball 解析。本检出目录说明源码与 tarball 安装方式；不声明该包可从注册表安装。

专用的本地 HTTP API 负责所有任务操作。按[快速开始](#quick-start)带已保存的连接安装技能。API 绑定到 `127.0.0.1:3789`；`DEEPCLUSTER_API_PORT` 选择其他端口。它接受来自本计算机且不带凭据的请求，并拒绝非回环对端（403 `remote-peer`）、浏览器来源请求，以及未指向该回环监听器的 Host 头。这里没有 bearer token：token 文件、`--api-token-file`、`apiTokenFile` 和 `DEEPCLUSTER_API_TOKEN_FILE` 均已停用；`~/.deep-cluster/config.json` 中保存的 `apiTokenFile` 会明确失败，必须删除。仪表盘保留 `service login-url` 返回的 DSH Web 登录 URL。命令、MCP 适配器和仪表盘都将操作转发到该 API。`~/.deep-cluster/config.json` 和已安装技能记录端点、DSH 工作目录、CLI 路径和仪表盘根目录。打包技能和安装技能来自同一 `assets.ts` 生成器；再次安装会保留已保存配置或现有已安装技能中的连接信息，切换目标后也一样。若未保存连接信息，`/DeepCluster` 会先询问 API 端点或包含插件的 DSH 安装路径，再启动或连接。独立工作代理配置文件默认为 `cluster`，需要可用模型、工具和凭据；工作代理具有完整访问权限，不启用沙箱。`/DeepCluster` 也支持主动委派合适的常规工作。

<a id="install-the-skill-for-any-harness"></a>
### 为任意 harness 安装技能

首次安装时，将连接随技能一起保存：传入绝对 `--dsh-path` 值以及服务使用的端点。仅当工作代理 `cliPath` 是仅用于工作代理的包装器时才需要 `--service-cli` 那一行。之后不带连接参数重新安装会保留已保存的值。

```sh
dsh --profile deep-cluster install --skills-root <absolute-skills-dir> \
  --api-endpoint http://127.0.0.1:3789 \
  --dashboard-endpoint http://127.0.0.1:3788 \
  --dsh-path <absolute-dsh-install-dir>
dsh --profile deep-cluster install --skills-root <absolute-skills-dir> --service-cli <absolute-dsh-cli>
dsh --profile deep-cluster install --skills-root <absolute-skills-dir> --label "<harness name>"
```

`--cli` 保存工作代理可执行文件，执行器始终使用它。`--service-cli` 保存一个独立的 DSH CLI，仅用于以 `--profile deep-cluster` 和 `--profile web` 启动持久化 API 与仪表盘；未设置 `serviceCliPath` 时，服务回退到 `cliPath`。仅接受 `--profile cluster` 和工作代理提示词的包装器不能用于服务启动：用 `--service-cli` 保存实际 DSH CLI，并把包装器保留在 `cliPath`。通用目标只写入 `<skills-root>/DeepCluster/SKILL.md`，不会创建 Cursor 或 Codex 目录。生成文本使用配置的标签（默认 `this harness`），不包含针对 Codex 或 Cursor 的指令，也不引用未随包发布的辅助脚本。仍可使用 `--planner cursor`、`--planner codex` 或 `--planner all` 安装预设目标。`--skills-root` 与 `--planner` 选择不同目标，不能同时使用；`--label` 需要配合 `--skills-root`。安装会把与渲染进技能相同的端点、DSH 路径、仪表盘根目录以及两条 CLI 路径合并结果持久化。

已安装技能是一份紧凑的单请求指南：请求无法连接时用 `service start`（幂等）确保服务运行，用 `wait` 和 `view=report` 在单个请求中提交计划文件，检查 `checks` 与变更路径，并抽查一项决定性事实。

<a id="build-pack-and-host-requirements"></a>
### 构建、打包与宿主需求

源码构建仅限 monorepo：`tsdown.config.ts` 引用共享的 `packages/client/tsdown.client.ts` 预设，宿主 tsconfig 也引用工作区包。在检出目录运行 `pnpm run build:artifacts` 构建产物，然后打包本包：

```sh
pnpm --filter @deepseek-ai/dsh-experimental-deep-cluster pack --pack-destination <absolute-output-dir>
```

`prepack` 脚本（`scripts/pack-clean.mjs --check`）在根级 `lib/*.js` 分块无法从已发布入口到达时拒绝打包，使陈旧的哈希 `install-*` 或 `web-*` 文件无法进入后续 tarball。运行一次 `pnpm --filter @deepseek-ai/dsh-experimental-deep-cluster pack:clean` 清理它们，或运行 `pack:check` 只报告而不删除；只处理不可达的根级分块，从不修改 `lib/types`。随后可用 tarball 替代 `link:` 依赖安装本包。DSH 工作区之外没有自包含的构建方式。

本包版本为 `0.2.1-rc.2`，面向同一 DSH 发行版。Node 要求为 `^22.19.0 || >=24.0.0`。其包组补丁需要已声明的运行时依赖 `@deepseek-ai/dsh-subprocess-local`，并与 `@deepseek-ai/cordis` 4.0.5 和 `@deepseek-ai/dsh-tools` 共享 peer。由于已发布声明和 API 覆盖配置需要宿主自身的副本，本包还将 `@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/dsh-client-ui-slots` 和 `@deepseek-ai/dsh-host-webserver` 声明为 peer 依赖。请从匹配的 DSH 发行版安装这些包，或使用 DSH profile；新使用方在启用 `skipLibCheck: false` 进行类型检查前，必须安装这些宿主包。上方的 API profile 声明了 API 覆盖配置所需的 `@deepseek-ai/dsh-host-webserver`。请安装到工作区包版本与本发行版匹配的 DSH 发行版；不支持的 Host 版本不在兼容范围内。API 和 Web 覆盖配置只由 `dsh` 启动器消费。

### 源码检出

仅用于源码开发：先构建检出目录，然后把检出的包和宿主 WebServer 链接到同样的 profile，而不是安装 tarball：

```sh
pnpm run build:artifacts
dsh plugin --profile deep-cluster add link:<absolute-checkout>/packages/experimental/deep-cluster link:<absolute-checkout>/packages/host/webserver
dsh plugin --profile web add link:<absolute-checkout>/packages/experimental/deep-cluster
```

检出目录构建不是自包含的：它使用 DSH 工作区和共享 client 预设。在源码检出中，`pnpm dsh` 运行已构建的启动器；对于持久化服务，安装时传入 `--cli <absolute-checkout>/apps/cli/lib/bin.js` 和 `--dsh-path <absolute-checkout>`，使工作代理和计划任务都启动该入口。当工作代理入口不同时，改为传入 `--service-cli <absolute-checkout>/apps/cli/lib/bin.js`，让调度和工作代理执行各自保留独立入口。安装了匹配发行版时，本文其余部分的 `dsh` 命令等价。

<a id="persistent-local-service"></a>
### 持久化本地服务

连接信息验证后，将 API 和浏览器仪表盘作为持久化本地服务启动。首次启动前，`~/.deep-cluster/config.json` 必须包含技能安装保存的 `apiEndpoint` 和 `dshPath`。`dshPath` 为必填项：缺少它时服务会在创建文件前失败。API 无法连接时，任何代理（包括被委派的工作代理）都可以执行受支持的 `service start` 命令。调用方退出后，两个服务仍由计划任务持有。计划任务生命周期仅支持 Windows；其他平台的服务命令会在创建服务文件前失败，需由操作者自己的监督进程运行 API 和仪表盘。即使使用原生容器化路径，WSL 启动的 Linux 进程也在 Windows 进程范围之外，无法观察后代退出，硬件租约保持隔离。

`<dshPath>/.deep-cluster/service-state/` 是主目录。它保存 `service/`（启动脚本、`service.json` 所有权、`runs/<stamp>/api.log`、`dashboard.log`、`startup-url.txt`）、`api-state/`（操作记录、`api-owner.lock`）、`leases/`、`claims/` 和 `claim-history.json`。`DEEPCLUSTER_SERVICE_DIRECTORY`、`DEEPCLUSTER_API_STATE_DIRECTORY` 和 `DEEPCLUSTER_API_LEASE_ROOT` 可覆盖这些路径。已保存配置仍位于 `~/.deep-cluster/config.json`，已释放声明证据位于 `<leaseRoot>/claim-history.json`。

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

两个服务都通过受支持的 `dsh` profile 作为按需的每用户计划任务启动。API 使用 `api.patch.yml`，仪表盘使用 `web.patch.yml`；不安装启动或登录自启项。启动器从已保存的 `serviceCliPath` 启动两者，仅当它缺失时才回退到 `cliPath`；工作代理执行始终使用 `cliPath`。启动会复用健康且有记录所有者的栈。会修改状态的生命周期命令通过调用方 Node 进程直接持有的一个 Windows 命名管道，在本机所有配置间串行执行。已保存的 `serviceLifecycleWaitMs` 限制等待时间（正整数毫秒，默认 300000）；管道不接受命令，并关闭所有传入连接。控制器退出（包括崩溃）时，Windows 释放管道所有权。

每次计划任务启动都在提交前记录精确操作，服务宿主则在启动 API 或仪表盘前持久保存原生进程回执。即使原调用方在保存 `service.json` 前退出，后续控制器也可依据启动证据和就绪检查核对身份匹配的活动监听进程。中断的启动会撤销后续目标启动，只停止与其匹配的计划任务操作，并等待已记录的原生进程范围退出；已替换的任务保持不变。启动记录只保存部署设置，不保存环境中的凭据值。

第一次外部修改前，控制器发布 `~/.deep-cluster/service-mutation.json`；该意图记录跨越命令、计划任务启动、就绪验证和所有权持久化。成功完成后移除记录。如果回滚已持久确认清理结束，失败操作也会移除记录；后续任何副作用都会在执行前撤销该确认。健康复用和预检拒绝不会创建标记。

start 和 restart 会在原控制器精确身份对应的进程退出后，依据持久清理确认、早于本次 Windows 启动的记录，或完整的原生命令回执，自动隔离已中断的意图记录。原生命令在目标启动前持久保存具名 Windows Job 回执；恢复终止这些已记录的进程范围并等待退出。未跟踪的子进程副作用会撤销此恢复保证。身份匹配的活动控制器、不完整的证据和恢复失败都会保留标记。对于旧命令或未跟踪命令，先运行 `service recover-controller --dry-run`，验证控制器及所有命令后代进程已停止，再运行 `service recover-controller --confirm-controller-intent <id>`。恢复保留精确匹配的标记作为证据；仅凭 PID 复用或经过时间绝不会授权恢复。只读状态查询仍然可用。

控制器在 `<dshPath>/.deep-cluster/service-state/service/service.json` 中记录 PID 和进程启动时间。两个计划任务都通过 `conhost.exe --headless` 隐藏运行，在电池供电时继续运行，且没有执行时间限制。stop 和 restart 会拒绝活动运行、不匹配的进程所有者以及未确认的清理。停止仪表盘会结束其计划任务，然后在重新核验 PID 和启动时间后终止记录的进程树。干净的 API 停止使用 `/v1/service/shutdown`，并由正常运行时清理释放所有权。`/v1/health` 中的 `cleanupUnconfirmed` 会阻止停止，直到操作者验证并终止相应进程范围，再传入 `--confirm-cleanup-unconfirmed`；该确认不会释放已隔离的租约。

即使 `service.json` 缺失或过时，启动仍检查 API 锁自身的 PID 与进程启动时间。匹配的存活所有者或占用的 API 端口会阻止恢复。若已停止的所有者来自较早的 Windows 启动，系统隔离前次启动的所有权记录，保留操作历史和本次启动的所有者。若所有者在本次启动中停止，完整原生回执允许先终止记录的 Windows Job，再仅释放该代所有权。工作代理清理不确定时，保留其活动租约、声明和等待者。已知受影响路径和资源仍阻止冲突工作；范围缺失或畸形时阻止所有新接纳，但 API 仍可供检查。工作代理恢复在 `terminationGraceMs` 内等待，超时后等待该恢复操作结束并报告保留的所有权；控制器或服务启动的所有权不确定时，仍适用其更严格的恢复检查。

没有完整原生回执时，自动恢复锁也可依据完整操作扫描所确认的结算，以及现存且为空的 API 记录租约和声明目录。已完成结果只要未明确否定清理即可；失败、取消或待确认结果要求 `result.cleanupConfirmed: true` 且无错误。`owner-stopped` 恢复结果只确认旧 API 已退出，不确认其工作代理停止。读取 `/v1/health` 的 `recoveryIssues`，其中含 `kind`、`id`、`message`、`observedAt` 和可选 `blocksAdmission: true`；后者以 503 `recovery-admission-blocked` 拒绝新运行。损坏操作证据原样保留并预留已知幂等 key；受影响 key 返回 503 `operation-record-damaged`，无关 key 可以继续。诊断在下一次服务启动或重启时刷新。

`service recover --dry-run` 只报告证据，不修改状态。缺少检查元数据的旧锁以及不确定的保留工作，要求操作者检查工作进程、租约和隔离事件后，再运行 `service recover --confirm-lock-owner <diagnosed owner>`。恢复会在 API 接纳围栏内重新检查身份和空闲证明，将精确匹配的锁重命名以保留证据，绝不删除或重放操作、租约或声明记录。即使提供确认，活动所有者和身份不明的情况仍会被拒绝。

新的 `dsh web:` 登录 URL 会私下写入 `<dshPath>/.deep-cluster/service-state/service/runs/<stamp>/startup-url.txt`，且只由 `service login-url` 返回。该私有文件是唯一书面副本：带 token 的 URL 不得进入技能、计划、已保存配置、共享报告或 API 请求体。仪表盘就绪要求经过身份验证的 HTML 和对 `/api/deepClusterDashboard/snapshot` 的成功读取。首次使用时应向用户显示新 URL，并在真实浏览器中确认面板已渲染。

服务会验证其仪表盘组合，而不是假定已保存的 `web` profile。[web.patch.yml](web.patch.yml) 禁用包组中重复的 `deep-cluster-subprocess` 和启动器 `deep-cluster-command` 行，禁用已保存的裸行和仪表盘行，并在不同服务标识下插入一个裸包行和一个仪表盘行。裸 `@deepseek-ai/dsh-experimental-deep-cluster` 行保持启用，因为浏览器客户端模块扫描只通过该精确说明符发现可见面板。同一覆盖配置适用于已保存仪表盘行的配置和干净配置。已保存的 `dashboardWorkspace` 和 `dashboardWorkspaces` 设置提供绝对主根目录和附加根目录；启动器将它们作为 `DEEPCLUSTER_WORKSPACE` 和 `DEEPCLUSTER_WORKSPACES`（JSON 数组）传递，安装技能时两者都会保留。两者都不硬编码用户路径；如果组合配置缺少一个启用的裸行或一个仪表盘行，启动必须明确失败。

### 编写并检查计划

如果有源码检出，可以从[并行检查示例](samples/parallel-plan.md)开始；否则直接编写计划。每个步骤包含稳定标识、专业角色、指令和至少一项不重复、非空白的验收条目。将步骤元数据放在 `acceptance:` 之前，并使用空行将后续指令与验收列表分开。后续指令中类似元数据的行仍然只是任务文本。工作代理必须逐字重复每项验收标签，并给出 `yes` 和具体证据；缺少证据、进程失败或报告缺失都会使本次尝试失败。

首次提交会为日志、团队邮箱和计划文件创建该工作区的 `.deep-cluster/`，其中 `.gitignore` 包含 `*`；无需仓库忽略规则。

```sh
dsh --profile deep-cluster coordinate --plan <absolute-plan.md> --concurrency 2 --dry-run
```

`--dry-run` 调用 `POST /v1/plans/validate` 检查工作区、计划和预算，不启动工作代理，也不创建操作。移除此参数后即可通过 `POST /v1/runs` 提交。`POST /v1/runs` 接受 `text/markdown` 或 `text/plain` 计划正文，并在查询中传入 `workspace`、`maxConcurrency`、`timeoutMs`、`maxAttempts` 和 `maxRepairs`；或接受 JSON 正文 `{workspace, plans, ...}` 且查询中不带选项；`POST /v1/plans/validate` 接受相同的正文。`Idempotency-Key` 可选；传入它可让重试安全。`wait=<seconds>` 会保持响应直到运行结束或等待结束，并受 API 最大超时限制；`view=report` 返回紧凑报告。`GET /v1/runs/:id` 接受 `wait` 和 `view`；以 `{}` 调用 `POST /v1/runs/:id/cancel` 时接受 `view` 并等待工作代理清理完成。提交结果不确定时，重用相同 key 和请求；相同 key 搭配不同请求会被拒绝。省略 `depends_on` 表示前一步必须通过；独立任务使用 `depends_on: none`。失败会阻止依赖任务，独立任务仍可完成。`dependency_policy: settled` 改为等待前置任务的最终结果，并在失败后运行诊断用审查或测试任务，而不重新标记失败工作，也不把整体失败的运行变为成功。尝试和修复分别具有每步骤预算；`maxRepairs: 0` 禁止修复代理。修复继承任务指令、角色限制和硬件分配。

`view=report` 响应包含 `operationId`、`status`、`error`（`code: message` 或 null）、`steps`、`open` 和 `failure`。每个步骤包含 `id`、`role`、`status`、`attempts` 和 `summary`，以及存在时的 `checks`（验收标签及工作代理证据）、`changed`（审计观察到该步骤期间变更的路径）、`auditProblem` 和 `improvisation`。`open` 列出未解决的即兴处理 id；`failure` 携带 `stepId` 和失败输出的最后 4,000 个字符。

重复 `--plan <file>` 可在一次操作中提交多个计划。它们的根任务可在共享 `--concurrency` 限制内同时运行；依赖关系保持在各自计划内，任务示例保留源计划的标题和目标。整个批次仍共享硬件和具名资源锁。

### 版本控制与写入所有权

每次运行记录规范工作区、物理工作树、Git 顶层目录、共享公共目录、分支、HEAD，以及已暂存、已修改和未跟踪的路径集合。探测为只读，并设置 `GIT_OPTIONAL_LOCKS=0`；一次快照读取一次 `git status --untracked-files=all` 和一次 `git ls-files --stage`，对既有变更和声明文件做 SHA-256，并按暂存条目的内容身份比较，而不是只看 porcelain 状态字母。因此，即使状态字母仍为 `M`，重新暂存已修改内容、取消暂存和暂存删除也能被发现。HEAD、分支和索引条目会被观察；reflog、其他 ref、packed-refs、config、日志、索引扩展和标志，以及公共目录中的任意文件不做内容指纹。工作代理指令携带保留规则和已观察路径。DeepCluster 从不执行 commit、reset、stash、clean 或 rebase。

声明按规范绝对路径冲突：父工作区与子工作区、嵌套仓库和子模块，以及包含所声明文件的外部非 Git 祖先都会彼此冲突；分离的物理工作树仍可并行。Git 元数据是独立的记账命名空间，通过共享公共目录声明串行化；每个 `git: write` 步骤同时持有整个工作树。已释放声明证据持久保存在 `<leaseRoot>/claim-history.json`，上限为 1,000 条释放记录或 12 小时；当审计窗口早于记录的 `prunedThrough` 时，未授权变更会报告为无法归属，而不是归咎于某个工作代理。在 Windows 上，声明注册表互斥使用命名管道，所有者退出时由操作系统释放。普通接纳最多等待配置的时限；旧目录互斥锁需要经过验证的恢复。

每个计划步骤控制其写入声明：

- 省略 `access` 和 `writes` 会独占整个物理工作树。
- `access: read-only` 声明不写入源码且不获取写入声明；`access: write` 不带 `writes` 时同样独占整个工作树。
- `access: write` 配合 `writes: path/a.ts, dir/` 允许不相交的并发写入者。路径是字面仓库相对路径；结尾 `/` 覆盖其后代。通配符、绝对或盘符路径、UNC 路径、反斜杠、`..` 或 `.` 段、`.git`、`.deep-cluster`、Windows 结尾空格或点、保留设备名，以及工作树之外的符号链接或 junction 逃逸都会被拒绝。
- `resources` 附加精确名称锁，绝不会替换写入声明；`resources: none` 声明不使用具名锁，但不会退出写入声明。要声明不写入，请使用 `access: read-only`。`git: write` 需要整工作树访问权限、真实 Git 工作树和公共目录锁，但仍不授权 DeepCluster 修改 Git。
- 声明按规范绝对跨度匹配，因此大小写别名、junction、符号链接、嵌套仓库和外部非 Git 祖先会解析到同一物理所有者。声明过期不会转移所有权；[服务恢复](#persistent-local-service)必须确立工作进程已终止。普通整工作树声明允许创建新文件，但不授权修改既有脏工作；只有显式的 `path` 声明才授权。

声明协调合作的 DeepCluster 进程，不是沙箱。任意 shell 都可以写到声明路径之外。`access: read-only` 是声明：如果另一份活动声明覆盖了该路径，快照无法区分两个写入者，因此该变更可能被归属到已观察声明的并集。步骤后和最终快照会报告未声明变更，以及声明之外被修改的既有脏文件，但仅限于 Git 或有界目录遍历可观察到的情况；不会识别具体的写入者。快照之间被修改后恢复的干净文件、遵循 Git 忽略规则的被忽略或生成文件，以及其他不可观察的写入不会被发现。快照或检测失败会报告，绝不会被视为通过。工作代理交换前置任务摘要和报告中的检查结果；详细产物保留在工作区中。

<a id="lease-hardware-and-inspect-outcomes"></a>
### 租用硬件并检查结果

所有访问该 GPU 的任务都应声明 `hardware: gpu0`，包括正确性测试和性能分析任务。系统也会根据任务文本中的工具名称和 `perf` 角色推断租约，但无法确定任意可执行程序的行为，也无法区分已保存的报告与新的测量。明确仅使用 CPU 的任务（例如审查已保存的 NCU 报告）可声明 `hardware: none`；这会关闭推断，该工作代理不得执行 GPU 工作。每个步骤接受一个硬件名称或保留值 `none`；空值或逗号分隔的步骤声明会被拒绝。使用同一设备的所有 API 服务器必须使用相同资源名和配置的租约根目录。

```sh
dsh --profile deep-cluster lease status --resource gpu0
dsh --profile deep-cluster journal --cwd . --tail 60
dsh --profile deep-cluster ledger --cwd . --tail 20
```

租约保持到后代进程清理得到确认。截止时间过期仅用于诊断，不转移所有权。未确认清理会停止该运行继续分派，并保留其所有权；`error.code: cleanup-unconfirmed` 不表示工作进程树已停止。`/v1/health` 将这些运行计入 `cleanupUnconfirmed`；优雅停止要求显式 `--confirm-cleanup-unconfirmed` 确认。恢复保留已知受影响的活动声明，让冲突工作等待；范围未知时可阻止所有新接纳，见[持久化本地服务](#persistent-local-service)。WSL 启动的 Linux 进程或任何 Windows 范围外后代仍不在原生终止保证内。恢复必须确认终止后才释放所有权。重试和修复保留配置的权限；输出文本不授予更广泛的访问。

API 通过 `GET /v1/journal?workspace=<absolute-path>&tail=60` 提供活动记录，通过 `GET /v1/ledger?tail=N` 提供最新 N 条任务结果，通过 `/v1/leases?resource=gpu0` 提供所有权信息。日志和账本读取还接受 `runId`、上一页返回的不透明 `after` 游标和 `limit`；响应包含 `cursor`、`more` 和 `reset`，因此监督者可增量读取长运行，而不必反复重扫历史。带过滤条件的读取会跨过被跳过的记录推进游标，因此后续匹配事件不会丢失。上述命令转发 tail 形式。账本分别统计失败和受阻数量；示例是工作代理报告，并非经过校准的能力概率。`needs-ack` 表示已报告的计划偏离；`POST /v1/ack` 接受 `{workspace,id,reject,note}`，并在最后一个未解决即兴处理解决后确定运行：`completed`，或任何一项被拒绝时以代码 `improvisation-rejected` 标记为 `failed`。确认前先检查证据，再更新计划。本计算机上的监督者可通过 `POST /v1/runs/<operationId>/messages` 和 `{toStepId, message}` 向一个精确的运行参与者发送有界反馈；接收者仍需通过 `cluster_inbox` 读取，该消息不授予权限、不改变依赖、不触发唤醒，也不转移租约。

`GET /v1/runs` 跨工作区发现保留的操作。可选过滤条件包括绝对路径 `workspace`、一个精确的 `status`，以及 `attention=true|false`；现存工作区的别名解析为物理路径，已移除的工作区仍可通过记录的绝对路径找到。`limit` 是受 API 的 `maxTail` 限制的正整数，默认等于该上限。响应为 `{runs, cursor, more}`。每条精简摘要包含操作和运行身份、工作区、状态、时间戳、未解决偏离数量、可用的步骤计数，以及 `attention` 数组；数组包含已记录的 `cleanup-unconfirmed`、`interrupted`、`needs-ack`、`failed` 或 `audit-problem` 条件。`attention=true` 选择非空数组，`false` 选择空数组。通过所选操作的 `GET /v1/runs/<operationId>?view=report` 查看详细证据。读取列表不会确认偏离、重试工作代理、修改计划或修改 Git；分配与后续决策由监督 AI 负责。

运行分页按创建时间和操作 id 降序排列。将返回的不透明 `cursor` 作为 `after` 传入，并保持过滤条件相同；允许改变每页大小。游标为 null 表示当前没有更多匹配记录。未知、重复或无效查询字段返回 400；格式错误、不匹配或锚定操作不可用的游标返回 400 `invalid-cursor`。列表读取当前状态，不是冻结快照：要发现已保存游标之前新提交或新匹配的操作，应省略 `after` 重新读取。增量事件使用日志游标。[设计比较](docs/design.md#agent-orchestrator-comparison)解释观察与分配的责任划分，以及尚缺少的集成能力。

<a id="share-knowledge-between-runs"></a>
### 在运行间共享知识

监督 AI 可保存文档、关联证据的经验和版本化协议，供后续计划使用。知识属于一个 API 状态目录内的一个规范化工作区；不同 API 状态目录不共享知识。下列每条路由都要求 `workspace=<url-encoded absolute existing path>`。API 接纳的任何本机调用方都可读取、写入、采纳或退役知识：采纳记录工作流决策，不代表经过身份验证的授权，也不增加操作系统权限。

| 路由 | 结果或请求 |
| --- | --- |
| `GET /v1/knowledge` | 不含正文或证据的最新摘要；可选 `limit` 和 `after`，记录 ID 升序，返回 `{records,cursor,more}`。 |
| `POST /v1/knowledge` | 完整替换 `{id,expectedRevision,kind,title,body,...}`；调用方生成 UUID 并以 `expectedRevision: 0` 创建记录，更新则必须指定当前修订。冲突返回 409。 |
| `GET /v1/knowledge/:id` | 含完整内容的 `{record}`；可选 `revision` 读取历史，否则读取最新修订。 |
| `POST /v1/knowledge/:id/transition` | `{expectedRevision,state}`，其中 `state` 为 `adopted` 或 `retired`；只有协议具有生命周期转换。 |
| `GET /v1/knowledge/:id/usage` | 必须指定精确 `revision`，可选 `limit`；返回选择过它的保留运行，以及 `count` 和 `truncated`。选择不证明实际应用或遵守。 |
| `GET /v1/briefing` | 可选 `limit`；返回有界运行和知识摘要、当前已采纳协议、经验、观察时间、各集合计数及截断标志，以及全部匹配保留运行的关注项计数。读取不影响执行或确认。 |

`kind` 为 `document`、`lesson` 或 `protocol`。经验必须提供 `evidence: [{operationId,stepId?}]`，指向同一工作区中保留且不再活动的操作；指定的步骤必须出现在其结果或最后记录的进度中。失败和中断的工作可作为经验依据，但引用不会验证结论。协议内容写入始终创建待采纳修订。采纳要求当前修订；退役阻止新的选择，编辑已采纳协议后必须重新采纳新修订才能选择。现有历史和已接纳快照保持不变。`limit` 受 `maxTail` 限制；知识记录、正文、引用和快照预算分别由 `maxKnowledgeRecords`、`maxKnowledgeBodyBytes`、`maxKnowledgeReferences` 和 `maxKnowledgeSnapshotBytes` 配置。

在 `POST /v1/runs` 或 `POST /v1/plans/validate` 的 JSON 请求中用 `knowledge: [{id,revision}]` 选择精确修订；文本计划提交不选择知识。文档和经验是参考材料；所选协议必须是当前已采纳修订。接纳时将完整快照保存在操作和 `run/start` 日志事件中，每次工作代理尝试都在已记录请求中收到相同的完整上下文。使用同一幂等键和请求重试时，即使后来发生编辑或退役，也返回原操作及其快照。新的或改变后的选择需要新的请求键。分配、验收和重新规划仍由监督 AI 负责。

所选协议可声明 `constraints.requireReviewAfterWrites: ["reviewer","tester"]`，也可只选择其中一个角色，并可附加 `requiredAcceptanceLabels`。每个可写步骤（包括省略 `access` 的步骤）都必须为每个所需角色安排一个明确声明 `access: read-only` 的下游步骤。依赖可以是传递的，共享审核可覆盖多个写入步骤；对每个角色和写入步骤，全部精确标签必须集中出现在一个合格审核步骤中。接纳会拒绝不满足要求的计划，不会自行添加步骤。这些检查验证计划结构，不证明执行成功、工作代理报告真实或工具权限有效。

<a id="continue-or-replace-a-worker"></a>
### 继续或替换工作代理

使用 `POST /v1/sessions` 和 `{id,workspace,title,role,handoff?}` 创建监督方分配的工作代理。提供新 UUID、现存工作区的绝对路径，以及 `developer`、`reviewer`、`tester` 或 `perf` 角色。创建只保存第 1 代和新的原生 DSH Session 标识，不启动模型。`GET /v1/sessions` 要求 `workspace`，并接受可选的有界 `limit`；`GET /v1/sessions/:id` 读取当前分配。创建响应不确定时，重试前先读取该 id；已存在的标识会冲突。

提交包含 `session: {id,generation}` 的 JSON 运行请求，计划必须只有一个步骤，并匹配分配的工作区和角色。原生轮次要求 `maxAttempts: 1` 和 `maxRepairs: 0`，这也是其默认值；步骤不能增加重试。首轮通过 `--new-session-id` 创建已分配的 Session；先前工作已完成或待确认且清理已确认后，后续轮次通过 `--session-id` 恢复其历史。工作代理必须发出一个匹配的开头 Session 事件。每轮拥有新的托管进程范围，并等待清理完成后才释放资源。同一代的并发轮次会被拒绝。失败或中断的轮次要求显式替换，不会自动重放。若所选协议要求写入后的下游审查，此单步骤轮次无法满足；应使用满足协议的普通多步骤计划。

使用 `POST /v1/sessions/:id/replace` 和 `{generation,handoff}` 替换工作代理。它先禁止旧代接收新轮次，取消并等待其活动轮次结束，再以新原生 Session id 发布下一代。旧清理未确认时拒绝替换，直到恢复确认其进程范围已结束。旧历史和沿袭关系保留；只复制显式交接文本，每次运行独立选择知识修订。旧代请求和唤醒不能驱动后继代。替换结果不确定时，先读取当前记录。`maxNativeSessions` 和 `maxSessionHandoffBytes` 限制保留数量和交接大小。工作代理 profile 必须支持 headless 标识参数，并保留 cwd、所有权和 preset 检查。

<a id="queue-a-bounded-wakeup"></a>
### 排队一个有界唤醒

`POST /v1/wakeups` 接受 `{id,run,trigger,expiresAtISO}`，用于一次后续运行。UUID 标识不可变的指令：相同请求返回保留的唤醒；修改指令则冲突。`run` 是完整 JSON 运行请求，包含固定的单步骤计划和精确的 `session: {id,generation}`。选择 `{kind:"at",atISO}` 指定时间，或选择 `{kind:"operation",operationId,when:"settled"|"attention"}` 引用同一工作区内保留的操作。必须显式设置到期时间，且晚于指定的计划时间。队列通过常规接纳流程提交，不选择角色、不添加任务，也不重新规划。

`GET /v1/wakeups` 要求 `workspace`，并接受可选的有界 `limit`；`GET /v1/wakeups/:id` 显示状态、尝试次数、已接纳操作及失败。以 `{}` 调用 `POST /v1/wakeups/:id/cancel` 会持久化取消并等待已接纳工作结束。待处理请求在重启后保留。持久化的 `wakeup:<id>` key 在结果丢失后找回已接纳操作；已经完成或失败的工作代理执行绝不重放。会话忙碌和临时接纳限制会按 `maxWakeupAttempts` 与 `wakeupRetryDelayMs` 有界重试；关闭服务保留待处理工作且不消耗该预算。到期阻止尚未提交的接纳，代际变化使旧请求失效。`maxWakeups` 限制保留数量，`wakeupPollIntervalMs` 控制轮询。另一个轮次需要另一个显式请求；唤醒不会周期重复。

<a id="configure-host-policy-hooks"></a>
### 配置宿主策略 hook

在 API profile 的 `deep-cluster-api` 行配置 `policyHooks`。每项提供 `{id,command,args,events,timeoutMs,maxInputBytes,maxOutputBytes}`；`events` 包含 `admission`、`tool` 或两者。可执行文件和参数是受信任的宿主设置，绝不以模型输入替换。程序读取 `DEEPCLUSTER_POLICY_REQUEST_FILE` 指向的私有 JSON 文件，其内容为 `{event,workspace,subject}`。接纳 subject 包含计划和所选会话；工具 subject 包含工具名和参数。Stdout 必须恰好为 `{decision:"allow"|"deny"|"require-review",reason:"..."}`。

Hook 按顺序运行，遇到拒绝即停止。错误、畸形输出、非零退出、超出预算和超时都会拒绝动作；进程清理不确定时保留所有权。`require-review` 同样拒绝执行，要求监督方决策，不产生自动批准。接纳决策进入日志，工具拒绝使用常规且有日志记录的工具结果路径。`POST /v1/plans/validate` 检查结构而不执行 hook；实际接纳会执行。静态工作代理覆盖配置读取每次运行的新上下文文件，使继续的会话收到当前策略设置。

每次运行的 `.deep-cluster/policy-<runId>.json` 保留为不可变的执行配置证据。各私有 `.deep-cluster/policy-inputs/<uuid>.json` 仅在该 hook 的清理得到确认后删除。接纳 hook 清理未确认时，会持久保存一个健康接口可见的 `policy-hook` 恢复问题，并设置 `blocksAdmission: true`。API 仍可启动并提供诊断，但新接纳保持阻断，直到恢复验证所记录的原生代已结束；仅 API 进程退出不会清除该问题。

Hook 可以拒绝动作，但不能授予权限、扩大声明、改写计划或分配工作。其可执行程序具有宿主的完整操作系统访问权限，这不是安全沙箱。只安装可信程序。分配、证据审查和后续计划仍由监督 AI 负责。

### 查看仪表盘

可选的 [Web 覆盖配置](web.patch.yml)通过经过身份验证的 DSH Remote 服务添加专用 DeepCluster 页面。地图视图把每个工作代理显示为石墨色平台上的光泽白色立柱；柱高对应工作代理的实时 token 速率，平台上平滑走线的连接表示已记录的消息、依赖等待和资源等待。选择柱或其标签会打开工作代理卡片，显示该工作代理的档案、实时日志和消息。

轨道视图按时间轴垂直列出工作代理。每条轨道上方是 token 速率历史曲线，下方是在时间轴上的活动片段，涵盖思考、命令、读取、写入、工具、启动、等待、排队和空闲；粗缎带在渐变填充之上按墙钟秒绘制每秒 token 数，每个片段按活动类型着色并带有图案，并配有对应图例。轨道下方的灰色缎带表示消息，虚线缎带表示依赖。

页头视图选择器或按键 1 和 2 切换视图。地图控件可平移、环绕、缩放和重置相机；轨道控件可围绕指针缩放时间、平移、滚动轨道、适配并跟随实时（即使没有工作代理运行，也将窗口保持在当前时间），时间缩放滑块设置可见时间跨度。视图下方列出硬件租约、结果账本和活动时间线。

实时每秒 token 数取最近五秒观察到的 tokenizer 输出增量之和，再除以五。可选的工作代理 `/telemetry` 插件默认每 250 ms 采样公开的助手流事件，计入文本、推理和工具参数，但不会导出它们的内容。它重新分词累计前缀，并计入有符号的合并修正。这是本地 tokenizer 估计值，与提供者计费用量不同；缺失或失败的监测显示为不可用。提供者的输入和输出总量仍在步骤完成后更新，并在每次工作代理尝试开始时重置。

在工作代理 profile 中配置本地 `tokenizerFile` 和 `tokenizerConfigFile`、说明性的 `tokenizer` 标签、匹配的 `models` 别名，以及可选的 `sampleIntervalMs`。启动前从所选模型的官方仓库下载文件，例如 [DeepSeek V4.1 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/main)。在该 profile 的 patch 中添加 `@deepseek-ai/dsh-experimental-deep-cluster/telemetry`；profile 必须依赖此包。模型别名不匹配时报告不可用，不会改用其他 tokenizer。

[监测 patch](telemetry.patch.yml) 展示了添加新工作代理插件所需的 `insert` 包装；设置其中三个 tokenizer 环境变量，或替换为本地路径和标签。[团队 patch](team.patch.yml) 在控制器提供运行身份时启用 `cluster_message` 和 `cluster_inbox`。将这些 patch 操作合并到工作代理 profile。消息限定在本次运行的任务列表中，保留至工作代理重试，并在接收者工具读取时形成已送达记录。工作代理在工作单元之间主动轮询；消息不会中断请求，也不会改变依赖或租约。监督者发送身份是保留的，不能作为计划步骤 id，因此 API 来源和对等来源的消息不会混淆。协议对每条持久消息上限为 16,000 个字符；工作代理配置的 `maxMessageChars` 限制其发送内容，且绝不会让较小接收端的预算导致已接纳消息无法读取。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[包组补丁](cordis.patch.yml)挂载已有的 DSH 子进程提供者、DeepCluster 服务及命令使用方。[API 覆盖配置](api.patch.yml)使用回环 WebServer 和 `/api` 插件替换命令使用方。工作代理通过 `dsh` 配置文件启动。Web Remote 将仪表盘请求转发给 API，并验证返回的仪表盘数据；API 拒绝浏览器来源请求。无需修改 agent-loop、Session、沙箱或应用启动流程：本包使用公开的 `subprocess`、`cmdlineArgs`/`appExit`/`appReady`、`webServer`、`typert`、工具和客户端插槽服务，应用启动由 `dsh` 启动器负责。

[协调器](src/coordinator.ts)验证任务图，按计划顺序接纳已就绪任务，并在派发前预留工作树写入声明和具名资源锁。[作用域](src/scope.ts)、[声明](src/claims.ts)和[仓库](src/repository.ts)模块规范化工作树身份、原子发布跨进程写入声明，并捕获只读 Git 和脏状态快照。[租约实现](src/lease.ts)原子发布完整的所有权文件，并保留到工作进程清理得到确认。[日志](src/journal.ts)串行化各写入者的追加操作，标识写入者和运行，并报告已提交记录的损坏。[能力账本](src/ledger.ts)从该日志投影任务最终证据。

[scripts/pack-clean.mjs](scripts/pack-clean.mjs) 中的干净打包过程只删除从清单运行时入口不可达的根级 `lib/*.js` 分块，使陈旧的哈希构建文件无法进入后续 tarball。它从不修改 `lib/types`，`--check` 只报告而不删除。

[设计参考](docs/design.md)解释研究支持的设计选择和验证限制。调度器测试使用受控完成信号与独立工作进程，检查并行执行、依赖失败、取消和硬件独占所有权。

[Relic 的插件实现](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/plugins/relic/relic_core/store.py)将共享工作和组织协议与可替换会话分开；其[投递测试](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/plugins/relic/tests/test_hook_delivery.py)在上下文截断时保留未读消息。DeepCluster 使用持久知识、显式修订选择和有界简报，同时保留由监督者编写的任务图和主动读取的邮箱。Relic 的[源码 README](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/README.md)区分统一的 Windows/macOS 源码候选版与已发布下载；[产品页面](https://www.hongyidu.ai/relic/en/plugins)和[验证记录](https://github.com/Hongyi-Du/Relic-Plugins/blob/main/docs/validation.md)分别提供发布功能与宿主测试的证据。源码存在本身不代表完整宿主支持。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [规划代理指令](AGENTS.md)定义委派和验证责任。
- [架构](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/architecture.md)描述受支持的 DSH 扩展点与应用启动方式。
- [Windows 失败处理](docs/windows-console-boundary.md)描述不自动提升权限的诊断方式。

-----

<a id="model-experience"></a>
## 模型体验

### 工作代理请求与前置证据

#### 模型看到什么

每个工作代理收到其角色规则、计划目标、分配的指令、验收检查、持有的硬件名称、已有前置任务或重试证据、所选知识修订，以及显式会话交接文本。这些输入通过正常且有日志记录的 DSH 用户请求进入子代理。原生继续还包含保留的对话；替换则开始新对话。知识正文不能覆盖用户或仓库指令、角色、依赖、声明或验收检查。[报告协议](src/protocol.ts)定义 `[[DEEPCLUSTER]]` 报告指令；工作代理返回经过格式检查的自报结果，独立测试和审查步骤提供进一步检查。

#### Token 影响

每次尝试和修复都会创建独立工作代理请求。角色指令、任务细节、依赖证据、所选知识快照和工具结果消耗该工作代理的上下文。知识接纳限制快照字节数，不会静默截断正文。控制代理只读取自己选择的报告与产物；增加工作代理可能提高模型总用量。

#### KV 缓存影响

一次性工作代理拥有独立 Session；显式选择的原生代在轮次间保留自己的对话。提供者缓存可能复用稳定输入，但 DeepCluster 不保证共享工作代理 KV 缓存或命中提供者缓存。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 租约协调同一主机上的合作进程，不限制无关应用、不提供多主机调度，也不恢复已记录原生进程范围之外的 GPU 工作。
- 写入声明协调合作的 DeepCluster 进程，而不是操作系统。任意 shell 写入可能离开声明路径，快照之间被修改后恢复的干净文件不可观察，被忽略或生成的文件也不在审计范围内。快照失败会报告，而不会变成通过。
- 持久化服务生命周期及其计划任务仅支持 Windows；WSL 启动的后代位于 Windows 进程范围之外，无法确认其退出，租约保持隔离。
- 工作代理通过任务依赖、工作区产物和运行内由接收方主动读取的对等邮箱协作。尚未实现自动工作树隔离和运行中重新规划任务图。
- 原生对话使用 DSH 支持的 headless Session 生命周期，不导入外部代理私有会话。唤醒执行固定的一次性计划；策略 hook 和协议检查不限制操作系统访问，也不授予对等表决权限。
- 能力账本反映实际提交的任务和工作代理报告。样本量较小、模型变化和工具链差异使角色通过率不能作为可靠的能力保证。
- 仪表盘读取并投影工作区日志。日志轮转会被检测并重建观察，但尚未实现日志保留和归档限制；运行内游标限制重复读取，但不索引历史运行。
- 安装规划代理技能不会配置模型凭据。API 保留幂等记录；达到配置上限后拒绝新提交。服务器中断后，重新提交工作前先检查日志和租约；未完成操作不会自动恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
