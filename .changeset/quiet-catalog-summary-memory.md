---
"@migrate-sdk/commercetools": patch
---

Optimize Commercetools item-state summaries with status-filtered GraphQL selections that return only keys and page counts. Status reads and run preparation no longer download or decode tracking records and recovery journals. Each status paginates independently without relying on capped query totals, and invalid status metadata or incomplete responses fail explicitly. Existing persisted records and the public store interface remain compatible; no storage upgrade is required.

Summary counts are eventually consistent while item statuses change, and converge on the next scan once writes stop.
