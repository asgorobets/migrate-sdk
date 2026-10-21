# Object discovery source

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Implement `FilesSDKSource.objects` as a normal configured source. Emit validated
serializable object references, not bodies/handles. Own opaque durable page
cursors and direct identity lookup within the configured storage/prefix scope.

## Acceptance criteria

- [x] Full discovery, multi-page reads, filtered empty pages, cursor-loop rejection, and restart/rescan behavior are tested.
- [x] Scope fingerprint rejects continuation from a different storage binding/configuration; identity contract detects a changed storage binding.
- [x] Exact logical keys survive case, Unicode, spaces, slashes, and provider directory behavior.
- [x] Lookup applies listing scope/filter rules; only NotFound maps to null.
- [x] Stable version policy, metadata hydration, missing-validator failure, custom policy contract ids, and opt-in SHA-256 behavior are covered.
- [x] Numeric timestamps encode consistently and payload schemas reject clients, streams, and invalid metadata.
- [x] No incremental/high-water promise is made; totals are unknown without explicit enumeration.
- [x] Existing configured-source/runtime tests demonstrate skip unchanged, changed versions, targeted retries, and partial-window replay.
- [x] Source mutation and authoritative orphan-scan limitations are documented.
- [x] Native provider order and folder-only listing limitations are explicit; no universal recursive-tree or stable limited-run guarantee is claimed.

## Blocked by

[01: package and Effect boundary](01-package-and-effect-boundary.md).

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.
