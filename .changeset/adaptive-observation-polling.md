---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

Stream remote dashboard and run updates over resumable HTTP sessions, with heartbeat-based stall detection. Require Migrate Protocol v3; clients and servers must upgrade together. Publish bounded Workflow progress during long-running steps, deliver lifecycle changes promptly, and coalesce durable status refreshes. Replace checkpoint-only adapter callbacks with execution events and defer redundant recovery checks while progress is arriving.
