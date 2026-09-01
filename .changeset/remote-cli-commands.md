---
"migrate-sdk": patch
---

Support every server-backed CLI command through `--server`, including registry
listing, dependency graphs, status, messages, and lock recovery. Remote HTTP
authentication failures now report 401 and 403 permission errors with a token
configuration hint. Finalize the pre-adoption Migrate Protocol v1 baseline with
static registry metadata and canonical selection-based status and message
reports; servers from the earlier incomplete v1 draft must be redeployed.
