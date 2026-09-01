---
"migrate-sdk": patch
---

Support every server-backed CLI command through `--server`, including registry
listing, dependency graphs, status, messages, and lock recovery. Remote HTTP
authentication failures now report 401 and 403 permission errors with a token
configuration hint.
