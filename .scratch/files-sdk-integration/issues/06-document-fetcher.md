# Files-backed document text fetcher

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Expose a fixed-object text fetcher bound to a Files layer. Compose it with
existing DocumentSource/DocumentParsers rather than implementing remote JSON
selection or CSV semantics in the Files integration.

## Acceptance criteria

- [x] Fetcher accepts an explicit object key and byte bound, returns text/fingerprint, and maps failures to SourceError.
- [x] Byte bounds apply while reading, including unknown or misleading size metadata.
- [x] A remote JSON fixture uses existing schema parsing, nested selectors, identity, and item version behavior.
- [x] A partially consumed resource changing across resume exercises existing fingerprint restart semantics.
- [x] Missing, unauthorized, oversized, invalid UTF-8, interrupted, and changed-during-read resources have defined outcomes.
- [x] No local-only cheap total-count capability, parsing logic, or new SourceRuntime contract is introduced.

## Blocked by

[01: package and Effect boundary](01-package-and-effect-boundary.md).

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.

2026-10-16 follow-up: added `FilesSDKDocumentFetchers.texts` for folder/prefix
discovery using shared `FilesSDKObjectDiscoveryOptions` and the same discovery
implementation as `FilesSDKSource.objects`. The fetcher returns pages of UTF-8
strings and enforces an aggregate byte bound. Added generic
`DocumentParsers.each(parser)` with coverage using JSON, schema, and custom
Effect fetchers. DocumentSource owns record identity, version, selection, and
partial-page restart. Documentation now leads with this composition.
