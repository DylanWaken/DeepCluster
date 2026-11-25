# Inspect DeepCluster
goal: collect independent source and test inventories for the controlling agent

## Step sources: inspect package entrypoints
role: reviewer
depends_on: none
access: read-only
hardware: none
acceptance:
- entrypoints listed

Read packages/experimental/deep-cluster/package.json and its declared entry files. Report their paths and responsibilities. Do not modify files or execute GPU commands.

## Step tests: inspect focused test coverage
role: reviewer
depends_on: none
access: read-only
hardware: none
acceptance:
- test files listed

Read packages/experimental/deep-cluster/tests. Report test file paths and the behaviors each exercises. Do not modify files or execute GPU commands.

## Step reconcile: reconcile the inventories
role: reviewer
depends_on: sources, tests
access: read-only
hardware: none
acceptance:
- coverage gaps identified

Use both prerequisite summaries and inspect the named files. Report concrete coverage gaps or state that the reviewed behaviors have focused tests. Do not modify files or execute GPU commands.
