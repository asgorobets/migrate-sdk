# Document Fetcher API And File Text Fetcher

Status: ready-for-agent

## Parent

[Document Source Plugin](../PRD.md)

## What to build

Introduce the Document Fetcher contract and the first concrete local file
fetcher. This slice extracts the resource-fetching responsibility from the
current JSON file source shape without building the full document source
composer yet.

The file text fetcher should use Effect platform services for filesystem and
path access, return a string resource for parsers, expose its cursor schema, and
include stable resource fingerprint behavior that later cursor logic can use.
Fetcher-side failures should be surfaced as source plugin failures with useful
resource context.

## Acceptance criteria

- [ ] A Document Fetcher contract exists with a cursor schema and a read
      operation that returns a resource, optional next fetcher cursor, and
      optional resource fingerprint.
- [ ] A Document Fetch Result contract exists and is reusable by future fetcher
      helpers.
- [ ] A file text fetcher helper reads local text resources through Effect
      platform filesystem and path services.
- [ ] The file text fetcher does not validate document schema or parse JSON.
- [ ] The file text fetcher returns a stable fingerprint for the resource it
      read.
- [ ] File read failures are normalized into source plugin failures with useful
      file/resource context.
- [ ] The helper supports dependency injection of platform services for tests.
- [ ] Tests cover successful file reads, missing/unreadable file behavior,
      fingerprint stability, and injected platform services.
- [ ] The fetcher API stays separate from lookup, selector, identity, and
      version behavior.

## Blocked by

None - can start immediately
