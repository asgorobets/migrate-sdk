---
"migrate-sdk": patch
"@migrate-sdk/commercetools": patch
"@migrate-sdk/workflow-sdk": patch
"@migrate-sdk/tui": patch
---

Upgrade Effect and its platform, SQL, and testing packages together to 4.0.4.
Fresh TUI installations now resolve compatible stable dependencies, and the
Workflow SDK example's PostgreSQL client sends TLS SNI for Neon connections.
Document one-off pnpm dlx usage with explicit Bun and esbuild build approvals.
