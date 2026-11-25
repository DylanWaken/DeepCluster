---
description: "在保留配置权限和硬件所有权的前提下诊断 Windows 工作进程启动失败。"
kind: "reference"
---

# Windows 工作进程启动失败

[English](windows-console-boundary.md) | 中文

## 概述

Windows 将 `0xC0000142` 报告为 `STATUS_DLL_INIT_FAILED`，即动态库初始化失败。[Microsoft 状态参考](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)未指定唯一原因。仅凭该状态无法确立失败由沙箱、控制台分配、环境大小或工具链引起。

## 诊断失败的操作

保留准确命令、工作目录、选择的权限模式、退出状态和可用的加载器诊断信息。将命令缩减为最小复现。在判断原因之前检查配置的 [Windows 沙箱提供者](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sandbox/sandbox-windows-acl/README.md)及工具链要求。没有输出的超时同样不足以确定原因。

DeepCluster 在重试和修复工作代理中保持相同权限配置。修复角色可以诊断并修复权限允许的工作区脚本或配置，不能给自己授予更广泛访问。如果选定执行环境无法启动所需工具，应报告缺失能力并停止依赖工作。

## 保留资源所有权

取消和超时会终止托管工作进程，并在释放硬件前等待后代退出的证明。无法确认清理时，租约保持隔离。WSL 启动的 Linux 进程，或拥有的 Windows 进程范围之外的任何后代，在其直接子进程退出后无法被观察；应将该运行视为未确认，并保持租约隔离。过期截止时间或已退出的协调器 pid 不能证明所有 GPU 工作已经结束；恢复锁前先确认终止。协调器日志记录失败及受影响任务。

持久化 API 和仪表盘生命周期使用每用户 Windows 计划任务，这些任务通过 `conhost.exe --headless` 隐藏运行，在使用电池供电时仍会启动并持续运行，且没有执行时间限制。其他平台的服务命令在创建服务文件前失败；请在这些平台上通过外部监督进程运行 profile。停止仪表盘会结束其计划任务，然后在重新核验 PID 和启动时间后终止记录的仪表盘进程树。`service recover --dry-run` 诊断现存的 API 所有权锁，`service recover` 仅在确认记录所有者已消失、PID 未被复用、端口空闲且没有保留操作仍活动后，才隔离该锁。

## 开发备注

无。
