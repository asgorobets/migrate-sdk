---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

Stream remote dashboard and run updates over resumable HTTP sessions, with heartbeat-based stall detection. Require Migrate Protocol v3; clients and servers must upgrade together. Publish compact cumulative Workflow contributions from committed item-state transitions, batched every five seconds and at step completion. Keep projections and stream cursors in shared client code so routine progress and serverless reconnection avoid item-summary scans. Refresh lifecycle metadata separately and reconcile stored totals when execution finishes.
