---
"migrate-sdk": patch
"@migrate-sdk/commercetools": patch
"@migrate-sdk/workflow-sdk": patch
"@migrate-sdk/tui": patch
---

Align Effect runtime packages on 4.0.5 so fresh installs use the Path API required by the Node platform dependencies. This fixes the missing `effect/Path` export that prevented packed TUI consumers from starting their local Migrate Server. The CSV source cache now retains inode values as bigint to match the updated filesystem metadata.
