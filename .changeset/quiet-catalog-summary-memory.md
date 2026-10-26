---
"@migrate-sdk/commercetools": patch
---

Bound memory use when summarizing migration item states with large tracking records or recovery journals. Status and run preparation now count validated item states in keyset pages of at most ten records and discard each page instead of retaining every full item state. Existing persisted records remain compatible and status counts remain exact.
