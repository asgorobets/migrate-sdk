---
"migrate-sdk": patch
---

Keep SQLite migration progress responsive while a migration is writing results.
Opening an existing migration store now checks its schema without requesting a
write lock, preventing dashboard updates from blocking the migration or causing
connection timeouts. No configuration changes are needed.
