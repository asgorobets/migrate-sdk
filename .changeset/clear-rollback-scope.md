---
"@migrate-sdk/commercetools": patch
"@migrate-sdk/tui": patch
"@migrate-sdk/workflow-sdk": patch
"migrate-sdk": minor
---

Rollback confirmations now explain which migrations will be rolled back and why dependent migrations go first. The TUI shows the execution order and uses one confirmation. Choose between Include dependencies, recommended and selected by default, and Selected only. When dependent records remain, Selected only explains the consequences and confirms forced rollback; otherwise it keeps dependency safety checks enabled.

Migrate Server now includes dependent migrations only when explicitly requested, matching the SDK and CLI defaults. The TUI requests inclusion by default and lets the operator change scope before confirming. CLI help and rollback errors explain that force skips safety checks without changing the selected migrations.

Migration completion is now stored separately from operation history. Finishing a full source pass unlocks dependencies even when individual items failed or need updates. Selected-item runs and retries alone do not mark a migration complete. Removing an entry during rollback clears completion and resets the source cursor immediately so the next run can restore removed items; no-op rollbacks preserve it. The dashboard and CLI show completion separately from the last operation.

Existing SQL stores need one schema upgrade to version 3, adding operation history and completion together. File and Commercetools stores gain separate completion records without an upgrade command. Existing migrations need a new full forward pass to establish completion. Custom stores must implement the completion and rollback-item transitions and accept named run-start inputs with an explicit operation. Successful forward orphan cleanup preserves completion; partially failed or cancelled cleanup after removal requires another source pass.

Run history continues to distinguish forward runs from rollbacks, including Workflow SDK execution.

Run and rollback confirmations share a complete numbered plan, with migration names shown only in the plan. Run, rescan, update, and retry prompts use short action descriptions and explain that forcing past dependencies may cause item failures. Rollback buttons use the fixed label “Rollback selected”.

The TUI can now connect to an outdated SQL store and show an upgrade popup before loading the dashboard. Review the changes, upgrade through the server, and continue in the same session. Errors stay visible for retry. Local servers reuse the existing SQL store configuration; remote hosts supply the SQL administration target. These server operations require Migrate Protocol v2, so update clients and servers together. The SQL schema remains version 3.
