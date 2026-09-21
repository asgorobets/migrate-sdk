---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
"@migrate-sdk/tui": minor
---

Separate source ID scope from update behavior. Selecting IDs now leaves already migrated items unchanged when their source version and version contract still match. Combine `--id` with `--update` to reprocess only the selected items, preserving other item states and saved scan progress in inline and Workflow runs. The TUI Source IDs dialog now offers the same Update option.
