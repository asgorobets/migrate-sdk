# @migrate-sdk/commercetools

## 0.2.0

### Minor Changes

- 7b011ee: Simplify the Commercetools destination API so migration code can pass Commercetools SDK drafts and typed update actions directly to destination helpers.

  Create helpers now accept the corresponding SDK draft shape without requiring exported `*DraftSchema` wrappers. Update helpers now accept `{ selector, version, actions }` with typed SDK update actions directly, instead of requiring callers to build updates through `make*Update` action-builder factories.

  The schema-backed action-builder factories and draft schema exports have been removed from the public destination surface. Custom-field builders remain available as pure helpers and now cover supported non-product resources: business units, customers, inventory entries, product selections, and stores.

## 0.1.0

### Minor Changes

- initial release

### Patch Changes

- Updated dependencies
  - migrate-sdk@0.1.0
