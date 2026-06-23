---
"migrate-sdk": minor
---

Validate omitted required dependency state before running selected migrations. Runs now allow leaf migrations to execute without `--with-dependencies` when required dependencies have already completed successfully, while failed or missing dependency state is rejected unless `--force` is used.

Dependency planning is now directional: run expansion follows required prerequisites, rollback expansion follows required dependents. Rollback no longer pulls parent migrations into a leaf rollback, and parent rollback can include dependent children with `--with-dependencies`.

Migration definitions now declare ordering through `dependencies.required` and `dependencies.optional`.
