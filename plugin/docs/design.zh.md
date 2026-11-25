---
description: "DeepCluster 任务调度、协作式租约和已观察能力证据的设计参考。"
kind: "reference"
---

# DeepCluster 执行设计

[English](design.md) | 中文

## 概述

DeepCluster 通过已有 DSH 执行配置文件调度显式任务图。设计优先保证有界并行、可观察的失败和独立验证任务。本页区分所引研究的发现与本实现采用的工程选择。

## 目录

- [研究依据](#research-basis)
- [与 Agent Orchestrator 的比较](#agent-orchestrator-comparison)
- [任务调度](#task-scheduling)
- [持久对话与计划轮次](#durable-conversations-and-scheduled-turns)
- [资源所有权](#resource-ownership)
- [版本控制与写入所有权](#version-control-and-write-ownership)
- [证据与协作](#evidence-and-collaboration)
- [开发备注](#dev-note)

<a id="research-basis"></a>
## 研究依据

[Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) 于 2026 年 4 月修订，评估了 260 种配置，发现协调收益取决于任务结构：增加代理可能降低顺序规划效果，而集中验证的架构传播较少错误。DeepCluster 据此推导出并行执行已声明独立任务并保留控制规划代理的设计，而非为所有任务自动增加工作代理。该论文并未证明本调度器最优。

[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) 分析了超过 1,600 条轨迹，将失败归类为系统设计、代理间对齐和任务验证。DeepCluster 采用显式验收标签、有界修复尝试、失败前置任务阻断，以及独立测试和审查角色，作为对这些类别的工程应对。这些机制约束工作流行为，但不能确立代理报告内容的真实性。

[An LLM Compiler for Parallel Function Calling](https://arxiv.org/abs/2312.04511) 将规划、任务获取和并行执行分离。DeepCluster 将依赖就绪派发模式用于长时间运行的工作代理，并未使用该论文的规划器，也未宣称其报告的基准提升适用于本实现。

[etcd 并发 API](https://etcd.io/docs/v3.6/dev-guide/api_concurrency_reference_v3/) 将锁所有权关联至租约，并提供用于事务所有权检查的锁键。本插件的 GPU 命令执行没有等效的隔离事务。因此，DeepCluster 将租约过期视为诊断信号，而不是启动另一个 GPU 工作代理的许可。这是本地实现选择，并非分布式租约协议。

<a id="agent-orchestrator-comparison"></a>
## 与 Agent Orchestrator 的比较

[Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) 通过持久守护进程管理编码代理会话。下表依据其公开源码和文档，不代表已在本机执行，也不表示功能对等。DeepCluster 将任务分解、工作代理分配、验收、重新规划以及对 CI 或审查反馈的响应交给监督 AI。确定性调度器执行已提交的任务图和预算。

| 能力 | Agent Orchestrator 参考 | DeepCluster 行为 |
|---|---|---|
| 规划与分配 | 其 [README](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/README.md) 描述由项目代理规划工作并启动工作代理。 | 监督 AI 提交显式依赖、角色、验收检查和资源声明；一次运行期间任务图保持固定。 |
| 观察与关注事项 | [可重放事件](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/httpd/events.go)和[持久通知服务](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/service/notification/service.go)支持补读和确认已读。 | 日志游标支持增量读取；运行列表提供保留的操作和派生的关注原因，不会确认或修改它们。 |
| 反馈 | [生命周期响应](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/lifecycle/reactions.go)对 CI、审查和冲突提醒去重。 | 运行内监督者和对等邮箱传递显式提交的反馈。DeepCluster 不观察 CI 或审查系统，也不会根据其事件派发修复任务。 |
| 工作区隔离 | [工作区适配器](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/backend/internal/adapters/workspace/gitworktree/workspace.go)管理各会话的 Git 工作树。 | 协作式路径声明允许不重叠的写入者在既有工作区中工作；DeepCluster 不创建或集成工作树。 |
| 工作代理会话 | 其[架构](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/architecture.md)描述多种代理适配器、持久会话和独立提供者宿主。 | 监督方可为显式单步骤轮次选择持久 DSH 对话。替换在确认旧工作代理结束后创建新原生 Session，只复制显式交接文本。仍支持一次性尝试；中断操作不会重放。 |
| 服务恢复 | 其[架构](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/architecture.md)将各代控制器与独立提供者宿主分开。 | 任何已配置的 harness 都可请求 Windows 服务启动。持久启动记录、精确进程身份和原生范围回执支持核对及陈旧所有者恢复，不会重放任务。 |
| 操作者访问 | 其[状态文档](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/STATUS.md)描述桌面和移动端界面；云端可用性取决于构建、账户和控制平面。 | 可选的 DSH 仪表盘观察本机工作代理；DeepCluster 不提供移动端配对或多主机执行。 |

收集事实与选择工作各有明确责任。无法确认清理、执行中断、偏离需要决策、任务失败或写入审计发现问题，都可能使运行需要关注。这些原因帮助监督 AI 选择下一次读取或计划；它们既不验证工作代理报告，也不授权重试。[API 参考](../README.zh.md#lease-hardware-and-inspect-outcomes)定义列表和日志语义。

<a id="task-scheduling"></a>
## 任务调度

规划代理提供静态有向无环图。缺少依赖元数据时，保持文档顺序执行。显式独立的根任务可在 `maxConcurrency` 限制内重叠；已就绪任务按文档顺序接纳。未知引用、环、重复标识和无效尝试预算会在启动任何工作代理前失败。调度不依赖延迟估计或推测的任务价值分数。

批次组合为各计划的任务标识添加前缀，并在合并任务图前解析各自的依赖。因此，即使首个步骤省略依赖元数据，不同计划的根任务仍然独立。所有任务图共享并发预算和资源命名空间。各任务保留源计划的标题和目标，用于提示词和账本证据。

每个任务拥有自己的尝试和修复预算。通过的修复允许再次尝试而不消耗普通尝试预算；每次实际主角色调用仍会增加记录的尝试次数。修复工作代理获取相同任务资源。默认情况下失败会阻断后继任务；`dependency_policy: settled` 改为等待前置任务的最终结果，并在失败后接纳诊断用审查或测试任务。已结算任务会收到失败前置任务的证据，但不能重新标记该工作，也不能把整体失败的运行变为成功。独立任务继续执行。取消会停止新派发，并等待运行中的工作代理结束；被取消的步骤报告其阶段，而不是伪造缺失报告，且取消不消耗重试次数。

前置任务摘要和报告检查进入下一工作代理的正常 DSH 用户请求，使该模型可见交接成为子 Session 的一部分。详细产物保留在分配的工作区文件中。任务图在一次运行期间固定；修改需要新的计划和运行。

<a id="durable-conversations-and-scheduled-turns"></a>
## 持久对话与计划轮次

持久分配将监督方拥有的身份和角色，与原生 Session id、替换代及进程所有权代区分开。接纳在启动受支持的 headless profile 前保存精确选择。原生轮次采用一个步骤、一次尝试且不修复；每个后续轮次由监督方决定。替换禁止旧代接收新轮次，并要求等待清理结束或取得精确代际的已结算恢复证据，才分配新 Session。私有历史保留在旧 Session；后继只收到显式交接文本和独立选择的[知识修订](../README.zh.md#share-knowledge-between-runs)。对话连续性不转移声明，也不削弱计划验证。

持久唤醒队列保存固定运行请求、精确会话代、一个时间或保留操作触发条件，以及到期时间。它使用稳定幂等 key 通过常规接纳流程分派。重启可以找回已接纳操作，而不使用另一个 key 提交新工作；工作代理失败绝不授权重放。临时接纳拒绝具有有界重试，取消在等待延迟接纳前先持久保存。监督 AI 选择计划和触发条件；队列不能选择工作代理、改写依赖或自行产生后续任务。[使用指南](../README.zh.md#queue-a-bounded-wakeup)定义请求和观察细节。

宿主策略 hook 在接纳或工具执行前运行固定的可信程序，只能拒绝或委托给正常流程。它们接收结构化动作数据，而不进行命令插值。静态工作代理覆盖配置加载当前运行的策略上下文，原生对话历史保持不变。决策进入日志和常规工具结果记录；畸形结果与执行失败会拒绝动作。Hook 代码具有完整宿主访问权限，因此策略决策属于工作流检查，不是操作系统沙箱，也不提供新权限。[配置和限制](../README.zh.md#configure-host-policy-hooks)仍由部署方拥有。

<a id="resource-ownership"></a>
## 资源所有权

每个协调器在接纳任务前预留存在冲突的资源名。跨进程接纳使用带时间戳的等待票据，并原子发布已完整写入的所有权文件。资源按稳定名称顺序获取。同一毫秒内创建的票据由标识决定先后；不保证精确到达顺序。

默认硬件命名空间是已保存 `dshPath` 下的主目录，在本计算机上跨工作区共享。不同账户或其他租约根目录需要显式共享目录。硬件名称必须一致地标识同一设备。工作区资源是按名称精确匹配的锁；具名资源是附加项，绝不会替换下节所述的工作树写入声明。规划代理必须为冲突的资源使用分配相同名称，并通过规范写入声明处理路径别名。

执行器只有在托管进程终止，并且宿主提供的进程范围证明支持观察到后代退出后，才结束任务。无法确认清理时，系统保留租约并终止该运行的后续派发。启动保留不确定的活动声明：已知路径和资源阻止冲突工作，未知范围阻止新接纳，但不隐藏检查 API。即使使用原生路径，WSL 启动的 Linux 进程也在 Windows 进程范围之外；无法观察其退出，因此租约保持隔离，直到操作者确认终止。仅凭协调器 PID 已退出并不能确立其后代也已停止；保留所有权需要持久服务的[启动恢复证据](../README.zh.md#persistent-local-service)。所有权文件是协作式调度锁，并不是对无关 GPU 应用的操作系统限制。

损坏的所有权记录会拒绝访问。有效持有中的租约不会因过期而交给第二个所有者。续约原子替换诊断元数据；调用者必须串行执行同一所有权令牌的续约和释放。恢复只有在确立相关工作已静止后才会隔离遗留文件；旧记录中的不确定状态仍需操作者确认。

<a id="version-control-and-write-ownership"></a>
## 版本控制与写入所有权

每次运行通过最接近的现存祖先和真实路径解析工作区，然后记录物理工作树、Git 顶层目录、共享公共目录、分支、HEAD，以及已暂存、已修改和未跟踪的路径集合。Git 探测为只读，并设置 `GIT_OPTIONAL_LOCKS=0`；DeepCluster 从不执行 commit、reset、stash、clean 或 rebase。暂存集合通过 `git ls-files --stage` 读取，并按条目内容身份比较，因此即使 porcelain 状态字母仍为 `M`，重新暂存已修改内容、取消暂存和暂存删除也能被发现。工作代理指令要求保留记录的状态，步骤后和最终快照会比较已观察变更与声明路径。

步骤省略 `access` 时，写入声明默认独占整个工作树。`access: read-only` 声明不写入源码且不获取写入声明；`access: write` 配合 `writes:` 只预留列出的字面仓库相对路径，结尾 `/` 覆盖其后代。通配符、绝对路径和盘符路径、UNC 路径、反斜杠、`..` 或 `.` 段、`.git`、`.deep-cluster`、Windows 保留名称，以及工作树之外的符号链接或 junction 逃逸都会被拒绝。资源会附加精确名称锁，绝不会替换该声明；`resources: none` 不会退出声明。`git: write` 需要整工作树访问权限、真实 Git 工作树和共享公共目录锁；它记录的是修改 Git 元数据的许可，而不是执行修改的指令。

声明在一个短暂的跨进程注册表互斥下获取，以唯一独占文件发布，并在持有期间续约；系统不会仅因截止时间过期或 PID 看似已死就替换声明。重叠判断使用规范绝对跨度，因此父工作区与子工作区、嵌套仓库和子模块，以及包含该文件的外部非 Git 祖先都会彼此冲突；分离的物理工作树可以并行运行。Git 元数据是独立的记账命名空间，通过共享公共目录声明串行化。在 Windows 上，注册表互斥使用命名管道，所有者退出时由操作系统释放。普通接纳最多等待配置的时限；旧目录互斥锁需要经过验证的恢复。已释放声明保存在 `<leaseRoot>/claim-history.json`，保留 1,000 条释放记录或 12 小时；当审计窗口早于记录的 `prunedThrough` 时，未授权变更会报告为无法归属，而不是归咎于某个工作代理。仅凭过期或 PID 已退出绝不会释放所有权。

执行边界是明确的：声明是协作式调度锁，不是沙箱。任意 shell 都可以写到声明路径之外。`access: read-only` 是声明；当另一份活动声明覆盖被修改的路径时，快照无法识别具体写入者。一次快照使用一次只读的 `git status --untracked-files=all`、一次 `git ls-files --stage`，加上对既有变更和声明文件的 SHA-256，从不整树哈希，因此快照之间被修改后恢复的干净文件、被忽略或生成的文件，以及其他不可观察的写入不会被报告。HEAD、分支和索引条目会被观察；reflog、其他 ref、packed-refs、config、日志、索引扩展和标志，以及公共目录中的任意文件不做内容指纹。快照或检测步骤失败会可见呈现，绝不会变成通过。

<a id="evidence-and-collaboration"></a>
## 证据与协作

仅追加日志标识每次运行和写入者。序列号属于单个写入者，并非全局时钟。同一写入者的并发任务串行追加；读取者拒绝损坏的完整记录，忽略不完整的末尾追加。日志写入失败会停止操作，而不会报告未记录的成功。

每个完成的模型步骤可将提供者输入、输出 token 数和观察到的响应耗时追加为 `agent/usage`。实时吞吐率使用 `agent/token-sample`：工作代理通过公开的 `agent/assistant-stream` 钩子生成有符号的输出前缀 token 增量，由控制器记录观察时间，并累加最近五秒的样本。[Hugging Face Tokenizers.js](https://github.com/huggingface/tokenizers.js) 使用明确配置的本地模型文件分词；此估计值不含协议特殊 token，可能与提供者计费用量不同。运行时 tokenizer 失败会发出 `agent/token-error`，并停止该流的计数；后续受支持的流可以恢复。文本或推理内容不会进入这些数值记录。用量、样本、错误和活动记录在工作代理完成之前写入完毕。

能力账本将任务最终结果投影为有界示例和角色计数，保留验收标签、报告检查、摘要、耗时以及成功、失败或受阻状态。通过的报告需要肯定的证据文本和成功的工作代理退出，但这些文本仍属于自报结果。独立测试、测量产物和控制代理审查决定交付结果是否可信。

规划代理根据能力账本示例进行委派前，应比较相似任务、模型设置、工具和硬件。数量小或有偏的样本不能支持经过校准的能力阈值。DeepCluster 展示示例，而不会根据通过率自动提升角色能力等级。

协作通过显式图依赖、持久化产物和可选的运行内对等邮箱进行。进入依赖任务提示的前置任务摘要会生成有向交接记录。工作代理工具原子发布消息并主动读取；发送和读取回执分别写入日志。读取不代表模型已按消息行动。重试进程可以再次读取早先消息。本计算机上的监督者可通过 `POST /v1/runs/<operationId>/messages` 向一个精确的运行参与者发布反馈；接收者仍需显式读取，保留的发送身份不能作为计划步骤 id。协议对每条持久消息上限为 16,000 个字符，因此较小的工作代理发送预算不会让已接纳消息无法读取。消息不能改变依赖或转移租约，也不隐含唤醒。分布式所有权、动态改写图、自动工作区隔离和日志保留不在已实现行为范围内。

<a id="dev-note"></a>
### 开发备注

候选扩展，尚未实现：优先考虑将去重事实返回监督 AI 的 CI 与审查观察；从显式配置的工作代理 profile 中按步骤选择；以及由监督者请求、集成责任明确的可选工作树。每项都需要独立验收证据。自动分配、自主 Git 修改和未经监督的事件触发修复循环不在这些候选项中。
