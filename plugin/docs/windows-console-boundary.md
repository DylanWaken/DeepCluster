---
description: "Diagnose Windows worker startup failures while preserving configured permissions and hardware ownership."
kind: "reference"
---

# Windows worker startup failures

English | [中文](windows-console-boundary.zh.md)

## Summary

Windows reports `0xC0000142` as `STATUS_DLL_INIT_FAILED`: a dynamic library failed initialization. [Microsoft’s status reference](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55) does not identify a unique cause. The status alone cannot establish that a sandbox, console allocation, environment size, or toolchain caused the failure.

## Diagnose the failing operation

Preserve the exact command, working directory, selected permission mode, exit status, and available loader diagnostics. Reduce the command to the smallest reproduction. Inspect the configured [Windows sandbox provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sandbox/sandbox-windows-acl/README.md) and toolchain requirements before assigning a cause. A timeout without output is also insufficient evidence to identify the cause.

DeepCluster keeps the same configured permissions across retries and repair workers. Its repair role may diagnose and repair allowed workspace scripts or configuration; it cannot grant itself broader access. If the selected execution environment cannot start the required tool, report the missing capability and stop dependent work.

## Preserve resource ownership

Cancellation and timeout terminate managed workers and wait for descendant exit proof before releasing hardware. Unconfirmed cleanup leaves the lease quarantined. A WSL-launched Linux process, or any descendant outside the owned Windows process range, cannot be observed after its direct child exits; treat that run as unconfirmed and keep its lease quarantined. A stale deadline or dead coordinator pid is not evidence that all GPU work ended; confirm termination before recovering the lock. The coordinator journal records the failure and its affected task.

The persistent API and dashboard lifecycle uses per-user Windows scheduled tasks that run hidden through `conhost.exe --headless`, start and keep running on battery, and have no execution time limit. Other platforms fail the service commands before creating service files; run the profiles under an external supervisor there. Stopping the dashboard ends its scheduled task and then terminates the recorded dashboard process tree after re-verifying its PID and start time. `service recover --dry-run` diagnoses a present API ownership lock, and `service recover` quarantines it only after confirming the recorded owner gone, its PID not reused, the port free, and no preserved operation live.

## Dev Note

None.
