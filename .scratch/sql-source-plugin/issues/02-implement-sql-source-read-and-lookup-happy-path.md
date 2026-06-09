# Implement SQL Source Read And Lookup Happy Path

Status: ready-for-agent

## Parent

[SQL Source Plugin](../PRD.md)

## What to build

Implement the end-to-end happy path for `SqlSourcePlugin`: execute configured SQL read and lookup statements through the provided `clientLayer`, turn returned SQL rows into Source Items through Result-style metadata extraction, and integrate with the existing migration runner so SQL row payloads are decoded by the Source Payload Schema before the Transformation Pipeline runs.

This slice should prove the core behavior with deterministic tests. A fake or scripted `SqlClient` is acceptable for the first happy path, as long as the source plugin genuinely consumes the `clientLayer` and the public Source Plugin methods work through the configured layer.

## Acceptance criteria

- [ ] `SqlSourcePlugin.make` returns a configured Source Plugin using the SQL source contract from issue 01.
- [ ] `read(null)` executes the configured read statement builder through the configured `clientLayer`.
- [ ] Read statement builders receive the input Source Cursor, configured `limit`, and Effect SQL statement constructor.
- [ ] Empty read results return no Source Items and no next Source Cursor.
- [ ] Non-empty read results return Source Items whose payload is the original SQL row.
- [ ] Non-empty read results compute next Source Cursor from the last emitted row's extracted cursor.
- [ ] Source Identity and Source Version values from metadata extraction pass through the existing source item normalization boundary.
- [ ] `readByIdentity(identity)` executes the configured lookup statement builder through the configured `clientLayer`.
- [ ] Lookup statement builders receive the requested Source Identity and Effect SQL statement constructor.
- [ ] Lookup returning no rows returns `null`.
- [ ] Lookup returning one row returns one Source Item and ignores the extracted cursor operationally.
- [ ] SQL reads and lookups are not wrapped in SQL transactions by default.
- [ ] SQL execution failures normalize through the current source error boundary.
- [ ] A migration using the SQL source can process a valid SQL row through the runner and pass the Source Payload Schema decoded value into the Transformation Pipeline.
- [ ] A SQL row with valid identity and version but invalid payload becomes a failed Migration Item State through existing runner behavior.
- [ ] Existing source plugin, runtime, and package typecheck tests remain green.

## Blocked by

- [01 - Define SQL Source Contract And Core Types](01-define-sql-source-contract-and-core-types.md)
