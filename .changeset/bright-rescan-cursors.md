---
"migrate-sdk": minor
"@migrate-sdk/commercetools": minor
"@migrate-sdk/workflow-sdk": minor
---

Sources now use full discovery by default. Completed runs clear their cursor, so
the next run scans from the beginning and can discover changes anywhere in the
source while still skipping items whose version has not changed. Sources with a
reliable high-water cursor can opt into `discovery: "incremental"` instead.

Customers can use `migrate run --rescan` to ignore a saved cursor without
forcing unchanged items through the Process Pipeline. Run plans and status show
the configured discovery mode and warn when an incremental run trusts its saved
cursor.

Commercetools sources now page by `(lastModifiedAt, id)` so new and updated
resources are not missed because of UUID ordering. Existing Commercetools
migrations with a saved cursor must run once with `--rescan` after upgrading to
replace the old cursor shape.
